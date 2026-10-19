const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? esc(s) : esc(s.slice(0, n).replace(/\s+\S*$/, '')) + '…'; };
let siteUrl = '';
const linkTickets = (s) => esc(String(s || '')).replace(/\b([A-Z][A-Z0-9]+-\d+)\b/g, (k) => siteUrl ? `<a href="${siteUrl}/browse/${k}" target="_blank">${k}</a>` : k);
// Revolver silhouette (cylinder + barrel + grip); emoji 🔫 renders as a toy water gun on macOS.
const GUN = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><rect x="9" y="6.4" width="12" height="2.6" rx=".5"/><circle cx="8" cy="9.6" r="3.3"/><path d="M7 12.4l-1.5 5.1a1 1 0 0 0 1 1.3h2a1 1 0 0 0 1-.75L11 12.4z"/><rect x="18.6" y="5" width="2.4" height="2" rx=".3"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>';

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
function openCaseModal(c) {
  openLog({
    ticket: c.ticket, state: c.state, project: c.project, item: c.item, phase: c.phase, question: c.question, worktree: c.worktree, ready: c.ready,
    live: c.state === 'working' || c.state === 'needs-input',
    needsInput: c.state === 'needs-input', blocked: c.state === 'blocked', failed: c.state === 'failed', stopped: c.state === 'stopped',
    pr: c.pr ? { number: c.prNumber, title: c.title, url: c.pr, branch: c.branch, ticket: c.ticket, comments: c.comments || [] } : null,
  }, c.title ? `${c.ticket} · ${c.title}` : c.ticket);
}

