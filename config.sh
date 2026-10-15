# Sourced by bin/daemon. Loads config from .env (this repo) and maps the
# JIRA_AUTOMATION_* variables to the working vars the daemon uses, with defaults.
# Nothing company-specific lives in code — it all comes from .env.

JIRA_DAEMON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer this repo's .env; fall back to a .env.local in the repo the daemon runs in.
if [ -f "$JIRA_DAEMON_ROOT/.env" ]; then
  set -a; source "$JIRA_DAEMON_ROOT/.env"; set +a
elif [ -f "$PWD/.env.local" ]; then
  set -a; source "$PWD/.env.local"; set +a
fi

# Connection
JIRA_USER_EMAIL="${JIRA_AUTOMATION_USER_EMAIL}"
JIRA_API_TOKEN="${JIRA_AUTOMATION_API_TOKEN}"
JIRA_CLOUD_ID="${JIRA_AUTOMATION_CLOUD_ID}"
JIRA_SITE_URL="${JIRA_AUTOMATION_SITE_URL:-}"
GITHUB_TOKEN="${JIRA_AUTOMATION_GITHUB_TOKEN}"
ANTHROPIC_API_KEY="${JIRA_AUTOMATION_CLAUDE_API_KEY}"

# Ticket selection
JIRA_PROJECTS="${JIRA_AUTOMATION_PROJECTS:-}"
JIRA_LABEL="${JIRA_AUTOMATION_LABEL:-ai-ready}"

# Workflow status names
JIRA_STATUS_READY="${JIRA_AUTOMATION_STATUS_READY:-Groomed}"
JIRA_STATUS_START="${JIRA_AUTOMATION_STATUS_START:-In Progress}"
JIRA_STATUS_DONE="${JIRA_AUTOMATION_STATUS_DONE:-In Review}"

# Behavior
CHECK_INTERVAL="${JIRA_AUTOMATION_CHECK_INTERVAL:-300}"
JIRA_TEST_INSTRUCTIONS="${JIRA_AUTOMATION_TEST_INSTRUCTIONS:-Run the automated tests relevant to your change (see README/CONTRIBUTING). Fix failures you introduced; ignore unrelated pre-existing ones.}"

# Export the vars the Node runner reads from the environment
export JIRA_CLOUD_ID JIRA_USER_EMAIL JIRA_API_TOKEN ANTHROPIC_API_KEY GITHUB_TOKEN
