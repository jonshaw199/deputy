import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jira from '../lib/trackers/jira.mjs';

// Minimal fetch stub: `router(url, opts)` returns { ok, status, body }.
let calls, origFetch;
function stub(router) {
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const r = router(String(url), opts) || {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  };
}

beforeEach(() => {
  calls = [];
  origFetch = global.fetch;
  process.env.DEPUTY_CLOUD_ID = 'cloud123';
  process.env.DEPUTY_USER_EMAIL = 'me@example.com';
  process.env.DEPUTY_API_TOKEN = 'tok';
  process.env.DEPUTY_SITE_URL = 'https://acme.atlassian.net';
  for (const k of ['DEPUTY_PROJECTS', 'DEPUTY_LABEL', 'DEPUTY_STATUS_START', 'DEPUTY_STATUS_DONE']) delete process.env[k];
});
afterEach(() => { global.fetch = origFetch; });

test('listReady queries by label only (no status clause) and maps issues', async () => {
  stub((url, opts) => {
    assert.ok(url.endsWith('/search/jql'));
    assert.equal(JSON.parse(opts.body).jql, 'labels = "ai-ready"');
    return { body: { issues: [{ key: 'SAAS-1', fields: { summary: 'Fix the thing' } }] } };
  });
  assert.deepEqual(await jira.listReady(), [{ id: 'SAAS-1', title: 'Fix the thing' }]);
});

test('listReady adds a project filter when DEPUTY_PROJECTS is set', async () => {
  process.env.DEPUTY_PROJECTS = 'SAAS';
  stub((url, opts) => {
    assert.equal(JSON.parse(opts.body).jql, 'labels = "ai-ready" AND project IN (SAAS)');
    return { body: { issues: [] } };
  });
  await jira.listReady();
});

test('listReady honors a custom label', async () => {
  process.env.DEPUTY_LABEL = 'claude-me';
  stub((url, opts) => { assert.equal(JSON.parse(opts.body).jql, 'labels = "claude-me"'); return { body: { issues: [] } }; });
  await jira.listReady();
});

test('listReady throws on Jira errorMessages', async () => {
  stub(() => ({ body: { errorMessages: ['bad JQL'] } }));
  await assert.rejects(() => jira.listReady(), /bad JQL/);
});

test('markStarted removes the label first, then transitions to the start status', async () => {
  stub((url, opts) => {
    const m = opts.method || 'GET';
    if (m === 'PUT' && /\/issue\/SAAS-1$/.test(url)) return { status: 204, body: '' };
    if (m === 'GET' && /\/issue\/SAAS-1\/transitions$/.test(url)) return { body: { transitions: [{ id: '31', name: 'In Progress' }] } };
    if (m === 'POST' && /\/issue\/SAAS-1\/transitions$/.test(url)) return { status: 204, body: '' };
    throw new Error(`unexpected ${m} ${url}`);
  });
  await jira.markStarted('SAAS-1');

  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { update: { labels: [{ remove: 'ai-ready' }] } });
  const post = calls.find((c) => c.method === 'POST' && /transitions$/.test(c.url));
  assert.deepEqual(JSON.parse(post.body), { transition: { id: '31' } });
});

test('markStarted still succeeds when the status transition is unavailable', async () => {
  stub((url, opts) => {
    const m = opts.method || 'GET';
    if (m === 'PUT') return { status: 204, body: '' };
    if (m === 'GET') return { body: { transitions: [] } }; // no matching transition
    throw new Error(`unexpected ${m} ${url}`);
  });
  await assert.doesNotReject(() => jira.markStarted('SAAS-1'));
  assert.ok(calls.some((c) => c.method === 'PUT'), 'label removal still happened');
});

test('markDone transitions to the done status and returns its name', async () => {
  stub((url, opts) => {
    const m = opts.method || 'GET';
    if (m === 'GET') return { body: { transitions: [{ id: '41', name: 'In Review' }] } };
    if (m === 'POST') return { status: 204, body: '' };
    throw new Error(`unexpected ${m} ${url}`);
  });
  assert.equal(await jira.markDone('SAAS-1'), 'In Review');
});

test('itemUrl and prRef build browse links from the site URL', () => {
  assert.equal(jira.itemUrl('SAAS-7'), 'https://acme.atlassian.net/browse/SAAS-7');
  assert.equal(jira.prRef('SAAS-7'), 'Jira: https://acme.atlassian.net/browse/SAAS-7');
});