function caseRow(c) {
  const review = c.state === 'in-review';
  const blocked = c.state === 'blocked';
  const failed = c.state === 'failed';
  const stopped = c.state === 'stopped';
  const live = !review;
  const n = (c.comments || []).length;
  const chip = n ? `<span class="chip">💬 ${n}</span>` : '';
  const links = [
    c.item ? `<a href="${c.item}" target="_blank">ticket</a>` : '',
    c.pr ? `<a href="${c.pr}" target="_blank">PR</a>` : '',
  ].filter(Boolean).join(' · ');

  const dot = c.state === 'needs-input' ? 'warn' : failed ? 'fail' : (blocked || stopped) ? 'wait' : review ? 'ok' : 'busy';
  const dotTitle = c.state === 'needs-input' ? 'Needs your call'
    : failed ? 'Failed — needs your attention' : stopped ? 'Stopped — ▶ to re-run' : blocked ? 'Blocked — waiting on a dependency' : review ? 'In review' : 'Working';
  const detail = c.state === 'needs-input'
    ? `<div class="sub question">📻 <b>Needs your call:</b> ${trunc(c.question, 220)}</div>`
    : failed
    ? `<div class="sub failed-note">⚠️ <b>Failed:</b> ${linkTickets(c.phase)} <span class="muted">· ▶ to retry · ✕ to forget</span></div>`
    : stopped
    ? `<div class="sub blocked-note">⏸ <b>Stopped</b> <span class="muted">· ▶ to re-run · ✕ to forget</span></div>`
    : blocked
    ? `<div class="sub blocked-note">⛓️ <b>Blocked:</b> ${linkTickets(c.phase)} <span class="muted">· will start once its dependency has a branch</span></div>`
    : `<div class="sub">${trunc(review ? c.title : c.phase, 180)}</div>`;

  const gun = `<span class="iconbtn gun ${c.auto ? 'on' : ''}" data-auto title="Full-auto: don't ask me questions, just decide and keep going">${GUN}</span>`;
  const canRerun = failed || stopped;
  const rerun = canRerun
    ? `<span class="iconbtn" data-rerun title="Re-run: bring this case back (resumes where it left off if it can)">${PLAY}</span>`
    : `<span class="iconbtn" aria-hidden="true" style="visibility:hidden">${PLAY}</span>`;
  const xTitle = (failed || stopped) ? 'Forget: remove this case + its worktree' : blocked ? 'Drop this blocked case' : live ? 'Stop: halt the agent (keeps the worktree)' : 'Hide this finished case (comes back only if a new review comment lands)';
  const stop = `<span class="iconbtn danger" data-x title="${xTitle}">${X_ICON}</span>`;
  const row = el('div', c.state === 'needs-input' ? 'case needs-input' : 'case');
  row.innerHTML = `
    <div class="case-head"><span class="dot ${dot}" title="${dotTitle}"></span> <b>${esc(c.ticket)}</b> ${chip}
      <span class="case-actions">${rerun}${gun}${stop}</span></div>
    ${detail}
    ${links ? `<div class="sub">${links}</div>` : ''}`;
  row.style.cursor = 'pointer';
  row.querySelector('[data-auto]').onclick = async (e) => {
    e.stopPropagation();
    await api('/api/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket, on: !c.auto }) });
    refresh();
  };
  row.onclick = () => openCaseModal(c);
  const rerunBtn = row.querySelector('[data-rerun]');
  if (rerunBtn) rerunBtn.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/rerun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket, project: c.project }) });
    refresh();
  };
  row.querySelector('[data-x]').onclick = async (e) => {
    e.stopPropagation();
    if (review) {
      if (!confirm(`Hide ${c.ticket}? It's in review with nothing to do; it'll reappear only if a new review comment lands.`)) return;
      await api('/api/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket, commentUrls: (c.comments || []).map((x) => x.url) }) });
    } else if (failed || stopped) {
      if (!confirm(`Forget ${c.ticket}? Removes its worktree and state (▶ re-run instead to keep it).`)) return;
      await api('/api/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket, project: c.project }) });
    } else {
      const msg = blocked ? `Drop blocked case ${c.ticket}? It will no longer be tracked until it's labelled again.` : `Stop ${c.ticket}? (halts the agent; keeps the worktree so you can ▶ re-run it)`;
      if (!confirm(msg)) return;
      await api('/api/stop-case', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: c.ticket }) });
    }
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
    const failedCount = cases.filter((c) => c.state === 'failed').length;
    const blockedCount = cases.filter((c) => c.state === 'blocked').length;
    const stoppedCount = cases.filter((c) => c.state === 'stopped').length;
    const working = cases.filter((c) => !['in-review', 'blocked', 'failed', 'stopped'].includes(c.state)).length;
    const review = cases.filter((c) => c.state === 'in-review').length;
    const card = el('div', 'card');
    const dot = !d.running ? 'off' : failedCount ? 'fail' : working ? 'busy' : 'ok';
    let status;
    if (!d.running) status = 'off duty';
    else {
      const parts = [];
      if (working) parts.push(`on ${working} case${working > 1 ? 's' : ''}`);
      if (review) parts.push(`${review} in review`);
      if (blockedCount) parts.push(`${blockedCount} blocked`);
      if (stoppedCount) parts.push(`${stoppedCount} stopped`);
      if (failedCount) parts.push(`⚠️ ${failedCount} failed`);
      status = parts.join(' · ') || 'on patrol';
    }
    const head = el('div', 'row deputy-head');
    head.innerHTML = `
      <div>
        <h3><span class="dot ${dot}"></span> ${esc(d.project)}</h3>
        <div class="sub">${status}${d.running ? ` · pid ${d.pid} · checks every ${d.interval}s` : ''}</div>
        <div class="sub">${esc(d.repoDir || '')}</div>
      </div>
      <div class="deputy-actions">
        ${d.running ? `<span class="iconbtn danger" data-standdown title="Stand down this deputy (stops the daemon)">${X_ICON}</span>` : ''}
      </div>`;
    head.onclick = () => openLog({ daemon: d.project }, `${d.project} · log`);
    const sd = head.querySelector('[data-standdown]');
    if (sd) sd.onclick = async (e) => { e.stopPropagation(); if (!confirm(`Stand ${d.project} down? (stops the daemon; cases can be resumed on restart)`)) return; await api('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: d.project }) }); refresh(); };
    card.append(head);
    if (cases.length) {
      const sec = el('div', 'recent');
      for (const c of cases) sec.append(caseRow(c));
      card.append(sec);
    }
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
    siteUrl = s.siteUrl || '';
    const running = s.daemons.filter((d) => d.running).length;
    const allCases = [...s.daemons.flatMap((d) => d.cases || []), ...(s.orphans || [])];
    const open = allCases.length;
    const needs = allCases.filter((c) => c.state === 'needs-input').length;
    const failed = allCases.filter((c) => c.state === 'failed').length;
    $('#globalDot').className = `dot ${failed ? 'fail' : needs ? 'warn' : open ? 'busy' : running ? 'ok' : 'off'}`;
    const needsNote = (needs ? ` · ⚠️ ${needs} need${needs === 1 ? 's' : ''} your call` : '') + (failed ? ` · ⚠️ ${failed} failed` : '');
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
    if (!deepLinked) {
      const t = new URLSearchParams(location.search).get('case');
      const c = t && allCases.find((x) => x.ticket === t);
      if (c) { deepLinked = true; openCaseModal(c); }
    }
  } catch (e) {
    $('#updated').textContent = 'server unreachable';
  }
}
let deepLinked = false;

