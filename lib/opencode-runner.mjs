#!/usr/bin/env node
// Reference runner that drives `opencode` instead of the bundled Claude Agent SDK, to show
// Deputy isn't tied to one agent. Implements the runner protocol (CONTRIBUTING → "Swapping the
// agent"): reads DEPUTY_PROMPT (task) and runs in the worktree (cwd); resumes DEPUTY_RESUME;
// tails DEPUTY_INPUT for live follow-ups; streams to stdout and writes the session id to
// DEPUTY_SESSION_FILE. Point DEPUTY_AGENT_CMD at it: `node /path/to/lib/opencode-runner.mjs`.
//
// opencode specifics (see its docs): `opencode run "<prompt>" --format json` is one-shot and
// hangs unless stdin is closed; every JSON event carries the `ses_…` sessionID; follow-ups
// resume with `opencode run -s <id>`. True mid-run streaming and park-and-ask need `opencode
// serve` (its HTTP API) and are out of scope here — a follow-up is a sequential warm resume.
// Tracker access: register Deputy's tracker as an MCP server in opencode.json, or rely on the
// item details the daemon puts in DEPUTY_PROMPT.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROMPT = process.env.DEPUTY_PROMPT || '';
const SESSION_FILE = process.env.DEPUTY_SESSION_FILE || '';
const INPUT_FILE = process.env.DEPUTY_INPUT || '';
const IDLE_MS = Number(process.env.DEPUTY_IDLE_MS || 900000);
const OPENCODE = process.env.DEPUTY_OPENCODE_BIN || 'opencode';
const MODEL = process.env.DEPUTY_OPENCODE_MODEL || '';

let sessionId = process.env.DEPUTY_RESUME || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter((l) => l.length); } catch { return []; } };

function persistSession(id) {
  if (!id || id === sessionId) return;
  sessionId = id;
  if (SESSION_FILE) { try { writeFileSync(SESSION_FILE, id); } catch {} }
}

// Run one opencode turn (fresh, or resumed when we already have a session), streaming readable
// text to stdout. Resolves with the exit code when the turn finishes.
function runTurn(message) {
  return new Promise((resolve) => {
    const args = ['run'];
    if (sessionId) args.push('-s', sessionId);
    if (MODEL) args.push('-m', MODEL);
    args.push('--format', 'json', message);
    const child = spawn(OPENCODE, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { console.log(line); continue; }
        persistSession(ev.sessionID || ev.sessionId || ev.session_id);
        const text = ev.text ?? ev.part?.text ?? ev.message ?? '';
        if (text) console.log(text);
        else if (ev.type) console.log(`[opencode:${ev.type}]`);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => { console.error(`[RUNNER] opencode failed to start: ${e.message}`); resolve(1); });
    child.on('close', (code) => { if (buf.trim()) console.log(buf.trim()); resolve(code ?? 0); });
  });
}

(async () => {
  console.log(`[RUNNER] opencode runner — ${sessionId ? `resuming ${sessionId}` : 'fresh run'} in ${process.cwd()}`);
  await runTurn(PROMPT);
  if (!INPUT_FILE) return; // one-shot: no live follow-ups

  console.log(`[RUNNER] Live mode: watching ${INPUT_FILE} for follow-ups (idle close ${IDLE_MS}ms)`);
  let processed = readLines(INPUT_FILE).length; // the daemon truncates this at start
  let lastTurnAt = Date.now();
  while (true) {
    const lines = readLines(INPUT_FILE);
    const fresh = lines.slice(processed);
    processed = lines.length;
    if (!fresh.length) {
      if (Date.now() - lastTurnAt > IDLE_MS) return;
      await sleep(400);
      continue;
    }
    for (const line of fresh) {
      if (line.trim() === '__exit__') return;
      if (!line.trim()) continue;
      console.log(`\n[YOU] ${line}\n`);
      await runTurn(line);
      lastTurnAt = Date.now();
    }
  }
})();
