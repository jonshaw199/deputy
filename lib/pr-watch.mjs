#!/usr/bin/env node
// Lists the deputy's open PRs (by label) and their unresolved review threads, as
// JSON on stdout. The daemon publishes this to /tmp so the dashboard can show
// finished-but-open PRs and flag review comments without the daemon ever replying.
import { execFileSync } from 'node:child_process';

const label = process.env.DEPUTY_PR_LABEL || 'ai-automated';
const idPattern = /[A-Z][A-Z0-9]+-\d+/; // a tracker id in the PR title, e.g. SAAS-123

const gh = (args) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
if (!repo) { console.log('[]'); process.exit(0); }
const [owner, name] = repo.split('/');

let prs = [];
try { prs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--label', label, '--json', 'number,title,url,headRefName']) || '[]'); } catch {}

const threadQuery = 'query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} path line body url}}}}}}}';

const out = prs.map((pr) => {
  let comments = [];
  try {
    const res = gh(['api', 'graphql', '-f', `query=${threadQuery}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `num=${pr.number}`]);
    const nodes = JSON.parse(res).data.repository.pullRequest.reviewThreads.nodes || [];
    comments = nodes.filter((t) => !t.isResolved && t.comments.nodes[0]).map((t) => {
      const c = t.comments.nodes[0];
      return { author: c.author?.login || '?', path: c.path || '', line: c.line ?? null, body: (c.body || '').slice(0, 600), url: c.url || pr.url };
    });
  } catch {}
  const id = pr.title.match(idPattern);
  return { number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, ticket: id ? id[0] : null, comments };
});

console.log(JSON.stringify(out));
