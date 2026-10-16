const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? esc(s) : esc(s.slice(0, n).replace(/\s+\S*$/, '')) + '…'; };

let logTarget = null; // { ticket } or { daemon } currently shown in the modal

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

function badge(outcome) {
  const map = { SUCCESS: ['ok', 'CLOSED'], TIMEOUT: ['warn', 'STALLED'], FAILED: ['fail', 'COLD'] };
  const [cls, label] = map[outcome] || ['fail', 'COLD'];
  return `<span class="badge ${cls}">${label}</span>`;
}

// One open case, nested under its deputy. Clicking opens the live chat / case log.
function caseRow(c) {
  const row = el('div', c.needsInput ? 'case needs-input' : 'case');
  const links = [
    c.item ? `<a href="${c.item}" target="_blank">ticket</a>` : '',
    c.pr ? `<a href="${c.pr}" target="_blank">PR</a>` : '',
  ].filter(Boolean).join(' · ');
  const dot = c.needsInput ? 'warn' : 'busy';
  const detail = c.needsInput
    ? `<div class="sub question">📻 <b>Needs your call:</b> ${trunc(c.question, 220)}</div>`
    : `<div class="sub">${trunc(c.phase, 200)}</div>`;
  row.innerHTML = `
    <div class="case-head"><span class="dot ${dot}"></span> <b>${esc(c.ticket)}</b>
      <span class="case-actions"><span class="linklike">💬 case log</span><span class="linklike danger" data-stop>call off</span></span></div>
    ${detail}
    ${links ? `<div class="sub">${links}</div>` : ''}`;
  row.style.cursor = 'pointer';
  row.onclick = () => openLog({ ticket: c.ticket, needsInput: c.needsInput }, `${c.ticket} · case log`);
  row.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  row.querySelector('[data-stop]').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Call off ${c.ticket}? (cancels the agent and drops its worktree)`)) return;
    await api('/api/stop-case', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket }) });
    refresh();
  };
  return row;
}

// A finished-but-open PR. Shows its unresolved review comments; clicking opens them
// with a reply box that tells Deputy what to fix (Deputy never replies on the PR itself).
function prRow(p, project) {
  const row = el('div', 'case');
  const n = p.comments?.length || 0;
  const chip = n ? `<span class="chip">💬 ${n} comment${n > 1 ? 's' : ''}</span>` : '';
  const label = p.ticket || `PR #${p.number}`;
  row.innerHTML = `
    <div class="case-head"><span class="dot ${n ? 'warn' : 'ok'}"></span> <b>${esc(label)}</b> ${chip}
      <span class="case-actions"><a href="${p.url}" target="_blank">PR</a></span></div>
    <div class="sub">${trunc(p.title, 140)}</div>`;
  row.style.cursor = 'pointer';
  row.onclick = () => openLog({ pr: p, project }, `${label} · review`);
  row.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  return row;
}

function renderDeputies(daemons, orphans) {
  const wrap = $('#daemons');
  wrap.innerHTML = '';
  if (!daemons.length) wrap.append(el('div', 'muted', '🤠 No deputies on patrol. Deputize a repo above, or start one from the CLI.'));
  for (const d of daemons) {
    const cases = d.cases || [];
    const card = el('div', 'card');
    const dot = !d.running ? 'off' : cases.length ? 'busy' : 'ok';
    const status = !d.running ? 'off duty' : cases.length ? `on ${cases.length} case${cases.length > 1 ? 's' : ''}` : 'on patrol';
    card.append(el('div', 'row', `
      <div>
        <h3><span class="dot ${dot}"></span> ${esc(d.project)}</h3>
        <div class="sub">${status}${d.running ? ` · pid ${d.pid} · checks every ${d.interval}s` : ''}</div>
        <div class="sub">${esc(d.repoDir || '')}</div>
      </div>`));
    if (cases.length) {
      const sec = el('div', 'recent'); sec.append(el('div', 'muted', 'Open cases'));
      for (const c of cases) sec.append(caseRow(c));
      card.append(sec);
    }
    if (d.prs?.length) {
      const sec = el('div', 'recent'); sec.append(el('div', 'muted', 'Open PRs (in review)'));
      for (const p of d.prs) sec.append(prRow(p, d.project));
      card.append(sec);
    }
    const footer = el('div', 'recent actions-row');
    const pl = el('button', 'linklike', '👁️ patrol log');
    pl.onclick = () => openLog({ daemon: d.project }, `${d.project} · patrol log`);
    footer.append(pl);
    if (d.running) {
      const stop = el('button', 'linklike danger', 'stand down');
      stop.onclick = async () => { if (!confirm(`Stand ${d.project} down?`)) return; await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: d.project }) }); refresh(); };
      footer.append(stop);
    }
    card.append(footer);
    wrap.append(card);
  }
  if (orphans?.length) {
    const card = el('div', 'card'); card.append(el('div', 'muted', 'Cases with no live deputy'));
    for (const c of orphans) card.append(caseRow(c));
    wrap.append(card);
  }
}

