import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../server/server.mjs';

let dir, server, base;
const ALLOWED_REPO = '/repos/webapp';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deputy-state-'));
  // A running deputy for webapp...
  writeFileSync(join(dir, 'deputy-webapp.pid'), String(process.pid)); // live pid → running
  writeFileSync(join(dir, 'deputy-webapp.log'), '[2026-01-01] SUCCESS: WEB-99\n');
  writeFileSync(join(dir, 'deputy-webapp.meta'), ALLOWED_REPO);
  // ...with one open case.
  writeFileSync(join(dir, 'deputy-item-DEMO-1.lock'), String(process.pid));
  writeFileSync(join(dir, 'deputy-item-DEMO-1.log'), '[ASSISTANT] working on it\nITEM_URL: https://acme.atlassian.net/browse/DEMO-1\n');
  writeFileSync(join(dir, 'deputy-item-DEMO-1.meta'), 'webapp');
  writeFileSync(join(dir, 'deputy-input-DEMO-1.jsonl'), '');
  // A second deputy (dead pid) hosting a case parked on a question.
  writeFileSync(join(dir, 'deputy-api.pid'), '2147483646'); // not alive
  writeFileSync(join(dir, 'deputy-api.meta'), '/repos/api');
  writeFileSync(join(dir, 'deputy-ask-DEMO-2.txt'), 'Muted illustration or a text prompt for the empty state?');
  writeFileSync(join(dir, 'deputy-paused-DEMO-2.meta'), 'api');
  writeFileSync(join(dir, 'deputy-session-DEMO-2.txt'), 'sess-xyz');
  writeFileSync(join(dir, 'deputy-item-DEMO-2.log'), '[NEEDS-INPUT] Muted illustration or a text prompt for the empty state?\n');
  // A dependency-blocked case waiting on a sibling's branch (no live process, no PR).
  writeFileSync(join(dir, 'deputy-blocked-WEB-500.meta'), 'webapp');
  writeFileSync(join(dir, 'deputy-blocked-WEB-500.txt'), 'WEB-499 not started yet');
  writeFileSync(join(dir, 'deputy-item-WEB-500.log'), 'ITEM_URL: https://acme.atlassian.net/browse/WEB-500\n');
  // A case that ended without producing a PR (push failed) — must stay visible, not vanish.
  writeFileSync(join(dir, 'deputy-failed-WEB-600.meta'), 'webapp');
  writeFileSync(join(dir, 'deputy-failed-WEB-600.txt'), 'finished without opening a PR (the push or PR step failed)\nfatal: CONNECT tunnel failed, response 403');
  writeFileSync(join(dir, 'deputy-item-WEB-600.log'), 'ITEM_URL: https://acme.atlassian.net/browse/WEB-600\n');
  // A case the user stopped (✕) but kept — must stay visible as a re-runnable "stopped" card.
  writeFileSync(join(dir, 'deputy-stopped-WEB-700.meta'), 'webapp');
  writeFileSync(join(dir, 'deputy-item-WEB-700.log'), 'ITEM_URL: https://acme.atlassian.net/browse/WEB-700\n');
  // Open PRs the daemon published: one in review with comments, one whose ticket is a live case.
  writeFileSync(join(dir, 'deputy-prs-webapp.json'), JSON.stringify([
    { number: 482, title: 'feat: empty state [WEB-290]', url: 'https://x/pull/482', branch: 'dev/web-290', ticket: 'WEB-290', comments: [{ author: 'alex', path: 'a.ts', line: 44, body: 'debounce this', url: 'https://x/482#r1' }] },
    { number: 9, title: 'wip [DEMO-1]', url: 'https://x/pull/9', branch: 'dev/demo-1', ticket: 'DEMO-1', comments: [] },
  ]));

  server = makeServer({ tmp: dir, repos: [ALLOWED_REPO], siteUrl: 'https://acme.atlassian.net', fileEnv: {} });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (p) => fetch(`${base}${p}`);
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/status nests the open case under its deputy and echoes config', async () => {
  const s = await (await get('/api/status')).json();
  assert.equal(s.siteUrl, 'https://acme.atlassian.net');
  assert.deepEqual(s.repos, [ALLOWED_REPO]);
  const d = s.daemons.find((x) => x.project === 'webapp');
  assert.ok(d.running);
  assert.equal(d.repoDir, ALLOWED_REPO);
  const demo1 = d.cases.find((c) => c.ticket === 'DEMO-1');
  assert.equal(demo1.state, 'working');
  assert.equal(demo1.item, 'https://acme.atlassian.net/browse/DEMO-1');
  assert.equal(s.orphans.length, 0);
});

test('GET /api/status surfaces a parked case as needsInput with its question', async () => {
  const s = await (await get('/api/status')).json();
  const api = s.daemons.find((x) => x.project === 'api');
  assert.equal(api.cases.length, 1);
  const c = api.cases[0];
  assert.equal(c.ticket, 'DEMO-2');
  assert.equal(c.needsInput, true);
  assert.match(c.question, /Muted illustration/);
});

