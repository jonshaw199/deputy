#!/usr/bin/env node
// For full-auto cases (marker /tmp/deputy-auto-<ticket>), auto-queue an "address all"
// continuation whenever new unresolved review comments appear. Deduped by comment url
// so the same comments aren't re-dispatched every poll. Args: <project>.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const project = process.argv[2];
if (!project) process.exit(0);
const TMP = process.env.DEPUTY_TMP || '/tmp';
const prsFile = `${TMP}/deputy-prs-${project}.json`;
if (!existsSync(prsFile)) process.exit(0);

let prs = [];
try { prs = JSON.parse(readFileSync(prsFile, 'utf8')); } catch { process.exit(0); }

for (const p of prs) {
  if (!p.ticket || !existsSync(`${TMP}/deputy-auto-${p.ticket}`)) continue;
  const comments = p.comments || [];
  if (!comments.length) continue;

  const handledFile = `${TMP}/deputy-auto-handled-${p.ticket}`;
  const handled = new Set(existsSync(handledFile) ? readFileSync(handledFile, 'utf8').split('\n').filter(Boolean) : []);
  const fresh = comments.filter((c) => !handled.has(c.url));
  if (!fresh.length) continue;

  const prompt = 'Full-auto: address these unresolved review comments on the PR by editing the code and pushing to the branch. Do NOT reply on the PR or resolve the threads; just make the changes.\n\n'
    + fresh.map((c, i) => `${i + 1}. @${c.author} ${c.path}${c.line ? ':' + c.line : ''} — ${c.body}`).join('\n');
  const id = `auto-${p.ticket}-${fresh.length}-${fresh[0].url.replace(/\W+/g, '').slice(-12)}`;
  appendFileSync(`${TMP}/deputy-queue-${project}.jsonl`, JSON.stringify({ ticket: p.ticket, prompt, branch: p.branch, kind: 'continue', id }) + '\n');
  writeFileSync(handledFile, [...handled, ...fresh.map((c) => c.url)].join('\n') + '\n');
  console.log(`[auto] queued address-all for ${p.ticket} (${fresh.length} new comment(s))`);
}
