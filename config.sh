# Sourced by bin/daemon. Loads .env (this repo) so every AIDAEMON_* value is
# exported into the environment, where the Node trackers and runner read them.
# Nothing company- or tracker-specific lives in code; it all comes from .env.

AIDAEMON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer this repo's .env; fall back to a .env.local in the repo the daemon runs in.
# set -a exports everything sourced, so Node child processes inherit the config.
if [ -f "$AIDAEMON_ROOT/.env" ]; then
  set -a; source "$AIDAEMON_ROOT/.env"; set +a
elif [ -f "$PWD/.env.local" ]; then
  set -a; source "$PWD/.env.local"; set +a
fi

# Values the bash daemon itself uses.
CHECK_INTERVAL="${AIDAEMON_CHECK_INTERVAL:-300}"
TEST_INSTRUCTIONS="${AIDAEMON_TEST_INSTRUCTIONS:-Run the automated tests relevant to your change (see README/CONTRIBUTING). Fix failures you introduced; ignore unrelated pre-existing ones.}"

# The Agent SDK reads ANTHROPIC_API_KEY; the agent's gh CLI reads GITHUB_TOKEN.
export ANTHROPIC_API_KEY="${AIDAEMON_CLAUDE_API_KEY}"
export GITHUB_TOKEN="${AIDAEMON_GITHUB_TOKEN}"
