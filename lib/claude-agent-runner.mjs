#!/usr/bin/env node
// Runs Claude Agent SDK with streaming output for daemon automation
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

const prompt = process.argv[2] || process.env.DEPUTY_PROMPT;
if (!prompt) {
  console.error('Usage: claude-agent-runner.js "<prompt>"  (or set DEPUTY_PROMPT)');
  process.exit(1);
}

// Log the locked working directory
const lockedCwd = process.cwd();
console.log(`[RUNNER] Locked to working directory: ${lockedCwd}`);

// Live mode: when DEPUTY_INPUT is set, the session stays open and reads follow-up
// messages appended (one per line) to that file, so you can talk to the agent
// mid-run. Without it, the runner is a one-shot batch (unchanged behavior).
const INPUT_FILE = process.env.DEPUTY_INPUT || '';
const IDLE_MS = Number(process.env.DEPUTY_IDLE_MS || 180000); // close session this long after a turn with no new input
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });

// Shared with the output loop so the input stream knows when a turn finished (idle).
const turn = { lastResultAt: 0, sawResult: false };

async function* inputStream(initialPrompt) {
  yield userMsg(initialPrompt);
  if (!INPUT_FILE) return; // one message then close => one-shot
  console.log(`[RUNNER] Live mode: watching ${INPUT_FILE} for follow-ups (idle close ${IDLE_MS}ms)`);
  let processed = 0;
  while (true) {
    const all = existsSync(INPUT_FILE)
      ? readFileSync(INPUT_FILE, 'utf8').split('\n').filter((l) => l.length)
      : [];
    const fresh = all.slice(processed);
    processed = all.length;
    let yielded = false;
    for (const line of fresh) {
      if (line.trim() === '__exit__') return;
      if (line.trim()) { turn.sawResult = false; turn.lastResultAt = 0; console.log(`\n[YOU] ${line}\n`); yield userMsg(line); yielded = true; }
    }
    if (!yielded) {
      if (turn.sawResult && turn.lastResultAt && Date.now() - turn.lastResultAt > IDLE_MS) return;
      await sleep(1000);
    }
  }
}

// In-process MCP server exposing the tracker operations the agent needs, backed
// by whichever tracker (Jira, GitHub Issues, …) is configured. Provider-agnostic:
// the agent reads the item and marks it done without knowing the backend.
function buildTrackerServer({ createSdkMcpServer, tool, z }) {
  let tracker;
  try {
    tracker = getTracker();
  } catch (e) {
    console.log(`[RUNNER] Tracker MCP disabled (${e.message})`);
    return null;
  }
  const text = (t) => ({ content: [{ type: 'text', text: t }] });

  console.log(`[RUNNER] Tracker MCP enabled (mcp__tracker__*, backend: ${tracker.name})`);
  return createSdkMcpServer({
    name: 'tracker',
    version: '1.0.0',
    tools: [
      tool(
        'get_item',
        'Fetch the work item (title, description, comments) by its id.',
        { itemId: z.string() },
        async ({ itemId }) => text(await tracker.getItem(itemId)),
      ),
      tool(
        'finish',
        'Mark the work item as done (e.g. move it to the review status / apply the review label).',
        { itemId: z.string() },
        async ({ itemId }) => {
          try {
            const result = await tracker.markDone(itemId);
            return text(`Marked ${itemId} done${result ? ` (${result})` : ''}.`);
          } catch (e) {
            return text(`Failed to mark ${itemId} done: ${e.message}`);
          }
        },
      ),
    ],
  });
}

