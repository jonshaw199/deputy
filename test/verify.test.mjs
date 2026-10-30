import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../lib/verify.mjs';

test('parseVerdict reads a done verdict with no gaps', () => {
  assert.deepEqual(parseVerdict('Looks complete.\n{"done": true, "gaps": []}'), { done: true, gaps: [] });
});

test('parseVerdict reads a not-done verdict and keeps the gaps', () => {
  const v = parseVerdict('{"done": false, "gaps": ["occurrence Task translator missing", "no PR opened"]}');
  assert.equal(v.done, false);
  assert.deepEqual(v.gaps, ['occurrence Task translator missing', 'no PR opened']);
});

test('parseVerdict treats a non-strict-true done as not done', () => {
  assert.deepEqual(parseVerdict('{"done": "yes", "gaps": []}'), { done: false, gaps: [] });
});

test('parseVerdict falls back to not-done when there is no verdict', () => {
  assert.equal(parseVerdict('no json here').done, false);
  assert.ok(parseVerdict('no json here').gaps.length >= 1);
});

test('parseVerdict falls back to not-done on malformed JSON', () => {
  const v = parseVerdict('{"done": true, "gaps": [');
  assert.equal(v.done, false);
  assert.ok(v.gaps.length >= 1);
});

test('parseVerdict defaults gaps to an array when missing', () => {
  assert.deepEqual(parseVerdict('{"done": false}'), { done: false, gaps: [] });
});
