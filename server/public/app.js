const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? esc(s) : esc(s.slice(0, n).replace(/\s+\S*$/, '')) + '…'; };
// Sharp pistol silhouette (emoji 🔫 renders as a toy water gun on macOS).
const GUN = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><rect x="3" y="7" width="18" height="3.2" rx=".6"/><path d="M7 10l-1.6 6a1 1 0 0 0 1 1.3h2.4a1 1 0 0 0 1-.7L11.6 10z"/><rect x="18.4" y="5.7" width="2.6" height="2" rx=".4"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

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

// One case per ticket. Every row is the same shape; stage shows only via the dot
// colour (blue = working, amber = needs you, green = in review) and the content.
// Clicking opens the live chat for a live agent, or the PR's review comments in-review.
function caseRow(c) {
  const review = c.state === 'in-review';
  const live = !review;
  const n = (c.comments || []).length;
  const chip = n ? `<span class="chip">💬 ${n}</span>` : '';
  const links = [
    c.item ? `<a href="${c.item}" target="_blank">ticket</a>` : '',
    c.pr ? `<a href="${c.pr}" target="_blank">PR</a>` : '',
  ].filter(Boolean).join(' · ');

  const dot = c.state === 'needs-input' ? 'warn' : review ? (n ? 'warn' : 'ok') : 'busy';
  const detail = c.state === 'needs-input'
    ? `<div class="sub question">📻 <b>Needs your call:</b> ${trunc(c.question, 220)}</div>`
    : `<div class="sub">${trunc(review ? c.title : c.phase, 180)}</div>`;

  const gun = `<span class="iconbtn gun ${c.auto ? 'on' : ''}" data-auto title="Full-auto: don't ask me questions, just decide and keep going">${GUN}</span>`;
  const stop = live ? `<span class="iconbtn danger" data-stop title="Stop: halt the agent (keeps the worktree)">${X_ICON}</span>` : '';
  const row = el('div', c.state === 'needs-input' ? 'case needs-input' : 'case');
  row.innerHTML = `
    <div class="case-head"><span class="dot ${dot}"></span> <b>${esc(c.ticket)}</b> ${chip}
      <span class="case-actions">${gun}${stop}</span></div>
    ${detail}
    ${links ? `<div class="sub">${links}</div>` : ''}`;
  row.style.cursor = 'pointer';
  row.querySelector('[data-auto]').onclick = async (e) => {
    e.stopPropagation();
    await api('/api/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket, on: !c.auto }) });
    refresh();
  };
  row.onclick = review
    ? () => openLog({ pr: { number: c.prNumber, title: c.title, url: c.pr, branch: c.branch, ticket: c.ticket, comments: c.comments || [] }, project: c.project }, `${c.ticket} · review`)
    : () => openLog({ ticket: c.ticket, needsInput: c.state === 'needs-input' }, `${c.ticket} · case log`);
  if (live) row.querySelector('[data-stop]').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Stop ${c.ticket}? (halts the agent; keeps the worktree)`)) return;
    await api('/api/stop-case', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket }) });
    refresh();
  };
  row.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
  return row;
}

function renderDeputies(daemons, orphans) {
  const wrap = $('#daemons');
  wrap.innerHTML = '';
  if (!daemons.length) wrap.append(el('div', 'muted', '🤠 No deputies on patrol. Deputize a repo above, or start one from the CLI.'));
  for (const d of daemons) {
    const cases = d.cases || [];
    const working = cases.filter((c) => c.state !== 'in-review').length;
    const review = cases.filter((c) => c.state === 'in-review').length;
    const card = el('div', 'card');
    const dot = !d.running ? 'off' : working ? 'busy' : 'ok';
    let status;
    if (!d.running) status = 'off duty';
    else {
      const parts = [];
      if (working) parts.push(`on ${working} case${working > 1 ? 's' : ''}`);
      if (review) parts.push(`${review} in review`);
      status = parts.join(' · ') || 'on patrol';
    }
    card.append(el('div', 'row', `
      <div>
        <h3><span class="dot ${dot}"></span> ${esc(d.project)}</h3>
        <div class="sub">${status}${d.running ? ` · pid ${d.pid} · checks every ${d.interval}s` : ''}</div>
        <div class="sub">${esc(d.repoDir || '')}</div>
      </div>`));
    if (cases.length) {
      const sec = el('div', 'recent');
      for (const c of cases) sec.append(caseRow(c));
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
    const needs = allCases.filter((c) => c.state === 'needs-input').length;
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
  if (target.pr) $('#replyInput').placeholder = (target.pr.comments || []).length ? 'Extra guidance (optional)…' : 'Tell Deputy what to do…';
  $('#letDecide').classList.toggle('hidden', !target.needsInput);
  $('#addressAll').classList.toggle('hidden', !(target.pr && (target.pr.comments || []).length));
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
// Build the instruction for a PR follow-up, auto-attaching the unresolved comments so
// the agent actually sees them (you don't retype). `extra` is your optional guidance.
function prCommentsPrompt(p, extra) {
  const cs = p.comments || [];
  let s = cs.length
    ? `Address these unresolved review comments on the PR by editing the code and pushing to the branch. Do NOT reply on the PR or resolve the threads; just make the changes.\n\n`
      + cs.map((c, i) => `${i + 1}. @${c.author} ${c.path}${c.line ? ':' + c.line : ''} — ${c.body}`).join('\n')
    : 'Do more work on this PR.';
  if (extra && extra.trim()) s += `\n\nAdditional guidance from the user: ${extra.trim()}`;
  return s;
}
$('#logReply').onsubmit = async (e) => {
  e.preventDefault();
  const inp = $('#replyInput');
  const btn = e.target.querySelector('button[type=submit]');
  const message = inp.value.trim();

  // A PR entry: dispatch a follow-up on that branch (Deputy works, you stay the only PR voice).
  if (logTarget?.pr) {
    const p = logTarget.pr;
    inp.value = '';
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
    const r = await api('/api/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: logTarget.project, ticket: p.ticket || `PR-${p.number}`, branch: p.branch, prompt: prCommentsPrompt(p, message) }) });
    btn.disabled = false; btn.textContent = label;
    if (r.error) { inp.value = message; alert(r.error); }
    else { $('#logBody').textContent += `\n\n[SENT] Deputy is on it; it'll appear as a working case.`; $('#logBody').scrollTop = $('#logBody').scrollHeight; }
    return;
  }

  if (!message) return;
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
// Fix every unresolved comment with no typing: dispatch with just the comment list.
$('#addressAll').onclick = () => {
  const n = (logTarget?.pr?.comments || []).length;
  if (!confirm(`Have Deputy address ${n} review comment${n === 1 ? '' : 's'} on this PR? It will edit the code and push a fix.`)) return;
  $('#replyInput').value = '';
  $('#logReply').requestSubmit();
};
// "I don't feel like answering" — resume the parked agent and let it decide for itself.
$('#letDecide').onclick = async () => {
  if (!logTarget?.needsInput) return;
  const btn = $('#letDecide'); btn.disabled = true; const t = btn.textContent; btn.textContent = 'Resuming…';
  const r = await api('/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: logTarget.ticket, message: 'Use your best judgment and proceed. Do not wait for my input: make a reasonable, reversible decision and continue the work.' }) });
  btn.disabled = false; btn.textContent = t;
  if (r.error) alert(r.error); else { pendingResume = true; $('#logBody').textContent += '\n[YOU] (let it decide)\n'; refreshLog(); }
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
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Deputizing…';
  const r = await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }) });
  btn.disabled = false; btn.textContent = label;
  if (r.error || r.ok === false) alert(`Deputize failed: ${r.error || (r.output || '').slice(-300)}`);
  refresh();
};

refresh();
setInterval(refresh, 3000);
