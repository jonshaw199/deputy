#!/usr/bin/env node
// Relevance judge for the "unrelated changes" watcher: given a ticket and a PR's diff, lists the files
// whose changes do NOT belong to the ticket (setup/test drift like a schema dump or lockfile that got
// swept in). A grounded, bounded judgment — the ticket is ground truth, the diff is the evidence —
// same shape as the routing judge. No hardcoded file names: the AI decides relevance per PR, so a schema
// dump that accompanies a migration the ticket added is KEPT, while the same file alone is dropped.
//
//   node lib/relevance.mjs <ticketId> <prNumber>
//   stdout: {"unrelated":["path", ...]}   (empty = nothing to strip)
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

export function parseUnrelated(text) {
  const m = (text || '').match(/\{[\s\S]*"unrelated"[\s\S]*\}/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v.unrelated) ? v.unrelated.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function resolveSdk() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.DEPUTY_SDK_DIR && join(process.env.DEPUTY_SDK_DIR, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
  ].filter(Boolean).find((p) => existsSync(p));
}

export async function judgeRelevance(ticketId, prNumber) {
  const tracker = getTracker();
  const ticket = tracker.getItem ? (await tracker.getItem(ticketId)).slice(0, 6000) : '';
  let diff = '';
  try { diff = execFileSync('gh', ['pr', 'diff', String(prNumber)], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch {}
  if (!diff.trim()) return [];
  diff = diff.slice(0, 14000);

  const sdkPath = resolveSdk();
  if (!sdkPath) throw new Error('claude-agent-sdk not found');
  const { query } = await import(pathToFileURL(sdkPath).href);

  const prompt = `A PR should contain only changes that implement its ticket. Some files get swept in by setup or test runs (a regenerated schema dump, a lockfile, an unrelated edit) and do NOT belong.

List ONLY the files whose changes do NOT belong to THIS ticket. A file BELONGS if its change implements the ticket OR is a direct product of such a change (e.g. a schema dump that accompanies a migration the ticket adds). When unsure, treat it as belonging (do not list it).

Reply with ONLY one JSON object: {"unrelated": ["<path>", ...]}  — empty array if everything belongs.

TICKET ${ticketId}:
${ticket}

PR #${prNumber} DIFF:
${diff}`;

  let text = '';
  for await (const msg of query({
    prompt,
    options: {
      maxTurns: 1,
      allowedTools: [],
      ...(process.env.DEPUTY_RELEVANCE_MODEL ? { model: process.env.DEPUTY_RELEVANCE_MODEL } : {}),
    },
  })) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  return parseUnrelated(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [ticketId, prNumber] = process.argv.slice(2);
  judgeRelevance(ticketId, prNumber)
    .then((unrelated) => {
      console.log(JSON.stringify({ unrelated }));
      console.error(`[relevance] ${ticketId} PR#${prNumber}: ${unrelated.length} unrelated`);
    })
    .catch((e) => { console.log(JSON.stringify({ unrelated: [] })); console.error(`[relevance] ${ticketId}: ${e.message}`); });
}
