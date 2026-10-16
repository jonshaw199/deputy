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
- **Stops and asks instead of guessing** — when a ticket is ambiguous or needs a
  decision, the deputy parks the case, shows its question ("needs your call"), and
  waits. You answer and it resumes the exact same session (works even after it exits,
  so long waits and reboots are fine). Not every ticket is one-shot, and that's OK.
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

## Talking to deputies

![Chatting with a deputy mid-run](docs/chat.png)

- **When a deputy needs your call:** if it hits something it shouldn't decide alone,
  it parks the case and surfaces its question (flagged "needs your call" on the
  dashboard). Open the case, answer in the same box, and it resumes right where it
  left off with full context. The session is saved to disk, so it survives the agent
  exiting, long waits, even a reboot. Or from the CLI: `deputy resume <TICKET> "…"`.
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

Each tracker is one small module (~80 lines) in
[`lib/trackers/`](lib/trackers/); adding another (Linear, etc.) is covered in
[CONTRIBUTING](CONTRIBUTING.md#adding-a-tracker). The daemon, the agent, and the
dashboard are all tracker-agnostic.

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

The agent reads and updates the tracker through an **in-process MCP server**, so
it never learns the backend. The dashboard and control API are decoupled from the
daemon (the API reads `/tmp` state and shells out), so any front-end can reuse the
same endpoints. Full internals, state layout, and gotchas live in
[CONTRIBUTING](CONTRIBUTING.md).

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

## Contributing

Architecture, local dev, the test suite, and hard-won gotchas are in
[CONTRIBUTING](CONTRIBUTING.md). Run the tests with `npm test`.
