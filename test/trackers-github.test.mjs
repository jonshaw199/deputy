import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import github, { blockersFromBody } from '../lib/trackers/github-issues.mjs';

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
  process.env.DEPUTY_GITHUB_REPO = 'acme/app';
  process.env.DEPUTY_GITHUB_TOKEN = 'ghtok';
  for (const k of ['DEPUTY_LABEL', 'DEPUTY_GITHUB_LABEL_STARTED', 'DEPUTY_GITHUB_LABEL_DONE']) delete process.env[k];
});
afterEach(() => { global.fetch = origFetch; });

test('listReady filters out PRs and maps issues to {id,title}, with auth + label', async () => {
  stub((url) => {
    assert.match(url, /\/repos\/acme\/app\/issues\?/);
    assert.match(url, /labels=ai-ready/);
    return { body: [{ number: 5, title: 'Bug' }, { number: 6, title: 'A PR', pull_request: {} }] };
  });
  assert.deepEqual(await github.listReady(), [{ id: '5', title: 'Bug' }]);
  assert.equal(calls[0].headers.Authorization, 'Bearer ghtok');
});

test('listReady throws when GitHub returns a non-array (error) payload', async () => {
  stub(() => ({ body: { message: 'Bad credentials' } }));
  await assert.rejects(() => github.listReady(), /Bad credentials/);
});

test('getItem returns issue plus comment bodies', async () => {
  stub((url) => {
    if (/\/issues\/5\/comments$/.test(url)) return { body: [{ body: 'c1' }, { body: 'c2' }] };
    if (/\/issues\/5$/.test(url)) return { body: { title: 'Bug', body: 'desc' } };
  });
  assert.deepEqual(JSON.parse(await github.getItem('5')), {
    id: '5', title: 'Bug', body: 'desc', comments: ['c1', 'c2'],
  });
});

test('getItem tolerates a non-array comments response', async () => {
  stub((url) => {
    if (/\/comments$/.test(url)) return { body: { message: 'nope' } };
    return { body: { title: 'Bug', body: 'desc' } };
  });
  assert.deepEqual(JSON.parse(await github.getItem('5')).comments, []);
});

test('getItem throws when the issue fetch fails', async () => {
  stub((url) => (/\/issues\/9$/.test(url) ? { ok: false, status: 404, body: 'not found' } : {}));
  await assert.rejects(() => github.getItem('9'), /Get issue 9 failed: 404/);
});

test('markStarted swaps the ready label for the in-progress label', async () => {
  stub(() => ({ ok: true, body: {} }));
  await github.markStarted('5');
  const del = calls.find((c) => c.method === 'DELETE');
  assert.match(del.url, /\/issues\/5\/labels\/ai-ready$/);
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { labels: ['ai-in-progress'] });
});

test('markDone swaps in-progress for the in-review label', async () => {
  stub(() => ({ ok: true, body: {} }));
  await github.markDone('5');
  assert.match(calls.find((c) => c.method === 'DELETE').url, /\/labels\/ai-in-progress$/);
  assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'POST').body), { labels: ['ai-in-review'] });
});

test('itemUrl and prRef', () => {
  assert.equal(github.itemUrl('5'), 'https://github.com/acme/app/issues/5');
  assert.equal(github.prRef('5'), 'Closes #5');
});

test('blockersFromBody parses "blocked by"/"depends on" issue refs and drops self', () => {
  assert.deepEqual(blockersFromBody('Blocked by #12 and depends on #13', '5').sort(), ['12', '13']);
  assert.deepEqual(blockersFromBody('after #5 only', '5'), []); // self-reference dropped
  assert.deepEqual(blockersFromBody('no deps here', '5'), []);
});

test('getBlockers reads the issue body for dependencies', async () => {
  stub((url) => {
    assert.match(url, /\/issues\/5$/);
    return { body: { title: 'Child', body: 'blocked by #4' } };
  });
  assert.deepEqual(await github.getBlockers('5'), ['4']);
});