let logTimer = null;
let pendingEcho = '';   // your just-sent message, shown until the real log line lands
let pendingResume = false;   // answering a parked case: show a "resuming" note until the agent reconnects

async function openLog(target, title) {
  logTarget = target;
  pendingEcho = ''; pendingResume = false;
  $('#logTitle').textContent = title;
  // Left pane (Activity log) is always shown. Reply box: chat a live agent, or do-more / address
  // comments on an in-review PR. Blocked/failed/stopped have no one to talk to (details on the right).
  const live = !!target.live;
  const canReply = live || !!target.pr;
  $('#logReply').classList.toggle('hidden', !canReply);
  if (canReply) $('#replyInput').placeholder = live
    ? (target.needsInput ? 'Answer the deputy…' : 'Reply to this agent…')
    : ((target.pr?.comments || []).length ? 'Extra guidance (or “address all” →)' : 'Tell Deputy to do more on this PR…');
  $('#letDecide').classList.toggle('hidden', !target.needsInput);
  $('#addressAll').classList.toggle('hidden', !(target.pr && (target.pr.comments || []).length));
  renderDetails(target);
  $('#logBody').textContent = '';
  $('#logModal').classList.remove('hidden');
  clearInterval(logTimer);
  refreshLog(); logTimer = setInterval(refreshLog, 1000);
  if (canReply) $('#replyInput').focus();
}

