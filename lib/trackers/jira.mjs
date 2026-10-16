// Jira tracker adapter. Reads DEPUTY_* from the environment.
const env = process.env;
const base = () => `https://api.atlassian.com/ex/jira/${env.DEPUTY_CLOUD_ID}/rest/api/3`;
const headers = () => ({
  Authorization: `Basic ${Buffer.from(`${env.DEPUTY_USER_EMAIL}:${env.DEPUTY_API_TOKEN}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const label = () => env.DEPUTY_LABEL || 'ai-ready';
const statusStart = () => env.DEPUTY_STATUS_START || 'In Progress';
const statusDone = () => env.DEPUTY_STATUS_DONE || 'In Review';

async function transitionTo(id, name) {
  const d = await (await fetch(`${base()}/issue/${id}/transitions`, { headers: headers() })).json();
  const want = name.toLowerCase();
  const m = (d.transitions || []).find((t) => t.name?.toLowerCase() === want || t.to?.name?.toLowerCase() === want);
  if (!m) throw new Error(`No transition to "${name}" for ${id}. Available: ${(d.transitions || []).map((t) => t.name).join(', ')}`);
  const r = await fetch(`${base()}/issue/${id}/transitions`, { method: 'POST', headers: headers(), body: JSON.stringify({ transition: { id: m.id } }) });
  if (!r.ok) throw new Error(`Transition failed: ${r.status} ${await r.text()}`);
  return m.name;
}

async function removeLabel(id, name) {
  const r = await fetch(`${base()}/issue/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ update: { labels: [{ remove: name }] } }) });
  if (!r.ok) throw new Error(`Remove label failed: ${r.status} ${await r.text()}`);
}

async function assignToSelf(id) {
  const me = await (await fetch(`${base()}/myself`, { headers: headers() })).json();
  if (!me.accountId) return;
  await fetch(`${base()}/issue/${id}/assignee`, { method: 'PUT', headers: headers(), body: JSON.stringify({ accountId: me.accountId }) });
}

// Tickets this one must wait on, from (1) "is blocked by" issue links and (2) prose
// in the description/summary ("blocked by WEB-2", "depends on WEB-3"). Pure + exported
// so the daemon can stack a dependent PR on its blocker's branch. Self-reference dropped.
export function blockersFromIssue(issue, selfKey) {
  const out = new Set();
  for (const l of issue?.fields?.issuelinks || []) {
    if (l.inwardIssue?.key && /block|depend/i.test(l.type?.inward || '')) out.add(l.inwardIssue.key);
  }
  const prose = JSON.stringify(issue?.fields?.description || '') + ' ' + (issue?.fields?.summary || '');
  for (const m of prose.matchAll(/(?:blocked by|depends on|after)\s+:?\s*([A-Z][A-Z0-9]+-\d+)/gi)) out.add(m[1].toUpperCase());
  if (selfKey) out.delete(selfKey.toUpperCase());
  return [...out];
}

export default {
  name: 'jira',
  // Pick up any ticket with the label, regardless of status (matches the GitHub tracker).
  async listReady() {
    let jql = `labels = "${label()}"`;
    if (env.DEPUTY_PROJECTS) jql += ` AND project IN (${env.DEPUTY_PROJECTS})`;
    const r = await fetch(`${base()}/search/jql`, { method: 'POST', headers: headers(), body: JSON.stringify({ jql, fields: ['summary'], maxResults: 10 }) });
    const j = await r.json();
    if (j.errorMessages?.length) throw new Error(j.errorMessages.join('; '));
    return (j.issues || []).map((i) => ({ id: i.key, title: i.fields?.summary || '' }));
  },
  async getItem(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=summary,description,comment`, { headers: headers() });
    return await r.text();
  },
  // Remove the label first so it won't be re-picked next poll; then move status (best-effort).
  async markStarted(id) {
    await removeLabel(id, label());
    try { await assignToSelf(id); } catch { /* assignment is optional */ }
    try { await transitionTo(id, statusStart()); } catch { /* status move is optional */ }
  },
  markDone(id) { return transitionTo(id, statusDone()); },
  async getBlockers(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=issuelinks,description,summary`, { headers: headers() });
    if (!r.ok) return [];
    return blockersFromIssue(await r.json(), id);
  },
  itemUrl(id) { return env.DEPUTY_SITE_URL ? `${env.DEPUTY_SITE_URL}/browse/${id}` : null; },
  prRef(id) { const u = env.DEPUTY_SITE_URL ? `${env.DEPUTY_SITE_URL}/browse/${id}` : id; return `Jira: ${u}`; },
};
