import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, gapsForProject } from '../lib/contract.mjs';

test('parseVerdict reads agree + typed gaps', () => {
  const v = parseVerdict('Looked at both.\n{"agree": false, "gaps": [{"project":"api","gap":"sends Task, web expects task"}]}');
  assert.equal(v.agree, false);
  assert.equal(v.gaps.length, 1);
  assert.equal(v.gaps[0].project, 'api');
});

test('parseVerdict returns agree=true with no gaps', () => {
  const v = parseVerdict('{"agree": true, "gaps": []}');
  assert.equal(v.agree, true);
  assert.deepEqual(v.gaps, []);
});

test('parseVerdict drops malformed gap entries', () => {
  const v = parseVerdict('{"agree": false, "gaps": [{"project":"api","gap":"x"}, {"project":"web"}, "nope", 7]}');
  assert.equal(v.gaps.length, 1);
  assert.equal(v.gaps[0].project, 'api');
});

test('parseVerdict treats no verdict / bad JSON as not-agree', () => {
  assert.equal(parseVerdict('nothing here').agree, false);
  assert.equal(parseVerdict('{"agree": fal').agree, false);
});

test('gapsForProject filters to one project', () => {
  const v = { agree: false, gaps: [{ project: 'api', gap: 'a' }, { project: 'web', gap: 'b' }, { project: 'api', gap: 'c' }] };
  assert.deepEqual(gapsForProject(v, 'api'), ['a', 'c']);
  assert.deepEqual(gapsForProject(v, 'web'), ['b']);
});
