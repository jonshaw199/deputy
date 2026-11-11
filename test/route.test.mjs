import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, exitCodeFor, reposFromBody, explicitVerdict } from '../lib/route.mjs';

test('reposFromBody parses an explicit Repos: line (case-insensitive, trimmed)', () => {
  assert.deepEqual(reposFromBody('Blah.\nRepos: tasks, icc_app\nmore'), ['tasks', 'icc_app']);
  assert.deepEqual(reposFromBody('repo:  Tasks '), ['tasks']);
  assert.deepEqual(reposFromBody('no directive here'), []);
});

test('explicitVerdict: this repo is in the multi-repo list -> mine + multi, high', () => {
  assert.deepEqual(explicitVerdict(['tasks', 'icc_app'], 'Ontra-ai/tasks', '/x/tasks'),
    { mine: true, multi: true, confidence: 'high', reason: 'explicit repos directive' });
});

test('explicitVerdict: sole repo in the list -> mine, not multi', () => {
  assert.equal(explicitVerdict(['tasks'], 'Ontra-ai/tasks', '/x/tasks').multi, false);
});

test('explicitVerdict: this repo not listed -> not mine (skip)', () => {
  assert.equal(explicitVerdict(['tasks', 'icc_app'], 'Ontra-ai/atlas', '/x/atlas').mine, false);
});

test('explicitVerdict: matches on the checkout dir name too', () => {
  assert.equal(explicitVerdict(['deputy-ct-consumer'], 'jonshaw199/other', '/x/deputy-ct-consumer').mine, true);
});

test('explicitVerdict: no list -> null (fall back to the AI router)', () => {
  assert.equal(explicitVerdict([], 'Ontra-ai/tasks', '/x/tasks'), null);
});

test('exitCodeFor maps the explicit verdict exactly like an AI one', () => {
  assert.equal(exitCodeFor(explicitVerdict(['tasks', 'icc_app'], 'o/tasks', '/x/tasks')), 10); // multi
  assert.equal(exitCodeFor(explicitVerdict(['tasks'], 'o/tasks', '/x/tasks')), 0);              // sole
  assert.equal(exitCodeFor(explicitVerdict(['tasks'], 'o/atlas', '/x/atlas')), 2);              // not mine
});

test('parseVerdict extracts the JSON verdict from surrounding chatter', () => {
  const text = 'Let me check the repo.\n\n{"mine": true, "multi": false, "confidence": "high", "reason": "shoryuken worker lives here"}\nDone.';
  assert.deepEqual(parseVerdict(text), { mine: true, multi: false, confidence: 'high', reason: 'shoryuken worker lives here' });
});

test('parseVerdict falls back to not-mine/low when there is no parseable verdict', () => {
  assert.deepEqual(parseVerdict('no json here'), { mine: false, multi: false, confidence: 'low', reason: 'unparseable' });
  assert.deepEqual(parseVerdict('{broken'), { mine: false, multi: false, confidence: 'low', reason: 'unparseable' });
});

test('exitCodeFor: confident sole owner -> 0 (claim normally)', () => {
  assert.equal(exitCodeFor({ mine: true, multi: false, confidence: 'high' }), 0);
});

test('exitCodeFor: confident multi-repo owner -> 10 (work slice, keep label)', () => {
  assert.equal(exitCodeFor({ mine: true, multi: true, confidence: 'high' }), 10);
});

test('exitCodeFor: not mine -> 2 (skip)', () => {
  assert.equal(exitCodeFor({ mine: false, multi: false, confidence: 'high' }), 2);
});

test('exitCodeFor: mine but low confidence -> 3 (leave for its real owner)', () => {
  assert.equal(exitCodeFor({ mine: true, multi: false, confidence: 'low' }), 3);
});

test('exitCodeFor: missing/garbage verdict -> 2 (never claim on nothing)', () => {
  assert.equal(exitCodeFor(null), 2);
  assert.equal(exitCodeFor({}), 2);
});
