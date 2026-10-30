#!/usr/bin/env node
// Evaluator step of an Evaluator-Optimizer loop (Anthropic, "Building Effective Agents"): a SEPARATE,
// skeptical pass that judges whether a ticket's work actually satisfies its acceptance criteria and is
// shipped — grounded in the real worktree diff, not the builder's own say-so. Returns concrete gaps the
// daemon feeds back to the builder to finish. The caller bounds the iterations.
//
//   node lib/verify.mjs <ticketId> <worktreePath>
//   stdout: {"done":bool,"gaps":[...]}   stderr: one log line
//   exit 0 = done · 1 = not done · 3 = could not evaluate (caller treats as not-done)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

export function parseVerdict(text) {
  const m = (text || '').match(/\{[\s\S]*"done"[\s\S]*\}/);
  if (!m) return { done: false, gaps: ['verifier returned no parseable verdict'] };
  try {
    const v = JSON.parse(m[0]);
    return { done: v.done === true, gaps: Array.isArray(v.gaps) ? v.gaps : [] };
  } catch {
    return { done: false, gaps: ['verifier verdict was not valid JSON'] };
  }
}

function resolveSdk() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.DEPUTY_SDK_DIR && join(process.env.DEPUTY_SDK_DIR, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
  ].filter(Boolean).find((p) => existsSync(p));
}

export async function verifyTicket(ticketId, worktree) {
  const tracker = getTracker();
  const ticket = tracker.getItem ? (await tracker.getItem(ticketId)).slice(0, 8000) : '';
  const sdkPath = resolveSdk();
  if (!sdkPath) throw new Error('claude-agent-sdk not found');
  const { query } = await import(pathToFileURL(sdkPath).href);

  const prompt = `You are a SKEPTICAL reviewer deciding whether this ticket's work is COMPLETE and ready to ship. Judge by evidence, not optimism — the builder tends to stop early.

Inspect the ACTUAL work with the read-only tools before deciding:
- "git -C ${worktree} status" and "git -C ${worktree} diff origin/main...HEAD" (plus untracked files) to see exactly what changed.
- Read the changed files to confirm they do what the ticket requires.

Check EVERY acceptance criterion in the ticket against the diff. A criterion that is unimplemented, partially implemented, or lacks the test the ticket asks for is a GAP. "No code written" and "no commit/PR" are also gaps.

Reply with ONLY one JSON object, nothing else:
{"done": <true ONLY if every acceptance criterion is implemented and covered by the tests the ticket requires>, "gaps": ["<specific, actionable missing item>", ...]}

TICKET ${ticketId}:
${ticket}`;

  let text = '';
  for await (const msg of query({
    prompt,
    options: {
      cwd: worktree,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Glob', 'Grep', 'Read', 'Bash'],
      maxTurns: Number(process.env.DEPUTY_VERIFY_MAX_TURNS || 15),
      ...(process.env.DEPUTY_VERIFY_MODEL ? { model: process.env.DEPUTY_VERIFY_MODEL } : {}),
    },
  })) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  return parseVerdict(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [ticketId, worktree] = process.argv.slice(2);
  verifyTicket(ticketId, worktree || process.cwd())
    .then((v) => {
      console.log(JSON.stringify(v));
      console.error(`[verify] ${ticketId}: done=${v.done} gaps=${v.gaps.length}`);
      process.exit(v.done ? 0 : 1);
    })
    .catch((e) => {
      console.log(JSON.stringify({ done: false, gaps: [`verifier error: ${e.message}`] }));
      console.error(`[verify] ${ticketId}: ${e.message}`);
      process.exit(3);
    });
}