test('POST /api/say resumes a parked case: queues a resume request, not a chat line', async () => {
  const r = await post('/api/say', { ticket: 'DEMO-2', message: 'use the muted illustration' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).resumed, true);
  const queued = readFileSync(join(dir, 'deputy-queue-api.jsonl'), 'utf8').trim();
  const entry = JSON.parse(queued);
  assert.equal(entry.kind, 'resume');
  assert.equal(entry.ticket, 'DEMO-2');
  assert.equal(entry.prompt, 'use the muted illustration');
});

test('GET /api/status folds a ticket PR into its live case and adds PR-only tickets as in-review', async () => {
  const s = await (await get('/api/status')).json();
  const icc = s.daemons.find((x) => x.project === 'webapp');
  // DEMO-1's PR merges into the live DEMO-1 case (no duplicate row).
  const demo1 = icc.cases.filter((c) => c.ticket === 'DEMO-1');
  assert.equal(demo1.length, 1);
  assert.equal(demo1[0].state, 'working');
  assert.equal(demo1[0].pr, 'https://x/pull/9');
  // WEB-290 has no live agent, so it's an in-review case carrying its comments.
  const web = icc.cases.find((c) => c.ticket === 'WEB-290');
  assert.equal(web.state, 'in-review');
  assert.equal(web.comments.length, 1);
  assert.equal(web.branch, 'dev/web-290');
});

test('GET /api/status surfaces a dependency-blocked case with its reason and ticket link', async () => {
  const s = await (await get('/api/status')).json();
  const web = s.daemons.find((x) => x.project === 'webapp');
  const blocked = web.cases.find((c) => c.ticket === 'WEB-500');
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.phase, /WEB-499 not started/);
  assert.equal(blocked.item, 'https://acme.atlassian.net/browse/WEB-500');
});

test('GET /api/status surfaces a failed case (no PR) with its error, not hidden', async () => {
  const s = await (await get('/api/status')).json();
  const web = s.daemons.find((x) => x.project === 'webapp');
  const f = web.cases.find((c) => c.ticket === 'WEB-600');
  assert.equal(f.state, 'failed');
  assert.match(f.phase, /without opening a PR|CONNECT tunnel/);
  assert.equal(f.item, 'https://acme.atlassian.net/browse/WEB-600');
});

test('GET /api/status shows a stopped case as re-runnable, not gone', async () => {
  const s = await (await get('/api/status')).json();
  const web = s.daemons.find((x) => x.project === 'webapp');
  const st = web.cases.find((c) => c.ticket === 'WEB-700');
  assert.equal(st.state, 'stopped');
  assert.equal(st.item, 'https://acme.atlassian.net/browse/WEB-700');
});

test('POST /api/rerun and /api/forget require a ticket', async () => {
  assert.equal((await post('/api/rerun', {})).status, 400);
  assert.equal((await post('/api/forget', {})).status, 400);
});

test('POST /api/continue queues a follow-up carrying the PR branch', async () => {
  const r = await post('/api/continue', { project: 'api', ticket: 'WEB-290', branch: 'dev/web-290', prompt: 'address the debounce comment' });
  assert.equal(r.status, 200);
  const lines = readFileSync(join(dir, 'deputy-queue-api.jsonl'), 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.branch, 'dev/web-290');
  assert.equal(entry.ticket, 'WEB-290');
  assert.equal(entry.prompt, 'address the debounce comment');
});

test('GET /api/log returns the case transcript, or 400 without a target', async () => {
  const ok = await (await get('/api/log?ticket=DEMO-1')).json();
  assert.match(ok.text, /working on it/);
  const bad = await get('/api/log');
  assert.equal(bad.status, 400);
});

test('POST /api/start rejects a repo outside the allowlist', async () => {
  const r = await post('/api/start', { repo: '/not/allowed' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /allowlist/);
});

test('POST /api/stop rejects an unknown daemon', async () => {
  const r = await post('/api/stop', { project: 'ghost' });
  assert.equal(r.status, 400);
});

test('POST /api/stop-case requires a ticket', async () => {
  assert.equal((await post('/api/stop-case', {})).status, 400);
});

test('POST /api/say rejects a ticket with no live agent', async () => {
  const r = await post('/api/say', { ticket: 'NOPE-1', message: 'hi' });
  assert.equal(r.status, 400);
});

test('POST /api/say appends to a live agent input channel', async () => {
  const r = await post('/api/say', { ticket: 'DEMO-1', message: 'use the muted variant' });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(dir, 'deputy-input-DEMO-1.jsonl'), 'utf8').trim(), 'use the muted variant');
});

test('serves the dashboard at / and 404s unknown paths', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal((await get('/does-not-exist')).status, 404);
});
