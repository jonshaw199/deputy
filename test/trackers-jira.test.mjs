import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jira, { blockersFromIssue } from '../lib/trackers/jira.mjs';

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
    return { body: { issues: [{ key: 'WEB-1', fields: { summary: 'Fix the thing' } }] } };
  });
  assert.deepEqual(await jira.listReady(), [{ id: 'WEB-1', title: 'Fix the thing' }]);
});

test('listReady adds a project filter when DEPUTY_PROJECTS is set', async () => {
  process.env.DEPUTY_PROJECTS = 'WEB';
  stub((url, opts) => {
    assert.equal(JSON.parse(opts.body).jql, 'labels = "ai-ready" AND project IN (WEB)');
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
    if (m === 'PUT' && /\/issue\/WEB-1$/.test(url)) return { status: 204, body: '' };
    if (m === 'GET' && /\/issue\/WEB-1\/transitions$/.test(url)) return { body: { transitions: [{ id: '31', name: 'In Progress' }] } };
    if (m === 'POST' && /\/issue\/WEB-1\/transitions$/.test(url)) return { status: 204, body: '' };
    throw new Error(`unexpected ${m} ${url}`);
  });
  await jira.markStarted('WEB-1');

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
  await assert.doesNotReject(() => jira.markStarted('WEB-1'));
  assert.ok(calls.some((c) => c.method === 'PUT'), 'label removal still happened');
});

test('markDone transitions to the done status and returns its name', async () => {
  stub((url, opts) => {
    const m = opts.method || 'GET';
    if (m === 'GET') return { body: { transitions: [{ id: '41', name: 'In Review' }] } };
    if (m === 'POST') return { status: 204, body: '' };
    throw new Error(`unexpected ${m} ${url}`);
  });
  assert.equal(await jira.markDone('WEB-1'), 'In Review');
});

test('itemUrl and prRef build browse links from the site URL', () => {
  assert.equal(jira.itemUrl('WEB-7'), 'https://acme.atlassian.net/browse/WEB-7');
  assert.equal(jira.prRef('WEB-7'), 'Jira: https://acme.atlassian.net/browse/WEB-7');
});

test('blockersFromIssue reads "is blocked by" issue links', () => {
  const issue = { fields: { issuelinks: [
    { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'WEB-2' } },
    { type: { inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'WEB-9' } }, // ignored
    { type: { inward: 'blocks', outward: 'is blocked by' }, outwardIssue: { key: 'WEB-3' } }, // we block it: ignored
  ] } };
  assert.deepEqual(blockersFromIssue(issue, 'WEB-1'), ['WEB-2']);
});

test('blockersFromIssue falls back to prose in description/summary', () => {
  const issue = { fields: { summary: 'Add preferences (depends on WEB-5)', description: { content: [{ type: 'text', text: 'Blocked by WEB-4.' }] } } };
  assert.deepEqual(blockersFromIssue(issue, 'WEB-1').sort(), ['WEB-4', 'WEB-5']);
});

test('blockersFromIssue dedupes and drops a self-reference', () => {
  const issue = { fields: {
    issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'WEB-2' } }],
    summary: 'blocked by WEB-2 and after WEB-1', // WEB-2 dup, WEB-1 is self
  } };
  assert.deepEqual(blockersFromIssue(issue, 'WEB-1'), ['WEB-2']);
});

test('blockersFromIssue returns [] when there are no dependencies', () => {
  assert.deepEqual(blockersFromIssue({ fields: { summary: 'standalone', issuelinks: [] } }, 'WEB-1'), []);
});

test('getBlockers fetches issue links/description and returns blocker keys', async () => {
  stub((url) => {
    assert.ok(/\/issue\/WEB-1\?fields=issuelinks,description,summary$/.test(url));
    return { body: { fields: { issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'WEB-2' } }] } } };
  });
  assert.deepEqual(await jira.getBlockers('WEB-1'), ['WEB-2']);
});