async function refresh() {
  try {
    const s = await api('/api/status');
    const running = s.daemons.filter((d) => d.running).length;
    const allCases = [...s.daemons.flatMap((d) => d.cases || []), ...(s.orphans || [])];
    const open = allCases.length;
    const needs = allCases.filter((c) => c.needsInput).length;
    $('#globalDot').className = `dot ${needs ? 'warn' : open ? 'busy' : running ? 'ok' : 'off'}`;
    const needsNote = needs ? ` · ⚠️ ${needs} need${needs === 1 ? 's' : ''} your call` : '';
    $('#updated').textContent = `${running} deput${running === 1 ? 'y' : 'ies'} · ${open} open case${open === 1 ? '' : 's'}${needsNote} · ${new Date().toLocaleTimeString()}`;

    // Dropdown = repos without a deputy already on patrol; rebuilt only when it changes.
    const sel = $('#repoSelect');
    const runningRepos = new Set(s.daemons.filter((d) => d.running).map((d) => d.repoDir));
    const avail = (s.repos || []).filter((r) => !runningRepos.has(r));
    const want = avail.join('|');
    if (sel.dataset.repos !== want) {
      sel.dataset.repos = want;
      sel.innerHTML = '';
      sel.append(new Option(avail.length ? 'Deputize a repo…' : 'All repos have a deputy', ''));
      for (const r of avail) sel.append(new Option(r.split('/').pop(), r));
    }
    renderDeputies(s.daemons, s.orphans);
    if (logTarget) refreshLog();
  } catch (e) {
    $('#updated').textContent = 'server unreachable';
  }
}

let logTimer = null;
let pendingEcho = '';   // your just-sent message, shown until the real log line lands
let pendingResume = false;   // answering a parked case: show a "resuming" note until the agent reconnects

async function openLog(target, title) {
  logTarget = target;
  pendingEcho = ''; pendingResume = false;
  $('#logTitle').textContent = title;
  const canReply = !!(target.ticket || target.pr);
  $('#logReply').classList.toggle('hidden', !canReply);
  if (target.ticket) $('#replyInput').placeholder = target.needsInput ? 'Answer the deputy…' : 'Reply to this agent…';
  if (target.pr) $('#replyInput').placeholder = 'Tell Deputy what to fix…';
  $('#logModal').classList.remove('hidden');
  clearInterval(logTimer);
  if (target.pr) { renderPrComments(target.pr); }
  else { refreshLog(); logTimer = setInterval(refreshLog, 1000); }
  if (canReply) $('#replyInput').focus();
}
function renderPrComments(p) {
  const cs = p.comments || [];
  const head = cs.length
    ? `${cs.length} unresolved review comment${cs.length > 1 ? 's' : ''}. Tell Deputy what to fix below; it edits the code and pushes, and never replies on the PR (that's you).\n\n`
    : `No unresolved review comments. You can still tell Deputy to do more work on this PR below.\n\n`;
  const list = cs.map((c) => `@${c.author}  ${c.path}${c.line ? ':' + c.line : ''}\n${c.body}\n${c.url}`).join('\n\n──────────\n\n');
  $('#logBody').textContent = head + list;
}
$('#logReply').onsubmit = async (e) => {
  e.preventDefault();
  const inp = $('#replyInput');
  const btn = e.target.querySelector('button');
  const message = inp.value.trim();
  if (!message) return;

  // A PR entry: dispatch a follow-up on that branch (Deputy works, you stay the only PR voice).
  if (logTarget?.pr) {
    const p = logTarget.pr;
    inp.value = '';
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
    const r = await api('/api/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: logTarget.project, ticket: p.ticket || `PR-${p.number}`, branch: p.branch, prompt: message }) });
    btn.disabled = false; btn.textContent = label;
    if (r.error) { inp.value = message; alert(r.error); }
    else { $('#logBody').textContent += `\n\n[SENT] Deputy is on it; it'll appear under Open cases.`; $('#logBody').scrollTop = $('#logBody').scrollHeight; }
    return;
  }

  if (!logTarget?.ticket) return;
  inp.value = '';
  // Optimistic echo: show it instantly, keep showing it until the agent's log catches up.
  pendingEcho = message;
  const body = $('#logBody');
  body.textContent += `\n[YOU] ${message}\n`;
  body.scrollTop = body.scrollHeight;
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
  const r = await api('/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: logTarget.ticket, message }) });
  btn.disabled = false; btn.textContent = label;
  if (r.error) { pendingEcho = ''; inp.value = message; alert(r.error); }
  else { if (r.resumed) pendingResume = true; inp.focus(); refreshLog(); }
};
async function refreshLog() {
  if (!logTarget || logTarget.pr) return;
  const q = logTarget.ticket ? `ticket=${encodeURIComponent(logTarget.ticket)}` : `daemon=${encodeURIComponent(logTarget.daemon)}`;
  const { text } = await api(`/api/log?${q}`);
  const body = $('#logBody');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
  let out = text || '(empty)';
  // Keep the optimistic echo visible until the real [YOU] line shows up in the log.
  if (pendingEcho) { if (out.includes(pendingEcho)) pendingEcho = ''; else out += `\n[YOU] ${pendingEcho}\n`; }
  // While a parked case spins back up, show a resuming note until the agent reconnects.
  if (pendingResume) { if (/Reconnecting to the agent/.test(out)) pendingResume = false; else out += `\n⏳ Resuming the deputy…\n`; }
  body.textContent = out;
  if (atBottom) body.scrollTop = body.scrollHeight;
}
$('#logClose').onclick = () => { logTarget = null; pendingEcho = ''; pendingResume = false; clearInterval(logTimer); $('#logModal').classList.add('hidden'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#logModal').classList.contains('hidden')) $('#logClose').click(); });

$('#startForm').onsubmit = async (e) => {
  e.preventDefault();
  const repo = $('#repoSelect').value;
  if (!repo) return;
  await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }) });
  refresh();
};

refresh();
setInterval(refresh, 3000);
