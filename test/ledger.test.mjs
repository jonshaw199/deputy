import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { parseLedger, dedupeRows, groupByTicket, siblingsFor, recordSlice, dropSlice } from '../lib/ledger.mjs';

const row = (ticket, project, extra = {}) => ({
  ticket, project, repo: `acme/${project}`, prNumber: '1', prUrl: `https://x/${project}/1`,
  headSha: 'abc', baseRef: 'main', ts: '2026-01-01T00:00:00Z', ...extra,
});
const line = (r) => ['ticket', 'project', 'repo', 'prNumber', 'prUrl', 'headSha', 'baseRef', 'ts'].map((f) => r[f]).join('\t');

test('parseLedger reads full rows and skips blank/short lines', () => {
  const text = [line(row('WEB-1', 'api')), '', '  ', 'too\tfew\tcols', line(row('WEB-1', 'web'))].join('\n');
  const rows = parseLedger(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.project), ['api', 'web']);
  assert.equal(rows[0].repo, 'acme/api');
});

test('dedupeRows keeps the latest row per ticket+project', () => {
  const rows = parseLedger([
    line(row('WEB-1', 'api', { headSha: 'old' })),
    line(row('WEB-1', 'api', { headSha: 'new' })),
    line(row('WEB-1', 'web')),
  ].join('\n'));
  const d = dedupeRows(rows);
  assert.equal(d.length, 2);
  assert.equal(d.find((r) => r.project === 'api').headSha, 'new');
});

test('groupByTicket buckets slices per ticket', () => {
  const rows = parseLedger([line(row('WEB-1', 'api')), line(row('WEB-1', 'web')), line(row('WEB-2', 'api'))].join('\n'));
  const g = groupByTicket(rows);
  assert.deepEqual(Object.keys(g).sort(), ['WEB-1', 'WEB-2']);
  assert.equal(g['WEB-1'].length, 2);
  assert.equal(g['WEB-2'].length, 1);
});

test('siblingsFor returns only OTHER projects for the ticket', () => {
  const rows = parseLedger([line(row('WEB-1', 'api')), line(row('WEB-1', 'web')), line(row('WEB-2', 'web'))].join('\n'));
  const sib = siblingsFor(rows, 'WEB-1', 'api');
  assert.equal(sib.length, 1);
  assert.equal(sib[0].project, 'web');
});

test('recordSlice appends, then replaces same ticket+project in place', () => {
  const file = join(tmpdir(), `ledger-test-${process.pid}.tsv`);
  if (existsSync(file)) rmSync(file);
  recordSlice(file, row('WEB-1', 'api', { headSha: 'a1' }));
  recordSlice(file, row('WEB-1', 'web'));
  recordSlice(file, row('WEB-1', 'api', { headSha: 'a2' }));   // resume: replaces, not duplicates
  const rows = parseLedger(readFileSync(file, 'utf8'));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.project === 'api').headSha, 'a2');
  rmSync(file);
});

test('dropSlice removes one ticket+project, leaves the rest', () => {
  const file = join(tmpdir(), `ledger-drop-${process.pid}.tsv`);
  if (existsSync(file)) rmSync(file);
  recordSlice(file, row('WEB-1', 'api'));
  recordSlice(file, row('WEB-1', 'web'));
  dropSlice(file, 'WEB-1', 'api');
  const rows = parseLedger(readFileSync(file, 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, 'web');
  dropSlice(file, 'WEB-1', 'web');   // dropping the last row leaves an empty (not malformed) file
  assert.equal(parseLedger(readFileSync(file, 'utf8')).length, 0);
  rmSync(file);
});
