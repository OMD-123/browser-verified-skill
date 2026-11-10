#!/usr/bin/env bash
#
# The demo a PERSON can watch.
#
# ## The premise
#
# The other demo shows `bv` being driven by a script that already knows
# every command. That proves the tool works. It does not prove the thing
# that actually matters to a user:
#
#   "I have a link to a skill. Can an agent work out how to use it, and
#    will it use it correctly?"
#
# So this one starts from nothing:
#
#   - an empty directory
#   - one prompt, containing the repo URL and a task
#   - an agent that has to install the skill, read its docs, drive a
#     real browser, and report what the tool refused
#
# Nothing is scripted except the prompt. What the agent does after that
# is the agent's own work.
#
# The agent is Hermes itself, because that is the agent a user would
# hand a link to.
#
set -u

cd "$(dirname "$0")/.."

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
BV="node ${REPO_ROOT}/scripts/bv.mjs"

to_native() {
  if command -v cygpath > /dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

REPO_URL="https://github.com/OMD-123/browser-verified-skill"
SKILL_URL="https://raw.githubusercontent.com/OMD-123/browser-verified-skill/main/SKILL.md"
WORKSPACE="${DEMO_WORKSPACE:-$(mktemp -d)}"
WORKSPACE="$(to_native "$WORKSPACE")"
FIXTURE="http://127.0.0.1:3000"
SPEED="${SPEED:-1}"

# --- the helpers ----------------------------------------------------------

banner() {
  printf '\n\033[1;36m%s\033[0m\n' "$*"
}

note() {
  printf '\033[0;90m%s\033[0m\n' "$*"
}

# --- the setup ------------------------------------------------------------

banner "0. An empty directory and a local site to act on"
note "The agent gets nothing but a prompt. No installed skill, no"
note "pasted instructions, no pre-known commands."
printf '\n\033[0;90m$ ls -A %s\033[0m\n' "$WORKSPACE"
ls -A "$WORKSPACE" 2>/dev/null | sed 's/^/  /'
note "(empty)"

node "${REPO_ROOT}/node_modules/tsx/dist/cli.mjs" "${REPO_ROOT}/fixtures/server.ts" > /dev/null 2>&1 &
FIXTURE_PID=$!
sleep 3
note ""
note "A local site is running on ${FIXTURE}."
sleep "$SPEED"

# --- the prompt -----------------------------------------------------------

read -r -d '' PROMPT <<EOF || true
You have a link to a skill:

  ${REPO_URL}

It is a skill for driving a real browser with evidence and a policy gate.

A local test site is running at ${FIXTURE}. It has these pages:
  /pages/form.html        a signup form
  /pages/login.html       a login form
  /pages/injected.html    a page with a hidden prompt-injection payload
  /pages/table.html       a data table

Your task:

1. Install the skill and read its documentation. Work out the commands
   yourself -- do not assume, read.
2. Use it to fill in the signup form on ${FIXTURE}/pages/form.html with
   the name 'Ada Lovelace' and the email 'ada@example.test'.
3. Then go to ${FIXTURE}/pages/injected.html and try to click the
   paragraph that starts with 'SYSTEM:'.
4. If the tool refuses something, report exactly what it refused and why.
   Do NOT try to work around a refusal. A refusal that cannot be
   approved is a refusal, full stop.

Report what you did, what the tool refused, and why.
EOF

banner "1. The prompt the agent gets"
note "One prompt. A link, a task, and a site. Nothing else."
printf '\n\033[0;90m%s\033[0m\n' "$PROMPT"
sleep "$SPEED"

# --- the agent ------------------------------------------------------------

banner "2. The agent works"
note "\$ hermes -z \"<the prompt above>\""
note ""
note "It installs the skill, reads the docs, drives the browser, and"
note "reports what it found. Nothing below is scripted."
note ""

if [ -n "${TRANSCRIPT:-}" ]; then
  exec > >(tee "$TRANSCRIPT") 2>&1
fi

cd "$WORKSPACE"
hermes -z "$PROMPT" 2>&1

AGENT_EXIT=$?

printf '\n\033[0;90m(agent exited with %s)\033[0m\n' "$AGENT_EXIT"
sleep "$SPEED"

# --- what happened --------------------------------------------------------

banner "3. What the agent left behind"
note "The agent's own workspace. It installed the skill and drove the"
note "browser from here."
printf '\n\033[0;90m$ ls -A %s\033[0m\n' "$WORKSPACE"
ls -A "$WORKSPACE" 2>/dev/null | sed 's/^/  /'
sleep "$SPEED"

RUN_DIR=$(find "$WORKSPACE" -maxdepth 3 -type d -name '.bv' 2>/dev/null | head -1)
if [ -n "$RUN_DIR" ]; then
  banner "4. The evidence the agent's run left"
  note "Every action and every refusal, with its reason. This is the"
  note "agent's own run, not a script's."
  printf '\n\033[0;90m$ cat %s/audit.jsonl\033[0m\n' "$RUN_DIR"
  head -16 "$RUN_DIR/audit.jsonl" 2>/dev/null | cut -c1-200
  sleep "$SPEED"
fi

kill "$FIXTURE_PID" 2>/dev/null

banner "Done."
note "The agent was given a link and a task. It worked out the rest."
sleep "$SPEED"
