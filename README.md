# Jira AI Daemon

A local daemon that watches Jira for ready, AI-labelled tickets and resolves each
one autonomously with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk):
it creates an isolated git worktree, implements the ticket, pushes a branch, opens
a draft PR, and moves the ticket forward. Ships with a web dashboard.

Nothing here is tied to a specific company. Point it at any Jira Cloud site and any
GitHub repo via `.env`.

## Trackers (where work items come from)

The work source is pluggable. Pick one with `JIRA_AUTOMATION_TRACKER`:

- `jira` — polls by JQL (label + status); marks progress by moving the ticket's status.
- `github` — polls open GitHub issues by label; marks progress by swapping labels.

Each tracker is one small module in `lib/trackers/` implementing six methods
(`listReady`, `getItem`, `markStarted`, `markDone`, `itemUrl`, `prRef`). To add
Linear or anything else, drop in a module and register it in `lib/trackers/index.mjs`.
The daemon, the agent, and the dashboard are all tracker-agnostic.

## Setup

```bash
cp .env.example .env     # fill in your Jira + GitHub credentials
npm install              # only needed for the dashboard; the daemon installs its
                         # own runtime deps into <repo>_automation on first start
```

Required in `.env`: `JIRA_AUTOMATION_USER_EMAIL`, `JIRA_AUTOMATION_API_TOKEN`,
`JIRA_AUTOMATION_CLOUD_ID`. See `.env.example` for the full list, including your
workflow status names and the label to watch.

## Run the daemon

Run it **from the repo you want it to work on** (that repo is the base for every
worktree):

```bash
cd ~/code/my-app
/path/to/jira-daemon/bin/daemon start    # also: stop | status
```

It polls Jira every `JIRA_AUTOMATION_CHECK_INTERVAL` seconds for tickets with your
label in the `STATUS_READY` status, and for each one moves it to `STATUS_START`,
does the work, opens a draft PR, and moves it to `STATUS_DONE`.

Logs:

```bash
tail -f /tmp/jira-automation-daemon-<repo>.log   # the poller
tail -f /tmp/jira-automation-<TICKET>.log        # one ticket, streaming
```

## Dashboard

```bash
npm run dashboard     # http://localhost:4319
```

Shows every running daemon, what each is working on right now (with live logs),
recent outcomes with PR links, and Start/Stop controls. To enable Start from the
UI, list the repo paths it may launch in via `JIRA_AUTOMATION_REPOS`.

## Layout

```
bin/daemon                 the poll-and-resolve daemon (bash)
lib/claude-agent-runner.mjs the Agent SDK runner + in-process Jira MCP tools
config.sh                  loads .env and maps it to the daemon's variables
server/server.mjs          control + status HTTP API (the shared "brain")
server/public/             the web dashboard (vanilla JS, no build step)
```

The dashboard and the API are decoupled: the API reads daemon state from `/tmp`
and shells out to `bin/daemon`, so other front-ends (e.g. a macOS menu bar widget)
can reuse the same endpoints (`/api/status`, `/api/start`, `/api/stop`, `/api/log`).
