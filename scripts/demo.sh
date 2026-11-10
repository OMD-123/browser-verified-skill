#!/usr/bin/env bash
#
# The demo.
#
# Every line here is a real `bv` command against the local fixture site.
# Nothing is mocked, and the refusals you see are the refusals the tool
# actually produced.
#
# The script is written for a RECORDING: each step prints a banner, then
# runs the command, then waits long enough to be read.
#
set -u

cd "$(dirname "$0")/.."

# Node on Windows needs a native path. Git Bash's /c/... is not one.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
BV="node ${REPO_ROOT}/scripts/bv.mjs"

# A native path for the demo workspace, because Node and the CLI both
# resolve --cwd as a native path.
to_native() {
  if command -v cygpath > /dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

DEMO_DIR="${DEMO_DIR:-$(mktemp -d)}"
DEMO_DIR="$(to_native "$DEMO_DIR")"
FIXTURE="http://127.0.0.1:3000"
SPEED="${SPEED:-1}"

# --- output ---------------------------------------------------------------
#
# The recording. If TRANSCRIPT is set, the demo writes its output there
# with the ANSI colour codes intact, and the renderer turns that into a
# video. The colours are stripped when the output is a terminal, so the
# transcript is exactly what you saw.

if [ -n "${TRANSCRIPT:-}" ]; then
  exec > >(tee "$TRANSCRIPT") 2>&1
fi

# --- helpers ---------------------------------------------------------------

banner() {
  printf '\n\033[1;36m%s\033[0m\n' "$*"
}

note() {
  printf '\033[0;90m%s\033[0m\n' "$*"
}

step() {
  # step "<what to say>" <command...>
  local say="$1"; shift
  banner "$say"
  note "\$ $*"
  "$@" 2>&1
  local code=$?
  printf '\033[0;90m(exit %s)\033[0m\n' "$code"
  sleep "$SPEED"
  return 0
}

# --- setup -----------------------------------------------------------------

note "This is a real run against the local fixture site."
note "Nothing here is mocked. Every refusal is the tool's own."

# A clean workspace.
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

banner "0. A clean workspace"
note "\$ bv init"
$BV --cwd "$DEMO_DIR" init 2>&1
sleep "$SPEED"

banner "0a. The local fixture site"
note "The demo runs against a real local site. No network, no mocks."
note ""
note "\$ npm run fixtures"
node "${REPO_ROOT}/node_modules/tsx/dist/cli.mjs" "${REPO_ROOT}/fixtures/server.ts" > /dev/null 2>&1 &
FIXTURE_PID=$!
sleep 3
note "the fixture site is up on ${FIXTURE}"

banner "0b. Start the session"
note "\$ bv session start"
$BV --cwd "$DEMO_DIR" session start 2>&1
sleep "$SPEED"

banner "0c. A plan, so the gate has something to check against"
cat > "$DEMO_DIR/plan.json" <<'JSON'
{
  "goal": "triage a support ticket",
  "successCondition": { "type": "text_visible", "text": "Account created" },
  "allowedOrigins": ["http://127.0.0.1:3000"],
  "allowedActionClasses": ["read", "navigate", "input", "submit"],
  "trustedValues": ["a-long-enough-password"]
}
JSON
note "\$ bv plan set plan.json"
$BV --cwd "$DEMO_DIR" plan set "$DEMO_DIR/plan.json" 2>&1
sleep "$SPEED"

# --- 1. the injection block ------------------------------------------------

banner "1. A page that tries to take over the agent"
note "The payload is invisible to a sighted user (opacity 0), so it never"
note "shows up in the accessibility tree -- but a snapshot reads the DOM."
note ""
note "\$ bv goto $FIXTURE/pages/injected.html"
$BV --cwd "$DEMO_DIR" goto "$FIXTURE/pages/injected.html" 2>&1
sleep "$SPEED"

banner "2. The snapshot reads the hidden text"
note "\$ bv snapshot"
$BV --cwd "$DEMO_DIR" snapshot 2>&1
sleep "$SPEED"

banner "3. Acting on the injected node is refused -- and cannot be approved"
note "The 'comment' field is fine. The injected paragraph is not."
note ""
note "\$ bv act click '#injected'"
$BV --cwd "$DEMO_DIR" act click '#injected' 2>&1
printf '\033[0;90m(exit %s -- 5 is the injection block)\033[0m\n' "$?"
sleep "$SPEED"

banner "4. A block is not an approval request"
note "There is no approval id. Approving an injection IS the attack succeeding."
note ""
note "\$ bv approvals"
$BV --cwd "$DEMO_DIR" approvals 2>&1
sleep "$SPEED"

banner "5. The agent cannot approve its own actions"
note "The daemon token is not enough. An approval needs the approver"
note "credential, which lives in a file the agent's process never reads."
note ""
note "\$ bv approve <some-action-id>"
$BV --cwd "$DEMO_DIR" approve 'not-a-real-action' 2>&1
printf '\033[0;90m(exit %s)\033[0m\n' "$?"
sleep "$SPEED"

# --- 6. the tainted value --------------------------------------------------

banner "6. A value read out of the page is not trusted"
note "The support ticket says to use a temporary password. The page also"
note "says to type the admin password. The tool does not take the page's"
note "word for it."
note ""
note "\$ bv act fill '#comment' --from-ref <the ticket paragraph>"
$BV --cwd "$DEMO_DIR" act fill '#comment' --from-ref 'e1' 2>&1
printf '\033[0;90m(exit %s)\033[0m\n' "$?"
sleep "$SPEED"

# --- 7. a legitimate run ---------------------------------------------------

banner "8. A real flow, one gated action at a time"
note "\$ bv goto $FIXTURE/pages/form.html"
$BV --cwd "$DEMO_DIR" goto "$FIXTURE/pages/form.html" 2>&1
sleep "$SPEED"

note "\$ bv act fill '#fullname' 'Ada Lovelace'"
$BV --cwd "$DEMO_DIR" act fill '#fullname' 'Ada Lovelace' 2>&1
printf '\033[0;90m(exit %s)\033[0m\n' "$?"
sleep "$SPEED"

note "\$ bv act fill '#email' 'ada@example.test'"
$BV --cwd "$DEMO_DIR" act fill '#email' 'ada@example.test' 2>&1
printf '\033[0;90m(exit %s)\033[0m\n' "$?"
sleep "$SPEED"

note "\$ bv act fill '#password' 'a-long-enough-password'"
$BV --cwd "$DEMO_DIR" act fill '#password' 'a-long-enough-password' 2>&1
printf '\033[0;90m(exit %s -- a password field is a sink, and the plan confirmed it)\033[0m\n' "$?"
sleep "$SPEED"

banner "9. The final submit needs a human -- and the human says yes"
note "Finishing the wizard is a submit. The submit class needs an approval,"
note "and the agent cannot give itself one: the daemon token is not enough."
note ""
note "\$ bv act click 'role=button name=\"Create account\"'"
FINISH_OUT=$($BV --cwd "$DEMO_DIR" --json act click 'role=button name="Create account"' 2>/dev/null)
printf '%s' "$FINISH_OUT" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try {
    const j = JSON.parse(d);
    const data = j.data ?? j;
    console.log('refused:', (data.reasons ?? []).join('; '));
    console.log('class:', data.actionClass ?? 'unknown');
    console.log('rules:', (data.ruleIds ?? []).join(', '));
    console.log('approval id:', data.approvalId ?? '(none)');
  } catch { console.log(d.trim()); }
});
"
printf '\033[0;90m(exit 4 means needs approval)\033[0m\n'
sleep "$SPEED"

