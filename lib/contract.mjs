#!/usr/bin/env node
// Cross-repo contract check: the general case of "two blind runs drifted." When one ticket is built as
// separate slices in separate repos, nothing makes them agree on what they share (an API path, a
// payload shape, an enum, a column name). This is a SEPARATE skeptical pass — the Evaluator of an
// Evaluator-Optimizer loop, like verify.mjs, but spanning every slice at once instead of one. It reads
// each slice's PR diff (read-only, via gh) and judges whether they line up, returning per-project gaps.
// Direction-agnostic and N-slice: the daemon of each repo acts only on ITS OWN project's gaps.
//
//   node lib/contract.mjs <ticketId> <slicesJson>
//     slicesJson = [{"project":"api","repo":"acme/api","prNumber":"12"}, ...]
//   stdout: {"agree":bool,"gaps":[{"project":"api","gap":"..."}]}   stderr: one log line
//   exit 0 = agree · 1 = disagree · 3 = could not evaluate (caller treats as no-op)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { getTracker } from './trackers/index.mjs';

export function parseVerdict(text) {
  const m = (text || '').match(/\{[\s\S]*"agree"[\s\S]*\}/);
  if (!m) return { agree: false, gaps: [{ project: '?', gap: 'contract judge returned no parseable verdict' }] };
  try {
    const v = JSON.parse(m[0]);
    const gaps = Array.isArray(v.gaps)
      ? v.gaps.filter((g) => g && typeof g.project === 'string' && typeof g.gap === 'string')
      : [];
    return { agree: v.agree === true, gaps };
  } catch {
    return { agree: false, gaps: [{ project: '?', gap: 'contract judge verdict was not valid JSON' }] };
  }
}

export function gapsForProject(verdict, project) {
  return (verdict.gaps || []).filter((g) => g.project === project).map((g) => g.gap);
}

function resolveSdk() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.DEPUTY_SDK_DIR && join(process.env.DEPUTY_SDK_DIR, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
    join(here, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
  ].filter(Boolean).find((p) => existsSync(p));
}

export async function verifyContract(ticketId, slices) {
  if (!Array.isArray(slices) || slices.length < 2) return { agree: true, gaps: [] };
  const tracker = getTracker();
  const ticket = tracker.getItem ? (await tracker.getItem(ticketId)).slice(0, 8000) : '';
  const sdkPath = resolveSdk();
  if (!sdkPath) throw new Error('claude-agent-sdk not found');
  const { query } = await import(pathToFileURL(sdkPath).href);

  const sliceList = slices.map((s) => `- project ${s.project}: PR #${s.prNumber} in ${s.repo}`).join('\n');
  const prompt = `You are a SKEPTICAL reviewer checking whether the slices of ONE ticket, each built in a SEPARATE repo as a SEPARATE pull request, AGREE on whatever they share across the repo boundary — an API path, a request/response shape, field names and casing, an enum or status vocabulary, an event name, a column. The slices were built in isolation and tend to drift.

Inspect each slice's ACTUAL diff with the read-only tools before deciding — fetch each one with:
  gh pr diff <number> -R <repo>
Slices:
${sliceList}

Identify what the slices must share, then check that every side matches on it. If one slice emits a shape another slice does not accept (wrong path, wrong casing, missing case, extra field), that is a GAP, attributed to the slice that is wrong (or to each side that must change).

Reply with ONLY one JSON object, nothing else:
{"agree": <true ONLY if all slices are consistent on everything they share>, "gaps": [{"project": "<project that must change>", "gap": "<specific, actionable mismatch>"}]}

TICKET ${ticketId}:
${ticket}`;

  let text = '';
  for await (const msg of query({
    prompt,
    options: {
      permissionMode: 'bypassPermissions',
      allowedTools: ['Bash'],
      maxTurns: Number(process.env.DEPUTY_CONTRACT_MAX_TURNS || 20),
      ...(process.env.DEPUTY_CONTRACT_MODEL ? { model: process.env.DEPUTY_CONTRACT_MODEL } : {}),
    },
  })) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') text += b.text;
  }
  return parseVerdict(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [ticketId, slicesJson] = process.argv.slice(2);
  let slices = [];
  try { slices = JSON.parse(slicesJson || '[]'); } catch {}
  verifyContract(ticketId, slices)
    .then((v) => {
      console.log(JSON.stringify(v));
      console.error(`[contract] ${ticketId}: agree=${v.agree} gaps=${v.gaps.length}`);
      process.exit(v.agree ? 0 : 1);
    })
    .catch((e) => {
      console.log(JSON.stringify({ agree: true, gaps: [] }));
      console.error(`[contract] ${ticketId}: ${e.message}`);
      process.exit(3);
    });
}
