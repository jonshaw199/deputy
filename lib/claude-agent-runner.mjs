#!/usr/bin/env node
// Runs Claude Agent SDK with streaming output for daemon automation
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'node:module';

const prompt = process.argv[2];
if (!prompt) {
  console.error('Usage: claude-agent-runner.js "<prompt>"');
  process.exit(1);
}

// Log the locked working directory
const lockedCwd = process.cwd();
console.log(`[RUNNER] Locked to working directory: ${lockedCwd}`);

// In-process MCP server exposing the Jira operations the agent needs. Uses the
// basic-auth creds the daemon already has, and transitions by status NAME so no
// transition ids are hardcoded. Returns null when creds are absent.
function buildJiraServer({ createSdkMcpServer, tool, z }) {
  const email = process.env.JIRA_USER_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const cloudId = process.env.JIRA_CLOUD_ID;
  if (!email || !token || !cloudId) {
    console.log('[RUNNER] Jira MCP disabled (missing JIRA_USER_EMAIL/JIRA_API_TOKEN/JIRA_CLOUD_ID)');
    return null;
  }

  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    Accept: 'application/json',
  };
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const transitionsOf = async (issueKey) =>
    (await (await fetch(`${base}/issue/${issueKey}/transitions`, { headers })).json()).transitions ?? [];

  console.log('[RUNNER] Jira MCP enabled (mcp__jira__*)');
  return createSdkMcpServer({
    name: 'jira',
    version: '1.0.0',
    tools: [
      tool(
        'get_issue',
        'Fetch a Jira issue by key (summary, description, type, status, priority, labels, comments).',
        { issueKey: z.string() },
        async ({ issueKey }) => {
          const fields = 'summary,description,issuetype,status,priority,labels,comment';
          const r = await fetch(`${base}/issue/${issueKey}?fields=${fields}`, { headers });
          return text(await r.text());
        },
      ),
      tool(
        'list_transitions',
        'List the workflow transitions currently available for an issue.',
        { issueKey: z.string() },
        async ({ issueKey }) => {
          const list = (await transitionsOf(issueKey)).map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
          return text(JSON.stringify(list));
        },
      ),
      tool(
        'transition_issue',
        'Move an issue to a target status by name (e.g. "In Review"); the transition id is resolved automatically.',
        { issueKey: z.string(), statusName: z.string() },
        async ({ issueKey, statusName }) => {
          const transitions = await transitionsOf(issueKey);
          const want = statusName.toLowerCase();
          const match = transitions.find((t) => t.name?.toLowerCase() === want || t.to?.name?.toLowerCase() === want);
          if (!match) {
            return text(`No transition to "${statusName}". Available: ${transitions.map((t) => t.name).join(', ')}`);
          }
          const res = await fetch(`${base}/issue/${issueKey}/transitions`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition: { id: match.id } }),
          });
          return text(res.ok ? `Moved ${issueKey} to "${match.name}".` : `Transition failed: ${res.status} ${await res.text()}`);
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

    const jiraServer = buildJiraServer({ createSdkMcpServer, tool, z });

    // Get main repo path (parent of worktree automation dir)
    const mainRepoPath = lockedCwd.includes('_automation_')
      ? lockedCwd.split('_automation_')[0]
      : null;

    // Custom permission handler to restrict file access
    const canUseTool = async (toolName, input) => {
      // Block the sub-agent tools - subagents run as separate sessions that can't
      // see the in-process Jira MCP server, and shouldn't spawn their own worktrees
      if (toolName === 'Task' || toolName === 'Agent') {
        console.log(`[BLOCKED] ${toolName} tool blocked - work directly in this session`);
        return {
          behavior: 'deny',
          message: `The ${toolName} tool is not allowed. Work directly in this session (you have the Jira MCP tools mcp__jira__* here); do not spawn sub-agents.`
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
      prompt: prompt,
      options: {
        maxTurns: 150,
        permissionMode: 'default',
        ...(jiraServer ? { mcpServers: { jira: jiraServer } } : {}),
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
