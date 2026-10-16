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
  const row = el('div', 'case');
  const links = [
    c.item ? `<a href="${c.item}" target="_blank">ticket</a>` : '',
    c.pr ? `<a href="${c.pr}" target="_blank">PR</a>` : '',
  ].filter(Boolean).join(' · ');
  row.innerHTML = `
    <div class="case-head"><span class="dot busy"></span> <b>${esc(c.ticket)}</b>
      <button class="linklike">💬 case log</button></div>
    <div class="sub">${esc(c.phase || '').slice(0, 160)}</div>
    ${links ? `<div class="sub">${links}</div>` : ''}`;
  row.querySelector('button').onclick = () => openLog({ ticket: c.ticket }, `${c.ticket} · case log`);
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
    const actions = el('div');
    if (d.running) {
      const stop = el('button', null, 'Stop');
      stop.onclick = async () => { stop.disabled = true; await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: d.project }) }); refresh(); };
      actions.append(stop);
    }
    card.querySelector('.row').append(actions);

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
    const footer = el('div', 'recent');
    const pl = el('button', 'linklike', '🔭 patrol log');
    pl.onclick = () => openLog({ daemon: d.project }, `${d.project} · patrol log`);
    footer.append(pl); card.append(footer);
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
    const open = s.daemons.reduce((n, d) => n + (d.cases || []).length, 0) + (s.orphans?.length || 0);
    $('#globalDot').className = `dot ${open ? 'busy' : running ? 'ok' : 'off'}`;
    $('#updated').textContent = `${running} deput${running === 1 ? 'y' : 'ies'} · ${open} open case${open === 1 ? '' : 's'} · ${new Date().toLocaleTimeString()}`;

    const sel = $('#repoSelect');
    if (sel.options.length <= 1 && s.repos.length) {
      for (const r of s.repos) sel.append(new Option(r.split('/').pop() + '  (' + r + ')', r));
    }
    renderDeputies(s.daemons, s.orphans);
    if (logTarget) refreshLog();
  } catch (e) {
    $('#updated').textContent = 'server unreachable';
  }
}

let logTimer = null;
let pendingEcho = '';   // your just-sent message, shown until the real log line lands

async function openLog(target, title) {
  logTarget = target;
  pendingEcho = '';
  $('#logTitle').textContent = title;
  // Show the reply box only when chatting with a live agent (a ticket, not a poller log).
  $('#logReply').classList.toggle('hidden', !target.ticket);
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
  if (r.error) { pendingEcho = ''; inp.value = message; alert(r.error); } else { inp.focus(); refreshLog(); }
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
  body.textContent = out;
  if (atBottom) body.scrollTop = body.scrollHeight;
}
$('#logClose').onclick = () => { logTarget = null; pendingEcho = ''; clearInterval(logTimer); $('#logModal').classList.add('hidden'); };

$('#startForm').onsubmit = async (e) => {
  e.preventDefault();
  const repo = $('#repoSelect').value;
  if (!repo) return;
  await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }) });
  refresh();
};

refresh();
setInterval(refresh, 3000);