(async () => {
  try {
    // Import from CWD's node_modules (automation worktree)
    const sdkPath = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
    const { query, createSdkMcpServer, tool } = await import(pathToFileURL(sdkPath).href);

    // Resolve zod (SDK peer dep) from the same node_modules as the SDK
    const sdkRequire = createRequire(pathToFileURL(sdkPath).href);
    const zodMod = await import(pathToFileURL(sdkRequire.resolve('zod')).href);
    const z = zodMod.z ?? zodMod.default?.z ?? zodMod.default;

    const trackerServer = buildTrackerServer({ createSdkMcpServer, tool, z });

    // Get main repo path (parent of worktree automation dir)
    const mainRepoPath = lockedCwd.includes('_deputy_')
      ? lockedCwd.split('_deputy_')[0]
      : null;

    // Custom permission handler to restrict file access
    const canUseTool = async (toolName, input) => {
      // Block the sub-agent tools - subagents run as separate sessions that can't
      // see the in-process tracker MCP server, and shouldn't spawn their own worktrees
      if (toolName === 'Task' || toolName === 'Agent') {
        console.log(`[BLOCKED] ${toolName} tool blocked - work directly in this session`);
        return {
          behavior: 'deny',
          message: `The ${toolName} tool is not allowed. Work directly in this session (you have the tracker MCP tools mcp__tracker__* here); do not spawn sub-agents.`
        };
      }

      // Block EnterWorktree - prevents nested worktrees inside the automation worktree
      if (toolName === 'EnterWorktree') {
        console.log(`[BLOCKED] EnterWorktree blocked - already in isolated worktree`);
        return {
          behavior: 'deny',
          message: `EnterWorktree is not allowed. You are already working in an isolated worktree. Do not create nested worktrees.`
        };
      }

      // Block git checkout to keep worktree on detached HEAD
      if (toolName === 'Bash' && input?.command) {
        if (/git\s+checkout/.test(input.command)) {
          console.log(`[BLOCKED] git checkout command blocked - must stay on detached HEAD`);
          return {
            behavior: 'deny',
            message: `git checkout is blocked. You must stay on the detached HEAD. Create the branch at the end with 'git branch <name>' instead.`
          };
        }
      }

      // Check if tool is accessing files
      const filePath = input?.file_path || input?.path || input?.notebook_path;

      if (filePath) {
        // ONLY block access to main repo - allow everything else (cache, tmp, etc)
        if (mainRepoPath && filePath.startsWith(mainRepoPath) && !filePath.startsWith(lockedCwd)) {
          console.log(`[BLOCKED] ${toolName} blocked: ${filePath} is in main repo ${mainRepoPath}`);
          return {
            behavior: 'deny',
            message: `Access denied: ${filePath} is in the main repository. Only worktree access allowed.`
          };
        }
      }

      // Allow all operations (worktree, cache, tmp, anywhere except main repo)
      return { behavior: 'allow', updatedInput: input };
    };

    for await (const msg of query({
      prompt: INPUT_FILE ? inputStream(prompt) : prompt,
      options: {
        maxTurns: 150,
        permissionMode: 'default',
        ...(trackerServer ? { mcpServers: { tracker: trackerServer } } : {}),
        cwd: lockedCwd,
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,  // Bash is sandboxed to CWD
          network: {
            allowLocalBinding: true  // Allow localhost connections (PostgreSQL, Redis, etc.)
          }
        },
        additionalDirectories: [lockedCwd, `${process.env.HOME}/.cache`],
        canUseTool: canUseTool  // Custom permission handler blocks files outside worktree
      }
    })) {
      // Log useful information based on message type
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if ('text' in block) {
            console.log(`\n[ASSISTANT] ${block.text}\n`);
          } else if (block.type === 'tool_use') {
            // Format tool input nicely
            let inputStr;
            if (block.name === 'Bash') {
              inputStr = block.input.command;
            } else if (block.name === 'Agent' || block.name === 'TodoWrite') {
              inputStr = JSON.stringify(block.input, null, 2);
            } else {
              inputStr = JSON.stringify(block.input);
            }
            console.log(`\n━━━ [${block.name}] ━━━`);
            console.log(inputStr);
          }
        }
      } else if (msg.type === 'user') {
        // Tool results - show output
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            // Show first 1000 chars of output
            const preview = content.length > 1000 ? content.substring(0, 1000) + '...[truncated]' : content;
            console.log(`↳ ${preview}\n`);
          }
        }
      } else if (msg.type === 'result') {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[RESULT] ${msg.subtype}`);
        console.log(`${'='.repeat(60)}\n`);
        turn.sawResult = true; turn.lastResultAt = Date.now();  // lets live input stream idle-close
      } else if (msg.type === 'status') {
        console.log(`[STATUS] ${msg.status}`);
      }
    }
  } catch (error) {
    console.error('[ERROR]', error);
    console.error('[STACK]', error.stack);
    process.exit(1);
  }
})();
