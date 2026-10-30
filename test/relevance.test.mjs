import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrop } from '../lib/relevance.mjs';

const CANDIDATES = ['db/structure.sql', 'yarn.lock', 'app/models/task.rb'];

test('parseDrop pulls the drop list', () => {
  assert.deepEqual(parseDrop('{"drop": ["db/structure.sql", "yarn.lock"]}', CANDIDATES), ['db/structure.sql', 'yarn.lock']);
});

test('parseDrop returns [] when everything belongs', () => {
  assert.deepEqual(parseDrop('All belong.\n{"drop": []}', CANDIDATES), []);
});

test('parseDrop never drops a file that was not a candidate', () => {
  // judge hallucinates a path we never offered -> ignored
  assert.deepEqual(parseDrop('{"drop": ["db/structure.sql", "secret/.env"]}', CANDIDATES), ['db/structure.sql']);
});

test('parseDrop returns [] on no verdict or bad JSON', () => {
  assert.deepEqual(parseDrop('nope', CANDIDATES), []);
  assert.deepEqual(parseDrop('{"drop": [', CANDIDATES), []);
});

test('parseDrop ignores non-string entries', () => {
  assert.deepEqual(parseDrop('{"drop": ["yarn.lock", 7, null]}', CANDIDATES), ['yarn.lock']);
});
