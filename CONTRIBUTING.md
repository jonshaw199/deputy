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

## Review comments on open PRs

Each poll, the daemon runs [`lib/pr-watch.mjs`](lib/pr-watch.mjs) and writes
`/tmp/deputy-prs-<repo>.json`: the open PRs it labelled, each with its unresolved
review threads (via `gh` + a GraphQL `reviewThreads` query). The dashboard reads that
file and shows finished-but-open PRs under "Open PRs", flagging comment counts. Deputy
never writes on the PR. When you reply from a PR entry, the dashboard posts to
`/api/continue` with the PR's `branch`, so `continue_ticket` works on the real branch
(including random-named collaboration branches, via the new branch arg) and pushes
there. You handle the thread replies/resolves yourself.

## Collaborating in your worktree

Before making its own throwaway worktree, `process_ticket` calls
`detect_user_worktree`, which walks ticket -> open PR -> head branch ->
checked-out worktree (`gh pr list` + `git worktree list`). If you already have that
branch open somewhere, the deputy works in *that* directory on *that* branch and
pushes to the same PR, and it does not delete the worktree afterward. The PR is the
only link, so it needs no branch-naming convention; before a PR exists there's
nothing to join on, so it starts fresh. The runner finds the Agent SDK via
`DEPUTY_SDK_DIR` when your worktree wasn't set up by the daemon.

## Stacked PRs (dependent tickets)

Label a whole epic `ai-ready` and the deputy figures out the order itself. Before a
ticket is marked started, `process_ticket` runs `resolve_base_ref`, which reads the
ticket's blockers (`tracker-cli blockers <id>` -> the tracker's optional `getBlockers`)
and inspects each blocker's PR with `gh`:

- **no blockers / all merged** -> build off `origin/main` (normal).
- **a blocker has no PR yet** (not started) or **more than one blocker still open**
  -> `WAIT`: leave the label on, write `deputy-blocked-<ticket>.*`, and re-check next
  poll. The dashboard shows it as a grey **blocked** case.
- **exactly one open blocker** -> `STACK`: branch the worktree off `origin/<parent>`
  and tell the agent to open the PR with `--base <parent>`. A `deputy-stack-<ticket>.json`
  records `{parent_branch, child_branch, last_parent_sha}`.

