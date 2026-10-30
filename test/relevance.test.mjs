import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnrelated } from '../lib/relevance.mjs';

test('parseUnrelated pulls the file list', () => {
  assert.deepEqual(parseUnrelated('{"unrelated": ["db/structure.sql", "yarn.lock"]}'), ['db/structure.sql', 'yarn.lock']);
});

test('parseUnrelated returns [] when everything belongs', () => {
  assert.deepEqual(parseUnrelated('Everything belongs.\n{"unrelated": []}'), []);
});

test('parseUnrelated returns [] on no verdict or bad JSON', () => {
  assert.deepEqual(parseUnrelated('no json'), []);
  assert.deepEqual(parseUnrelated('{"unrelated": ['), []);
});

test('parseUnrelated ignores non-string entries', () => {
  assert.deepEqual(parseUnrelated('{"unrelated": ["a.rb", 5, null, "b.rb"]}'), ['a.rb', 'b.rb']);
});

test('parseUnrelated defaults to [] when key missing', () => {
  assert.deepEqual(parseUnrelated('{"other": 1}'), []);
});
