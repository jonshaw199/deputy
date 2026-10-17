# Sourced by bin/daemon. Loads .env (this repo) so every DEPUTY_* value is
# exported into the environment, where the Node trackers and runner read them.
# Nothing company- or tracker-specific lives in code; it all comes from .env.

DEPUTY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer this repo's .env; fall back to a .env.local in the repo the daemon runs in.
# set -a exports everything sourced, so Node child processes inherit the config.
if [ -f "$DEPUTY_ROOT/.env" ]; then
  set -a; source "$DEPUTY_ROOT/.env"; set +a
elif [ -f "$PWD/.env.local" ]; then
  set -a; source "$PWD/.env.local"; set +a
fi

# Values the bash daemon itself uses.
CHECK_INTERVAL="${DEPUTY_CHECK_INTERVAL:-300}"
TEST_INSTRUCTIONS="${DEPUTY_TEST_INSTRUCTIONS:-Run the automated tests relevant to your change (see README/CONTRIBUTING). Fix failures you introduced; ignore unrelated pre-existing ones.}"

# The Agent SDK reads ANTHROPIC_API_KEY. GITHUB_TOKEN is NOT exported globally on purpose:
# it would override the daemon's own `gh` keychain auth (breaking `gh pr list` etc.); it's
# passed only to the agent in run_agent, where the sandbox has no keychain access.
export ANTHROPIC_API_KEY="${DEPUTY_CLAUDE_API_KEY}"
