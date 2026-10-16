<img src="docs/icon.svg" width="72" alt="Deputy" />

# Deputy

**Point it at your backlog. It ships PRs while you sleep.**

A local daemon that watches a tracker (Jira or GitHub Issues) for ready,
AI-labelled work items and resolves each one autonomously with the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk):
isolated git worktree → implement → push → draft PR → move the item forward.
Comes with a live web dashboard.

![Deputy dashboard](docs/dashboard.png)

---

## The idea

**You're the sheriff.** You *deputize* a repo and a **deputy** patrols it, watching
for ready tickets. When it finds one it takes the **case** — spins up an isolated
worktree, writes the code, and opens a draft PR. You can watch any deputy work and
**chat with it live** from the dashboard, and it **fixes its own red CI**.

## Why

You label a ticket `ai-ready`. A few minutes later there's a draft PR waiting for
review and the ticket is in review. No prompts to babysit, no copy-pasting
tickets into a chat window. It runs on your machine, uses your credentials, and
every change lands in its own throwaway git worktree so it never touches what
you're working on.

## Highlights

- **Fully autonomous loop** — poll → implement → push → draft PR → advance the item.
- **Fixes its own CI** — watches its PRs; when CI goes red it pulls the failures +
  annotations and pushes a fix automatically.
- **Chat with any deputy live** — open a case and talk to the agent mid-run; it keeps
  full context (💬 case log). Or `deputy continue <TICKET> "…"`. No PR/Jira comments.
- **Pluggable trackers** — Jira and GitHub Issues built in; add another in ~80 lines.
- **Not locked to Claude** — the agent is a swappable command (`DEPUTY_AGENT_CMD`).
- **Isolated by construction** — one git worktree per item, off `origin/main`,
  on a detached HEAD, with its own deps installed. Your working tree is never touched.
- **Concurrent** — processes multiple items at once, each fully sandboxed.
- **Live dashboard** — deputies on patrol, their open cases nested beneath with
  streaming logs + live chat, recent cases, and one-click deputize / stand down.
- **Zero company lock-in** — all config lives in `.env`; the repo carries no
  secrets and nothing employer-specific. Fork it, point it anywhere.

## Quickstart

```bash
cp .env.example .env     # fill in your tracker + GitHub credentials
npm install              # for the dashboard (the daemon installs its own runtime deps)
```

Run it **from the repo you want it to work on**:

```bash
cd ~/code/my-app
/path/to/deputy/bin/daemon start      # also: stop | status
```

Launch the dashboard:

```bash
npm run dashboard        # http://localhost:4319
```

Other commands:

```bash
bin/daemon restart
bin/daemon continue <TICKET> "also handle the empty state"   # follow-up on its PR
bin/daemon stop-ticket <TICKET>                              # cancel one in-flight job
```

## Talking to deputies (no PR/Jira comments)

- **Live chat:** on the dashboard, open a case and type in the reply box — the
  message streams straight into that running agent's session (full context kept),
  and you watch it think and respond live. **Call off** cancels a case.
- **Follow-up on an existing PR:** `deputy continue <TICKET> "…"` (or the UI)
  re-checks-out that PR's branch, runs the agent with your note, and pushes to the
  same PR.
- **CI is handled automatically** — when a deputy's PR goes red, it reads the failing
  checks + annotations and pushes a fix without being asked.

## Trackers

Pick where work comes from with `DEPUTY_TRACKER`:

| Tracker  | Polls                      | "started" / "done"        |
|----------|----------------------------|---------------------------|
| `jira`   | JQL: label + status        | moves the ticket's status |
| `github` | open issues with a label   | swaps labels              |

Each tracker is one small module in [`lib/trackers/`](lib/trackers/) implementing
six methods — `listReady`, `getItem`, `markStarted`, `markDone`, `itemUrl`,
`prRef`. Drop in `linear.mjs`, register it in
[`lib/trackers/index.mjs`](lib/trackers/index.mjs), and you're done. The daemon,
the agent, and the dashboard are all tracker-agnostic.

## How it works

```
         ┌──────────── bin/daemon (one per repo) ─────────┐
 tracker │  poll ready items  ──▶  for each item:         │
  (Jira/ │                          • git worktree off origin/main
  GitHub)│                          • run the agent (Claude Agent SDK)
         │                          • push branch, open draft PR          │
         │                          • mark the item done                  │
         └────────────────────────────────────────────────┘
                     ▲                         │ reads /tmp state
                     │ start / stop            ▼
              server/server.mjs  ◀──────  web dashboard (or a future menu bar)
```

- The agent runs with an **in-process MCP server** (`mcp__tracker__*`) so it can
  read the item and mark it done through whatever tracker is configured — it
  never learns the backend.
- **Live sessions:** each case's agent runs with a per-case input channel
  (`DEPUTY_INPUT`, set by the daemon). The dashboard reply box / `/api/say` stream
  messages into the open session; a `SIGUSR1` nudge makes follow-ups fire instantly
  instead of waiting for the poll.
- The dashboard and control API are decoupled: the API reads daemon state from
  `/tmp` and shells out to `bin/daemon`, so any front-end (web, a macOS menu bar
  widget, a CLI) can reuse the same endpoints: `/api/status`, `/api/start`,
  `/api/stop`, `/api/stop-case`, `/api/log`, `/api/continue`, `/api/say`.

## Layout

```
bin/daemon                   the poll-and-resolve loop (bash)
lib/claude-agent-runner.mjs  the Agent SDK runner + in-process tracker MCP tools
lib/trackers/                one module per backend (jira, github-issues, …)
lib/tracker-cli.mjs          bash↔tracker bridge (list-ready / start / url / ref)
config.sh                    loads .env into the environment
server/server.mjs            control + status HTTP API
server/public/               the dashboard (vanilla JS, no build step)
```

## Configuration

Needs `node` ≥18, `git`, `gh` (authenticated), and `jq`. The daemon installs its
own agent deps into `<repo>_deputy/` on first start.

Everything is driven by `DEPUTY_*` variables in `.env` — see
[`.env.example`](.env.example) for the full list. Required: tracker credentials +
a GitHub token. Notable knobs:

- `DEPUTY_TRACKER` — `jira` | `github`
- `DEPUTY_REPOS` — repo paths the dashboard can deputize (one daemon per repo)
- `DEPUTY_WORKTREE_SETUP` — command run in each fresh worktree, e.g. `bundle install && yarn install` (so tests/hooks pass)
- `DEPUTY_AGENT_CMD` — the agent command; defaults to the bundled Claude runner, swap for any other
- `DEPUTY_PR_LABEL` — label put on deputy PRs (also how CI auto-fix finds them)
