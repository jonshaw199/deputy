# Contributing to Deputy

How the pieces fit together, how to run it locally, how to test it, and how to
extend it. For what Deputy is and how to use it, see the [README](README.md).

## Layout

```
bin/daemon                   the poll-and-resolve loop (bash)
lib/claude-agent-runner.mjs  the Agent SDK runner + in-process tracker MCP tools
lib/trackers/                one module per backend (jira, github-issues, …)
lib/tracker-cli.mjs          bash↔tracker bridge (list-ready / start / url / ref)
config.sh                    loads .env into the environment
server/server.mjs            control + status HTTP API
server/public/               the dashboard (vanilla JS, no build step)
test/                        node:test suite
```

## The three moving parts

- **`bin/daemon`** (bash), one process per repo. Polls the tracker; for each ready
  ticket it creates a git worktree, runs the agent, opens the PR, and watches its own
  PRs for red CI. Backgrounded via `nohup … __run`; a `SIGUSR1` makes it drain the
  follow-up queue immediately.
- **`lib/claude-agent-runner.mjs`** (node), runs the Claude Agent SDK inside a
  worktree. One-shot by default; a **live session** when `DEPUTY_INPUT` is set: it
  tails that file and streams each line into the same `query()` (full context), closing
  on `__exit__` or idle.
- **`server/server.mjs` + `server/public/`**, the dashboard. Reads daemon state from
  `/tmp` (read-only) and acts by shelling out to `bin/daemon` or writing the input/queue
  files. Vanilla JS, no build step.

Key design points:

- The agent runs with an **in-process MCP server** (`mcp__tracker__*`) so it can
  read the item and mark it done through whatever tracker is configured; it never
  learns the backend.
- **Live sessions:** each case's agent runs with a per-case input channel
  (`DEPUTY_INPUT`, set by the daemon). The dashboard reply box / `/api/say` stream
  messages into the open session; a `SIGUSR1` nudge makes follow-ups fire instantly
  instead of waiting for the poll.
- The dashboard and control API are decoupled: the API reads daemon state from
  `/tmp` and shells out to `bin/daemon`, so any front-end (web, a macOS menu bar
  widget, a CLI) can reuse the same endpoints: `/api/status`, `/api/start`,
  `/api/stop`, `/api/stop-case`, `/api/log`, `/api/continue`, `/api/say`.

## Stop-and-wait (parked cases)

Not every ticket is one-shot. The agent has an `mcp__deputy__ask_user` tool: when
it calls it, the runner writes the question to `DEPUTY_ASK_FILE`, records the SDK
session id to `DEPUTY_SESSION_FILE`, and the run ends. The daemon sees the ask file,
keeps the worktree, and marks the case parked (it does not fail it or open a PR).

When you answer (dashboard reply box or `deputy resume <TICKET> "…"`), the daemon
relaunches the runner in the same worktree with `DEPUTY_RESUME=<session id>`. The SDK
persists sessions to disk, so the resumed agent has the entire prior conversation,
even if the original process exited, you waited hours, or the machine rebooted.

On the dashboard, `/api/say` is the single entry point: if the agent is live it
streams the message into the session; if the case is parked it queues a `resume`
request instead (daemon drains it on the `SIGUSR1` nudge).

## State

All runtime state lives in `/tmp`:

```
deputy-<repo>.pid / .log / .meta          a deputy: pid, patrol log, repo path
deputy-item-<ticket>.lock / .log / .meta  a case: real pid, transcript, owning repo
deputy-input-<ticket>.jsonl               a case's live chat channel (runner tails it)
deputy-queue-<repo>.jsonl                 pending continue/resume requests (drained on SIGUSR1)
deputy-ask-<ticket>.txt                   a parked case's question (present => needs your call)
deputy-session-<ticket>.txt               the SDK session id, for resuming after a pause
deputy-paused-<ticket>.meta               a parked case's owning repo
```

## Adding a tracker

Each tracker is one small module in [`lib/trackers/`](lib/trackers/) implementing
six methods: `listReady`, `getItem`, `markStarted`, `markDone`, `itemUrl`, `prRef`.
Drop in `linear.mjs`, register it in
[`lib/trackers/index.mjs`](lib/trackers/index.mjs), and you're done. The daemon,
the agent, and the dashboard are all tracker-agnostic. See
[`jira.mjs`](lib/trackers/jira.mjs) and
[`github-issues.mjs`](lib/trackers/github-issues.mjs) for reference, and add a
`test/trackers-<name>.test.mjs` modeled on the existing ones.

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

## Running locally

```bash
cd <repo> && /path/to/deputy/bin/daemon start
tail -f /tmp/deputy-<repo>.log          # patrol log
tail -f /tmp/deputy-item-<TICKET>.log   # a case's transcript
npm run dashboard                        # the UI
```

## Gotchas (learned the hard way, keep these)

- The agent must run with **`CLAUDECODE` unset** (`env -u CLAUDECODE`) or the nested
  Claude CLI exits 1.
- Lock files store the job's **real pid via the spawner's `$!`**: bash `$$` is the
  daemon's pid even in a backgrounded subshell, and macOS bash 3.2 has no `$BASHPID`.
  This is why `stop-ticket` kills the case and not the whole daemon.
- The poll sleep is `sleep … & wait $!` so a `SIGUSR1` can interrupt it.
- **Quote any `.env` value with spaces** or `source` mangles it.
