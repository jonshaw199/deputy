const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let logTarget = null; // { ticket } or { daemon } currently shown in the modal

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

function badge(outcome) {
  const cls = outcome === 'SUCCESS' ? 'ok' : outcome === 'TIMEOUT' ? 'warn' : 'fail';
  return `<span class="badge ${cls}">${outcome}</span>`;
}

function renderDaemons(daemons) {
  const wrap = $('#daemons');
  wrap.innerHTML = '';
  if (!daemons.length) { wrap.append(el('div', 'muted', '🤠 No deputies on patrol. Deputize a repo above, or start one from the CLI.')); return; }
  for (const d of daemons) {
    const card = el('div', 'card');
    const dot = d.running ? 'ok' : 'off';
    card.append(el('div', 'row', `
      <div>
        <h3><span class="dot ${dot}"></span> ${esc(d.project)}</h3>
        <div class="sub">${d.running ? `on patrol · pid ${d.pid} · checks every ${d.interval}s` : 'off duty'}</div>
        <div class="sub">${esc(d.repoDir || '')}</div>
      </div>`));
    const actions = el('div');
    if (d.running) {
      const stop = el('button', null, 'Stop');
      stop.onclick = async () => { stop.disabled = true; await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: d.project }) }); refresh(); };
      actions.append(stop);
    }
    const viewLog = el('button', 'linklike', 'patrol log');
    viewLog.onclick = () => openLog({ daemon: d.project }, `${d.project} · patrol log`);
    card.querySelector('.row').append(actions);

    if (d.recent.length) {
      const recent = el('div', 'recent');
      recent.append(el('div', 'muted', 'Recent cases'));
      for (const r of d.recent) {
        const item = el('div', 'item');
        const pr = r.pr ? ` · <a href="${r.pr}" target="_blank">PR</a>` : '';
        item.innerHTML = `${badge(r.outcome)} <span>${esc(r.ticket)}</span>${pr}`;
        recent.append(item);
      }
      card.append(recent);
    }
    const footer = el('div', 'recent'); footer.append(viewLog); card.append(footer);
    wrap.append(card);
  }
}

function renderActive(active) {
  const wrap = $('#active');
  wrap.innerHTML = '';
  if (!active.length) { wrap.append(el('div', 'muted', '🌵 All quiet in town. No open cases right now.')); return; }
  for (const a of active) {
    const card = el('div', 'card');
    const item = a.item ? ` · <a href="${a.item}" target="_blank">ticket</a>` : '';
    const pr = a.pr ? ` · <a href="${a.pr}" target="_blank">PR</a>` : '';
    card.append(el('div', null, `<h3><span class="dot busy"></span> ${esc(a.ticket)}</h3><div class="sub">${esc(a.phase).slice(0, 160)}</div><div class="sub">${item}${pr}</div>`));
    const log = el('button', 'linklike', '💬 chat / live log');
    log.onclick = () => openLog({ ticket: a.ticket }, a.ticket);
    const footer = el('div', 'recent'); footer.append(log); card.append(footer);
    wrap.append(card);
  }
}

async function refresh() {
  try {
    const s = await api('/api/status');
    const anyRunning = s.daemons.some((d) => d.running);
    const anyBusy = s.active.length > 0;
    $('#globalDot').className = `dot ${anyBusy ? 'busy' : anyRunning ? 'ok' : 'off'}`;
    $('#updated').textContent = `${s.daemons.filter((d) => d.running).length} on patrol · ${s.active.length} on the job · ${new Date().toLocaleTimeString()}`;

    const sel = $('#repoSelect');
    if (sel.options.length <= 1 && s.repos.length) {
      for (const r of s.repos) sel.append(new Option(r.split('/').pop() + '  (' + r + ')', r));
    }
    renderDaemons(s.daemons);
    renderActive(s.active);
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
