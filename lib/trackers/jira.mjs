// Jira tracker adapter. Reads DEPUTY_* from the environment.
const env = process.env;
const base = () => `https://api.atlassian.com/ex/jira/${env.DEPUTY_CLOUD_ID}/rest/api/3`;
const headers = () => ({
  Authorization: `Basic ${Buffer.from(`${env.DEPUTY_USER_EMAIL}:${env.DEPUTY_API_TOKEN}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const label = () => env.DEPUTY_LABEL || 'ai-ready';

async function removeLabel(id, name) {
  const r = await fetch(`${base()}/issue/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ update: { labels: [{ remove: name }] } }) });
  if (!r.ok) throw new Error(`Remove label failed: ${r.status} ${await r.text()}`);
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
  // Pick up labelled tickets ASSIGNED TO YOU only, so when a team shares a project each
  // person's Deputy takes their own tickets (no race, no stealing). Assign + label to queue.
  async listReady() {
    let jql = `labels = "${label()}" AND assignee = currentUser()`;
    if (env.DEPUTY_PROJECTS) jql += ` AND project IN (${env.DEPUTY_PROJECTS})`;
    const r = await fetch(`${base()}/search/jql`, { method: 'POST', headers: headers(), body: JSON.stringify({ jql, fields: ['summary'], maxResults: 10 }) });
    if (!r.ok) throw new Error(`Jira API ${r.status} — check DEPUTY_CLOUD_ID, DEPUTY_USER_EMAIL, and DEPUTY_API_TOKEN`);
    const j = await r.json();
    if (j.errorMessages?.length) throw new Error(j.errorMessages.join('; '));
    return (j.issues || []).map((i) => ({ id: i.key, title: i.fields?.summary || '' }));
  },
  async getItem(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=*all&expand=names,renderedFields`, { headers: headers() });
    return await r.text();
  },
  async title(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=summary`, { headers: headers() });
    if (!r.ok) return '';
    const j = await r.json();
    return j.fields?.summary || '';
  },
  // Picking up a ticket just removes its label so the next poll won't re-grab it.
  // Deputy never moves Jira status — you move the ticket to In Progress / In Review yourself.
  markStarted(id) { return removeLabel(id, label()); },
  markDone() { return Promise.resolve(null); },
  async getBlockers(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=issuelinks,description,summary`, { headers: headers() });
    if (!r.ok) return [];
    return blockersFromIssue(await r.json(), id);
  },
  itemUrl(id) { return env.DEPUTY_SITE_URL ? `${env.DEPUTY_SITE_URL}/browse/${id}` : null; },
  prRef(id) { const u = env.DEPUTY_SITE_URL ? `${env.DEPUTY_SITE_URL}/browse/${id}` : id; return `Jira: ${u}`; },
};