// Right pane: the contextual sections that apply to this case (status, failure, blocked,
// needs-input, review comments, links). A daemon/patrol-log target has no case → pane hidden.
function renderDetails(target) {
  const d = $('#logDetails');
  if (!target.ticket) { d.classList.add('hidden'); d.innerHTML = ''; return; }
  const label = { working: 'working', 'needs-input': 'needs your call', blocked: 'blocked', failed: 'failed', stopped: 'stopped', 'in-review': 'in review' }[target.state] || target.state || '';
  // One "Case" overview: status + ticket/PR/branch together.
  const meta = [`<div class="meta-row"><span>status</span><span class="statepill">${esc(label)}</span></div>`];
  if (target.ticket) meta.push(`<div class="meta-row"><span>ticket</span>${target.item ? `<a href="${target.item}" target="_blank">${esc(target.ticket)}</a>` : esc(target.ticket)}</div>`);
  if (target.pr) {
    meta.push(`<div class="meta-row"><span>PR</span><a href="${target.pr.url}" target="_blank">#${target.pr.number}</a></div>`);
    if (target.pr.branch) {
      const repoBase = target.pr.url.replace(/\/pull\/\d+.*$/, '');
      meta.push(`<div class="meta-row"><span>branch</span><a href="${repoBase}/tree/${encodeURIComponent(target.pr.branch)}" target="_blank">${esc(target.pr.branch)}</a></div>`);
    }
  }
  if (target.worktree) {
    const prepping = target.ready === false ? ' <span class="muted">(preparing…)</span>' : '';
    meta.push(`<div class="meta-row"><span>worktree</span><span class="path">${esc(target.worktree)}${prepping}</span></div>`);
  }
  const openCode = target.worktree ? `<button class="ghost" data-open-code style="margin-top:10px;padding:3px 9px;font-size:12px">Open in editor ↗</button>` : '';
  const s = [`<div class="detail"><h4>Case</h4>${meta.join('')}${openCode}</div>`];
  if (target.needsInput) s.push(`<div class="detail"><h4>Needs your call</h4><div>${esc(target.question || target.phase || '')}</div></div>`);
  if (target.blocked) s.push(`<div class="detail"><h4>Blocked</h4><div>${linkTickets(target.phase)}</div><div class="muted">Starts once its dependency has a branch.</div></div>`);
  if (target.failed) s.push(`<div class="detail"><h4>Failure</h4><div class="err">${esc(target.phase || 'the run failed')}</div><button class="ghost" data-retry style="margin-top:10px">▶ re-run</button></div>`);
  if (target.stopped) s.push(`<div class="detail"><h4>Stopped</h4><div class="muted">Kept so you can bring it back.</div><button class="ghost" data-retry style="margin-top:10px">▶ re-run</button></div>`);
  if (target.pr) {
    const cs = target.pr.comments || [];
    const body = cs.length
      ? cs.map((c) => `<div class="cmt"><div class="who">@${esc(c.author)} <span class="loc">${esc(c.path)}${c.line ? ':' + c.line : ''}</span></div><div>${esc(c.body)}</div><a href="${c.url}" target="_blank">view</a></div>`).join('')
      : `<div class="muted">No unresolved review comments.</div>`;
    s.push(`<div class="detail"><h4>Review comments${cs.length ? ` (${cs.length})` : ''}</h4>${body}${cs.length ? `<div class="muted" style="margin-top:6px">Tell Deputy what to fix on the left — it edits + pushes, never replies on the PR.</div>` : ''}</div>`);
  }
  d.innerHTML = s.join('');
  d.classList.remove('hidden');
  const rb = d.querySelector('[data-retry]');
  if (rb) rb.onclick = async () => { await api('/api/rerun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: target.ticket, project: target.project }) }); $('#logClose').click(); refresh(); };
  const ob = d.querySelector('[data-open-code]');
  if (ob) ob.onclick = async () => {
    ob.disabled = true; const label = ob.textContent; ob.textContent = 'Opening…';
    const r = await api('/api/open-in-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: target.ticket }) });
    ob.disabled = false; ob.textContent = label;
    if (r.error) alert(r.error);
  };
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

  // In-review PR (not a live agent): typed = do exactly that; empty = "address all" (with a confirm).
  if (!logTarget?.live && logTarget?.pr) {
    const p = logTarget.pr;
    let prompt = message;
    if (!message) {
      const n = (p.comments || []).length;
      if (!n) return;
      if (!confirm(`Have Deputy address ${n} review comment${n === 1 ? '' : 's'} on this PR? It will edit the code and push a fix.`)) return;
      prompt = prCommentsPrompt(p, '');
    }
    inp.value = '';
    // Echo your message right away (kept until it shows up in the activity log), like live chat.
    pendingEcho = message || '(address all comments)';
    $('#logBody').textContent += `\n[YOU] ${pendingEcho}\n`;
    $('#logBody').scrollTop = $('#logBody').scrollHeight;
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
    const r = await api('/api/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: logTarget.project, ticket: p.ticket || `PR-${p.number}`, branch: p.branch, prompt }) });
    btn.disabled = false; btn.textContent = label;
    if (r.error) { pendingEcho = ''; inp.value = message; alert(r.error); }
    else { refreshLog(); }
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
// "Address all" = submit with an empty box; the submit handler confirms and bundles the comments.
$('#addressAll').onclick = () => { $('#replyInput').value = ''; $('#logReply').requestSubmit(); };
// "I don't feel like answering" — resume the parked agent and let it decide for itself.
$('#letDecide').onclick = async () => {
  if (!logTarget?.needsInput) return;
  const btn = $('#letDecide'); btn.disabled = true; const t = btn.textContent; btn.textContent = 'Resuming…';
  const r = await api('/api/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: logTarget.ticket, message: 'Use your best judgment and proceed. Do not wait for my input: make a reasonable, reversible decision and continue the work.' }) });
  btn.disabled = false; btn.textContent = t;
  if (r.error) alert(r.error); else { pendingResume = true; $('#logBody').textContent += '\n[YOU] (let it decide)\n'; refreshLog(); }
};
async function refreshLog() {
  if (!logTarget) return;
  const q = logTarget.ticket ? `ticket=${encodeURIComponent(logTarget.ticket)}` : logTarget.daemon ? `daemon=${encodeURIComponent(logTarget.daemon)}` : null;
  if (!q) return;
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
