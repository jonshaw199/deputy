import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTracker } from '../lib/trackers/index.mjs';

beforeEach(() => { delete process.env.DEPUTY_TRACKER; });

test('defaults to the jira tracker', () => {
  assert.equal(getTracker().name, 'jira');
});

test('selects github when DEPUTY_TRACKER=github', () => {
  process.env.DEPUTY_TRACKER = 'github';
  assert.equal(getTracker().name, 'github');
});

test('is case-insensitive', () => {
  process.env.DEPUTY_TRACKER = 'GitHub';
  assert.equal(getTracker().name, 'github');
});

test('throws on an unknown tracker, listing the available ones', () => {
  process.env.DEPUTY_TRACKER = 'linear';
  assert.throws(() => getTracker(), /Unknown tracker "linear".*jira, github/s);
});

test('every registered tracker implements the full contract', () => {
  const required = ['name', 'listReady', 'getItem', 'markStarted', 'markDone', 'itemUrl', 'prRef'];
  for (const name of ['jira', 'github']) {
    process.env.DEPUTY_TRACKER = name;
    const t = getTracker();
    for (const method of required) assert.ok(t[method] != null, `${name} is missing ${method}`);
  }
});
