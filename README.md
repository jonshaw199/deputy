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

## Day to day

1. **Post a deputy** to a repo — `Deputize` it in the dashboard, or `cd <repo> && /path/to/deputy/bin/daemon start`.
2. **Hand it a case** — label a ticket `ai-ready` (Jira or GitHub Issues). The deputy picks it up on its next patrol (≤ `CHECK_INTERVAL`).
3. **Watch it work** — open the dashboard (`npm run dashboard` → http://localhost:4319). The case shows under its deputy with a streaming log.
4. **Steer it live** — open the case and type in the reply box; it answers in the same session.
5. **It finishes on its own** — opens a draft PR and advances the ticket. If the PR's CI goes red, it fixes it automatically.
6. **Cancel anything** — "call off" a single case, "stand down" a whole deputy.

## Talking to deputies (no PR/Jira comments)

![Chatting with a deputy mid-run](docs/chat.png)

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

| Tracker  | Polls                          | "started" / "done"                |
|----------|--------------------------------|-----------------------------------|
| `jira`   | any ticket with the label      | removes the label, moves status   |
| `github` | open issues with the label     | swaps labels                      |

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

## Tests

```bash
npm test        # node --test, zero extra deps, no build step
```

Covered: the tracker adapters (Jira + GitHub Issues) against a mocked `fetch`,
the tracker factory/contract, the dashboard's log-parsing helpers, and the
control API end to end (status nesting, log, live-chat append, and the input
validation on every POST) against a throwaway state dir on an ephemeral port.
The server exposes a `makeServer({ tmp, repos, siteUrl })` factory so tests run
fully isolated from your real `/tmp` and never shell out to a live daemon.

## Architecture & dev notes

Three moving parts:

- **`bin/daemon`** (bash) — one process per repo. Polls the tracker; for each ready
  ticket it creates a git worktree, runs the agent, opens the PR, and watches its own
  PRs for red CI. Backgrounded via `nohup … __run`; a `SIGUSR1` makes it drain the
  follow-up queue immediately.
- **`lib/claude-agent-runner.mjs`** (node) — runs the Claude Agent SDK inside a
  worktree. One-shot by default; a **live session** when `DEPUTY_INPUT` is set — it
  tails that file and streams each line into the same `query()` (full context), closing
  on `__exit__` or idle.
- **`server/server.mjs` + `server/public/`** — the dashboard. Reads daemon state from
  `/tmp` (read-only) and acts by shelling out to `bin/daemon` or writing the input/queue
  files. Vanilla JS, no build step.

State all lives in `/tmp`:

```
deputy-<repo>.pid / .log / .meta        a deputy: pid, patrol log, repo path
deputy-item-<ticket>.lock / .log / .meta  a case: real pid, transcript, owning repo
deputy-input-<ticket>.jsonl             a case's live chat channel (runner tails it)
deputy-queue-<repo>.jsonl               pending `continue` requests (drained on SIGUSR1)
```

Run / debug locally:

```bash
cd <repo> && /path/to/deputy/bin/daemon start
tail -f /tmp/deputy-<repo>.log          # patrol log
tail -f /tmp/deputy-item-<TICKET>.log   # a case's transcript
npm run dashboard                        # the UI
```

Gotchas (learned the hard way, keep these):

- The agent must run with **`CLAUDECODE` unset** (`env -u CLAUDECODE`) or the nested
  Claude CLI exits 1.
- Lock files store the job's **real pid via the spawner's `$!`** — bash `$$` is the
  daemon's pid even in a backgrounded subshell, and macOS bash 3.2 has no `$BASHPID`.
  This is why `stop-ticket` kills the case and not the whole daemon.
- The poll sleep is `sleep … & wait $!` so a `SIGUSR1` can interrupt it.
- **Quote any `.env` value with spaces** or `source` mangles it.
