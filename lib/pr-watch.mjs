#!/usr/bin/env node
// Lists the deputy's open PRs (by label) and their unresolved review threads, as
// JSON on stdout. The daemon publishes this to /tmp so the dashboard can show
// finished-but-open PRs and flag review comments without the daemon ever replying.
import { execFileSync } from 'node:child_process';
import { getTracker } from './trackers/index.mjs';

const label = process.env.DEPUTY_PR_LABEL || 'ai-automated';
let tracker; try { tracker = getTracker(); } catch {}
const itemUrl = (id) => { try { return id && tracker ? tracker.itemUrl(id) : null; } catch { return null; } };
const idPattern = /[A-Z][A-Z0-9]+-\d+/; // a tracker id in the PR title, e.g. WEB-123

const gh = (args) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

// Exit non-zero (rather than printing []) when gh can't answer, so the daemon keeps the
// last good file instead of blanking the dashboard on a transient hiccup.
const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
if (!repo) process.exit(1);
const [owner, name] = repo.split('/');

const prsRaw = gh(['pr', 'list', '--state', 'open', '--label', label, '--json', 'number,title,url,headRefName']);
if (!prsRaw) process.exit(1); // gh failed (empty); "no PRs" returns "[]", which is fine
let prs = [];
try { prs = JSON.parse(prsRaw); } catch { process.exit(1); }

// A reviewer leaves feedback in three places on a PR; fetch all of them, not just inline threads:
//   reviewThreads — inline comments on file lines (have a resolved state)
//   comments      — top-level conversation comments on the PR
//   reviews       — a review's summary body (the note left when submitting a review)
const threadQuery = 'query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} path line body url}}}} comments(first:100){nodes{author{login __typename} body url}} reviews(first:50){nodes{author{login __typename} body url}}}}}';

// Top-level PR comments are where CI/coverage bots post — keep only human reviewers so the
// dashboard shows actionable feedback, not a Datadog coverage dump. (Inline review threads are
// human review feedback by nature, so those aren't filtered.)
const isBot = (a) => !a || a.__typename === 'Bot' || /\[bot\]$|^(dependabot|renovate)|datadog|codecov|coveralls|sonar|github-actions|-official$|-ci$/i.test(a.login || '');

const out = prs.map((pr) => {
  let comments = [];
  try {
    const res = gh(['api', 'graphql', '-f', `query=${threadQuery}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `num=${pr.number}`]);
    const prd = JSON.parse(res).data.repository.pullRequest;
    const inline = (prd.reviewThreads.nodes || []).filter((t) => !t.isResolved && t.comments.nodes[0]).map((t) => {
      const c = t.comments.nodes[0];
      return { author: c.author?.login || '?', path: c.path || '', line: c.line ?? null, body: (c.body || '').slice(0, 600), url: c.url || pr.url };
    });
    const topLevel = (prd.comments.nodes || []).filter((c) => !isBot(c.author)).map((c) => ({ author: c.author?.login || '?', path: '', line: null, body: (c.body || '').slice(0, 600), url: c.url || pr.url }));
    const reviewBodies = (prd.reviews.nodes || []).filter((r) => (r.body || '').trim() && !isBot(r.author)).map((r) => ({ author: r.author?.login || '?', path: '', line: null, body: r.body.slice(0, 600), url: r.url || pr.url }));
    const seen = new Set();
    comments = [...inline, ...topLevel, ...reviewBodies].filter((c) => !seen.has(c.url) && seen.add(c.url));
  } catch {}
  const id = pr.title.match(idPattern);
  const ticket = id ? id[0] : null;
  return { number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, ticket, item: itemUrl(ticket), comments };
});

console.log(JSON.stringify(out));
