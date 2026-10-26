import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, exitCodeFor } from '../lib/route.mjs';

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
