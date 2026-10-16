#!/usr/bin/env node
// Control + status API and static host for the dashboard. This is the shared
// "brain": the web UI talks to it over HTTP, and a future menu bar widget can
// hit the exact same endpoints. It reads daemon state from /tmp (read-only) and
// shells out to bin/daemon for start/stop.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SERVER_DIR, '..');
const PUBLIC_DIR = join(SERVER_DIR, 'public');
const DAEMON_BIN = join(PROJECT_ROOT, 'bin', 'daemon');

export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// A readable one-liner for the card preview. Prefer the agent's last actual
// narration ([ASSISTANT]) or your last message ([YOU]); if the tail is mid-tool
// (raw code, diffs, command output), humanize the current tool instead of dumping it.
const humanizeTool = (t) => {
  if (/get_item/.test(t)) return 'reading the ticket';
  if (/ask_user/.test(t)) return 'asking you a question';
  if (/finish|markDone/i.test(t)) return 'wrapping up';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)/.test(t)) return 'editing files';
  if (/^(Read|Grep|Glob|LS)/.test(t)) return 'exploring the code';
  if (/^Bash/.test(t)) return 'running a command';
  return 'working…';
};
export const lastMeaningful = (text) => {
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^\[ASSISTANT\]/.test(l)) return l.replace(/^\[ASSISTANT\]\s*/, '');
    if (/^\[YOU\]/.test(l)) return l.replace(/^\[YOU\]\s*/, 'you: ');
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^━+\s*\[([^\]]+)\]/);
    if (m) return humanizeTool(m[1]);
  }
  return '';
};
export const prUrlIn = (text) => { const m = text.match(/https:\/\/github\.com\/[^\s"']+\/pull\/\d+/g); return m ? m[m.length - 1] : null; };
export const itemUrlIn = (text) => { const m = text.match(/ITEM_URL: (\S+)/g); return m ? m[m.length - 1].replace('ITEM_URL: ', '') : null; };

// Build the HTTP server with its config injected, so tests can point it at a
// temp state dir / repo allowlist instead of the real /tmp. Nothing listens
// until the caller calls .listen().
export function makeServer(opts = {}) {
  const fileEnv = opts.fileEnv ?? parseEnvFile(join(PROJECT_ROOT, '.env'));
  const cfg = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

  const TMP = opts.tmp ?? cfg('DEPUTY_TMP', '/tmp');
  const PORT = opts.port ?? Number(cfg('DEPUTY_DASHBOARD_PORT', '4319'));
  const SITE_URL = opts.siteUrl ?? cfg('DEPUTY_SITE_URL', '');
  const REPOS = opts.repos ?? (cfg('DEPUTY_REPOS', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const daemonBin = opts.daemonBin ?? DAEMON_BIN;

  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const tail = (path, n = 4000) => { try { const t = readFileSync(path, 'utf8'); return t.length > n ? t.slice(-n) : t; } catch { return ''; } };

  function listDaemons() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-(.+)\.pid$/))
      .filter(Boolean)
      .map((m) => {
        const project = m[1];
        const pid = Number(tail(join(TMP, `deputy-${project}.pid`)).trim());
        const log = tail(join(TMP, `deputy-${project}.log`), 20000);
        const repoDir = tail(join(TMP, `deputy-${project}.meta`)).trim() || null;
        const recent = [...log.matchAll(/\[(.+?)\]\s+(SUCCESS|FAILED|TIMEOUT):\s+(\S+)/g)]
          .slice(-12).reverse()
          .map((r) => ({ ts: r[1], outcome: r[2], ticket: r[3], pr: prUrlIn(tail(join(TMP, `deputy-item-${r[3]}.log`))) }));
        return { project, pid, running: isAlive(pid), repoDir, interval: Number(cfg('DEPUTY_CHECK_INTERVAL', '300')), recent };
      });
  }

  function listActive() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-item-(.+)\.lock$/))
      .filter((m) => m && !m[1].startsWith('daemon-'))
      .map((m) => {
        const raw = m[1];
        const ticket = raw.replace(/-cont-.*$/, ''); // a continuation job folds into its base ticket
        const logPath = join(TMP, `deputy-item-${raw}.log`);
        const log = tail(logPath);
        const full = tail(logPath, Infinity); // ITEM_URL/PR are written once near the top
        const project = tail(join(TMP, `deputy-item-${raw}.meta`)).trim() || null;
        return { ticket, project, phase: lastMeaningful(log), pr: prUrlIn(full), item: itemUrlIn(full), needsInput: false };
      });
  }

  // Cases parked by the agent (ask_user): a question on file, no live process; a reply resumes them.
  function listPaused() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-ask-(.+)\.txt$/))
      .filter(Boolean)
      .map((m) => {
        const ticket = m[1];
        const question = tail(join(TMP, `deputy-ask-${ticket}.txt`)).trim();
        const full = tail(join(TMP, `deputy-item-${ticket}.log`), Infinity);
        const project = tail(join(TMP, `deputy-paused-${ticket}.meta`)).trim()
          || tail(join(TMP, `deputy-item-${ticket}.meta`)).trim() || null;
        return { ticket, project, phase: question, question, pr: prUrlIn(full), item: itemUrlIn(full), needsInput: true };
      });
  }
  // Cases waiting on a dependency (a sibling ticket's PR): no live process, no PR yet.
  // The daemon re-checks them each poll and starts them (stacked) once the parent has a branch.
  function listBlocked() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-blocked-(.+)\.meta$/))
      .filter(Boolean)
      .map((m) => {
        const ticket = m[1];
        const reason = tail(join(TMP, `deputy-blocked-${ticket}.txt`)).trim() || 'waiting on a dependency';
        const log = tail(join(TMP, `deputy-item-${ticket}.log`));
        const project = tail(join(TMP, `deputy-blocked-${ticket}.meta`)).trim() || null;
        return { ticket, project, state: 'blocked', phase: reason, item: itemUrlIn(log) };
      });
  }
  // Cases that ended without producing a PR (push failed, timed out, agent errored). The
  // worktree is kept; the case stays visible with the error until dismissed or restarted.
  function listFailed() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-failed-(.+)\.meta$/))
      .filter(Boolean)
      .map((m) => {
        const ticket = m[1];
        const reason = tail(join(TMP, `deputy-failed-${ticket}.txt`)).trim() || 'the run failed';
        const log = tail(join(TMP, `deputy-item-${ticket}.log`), Infinity);
        const project = tail(join(TMP, `deputy-failed-${ticket}.meta`)).trim() || null;
        return { ticket, project, state: 'failed', phase: reason, item: itemUrlIn(log), pr: prUrlIn(log) };
      });
  }
  // Cases the user stopped (✕) but kept — re-runnable with ▶. Shown as muted "stopped" cards.
  function listStopped() {
    return readdirSync(TMP)
      .map((f) => f.match(/^deputy-stopped-(.+)\.meta$/))
      .filter(Boolean)
      .map((m) => {
        const ticket = m[1];
        const log = tail(join(TMP, `deputy-item-${ticket}.log`), Infinity);
        const project = tail(join(TMP, `deputy-stopped-${ticket}.meta`)).trim() || null;
        return { ticket, project, state: 'stopped', phase: 'stopped by you', item: itemUrlIn(log), pr: prUrlIn(log) };
      });
  }
  // Open PRs + unresolved review comments the daemon published (deputy never replies).
  const readPrs = (project) => {
    try { return JSON.parse(readFileSync(join(TMP, `deputy-prs-${project}.json`), 'utf8')); } catch { return []; }
  };
  // Full-auto marker: this ticket never parks to ask, and auto-handles review comments.
  const isAuto = (ticket) => existsSync(join(TMP, `deputy-auto-${ticket}`));
  // Dismissed in-review case: hidden until a review comment not in the snapshot shows up.
  const isDismissed = (ticket, comments) => {
    try {
      const snap = new Set(JSON.parse(readFileSync(join(TMP, `deputy-hidden-${ticket}`), 'utf8')).urls || []);
      return (comments || []).every((c) => snap.has(c.url));
    } catch { return false; }
  };
  const liveOrPaused = () => {
    const paused = listPaused();
    const pausedIds = new Set(paused.map((p) => p.ticket));
    return [...listActive().filter((a) => !pausedIds.has(a.ticket)), ...paused];
  };

  // Fold live agents and open PRs into one case per ticket. A ticket with a live
  // agent is working / needs-input (and keeps its PR + comments if it has one); a
  // ticket with only an open PR is in-review. Live cases first, then in-review.
  function mergeCases(live, prs, blocked, failed, stopped, project) {
    const byTicket = new Map();
    for (const a of live) byTicket.set(a.ticket, { ...a, state: a.needsInput ? 'needs-input' : 'working' });
    for (const b of blocked) if (!byTicket.has(b.ticket)) byTicket.set(b.ticket, b);
    for (const f of failed) if (!byTicket.has(f.ticket)) byTicket.set(f.ticket, f);
    for (const s of stopped) if (!byTicket.has(s.ticket)) byTicket.set(s.ticket, s);
    for (const p of prs) {
      const key = p.ticket || `PR-${p.number}`;
      const ex = byTicket.get(p.ticket);
      if (ex) { ex.pr = p.url; ex.branch = p.branch; ex.comments = p.comments; ex.prNumber = p.number; if (!ex.item) ex.item = p.item; }
      else byTicket.set(key, { ticket: key, project, state: 'in-review', title: p.title, pr: p.url, branch: p.branch, prNumber: p.number, comments: p.comments, item: p.item });
    }
    return [...byTicket.values()]
      .filter((c) => !(c.state === 'in-review' && isDismissed(c.ticket, c.comments)))
      .map((c) => ({ ...c, auto: isAuto(c.ticket) }));
  }

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

  const readBody = (req) =>
    new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
  const runDaemon = (cwd, ...args) =>
    new Promise((resolve) => execFile(daemonBin, args, { cwd }, (err, stdout, stderr) => resolve({ ok: !err, output: (stdout || '') + (stderr || '') })));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === '/api/status') {
      const daemons = listDaemons();
      const live = liveOrPaused();
      const blocked = listBlocked();
      const failed = listFailed();
      const stopped = listStopped();
      // One case per ticket: a live agent (working / needs-input), a dependency-blocked
      // case, a failed or stopped run, and its open PR (in-review) all merge here.
      for (const d of daemons) d.cases = mergeCases(live.filter((a) => a.project === d.project), readPrs(d.project), blocked.filter((b) => b.project === d.project), failed.filter((f) => f.project === d.project), stopped.filter((s) => s.project === d.project), d.project);
      const orphans = live.filter((a) => !daemons.some((d) => d.project === a.project))
        .map((a) => ({ ...a, state: a.needsInput ? 'needs-input' : 'working', auto: isAuto(a.ticket) }));
      return json(res, 200, { daemons, orphans, repos: REPOS, siteUrl: SITE_URL });
    }
    if (path === '/api/log') {
      const ticket = url.searchParams.get('ticket');
      const project = url.searchParams.get('daemon');
      const file = ticket ? `deputy-item-${ticket}.log` : project ? `deputy-${project}.log` : null;
      if (!file) return json(res, 400, { error: 'ticket or daemon required' });
      return json(res, 200, { text: tail(join(TMP, file), 20000) });
    }
    if (path === '/api/stop' && req.method === 'POST') {
      const { project } = await readBody(req);
      const d = listDaemons().find((x) => x.project === project);
      if (!d?.repoDir) return json(res, 400, { error: 'unknown daemon or missing repo dir' });
      return json(res, 200, await runDaemon(d.repoDir, 'stop'));
    }
    if (path === '/api/start' && req.method === 'POST') {
      const { repo } = await readBody(req);
      if (!REPOS.includes(repo)) return json(res, 400, { error: 'repo not in DEPUTY_REPOS allowlist' });
      return json(res, 200, await runDaemon(repo, 'start'));
    }
    if (path === '/api/continue' && req.method === 'POST') {
      const { project, ticket, prompt, branch } = await readBody(req);
      if (!listDaemons().some((d) => d.project === project)) return json(res, 400, { error: 'unknown daemon' });
      if (!ticket || !prompt) return json(res, 400, { error: 'ticket and prompt required' });
      const line = JSON.stringify({ ticket, prompt, branch, id: `web-${ticket}-${Date.now()}` });
      appendFileSync(join(TMP, `deputy-queue-${project}.jsonl`), line + '\n');
      // Nudge the daemon to drain the queue now instead of waiting for the poll.
      try { process.kill(Number(tail(join(TMP, `deputy-${project}.pid`)).trim()), 'SIGUSR1'); } catch {}
      return json(res, 200, { ok: true });
    }
    if (path === '/api/stop-case' && req.method === 'POST') {
      // Call off one in-flight case (runs `daemon stop-ticket <ticket>` in its repo).
      const { ticket } = await readBody(req);
      if (!ticket) return json(res, 400, { error: 'ticket required' });
      const c = listActive().find((a) => a.ticket === ticket);
      const daemons = listDaemons();
      const cwd = (daemons.find((d) => d.project === c?.project) || daemons.find((d) => d.repoDir))?.repoDir;
      if (!cwd) return json(res, 400, { error: 'no repo for that case' });
      return json(res, 200, await runDaemon(cwd, 'stop-ticket', ticket));
    }
    if ((path === '/api/rerun' || path === '/api/forget') && req.method === 'POST') {
      // ▶ re-run a stopped/failed case, or forget it entirely. Both shell to the daemon.
      const { ticket, project } = await readBody(req);
      if (!ticket) return json(res, 400, { error: 'ticket required' });
      const daemons = listDaemons();
      const cwd = (daemons.find((d) => d.project === project) || daemons.find((d) => d.repoDir))?.repoDir;
      if (!cwd) return json(res, 400, { error: 'no repo for that case' });
      return json(res, 200, await runDaemon(cwd, path === '/api/rerun' ? 'rerun' : 'forget-ticket', ticket));
    }
    if (path === '/api/dismiss' && req.method === 'POST') {
      // Hide a finished in-review case; it reappears only if a new (non-snapshot) comment lands.
      const { ticket, commentUrls } = await readBody(req);
      if (!ticket) return json(res, 400, { error: 'ticket required' });
      writeFileSync(join(TMP, `deputy-hidden-${ticket}`), JSON.stringify({ urls: commentUrls || [] }));
      return json(res, 200, { ok: true });
    }
    if (path === '/api/auto' && req.method === 'POST') {
      // Toggle full-auto for a ticket: the agent decides for itself instead of parking to ask.
      const { ticket, on } = await readBody(req);
      if (!ticket) return json(res, 400, { error: 'ticket required' });
      const marker = join(TMP, `deputy-auto-${ticket}`);
      if (on) writeFileSync(marker, '1');
      else try { unlinkSync(marker); } catch {}
      return json(res, 200, { ok: true, auto: !!on });
    }
    if (path === '/api/say' && req.method === 'POST') {
      // One box: stream to a live agent, or resume a parked one (queue + SIGUSR1 nudge).
      const { ticket, message } = await readBody(req);
      if (!ticket || !message) return json(res, 400, { error: 'ticket and message required' });
      // Parked state is authoritative: a parked case resumes even if a stale lock lingers.
      const paused = listPaused().find((a) => a.ticket === ticket);
      if (paused?.project) {
        const line = JSON.stringify({ ticket, prompt: message, kind: 'resume', id: `web-${ticket}-${Date.now()}` });
        appendFileSync(join(TMP, `deputy-queue-${paused.project}.jsonl`), line + '\n');
        try { process.kill(Number(tail(join(TMP, `deputy-${paused.project}.pid`)).trim()), 'SIGUSR1'); } catch {}
        return json(res, 200, { ok: true, resumed: true });
      }
      if (listActive().some((a) => a.ticket === ticket)) {
        appendFileSync(join(TMP, `deputy-input-${ticket}.jsonl`), message + '\n');
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: 'no live or parked agent for that ticket' });
    }

    // Static
    const file = path === '/' ? 'index.html' : path.slice(1);
    const full = join(PUBLIC_DIR, file);
    if (full.startsWith(PUBLIC_DIR) && existsSync(full)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    res.writeHead(404); res.end('Not found');
  });

  server.deputyPort = PORT;
  return server;
}

// Run directly (`node server/server.mjs`) → start listening. Imported (tests) → don't.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = makeServer();
  server.listen(server.deputyPort, () => console.log(`Deputy dashboard: http://localhost:${server.deputyPort}`));
}
