const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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
    ? `<div class="sub question">📻 <b>Needs your call:</b> ${esc(c.question || '').slice(0, 220)}</div>`
    : `<div class="sub">${esc(c.phase || '').slice(0, 200)}</div>`;
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
    if (d.recent?.length) {
      const sec = el('div', 'recent'); sec.append(el('div', 'muted', 'Recent cases'));
      for (const r of d.recent) {
        const it = el('div', 'item');
        const pr = r.pr ? ` · <a href="${r.pr}" target="_blank">PR</a>` : '';
        it.innerHTML = `${badge(r.outcome)} <span>${esc(r.ticket)}</span>${pr}`;
        sec.append(it);
      }
      card.append(sec);
    }
    const footer = el('div', 'recent actions-row');
    const pl = el('button', 'linklike', '🐎 patrol log');
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
  pendingEcho = '';
  $('#logTitle').textContent = title;
  // Show the reply box only when chatting with a live agent (a ticket, not a poller log).
  $('#logReply').classList.toggle('hidden', !target.ticket);
  if (target.ticket) $('#replyInput').placeholder = target.needsInput ? 'Answer the deputy…' : 'Reply to this agent…';
  $('#logModal').classList.remove('hidden');
  refreshLog();
  clearInterval(logTimer);
  logTimer = setInterval(refreshLog, 1000);   // snappy transcript while the chat is open
  if (target.ticket) $('#replyInput').focus();
}
$('#logReply').onsubmit = async (e) => {
  e.preventDefault();
  if (!logTarget?.ticket) return;
  const inp = $('#replyInput');
  const btn = e.target.querySelector('button');
  const message = inp.value.trim();
  if (!message) return;
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
  if (!logTarget) return;
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
