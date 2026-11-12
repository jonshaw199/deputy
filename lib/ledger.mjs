#!/usr/bin/env node
// Shared multi-repo ledger: the one place separate repo Deputies can see each other. Each Deputy is
// otherwise an island (its runtime state is per-repo), so a ticket that spans repos is built by two
// blind runs that drift. When a Deputy finishes a slice of a `multi` ticket it records that slice here;
// because the ledger lives in the shared runtime dir, every Deputy on the box reads the same file. The
// contract check, the dashboard's multi-repo grouping, and sibling/orphan awareness all read from it.
//
// One tab-separated row per slice: ticket, project, repo, prNumber, prUrl, headSha, baseRef, isoTime.
// Re-recording the same ticket+project replaces the old row (a resumed slice reports a fresh sha).
//
//   node lib/ledger.mjs record <ticket> <project> <repo> <prNumber> <prUrl> <sha> <base>
//   node lib/ledger.mjs siblings <ticket> <project>   # TSV rows for the ticket in OTHER projects
//   node lib/ledger.mjs list                           # grouped JSON (for the dashboard)
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const FIELDS = ['ticket', 'project', 'repo', 'prNumber', 'prUrl', 'headSha', 'baseRef', 'ts'];

export function ledgerFile() {
  return process.env.DEPUTY_LEDGER_FILE || `${process.env.DEPUTY_TMP || '/var/tmp'}/deputy-multi-ledger.tsv`;
}

export function parseLedger(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split('\t');
      if (parts.length < FIELDS.length) return null;
      return Object.fromEntries(FIELDS.map((f, i) => [f, parts[i]]));
    })
    .filter(Boolean);
}

// Latest row per ticket+project wins (a resumed slice appends a newer row); order preserved by first-seen.
export function dedupeRows(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.ticket}\t${r.project}`, r);
  return [...byKey.values()];
}

export function groupByTicket(rows) {
  const out = {};
  for (const r of dedupeRows(rows)) (out[r.ticket] ||= []).push(r);
  return out;
}

export function siblingsFor(rows, ticket, project) {
  return dedupeRows(rows).filter((r) => r.ticket === ticket && r.project !== project);
}

function readRows(file) {
  return existsSync(file) ? parseLedger(readFileSync(file, 'utf8')) : [];
}

function writeRows(file, rows) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, rows.map((r) => FIELDS.map((f) => r[f]).join('\t')).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, file);
}

export function recordSlice(file, row) {
  const kept = readRows(file).filter((r) => !(r.ticket === row.ticket && r.project === row.project));
  const line = FIELDS.map((f) => String(row[f] ?? '').replace(/\t|\n/g, ' ')).join('\t');
  writeFileSync(`${file}.tmp`, [...kept.map((r) => FIELDS.map((f) => r[f]).join('\t')), line].join('\n') + '\n');
  renameSync(`${file}.tmp`, file);
}

// Drop one slice (ticket+project) once its PR merges/closes, so the ledger tracks only live work.
export function dropSlice(file, ticket, project) {
  if (!existsSync(file)) return;
  writeRows(file, readRows(file).filter((r) => !(r.ticket === ticket && r.project === project)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...a] = process.argv.slice(2);
  const file = ledgerFile();
  if (cmd === 'record') {
    const [ticket, project, repo, prNumber, prUrl, headSha, baseRef] = a;
    recordSlice(file, { ticket, project, repo, prNumber, prUrl, headSha, baseRef, ts: new Date().toISOString() });
    console.error(`[ledger] recorded ${ticket} @ ${project} (${prUrl})`);
  } else if (cmd === 'siblings') {
    const [ticket, project] = a;
    for (const r of siblingsFor(readRows(file), ticket, project)) console.log(FIELDS.map((f) => r[f]).join('\t'));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(groupByTicket(readRows(file))));
  } else if (cmd === 'drop') {
    const [ticket, project] = a;
    dropSlice(file, ticket, project);
    console.error(`[ledger] dropped ${ticket} @ ${project}`);
  } else {
    console.error('usage: ledger.mjs record|siblings|list ...');
    process.exit(2);
  }
}
