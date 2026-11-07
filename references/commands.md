# The command reference

Every command takes `--help` and `--json`, and every command has a
meaningful exit code.

## The exit codes

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
bv snapshot [--full] [--max-tokens N] [--expand ref]
```

The output is a **diff** against the previous snapshot: what changed, not
the whole page. `--full` gives the whole tree.

The refs (`e12`) are stable within a snapshot. Use them in `bv act`.

## Acting

```bash
bv act <kind> <target> [value] [--dry-run] [--approve token]
```

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
bv approve <actionId>
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
