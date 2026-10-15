// Jira tracker adapter. Reads AIDAEMON_* from the environment.
const env = process.env;
const base = () => `https://api.atlassian.com/ex/jira/${env.AIDAEMON_CLOUD_ID}/rest/api/3`;
const headers = () => ({
  Authorization: `Basic ${Buffer.from(`${env.AIDAEMON_USER_EMAIL}:${env.AIDAEMON_API_TOKEN}`).toString('base64')}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const label = () => env.AIDAEMON_LABEL || 'ai-ready';
const statusReady = () => env.AIDAEMON_STATUS_READY || 'Groomed';
const statusStart = () => env.AIDAEMON_STATUS_START || 'In Progress';
const statusDone = () => env.AIDAEMON_STATUS_DONE || 'In Review';

async function transitionTo(id, name) {
  const d = await (await fetch(`${base()}/issue/${id}/transitions`, { headers: headers() })).json();
  const want = name.toLowerCase();
  const m = (d.transitions || []).find((t) => t.name?.toLowerCase() === want || t.to?.name?.toLowerCase() === want);
  if (!m) throw new Error(`No transition to "${name}" for ${id}. Available: ${(d.transitions || []).map((t) => t.name).join(', ')}`);
  const r = await fetch(`${base()}/issue/${id}/transitions`, { method: 'POST', headers: headers(), body: JSON.stringify({ transition: { id: m.id } }) });
  if (!r.ok) throw new Error(`Transition failed: ${r.status} ${await r.text()}`);
  return m.name;
}

export default {
  name: 'jira',
  async listReady() {
    let jql = `labels = "${label()}" AND status = "${statusReady()}"`;
    if (env.AIDAEMON_PROJECTS) jql += ` AND project IN (${env.AIDAEMON_PROJECTS})`;
    const r = await fetch(`${base()}/search/jql`, { method: 'POST', headers: headers(), body: JSON.stringify({ jql, fields: ['summary'], maxResults: 10 }) });
    const j = await r.json();
    if (j.errorMessages?.length) throw new Error(j.errorMessages.join('; '));
    return (j.issues || []).map((i) => ({ id: i.key, title: i.fields?.summary || '' }));
  },
  async getItem(id) {
    const r = await fetch(`${base()}/issue/${id}?fields=summary,description,comment`, { headers: headers() });
    return await r.text();
  },
  markStarted(id) { return transitionTo(id, statusStart()); },
  markDone(id) { return transitionTo(id, statusDone()); },
  itemUrl(id) { return env.AIDAEMON_SITE_URL ? `${env.AIDAEMON_SITE_URL}/browse/${id}` : null; },
  prRef(id) { const u = env.AIDAEMON_SITE_URL ? `${env.AIDAEMON_SITE_URL}/browse/${id}` : id; return `Jira: ${u}`; },
};
