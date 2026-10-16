import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastMeaningful, prUrlIn, itemUrlIn, parseEnvFile } from '../server/server.mjs';

test('lastMeaningful returns the agent last words, stripping the [ASSISTANT] tag', () => {
  const log = '[RUNNER] started\n[ASSISTANT] Draft PR is up\n============\n[RESULT] success\n';
  assert.equal(lastMeaningful(log), 'Draft PR is up');
});

test('lastMeaningful rewrites a trailing [YOU] line to a "you:" prefix', () => {
  assert.equal(lastMeaningful('[ASSISTANT] on it\n[YOU] also fix the empty state\n'), 'you: also fix the empty state');
});

test('lastMeaningful skips separators, rules, bracketed status lines and ↳ noise', () => {
  const log = '[ASSISTANT] real line\n━━━━━━\n[STATUS] working\n[BLOCKED] nope\n↳ tool output\n====\n';
  assert.equal(lastMeaningful(log), 'real line');
});

test('lastMeaningful returns empty string when everything is noise', () => {
  assert.equal(lastMeaningful('====\n[RESULT] success\n↳ x\n'), '');
});

test('prUrlIn finds the last PR url and is null when absent', () => {
  assert.equal(prUrlIn('see https://github.com/acme/app/pull/1 and https://github.com/acme/app/pull/42'), 'https://github.com/acme/app/pull/42');
  assert.equal(prUrlIn('no links here'), null);
});

test('itemUrlIn extracts an ITEM_URL marker and is null when absent', () => {
  assert.equal(itemUrlIn('x\nITEM_URL: https://acme.atlassian.net/browse/WEB-1\n'), 'https://acme.atlassian.net/browse/WEB-1');
  assert.equal(itemUrlIn('nothing'), null);
});

test('parseEnvFile strips quotes, trims, and ignores comments/blanks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deputy-env-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, '.env');
  writeFileSync(f, '# a comment\n\nDEPUTY_LABEL = ai-ready \nDEPUTY_WORKTREE_SETUP="bundle install && yarn install"\nIGNORED lowercase=1\n');
  const env = parseEnvFile(f);
  assert.equal(env.DEPUTY_LABEL, 'ai-ready');
  assert.equal(env.DEPUTY_WORKTREE_SETUP, 'bundle install && yarn install');
  assert.equal(env.IGNORED, undefined);
});

test('parseEnvFile returns {} for a missing file', () => {
  assert.deepEqual(parseEnvFile('/no/such/.env'), {});
});
