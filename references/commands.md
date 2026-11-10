# The command reference

Every command takes `--help` and `--json`, and every command has a
meaningful exit code.

## The exit codes

| Code | Meaning                    |
| ---- | -------------------------- |
| 0    | ok                         |
| 1    | failure                    |
| 2    | usage error                |
| 3    | policy denied              |
| 4    | needs approval             |
| 5    | **prompt-injection block** |
| 6    | verification failed        |

Exit 5 is the one to alert on. It means the page carried a
prompt-injection payload and the action was **refused**. It is not a
policy denial and it is not a request for approval: an injection block
**cannot be approved**, because approving it is the attack succeeding.
A pipeline that sees exit 5 should stop and let a human look at the
page.

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | ok                                                      |
| 1    | failure — the command ran, the operation did not work   |
| 2    | usage error — the command line was malformed            |
| 3    | policy denied — a rule refused the action               |
| 4    | needs approval — a human has to approve the action      |
| 5    | injection block — the page tried to inject instructions |
| 6    | verification failed — the success condition was not met |

**Exit 3 is not "try again".** It means the action is outside the plan or
the policy. Exit 4 is "ask a human". Exit 6 is "unverified", not
"failed".

## Setup

```bash
bv doctor [--install]       # check node, the browser, the permissions and the policy
bv init                     # create .bv/ and write a default policy
```

### The contact URL

The user agent carries a contact URL so a site owner can reach whoever
is running the automation. It is only there if it is REAL:

- pass `--contact https://yoursite/contact` when starting a session, or
- list your site in the policy's `ownedOrigins`

A placeholder contact is refused. `bv session start --contact
https://your-site/contact` exits 2, because that URL goes nowhere and
"honest" has to mean something. A session with no real contact simply
has no contact in its user agent.

## The sessions

```bash
bv session start [--headed] [--contact url]   # start the browser
bv session status                               # is it running?
bv session stop                                 # stop it
```

The session owns the browser. Every other command talks to it over a
local HTTP API with a bearer token.

## Reading the page

```bash
bv goto <url>                    # navigate
bv snapshot [--full] [--max-tokens N] [--expand ref]
bv tab list|select|close         # tabs and popups
```

The output is a **diff** against the previous snapshot: what changed, not
the whole page. `--full` gives the whole tree.

The refs (`e12`) are stable within a snapshot. Use them in `bv act`.

## Acting

```bash
bv act <kind> <target> [value] [--dry-run] [--approve token]
```

A value typed on the command line is **not trusted** unless a human put
it in the plan's `trustedValues`. A value that came from the page is
always untrusted:

```bash
bv act fill '#email' --from-ref e12        # the value is the text of e12
bv act fill '#email' --from-extract email   # the value is the extracted field
```

Both read the value out of the page and mark it tainted, so the sink
rules apply. A tainted value cannot reach a password, card, OTP or
email-recipient field, and cannot be sent, without an approval.

Kinds: `click`, `dblclick`, `hover`, `type`, `fill`, `select`, `check`,
`uncheck`, `press`, `scroll`, `upload`, `focus`.

A target is a ref (`e12`) or a descriptor:

```
role=button name="Sign in"
label="Email"
text="Continue"
testid=submit
#submit-button
```

`--dry-run` reports what would happen without doing it.

## The plan

```bash
bv plan set <file>       # set the plan-lock
bv plan show             # show it
bv plan amend --goal "..." --add-origin ... --approve <token>
```

An amendment needs an approval, because widening the plan is exactly the
thing the plan exists to prevent.

## Approvals

```bash
bv approvals                        # what is waiting for a human
bv approve <actionId>               # approve with the operator credential
bv approve <actionId> --code CODE   # approve with the one-time code
```

`bv approve` needs the **approver** credential, which lives in
`.bv/approver.token`. The agent's process never reads that file, so an
agent cannot approve its own action. The `--code` form needs no
credential: the short code, shown on the terminal that started the
daemon, is the human's proof.

## The dry run

```bash
bv dryrun-report [--run <runId>]   # what would have been sent, from the last dry run
```

Prints a one-time token bound to that exact action. Use it with
`--approve` on the action it was issued for.

## The vault

```bash
bv vault set <name> [value]
bv vault list
bv vault rm <name>
```

The passphrase comes from `BV_VAULT_PASSPHRASE`. A secret is referenced
in an action with `{{secret:name}}` and is resolved **only inside the
daemon**, at the moment of the fill.

## QA

```bash
bv test --suite f.json [--tag t]                   # run a suite of checks
bv redteam run                                     # test the tool's own guards
bv diff --a <url> --b <url>                        # compare two pages' trees
bv discover-api <runId> [--openapi]                # the endpoints the run actually used
bv research --questions q.json --sources urls.txt  # answer questions from sources
```

## Proof

```bash
bv verify --condition <file>      # check the success condition
bv extract --schema <file>         # pull values out, each with its source
bv rewind --to <n>                 # branch the run from an earlier step
bv report <runId> [--format md|json]
bv audit [runId]
```

## Reuse

```bash
bv compile <runId> --out flows/x.spec.ts   # a plain Playwright script
bv replay <runId> [--var k=v] [--heal]     # deterministic, no LLM cost
bv drift <runId>                            # what changed since the recording
bv memory ls                                # what the tool remembers
```

## QA

```bash
bv diff --a <url> --b <url>       # compare two pages' trees
bv discover-api <runId>           # the endpoints the run actually used
bv research --questions q.json --sources urls.txt
```

## MCP

```bash
bv mcp
```

Serves `snapshot`, `act`, `approve`, `verify`, `extract`, `compile` and
`replay` over the Model Context Protocol on stdio. The MCP path runs the
**same policy engine** — there is no route through MCP that skips a
check.
