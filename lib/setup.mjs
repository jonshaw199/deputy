#!/usr/bin/env node
// Interactive first-run setup: asks for the handful of values Deputy needs, validates the
// tracker credentials with a live poll, and writes .env. Run with `npm run setup`.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env.DEPUTY_ENV_OUT || join(ROOT, '.env');

// Interactive over a TTY; when stdin is piped (scripts/tests) serve pre-read lines.
const piped = !stdin.isTTY;
const queued = piped ? readFileSync(0, 'utf8').split('\n') : null;
const rl = piped ? null : createInterface({ input: stdin, output: stdout });
async function raw(label) {
  if (piped) { const l = queued.length ? queued.shift() : ''; stdout.write(label + l + '\n'); return l; }
  return await rl.question(label);
}
const ask = async (label, def = '') => {
  const a = (await raw(`${label}${def ? ` [${def}]` : ''}: `)).trim();
  return a || def;
};
const askReq = async (label, def = '') => {
  let a = '';
  while (!(a = await ask(label, def))) { if (piped) break; stdout.write('  (required)\n'); }
  return a;
};

console.log('\n  Deputy setup — point it at your tracker + GitHub, then `npm run dashboard`.\n');

if (existsSync(ENV) && (await ask('.env already exists. Overwrite? (y/N)')).toLowerCase() !== 'y') {
  console.log('Keeping your existing .env. Run `npm run doctor` to check it.');
  rl?.close();
  process.exit(0);
}

const env = {};
env.DEPUTY_TRACKER = (await askReq('Tracker (jira / github)', 'jira')).toLowerCase();

if (env.DEPUTY_TRACKER === 'jira') {
  env.DEPUTY_SITE_URL = await askReq('Jira site URL (e.g. https://acme.atlassian.net)');
  env.DEPUTY_CLOUD_ID = await askReq('Jira cloud id (https://acme.atlassian.net/_edit/cloud/id or the API)');
  env.DEPUTY_USER_EMAIL = await askReq('Your Jira account email');
  env.DEPUTY_API_TOKEN = await askReq('Jira API token (id.atlassian.com/manage-profile/security/api-tokens)');
  env.DEPUTY_PROJECTS = await ask('Limit to project keys, comma-separated (blank = all)');
} else {
  env.DEPUTY_GITHUB_REPO = await askReq('GitHub repo the issues live in (owner/name)');
}

env.DEPUTY_GITHUB_TOKEN = await askReq('GitHub token for opening PRs (github.com/settings/tokens, repo scope)');
env.DEPUTY_CLAUDE_API_KEY = await ask('Anthropic API key (blank = use your Claude Code subscription auth)');
env.DEPUTY_LABEL = await ask('Pickup label', 'ai-ready');
env.DEPUTY_REPOS = await ask('Repo paths the dashboard may deputize, comma-separated (blank = CLI only)');
env.DEPUTY_WORKTREE_SETUP = await ask('Setup command per worktree so tests/hooks pass (e.g. "bundle install && yarn install")');

const defaults = { DEPUTY_CHECK_INTERVAL: '300', DEPUTY_PR_LABEL: 'ai-automated', DEPUTY_DASHBOARD_PORT: '4319' };
const lines = ['# Written by `npm run setup`. See .env.example for the full list of knobs.'];
for (const [k, v] of Object.entries({ ...defaults, ...env })) {
  lines.push(/[ "'&|]/.test(v) ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`);
}
writeFileSync(ENV, lines.join('\n') + '\n');
console.log(`\n  Wrote ${ENV}`);

stdout.write('  Validating tracker credentials… ');
try {
  const out = execFileSync('node', [join(ROOT, 'lib', 'tracker-cli.mjs'), 'list-ready'], {
    env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const n = out.split('\n').filter(Boolean).length;
  console.log(`ok ✓  (${n} ticket${n === 1 ? '' : 's'} labelled "${env.DEPUTY_LABEL}" assigned to you)`);
} catch (e) {
  console.log('failed ✗');
  console.log('  ' + String(e.stderr || e.message).trim().split('\n').slice(-2).join('\n  '));
  console.log('  Fix the values in .env (or re-run `npm run setup`), then `npm run doctor`.');
}

console.log('\n  Next:');
console.log('    npm run doctor        # verify prerequisites + credentials');
console.log('    cd <your-repo> && ' + join(ROOT, 'bin', 'daemon') + ' start');
console.log('    npm run dashboard     # http://localhost:' + (env.DEPUTY_DASHBOARD_PORT || defaults.DEPUTY_DASHBOARD_PORT) + '\n');
rl?.close();
