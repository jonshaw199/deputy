#!/usr/bin/env node
// Commit-time relevance judge (runs ONCE when a case finishes, never as a watcher — so it can't loop).
// The daemon keeps the agent's authored files deterministically and only hands the LEFTOVER files
// (changed but not authored — setup/test drift) to this judge, which says which to drop. A generated
// file that belongs with a change the ticket made (e.g. a schema dump beside a migration) is kept.
//
//   printf '<path>\n<path>\n' | node lib/relevance.mjs <ticketId> <worktree> <baseRef>
//   stdout: {"drop":["path", ...]}   (subset of the input paths)
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

export function parseDrop(text, candidates) {
  const m = (text || '').match(/\{[\s\S]*"drop"[\s\S]*\}/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    const drop = Array.isArray(v.drop) ? v.drop.filter((x) => typeof x === 'string') : [];
    // Never drop anything that wasn't a candidate leftover — the judge can only act on what we gave it.
    return candidates ? drop.filter((d) => candidates.includes(d)) : drop;
  } catch { return []; }
}

function resolveSdk() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.DEPUTY_SDK_DIR && join(process.env.DEPUTY_SDK_DIR, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
  ].filter(Boolean).find((p) => existsSync(p));
}

export async function judgeLeftovers(ticketId, worktree, baseRef, files) {
  if (!files.length) return [];
  const tracker = getTracker();
  const ticket = tracker.getItem ? (await tracker.getItem(ticketId)).slice(0, 6000) : '';
  let diff = '';
  try { diff = execFileSync('git', ['-C', worktree, 'diff', `${baseRef}...HEAD`, '--', ...files], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch {}
  diff = diff.slice(0, 12000);

  const sdkPath = resolveSdk();
  if (!sdkPath) throw new Error('claude-agent-sdk not found');
  const { query } = await import(pathToFileURL(sdkPath).href);

  const prompt = `These files changed in a PR but were NOT authored directly by the engineer — they may be setup/test drift (a regenerated schema dump, a lockfile) OR a legitimate side effect of the ticket's work (e.g. a schema dump beside a migration the ticket adds).

Decide which of THESE files do NOT belong in the ticket's PR and should be dropped. Keep a file if it is a genuine product of the ticket's change; drop it if it is unrelated drift. Only choose from the list below.

Reply with ONLY one JSON object: {"drop": ["<path>", ...]}  — empty if all of them belong.

TICKET ${ticketId}:
${ticket}

CANDIDATE FILES:
${files.join('\n')}

THEIR DIFF:
${diff}`;

  let text = '';
  for await (const msg of query({
    prompt,
    options: { maxTurns: 1, allowedTools: [], ...(process.env.DEPUTY_RELEVANCE_MODEL ? { model: process.env.DEPUTY_RELEVANCE_MODEL } : {}) },
  })) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  return parseDrop(text, files);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [ticketId, worktree, baseRef] = process.argv.slice(2);
  const files = readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  judgeLeftovers(ticketId, worktree, baseRef, files)
    .then((drop) => { console.log(JSON.stringify({ drop })); console.error(`[relevance] ${ticketId}: drop ${drop.length}/${files.length}`); })
    .catch((e) => { console.log(JSON.stringify({ drop: [] })); console.error(`[relevance] ${ticketId}: ${e.message}`); });
}
