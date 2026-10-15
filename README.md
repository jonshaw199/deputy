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
- **Follow-ups without leaving the terminal** — tell it "do X next" on any ticket's
  PR from the dashboard box or `deputy continue <TICKET> "…"`. No PR/Jira comments.
- **Pluggable trackers** — Jira and GitHub Issues built in; add another in ~80 lines.
- **Not locked to Claude** — the agent is a swappable command (`DEPUTY_AGENT_CMD`).
- **Isolated by construction** — one git worktree per item, off `origin/main`,
  on a detached HEAD, with its own deps installed. Your working tree is never touched.
- **Concurrent** — processes multiple items at once, each fully sandboxed.
- **Live dashboard** — every daemon, what it's working on now (streaming logs),
  recent PRs, Start/Stop, and a "tell deputy" box.
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

## Follow-ups & CI fixes (no comments)

Once a ticket has a PR, you can nudge it without touching GitHub/Jira:

- **Dashboard:** type a ticket + instruction in the "tell deputy…" box, hit Send.
- **CLI:** `deputy continue <TICKET> "…"`.

Either way the instruction is queued; deputy re-checks-out that PR's branch, runs
the agent with your note, and pushes to the same PR. **Red CI is handled on its
own** — no need to ask. (These run follow-ups on an existing PR; they don't steer
an agent that's mid-implementation.)

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
- The dashboard and the control API are decoupled: the API reads daemon state
  from `/tmp` and shells out to `bin/daemon`, so any front-end (web, a macOS menu
  bar widget, a CLI) can reuse the same endpoints:
  `/api/status`, `/api/start`, `/api/stop`, `/api/log`, `/api/continue`.

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

Everything is driven by `DEPUTY_*` variables in `.env` — see
[`.env.example`](.env.example) for the full list. Required: tracker credentials
and a GitHub token. One daemon runs per repo; list repo paths in `DEPUTY_REPOS`
to start them from the dashboard.