`maintain_stacks` (each poll) keeps recorded stacks fresh, skipping any child that's
working, parked, blocked, or checked out in your own worktree: when the parent's head
moves it rebases the child onto it; when the parent **merges** it rebases the child onto
`main` and retargets the PR base. The clean rebase force-pushes with `--force-with-lease`
automatically; a conflict is aborted to a safe state and handed to the agent
(`continue_ticket ... rebase`) to resolve. Disable the auto-rebase with
`DEPUTY_STACK_AUTOSYNC=false` (stacking at creation still works).

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
deputy-blocked-<ticket>.meta / .txt       a dependency-blocked case: owning repo + reason
deputy-failed-<ticket>.meta / .txt        a run that produced no PR: owning repo + error
deputy-stopped-<ticket>.meta              a case you stopped (✕) but kept, re-runnable with ▶
deputy-stack-<ticket>.json                a stacked PR's parent/child branches + last parent sha
```

Durable state (survives reboot — `/tmp` does not) lives under `<repo>_deputy/cases/`:

```
cases/<ticket>.json       the case journal: status, worktree, branch, base/stack, project
cases/<ticket>.session    the SDK session id (written live, the instant it's known)
```

## Resilience (resume after restart / reboot / ✕)

A case's durable truth is the journal + session above; `/tmp` is just the live view. The
runner writes the session id on the *first* message, so a killed agent is still resumable.

- **Daemon/computer restart:** `reconcile_cases` runs at startup. For each journal left in
  `working` (i.e. interrupted) it `resume_or_restart`s: resume the SDK session in its worktree,
  else finish the push/PR if the branch has work, else re-run from scratch. Stale locks from
  killed agents are cleared; `failed`/`stopped` journals rehydrate their `/tmp` markers so the
  cards reappear.
- **No run vanishes:** a run that ends without a PR is recovered by the daemon (it pushes the
  branch + opens the PR itself, outside the agent sandbox); only if there's nothing to recover
  does it become a visible red `failed` card.
- **✕ then change your mind:** `stop-ticket` keeps the journal/worktree/session and shows a
  muted `stopped` card; ▶ (`rerun`) brings it back, `forget-ticket` deletes it for real.
- **Survive a reboot:** `bin/daemon autostart-install` writes a macOS LaunchAgent that runs
  `bin/daemon foreground` (supervised) at login, so the daemon comes back and reconciles on its own.

## Adding a tracker

Each tracker is one small module in [`lib/trackers/`](lib/trackers/) implementing
six methods: `listReady`, `getItem`, `markStarted`, `markDone`, `itemUrl`, `prRef`
(plus an optional `getBlockers` for stacked PRs).
Drop in `linear.mjs`, register it in
[`lib/trackers/index.mjs`](lib/trackers/index.mjs), and you're done. The daemon,
the agent, and the dashboard are all tracker-agnostic. See
[`jira.mjs`](lib/trackers/jira.mjs) and
[`github-issues.mjs`](lib/trackers/github-issues.mjs) for reference, and add a
`test/trackers-<name>.test.mjs` modeled on the existing ones.

## Swapping the agent (runner protocol)

The daemon never calls Claude directly — it runs `DEPUTY_AGENT_CMD` in the worktree and
talks to it only through environment variables, a few files, and stdout. All Claude-specific
code lives in one place, [`lib/claude-agent-runner.mjs`](lib/claude-agent-runner.mjs); it's
just the default. Any command that speaks the contract below can replace it.

**What the runner reads** (environment):

- `DEPUTY_PROMPT` — the task. The runner runs in the worktree (its cwd), implements, commits,
  pushes, and opens the draft PR.
- `DEPUTY_GITHUB_TOKEN` — passed through for `gh`.
- *(optional, for the premium features)* `DEPUTY_INPUT` — a file to tail for live follow-up
  messages (one per line); `DEPUTY_SESSION_FILE` — write your agent's session handle here;
  `DEPUTY_RESUME` — resume that handle instead of starting fresh; `DEPUTY_ASK_FILE` — write a
  question here and exit to "park" the case for the human.

**What the runner writes:**

- Everything to **stdout** — that's the dashboard log.
- The **PR url** somewhere in stdout (the daemon greps `github.com/<owner>/<repo>/pull/<n>`).
- Its **session id** to `DEPUTY_SESSION_FILE` — enables warm resume + the editor handoff.

**Graceful degradation.** A bare command that just does prompt → PR works. The premium
features — live chat, park-and-ask, warm resume — are *protocol features*: a runner that
implements the file contract above gets them; one that doesn't still ships PRs.

**Tracker access.** The default runner exposes the tracker as an in-process MCP server
(`mcp__tracker__get_item` / `finish`). A different agent can register the same tracker via its
own MCP config, or read the ticket from `DEPUTY_PROMPT` (the item URL is always included).

**Editor handoff.** The dashboard's "Open in editor" button runs `DEPUTY_OPEN_CMD` with
`$DEPUTY_WORKTREE` + `$DEPUTY_SESSION` in the environment (default: open the folder in VS Code
and resume the Claude Code session). Set it to match your agent.

**Example — opencode.** Point `DEPUTY_AGENT_CMD` at a wrapper that runs
`opencode run "$DEPUTY_PROMPT" --format json` (with stdin closed), parses `sessionID` from the
JSON stream into `DEPUTY_SESSION_FILE`, and on `DEPUTY_RESUME` runs `opencode run -s <id>`.
Register the tracker under the `mcp` key in `opencode.json`. `DEPUTY_OPEN_CMD` opens the folder
in VS Code (opencode has no session deep-link URI). Live mid-run chat and park-and-ask would
need opencode's HTTP server (`opencode serve`) rather than the one-shot `run`.

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
