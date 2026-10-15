# Sourced by bin/daemon. Loads .env (this repo) so every JIRA_AUTOMATION_* value is
# exported into the environment, where the Node trackers and runner read them.
# Nothing company- or tracker-specific lives in code; it all comes from .env.

JIRA_DAEMON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer this repo's .env; fall back to a .env.local in the repo the daemon runs in.
# set -a exports everything sourced, so Node child processes inherit the config.
if [ -f "$JIRA_DAEMON_ROOT/.env" ]; then
  set -a; source "$JIRA_DAEMON_ROOT/.env"; set +a
elif [ -f "$PWD/.env.local" ]; then
  set -a; source "$PWD/.env.local"; set +a
fi

# Values the bash daemon itself uses.
CHECK_INTERVAL="${JIRA_AUTOMATION_CHECK_INTERVAL:-300}"
JIRA_TEST_INSTRUCTIONS="${JIRA_AUTOMATION_TEST_INSTRUCTIONS:-Run the automated tests relevant to your change (see README/CONTRIBUTING). Fix failures you introduced; ignore unrelated pre-existing ones.}"

# The Agent SDK reads ANTHROPIC_API_KEY; the agent's gh CLI reads GITHUB_TOKEN.
export ANTHROPIC_API_KEY="${JIRA_AUTOMATION_CLAUDE_API_KEY}"
export GITHUB_TOKEN="${JIRA_AUTOMATION_GITHUB_TOKEN}"
