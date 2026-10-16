import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../server/server.mjs';

let dir, server, base;
const ALLOWED_REPO = '/repos/icc_app';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deputy-state-'));
  // A running deputy for icc_app...
  writeFileSync(join(dir, 'deputy-icc_app.pid'), String(process.pid)); // live pid → running
  writeFileSync(join(dir, 'deputy-icc_app.log'), '[2026-01-01] SUCCESS: SAAS-99\n');
  writeFileSync(join(dir, 'deputy-icc_app.meta'), ALLOWED_REPO);
  // ...with one open case.
  writeFileSync(join(dir, 'deputy-item-DEMO-1.lock'), String(process.pid));
  writeFileSync(join(dir, 'deputy-item-DEMO-1.log'), '[ASSISTANT] working on it\nITEM_URL: https://acme.atlassian.net/browse/DEMO-1\n');
  writeFileSync(join(dir, 'deputy-item-DEMO-1.meta'), 'icc_app');
  writeFileSync(join(dir, 'deputy-input-DEMO-1.jsonl'), '');
  // A second deputy (dead pid) hosting a case parked on a question.
  writeFileSync(join(dir, 'deputy-atlas.pid'), '2147483646'); // not alive
  writeFileSync(join(dir, 'deputy-atlas.meta'), '/repos/atlas');
  writeFileSync(join(dir, 'deputy-ask-DEMO-2.txt'), 'Muted illustration or a text prompt for the empty state?');
  writeFileSync(join(dir, 'deputy-paused-DEMO-2.meta'), 'atlas');
  writeFileSync(join(dir, 'deputy-session-DEMO-2.txt'), 'sess-xyz');
  writeFileSync(join(dir, 'deputy-item-DEMO-2.log'), '[NEEDS-INPUT] Muted illustration or a text prompt for the empty state?\n');

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
  const d = s.daemons.find((x) => x.project === 'icc_app');
  assert.ok(d.running);
  assert.equal(d.repoDir, ALLOWED_REPO);
  assert.equal(d.cases.length, 1);
  assert.equal(d.cases[0].ticket, 'DEMO-1');
  assert.equal(d.cases[0].item, 'https://acme.atlassian.net/browse/DEMO-1');
  assert.equal(s.orphans.length, 0);
});

test('GET /api/status surfaces a parked case as needsInput with its question', async () => {
  const s = await (await get('/api/status')).json();
  const atlas = s.daemons.find((x) => x.project === 'atlas');
  assert.equal(atlas.cases.length, 1);
  const c = atlas.cases[0];
  assert.equal(c.ticket, 'DEMO-2');
  assert.equal(c.needsInput, true);
  assert.match(c.question, /Muted illustration/);
});

test('POST /api/say resumes a parked case: queues a resume request, not a chat line', async () => {
  const r = await post('/api/say', { ticket: 'DEMO-2', message: 'use the muted illustration' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).resumed, true);
  const queued = readFileSync(join(dir, 'deputy-queue-atlas.jsonl'), 'utf8').trim();
  const entry = JSON.parse(queued);
  assert.equal(entry.kind, 'resume');
  assert.equal(entry.ticket, 'DEMO-2');
  assert.equal(entry.prompt, 'use the muted illustration');
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
