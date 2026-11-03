# CLAUDE.md — Deputy

Deputy is a company-agnostic AI coding daemon + dashboard: it watches a tracker (Jira / GitHub
Issues) for labelled, assigned tickets and autonomously resolves each (worktree → implement →
verify → draft PR), with a live dashboard. User-facing docs: `README.md`. Setup / dev depth:
`CONTRIBUTING.md`. This file is what a coding agent needs to extend Deputy safely.

## Layout

- `bin/daemon` — bash. The poll loop `watch_and_process` + per-repo watchers (`check_for_ci_failures`,
  `check_for_conflicts`, `freshen_stale_branches`, `check_for_unrelated_changes`/relevance),
  `process_ticket` (build one ticket), and helpers (`recover_pr`, `finalize_relevance`,
  `verify_and_optimize`, continue/resume, `maintain_stacks`).
- `lib/*.mjs` — node. Tracker adapters (`trackers/jira.mjs`, `trackers/github-issues.mjs`), the agent
  runner (`claude-agent-runner.mjs`), and one-shot AI judges (`route.mjs`, `verify.mjs`, `relevance.mjs`).
- `server/` — the dashboard (`server.mjs` + `public/`).
- Config: `config.sh` sources `.env` (shared) then a repo's `.env.local` (per-repo override). Every knob
  is documented in `.env.example` — add new ones there.

## Adding a feature — copy the existing shape (see PATTERN RULE)

- **New watcher:** mirror `check_for_conflicts` verbatim — list labelled PRs → per-sha guard in
  `$PROCESSED_FILE` → skip busy/parked/blocked/foreign-worktree cases → act → call it from
  `watch_and_process`.
- **New AI judge:** copy `route.mjs` / `verify.mjs` / `relevance.mjs` — `resolveSdk()`,
  `query({ cwd, allowedTools, maxTurns })`, parse a single JSON verdict, exit codes; export the pure
  `parse*` function and unit-test it in `test/*.test.mjs`.
- **New config knob:** read `${DEPUTY_X:-default}` and document it in `.env.example`.
- Verify before running: `bash -n bin/daemon` and `node --test`.

## Hard-won rules (do not relearn these)

- **Prefer commit-time / once over a repeating watcher.** A watcher that scans AND edits open PRs
  self-triggers — its own push is a new sha, which re-triggers it → infinite loop. Relevance runs once
  at case success for exactly this reason.
- **Per-sha guards don't stop self-made loops** (each fix is a new sha). Anything that pushes must
  **cap attempts per branch and reset on green** (see the CI-fix cap, `DEPUTY_CI_FIX_MAX`).
- **Prove before merging.** Build on a branch, test locally (controlled repo or a real ticket), merge
  only once proven. This discipline caught an infinite loop before it shipped.
- **Restart from the repo dir:** `( cd <repo> && bin/daemon restart )`. A bare restart spawns a bogus
  daemon named after the wrong directory.
- **macOS has no `setsid`.** Persist background processes with `nohup … & disown` (both the daemon and
  the dashboard die on shell exit otherwise).
- **`env -u CLAUDECODE`** before invoking the Agent SDK nested (otherwise the SDK's pipe throws EPIPE).
- **Stay agent-agnostic:** never couple to Claude; inject behavior via the `DEPUTY_*_CMD` seams.
- **This is a public portfolio repo:** commit author is `Jon Shaw <jonshaw199@gmail.com>` (never a work
  email); keep ZERO company data (examples use generic acme/webapp); `.env` is gitignored — never
  commit secrets.

## Runtime state

- Durable, per repo: `<repo>_deputy/` (journal `cases/`, stacks `stacks/`).
- Ephemeral: `${DEPUTY_TMP:-/var/tmp}/deputy-*` (logs, locks, pid/meta, per-sha guards).
- Dashboard: `node server/server.mjs` on `DEPUTY_DASHBOARD_PORT` (default 4319); start it detached.
