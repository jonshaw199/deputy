// GitHub Issues tracker adapter. Reads AIDAEMON_GITHUB_* from the environment.
// "ready/started/done" are expressed as labels (Jira statuses have no equivalent).
const env = process.env;
const repo = () => env.AIDAEMON_GITHUB_REPO; // owner/name
const api = (path, opts = {}) =>
  fetch(`https://api.github.com/repos/${repo()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.AIDAEMON_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
const labelReady = () => env.AIDAEMON_LABEL || 'ai-ready';
const labelStarted = () => env.AIDAEMON_GITHUB_LABEL_STARTED || 'ai-in-progress';
const labelDone = () => env.AIDAEMON_GITHUB_LABEL_DONE || 'ai-in-review';

async function relabel(id, { remove = [], add = [] }) {
  for (const l of remove) await api(`/issues/${id}/labels/${encodeURIComponent(l)}`, { method: 'DELETE' });
  if (add.length) {
    const r = await api(`/issues/${id}/labels`, { method: 'POST', body: JSON.stringify({ labels: add }) });
    if (!r.ok) throw new Error(`Label update failed: ${r.status} ${await r.text()}`);
  }
}

export default {
  name: 'github',
  async listReady() {
    const r = await api(`/issues?state=open&labels=${encodeURIComponent(labelReady())}&per_page=10`);
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error(`GitHub issues error: ${JSON.stringify(list)}`);
    return list.filter((i) => !i.pull_request).map((i) => ({ id: String(i.number), title: i.title }));
  },
  async getItem(id) {
    const ir = await api(`/issues/${id}`);
    if (!ir.ok) throw new Error(`Get issue ${id} failed: ${ir.status} ${await ir.text()}`);
    const issue = await ir.json();
    const comments = await (await api(`/issues/${id}/comments`)).json();
    const commentBodies = Array.isArray(comments) ? comments.map((c) => c.body) : [];
    return JSON.stringify({ id, title: issue.title, body: issue.body, comments: commentBodies });
  },
  markStarted(id) { return relabel(id, { remove: [labelReady()], add: [labelStarted()] }); },
  markDone(id) { return relabel(id, { remove: [labelStarted()], add: [labelDone()] }); },
  itemUrl(id) { return `https://github.com/${repo()}/issues/${id}`; },
  prRef(id) { return `Closes #${id}`; },
};
