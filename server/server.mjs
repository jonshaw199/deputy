#!/usr/bin/env node
// Control + status API and static host for the dashboard. This is the shared
// "brain": the web UI talks to it over HTTP, and a future menu bar widget can
// hit the exact same endpoints. It reads daemon state from /tmp (read-only) and
// shells out to bin/daemon for start/stop.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SERVER_DIR, '..');
const PUBLIC_DIR = join(SERVER_DIR, 'public');
const DAEMON_BIN = join(PROJECT_ROOT, 'bin', 'daemon');
const TMP = '/tmp';

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
const fileEnv = parseEnvFile(join(PROJECT_ROOT, '.env'));
const cfg = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const PORT = Number(cfg('JIRA_AUTOMATION_DASHBOARD_PORT', '4319'));
const SITE_URL = cfg('JIRA_AUTOMATION_SITE_URL', '');
const REPOS = (cfg('JIRA_AUTOMATION_REPOS', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tail = (path, n = 4000) => { try { const t = readFileSync(path, 'utf8'); return t.length > n ? t.slice(-n) : t; } catch { return ''; } };
const lastMeaningful = (text) => { const lines = text.split('\n').map((l) => l.trim()).filter(Boolean); return lines[lines.length - 1] || ''; };
const prUrlIn = (text) => { const m = text.match(/https:\/\/github\.com\/[^\s"']+\/pull\/\d+/g); return m ? m[m.length - 1] : null; };
const itemUrlIn = (text) => { const m = text.match(/ITEM_URL: (\S+)/g); return m ? m[m.length - 1].replace('ITEM_URL: ', '') : null; };

function listDaemons() {
  return readdirSync(TMP)
    .map((f) => f.match(/^jira-automation-daemon-(.+)\.pid$/))
    .filter(Boolean)
    .map((m) => {
      const project = m[1];
      const pid = Number(tail(join(TMP, `jira-automation-daemon-${project}.pid`)).trim());
      const log = tail(join(TMP, `jira-automation-daemon-${project}.log`), 20000);
      const repoDir = tail(join(TMP, `jira-automation-daemon-${project}.meta`)).trim() || null;
      const recent = [...log.matchAll(/\[(.+?)\]\s+(SUCCESS|FAILED|TIMEOUT):\s+(\S+)/g)]
        .slice(-12).reverse()
        .map((r) => ({ ts: r[1], outcome: r[2], ticket: r[3], pr: prUrlIn(tail(join(TMP, `jira-automation-${r[3]}.log`))) }));
      return { project, pid, running: isAlive(pid), repoDir, interval: Number(cfg('JIRA_AUTOMATION_CHECK_INTERVAL', '300')), recent };
    });
}

function listActive() {
  return readdirSync(TMP)
    .map((f) => f.match(/^jira-automation-(.+)\.lock$/))
    .filter((m) => m && !m[1].startsWith('daemon-'))
    .map((m) => {
      const ticket = m[1];
      const log = tail(join(TMP, `jira-automation-${ticket}.log`));
      return { ticket, phase: lastMeaningful(log), pr: prUrlIn(log), item: itemUrlIn(log) };
    });
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}
function runDaemon(cwd, action) {
  return new Promise((resolve) => execFile(DAEMON_BIN, [action], { cwd }, (err, stdout, stderr) => resolve({ ok: !err, output: (stdout || '') + (stderr || '') })));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/api/status') {
    return json(res, 200, { daemons: listDaemons(), active: listActive(), repos: REPOS, siteUrl: SITE_URL });
  }
  if (path === '/api/log') {
    const ticket = url.searchParams.get('ticket');
    const project = url.searchParams.get('daemon');
    const file = ticket ? `jira-automation-${ticket}.log` : project ? `jira-automation-daemon-${project}.log` : null;
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
    if (!REPOS.includes(repo)) return json(res, 400, { error: 'repo not in JIRA_AUTOMATION_REPOS allowlist' });
    return json(res, 200, await runDaemon(repo, 'start'));
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

server.listen(PORT, () => console.log(`Jira daemon dashboard: http://localhost:${PORT}`));