note "\$ bv approvals"
$BV --cwd "$DEMO_DIR" approvals 2>&1
sleep "$SPEED"

APPROVAL_ID=$(printf '%s' "$FINISH_OUT" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { const j = JSON.parse(d); console.log((j.data ?? j).approvalId ?? ''); } catch { console.log(''); }
});
")

if [ -n "$APPROVAL_ID" ]; then
  note ""
  note "\$ bv approve $APPROVAL_ID"
  note "(this is the OPERATOR's command, not the agent's -- it carries the"
  note " approver credential, which lives in a file the agent never reads)"
  APPROVE_OUT=$($BV --cwd "$DEMO_DIR" --json approve "$APPROVAL_ID" 2>/dev/null)
  printf '%s\n' "$APPROVE_OUT" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try {
    const j = JSON.parse(d);
    console.log('approved:', j.description ?? j.data?.description ?? '');
  } catch { console.log(d.trim()); }
});
"
  sleep "$SPEED"

  TOKEN=$(printf '%s' "$APPROVE_OUT" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { const j = JSON.parse(d); console.log(j.token ?? j.data?.token ?? ''); } catch { console.log(''); }
});
");

  if [ -n "$TOKEN" ]; then
    banner "9b. The agent retries with the one-time token"
    note "\$ bv act click 'role=button name=\"Create account\"' --approve <token>"
    $BV --cwd "$DEMO_DIR" act click 'role=button name="Create account"' --approve "$TOKEN" 2>&1
    printf '\033[0;90m(exit %s)\033[0m\n' "$?"
    sleep "$SPEED"
  fi
fi

banner "10. Verification: the run is proven, not claimed"
cat > "$DEMO_DIR/condition.json" <<'JSON'
{ "type": "text_visible", "text": "Account created" }
JSON
note "\$ bv verify --condition condition.json"
$BV --cwd "$DEMO_DIR" verify --condition "$DEMO_DIR/condition.json" 2>&1
printf '\033[0;90m(exit %s)\033[0m\n' "$?"
sleep "$SPEED"

# --- 10. compile -----------------------------------------------------------

RUN_ID=$($BV --cwd "$DEMO_DIR" --json audit 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { const j=JSON.parse(d); console.log(j.runId ?? j.data?.runId ?? ''); } catch { console.log(''); }
});
")

if [ -n "$RUN_ID" ]; then
  banner "11. The run compiles into a plain Playwright script"
  note "No gate, no policy, no daemon. Just Playwright. It runs in CI."
  note ""
  note "\$ bv compile $RUN_ID --out flows/login.spec.ts"
  $BV --cwd "$DEMO_DIR" compile "$RUN_ID" --out "$DEMO_DIR/flows/login.spec.ts" 2>&1
  sleep "$SPEED"

  banner "12. The compiled script is a normal Playwright test"
  note "This is the whole point: the evidence becomes code."
  note ""
  head -28 "$DEMO_DIR/flows/login.spec.ts" 2>/dev/null
  sleep "$SPEED"
fi

# --- cleanup ---------------------------------------------------------------

banner "13. The audit trail"
note "Every action, every refusal, with its reason."
note ""
note "\$ bv audit"
$BV --cwd "$DEMO_DIR" audit 2>&1 | head -20
sleep "$SPEED"

$BV --cwd "$DEMO_DIR" session stop > /dev/null 2>&1
kill "$FIXTURE_PID" 2>/dev/null

banner "Done."
note "The refusals are the product."
note "A tool that cannot be stopped from doing something unsafe is not"
note "a tool an agent can be trusted with."
sleep "$SPEED"

note ""
note "DEMO_DIR=$DEMO_DIR"
