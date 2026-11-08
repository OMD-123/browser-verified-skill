# Architecture

This document maps the modules of `browser-verified-skill`, explains the boundaries
between them, and records the invariants that the rest of the codebase relies
on. Design decisions and their rejected alternatives live in
[`DECISIONS.md`](DECISIONS.md).

---

## 1. The shape of the system

`bv` is a **thin client over a stateful daemon**.

```
   bv snapshot ──┐
   bv act ───────┼── HTTP (127.0.0.1, bearer token) ──▶  daemon  ──▶ Playwright
   bv verify ────┘                                                │
                                                                   ▼
                                                            .bv/runs/<id>/
```

The daemon owns the `Browser`, the `BrowserContext`, the open pages, the run
store and the safety state. The CLI owns nothing but argument parsing and
output formatting.

**Why:** a browser session is expensive to create and must be shared across
many short-lived CLI invocations. A long-lived daemon also survives a client
crash, which is an explicit acceptance criterion.

**Consequence:** every security control that must not be bypassed lives in the
daemon. The CLI is not a trust boundary — it is a rendering layer.

---

## 2. Module map

### `src/core/` — the daemon and its plumbing

| Module        | Responsibility                                               |
| ------------- | ------------------------------------------------------------ |
| `daemon.ts`   | Owns the `Browser`, serves the HTTP API, enforces the token. |
| `client.ts`   | The CLI-side HTTP client. Talks to `daemon.json`.            |
| `contexts.ts` | Browser contexts, tabs, popups, frames, storage state.       |
| `exit.ts`     | The documented exit codes.                                   |
| `errors.ts`   | Typed errors carrying an exit code and reason codes.         |
| `output.ts`   | `--json` / human output contract.                            |
| `paths.ts`    | The `.bv/` filesystem layout.                                |
| `clock.ts`    | Injectable clock, so time-dependent logic is testable.       |

### `src/perception/` — turning a page into a compact tree

| Module        | Responsibility                                                         |
| ------------- | ---------------------------------------------------------------------- |
| `snapshot.ts` | Fetch the AX tree, build the node model, allocate refs.                |
| `diff.ts`     | Structural diff between two snapshots.                                 |
| `prune.ts`    | Drop decorative/duplicate/hidden nodes, collapse lists, truncate text. |
| `refs.ts`     | Ref ↔ node identity mapping, stable across steps.                      |
| `tokens.ts`   | Token estimation (chars ÷ 4), flagged as an estimate.                  |

**Invariant:** a ref is bound to a _node key_, not to a tree position. A ref
survives re-snapshots while the element exists, and is invalidated only by a
navigation.

### `src/actions/` — doing things to the page

| Module        | Responsibility                                                     |
| ------------- | ------------------------------------------------------------------ |
| `locate.ts`   | The locator chain: ref → role+name → label → text → test-id → CSS. |
| `act.ts`      | Execute an action and report which strategy won.                   |
| `waits.ts`    | Condition-based waits. Never a fixed sleep.                        |
| `download.ts` | Download capture.                                                  |
| `frames.ts`   | Frame refs and cross-origin traversal.                             |

**Invariant:** the winning locator strategy is recorded on every action. That
record is the input to healing and drift reporting.

### `src/safety/` — the security layer (100% branch coverage required)

| Module                         | Responsibility                                                         |
| ------------------------------ | ---------------------------------------------------------------------- |
| `policy.ts`                    | Action classification and the `allow`/`deny`/`needs_approval` verdict. |
| `approvals.ts`                 | One-time, action-bound approval tokens.                                |
| `planlock.ts`                  | The plan envelope; `off_plan` denial.                                  |
| `taint.ts`                     | Provenance tracking and sink checks.                                   |
| `injection/`                   | Detectors, the nonce envelope, sanitisation.                           |
| `vault.ts`                     | AES-256-GCM secret storage, placeholder resolution.                    |
| `redact.ts`                    | Secret masking applied at every sink.                                  |
| `dryrun.ts`                    | Request interception and the dry-run report.                           |
| `compliance/robots.ts`         | robots.txt fetch, cache, evaluation.                                   |
| `compliance/ratelimit.ts`      | Per-domain token bucket with jitter.                                   |
| `compliance/handoff.ts`        | Human handoff protocol.                                                |
| `compliance/captcha-detect.ts` | CAPTCHA / login wall / 2FA detection.                                  |

### `src/verify/` — proving it worked

| Module          | Responsibility                                        |
| --------------- | ----------------------------------------------------- |
| `conditions.ts` | The success-condition DSL (zod-validated).            |
| `verifier.ts`   | Evaluates conditions; deterministic first.            |
| `evidence.ts`   | Produces the evidence bundle.                         |
| `extract.ts`    | JSON Schema → zod extraction with per-field evidence. |

### `src/compile/` — turning a run into a script

| Module        | Responsibility                                                 |
| ------------- | -------------------------------------------------------------- |
| `recorder.ts` | Normalised IR steps.                                           |
| `compiler.ts` | IR → readable Playwright TypeScript, with inferred assertions. |
| `replay.ts`   | Deterministic re-execution, zero LLM cost.                     |
| `heal.ts`     | Fallback-chain healing; structured failure for the host agent. |
| `drift.ts`    | The drift log: what changed, and when.                         |

### `src/interaction/` — realistic (not evasive) interaction

Typing modes, mouse behaviour, environment profiles built on Playwright
`devices`, rate-limit jitter, and "messy-user mode" restricted to `ownedOrigins`.

### `src/testing/` — QA

The test-suite runner, console capture, a11y (axe-core), the viewport matrix,
perf metrics, visual comparison (hash-based), bug reports, the flaky
classifier, site health scoring, the differential runner, API discovery, the
research module, and the red-team runner.

### `src/agent/` — Mode B only

The agent loop and the cost report.

The loop's defining property: **the safety gate is inside the loop, not above
it**. Every action the model proposes goes through the same `evaluateAction`
the CLI uses. A model that decides to click something it should not is refused
exactly as a human's would be.

The loop stops on its own, with specific reasons: the model finished, the step
budget ran out, it asked a question, it repeated itself, it made no progress,
or an error stopped it.

### `src/llm/` — Mode B only

`LlmClient` interface, the tier router, the budget guard, and cost reporting.
Mode A never touches these.

### `src/mcp/` — the Model Context Protocol

The MCP server and its wiring. Every tool call becomes a daemon request, so
the MCP path and the CLI path go through **one** policy engine. There is no
route through MCP that skips a check.

### `src/memory/` — playbooks and skills

The site memory (playbooks, as an atomically-written JSON file) and the skills. A skill is **data**,
not code: markdown with a frontmatter block, read at runtime, so it can be
reviewed and corrected by the person who knows the site without a rebuild.

A skill never bypasses the policy — the gate does not read skills, so there
is nothing for a skill to influence. And a skill is untrusted text: one that
came from a page is rendered with a marker before its body.

---

## 3. Data flow of a single action

```
CLI                    Daemon                      Browser
 │                       │                            │
 │ act click "Sign in"   │                            │
 ├──────────────────────▶│                            │
 │                       │ 1. classify action         │
 │                       │ 2. policy.evaluate()       │
 │                       │ 3. plan-lock check         │
 │                       │ 4. taint check at the sink │
 │                       │ 5. approval check          │
 │                       │ 6. locate (chain)          │
 │                       │ 7. wait (conditions)       │
 │                       │ 8. act                     │
 │                       │ 9. snapshot + diff         │
 │                       │ 10. redact + record step   │
 │◀──────────────────────┤                            │
 │ {ok, diff, url,       │                            │
 │  consoleErrors,        │                            │
 │  injectionFindings}   │                            │
```

Steps 1–5 are **pure functions** over plain data. That is what makes them
exhaustively testable without a browser.

---

## 4. Invariants

These hold across the codebase and are checked by tests.

1. **No action executes without passing policy, plan-lock, taint and approval.**
   The checks live in the daemon, immediately before execution.
2. **The injection guard wraps every page-derived string** that leaves the
   process towards a model or the host agent.
3. **Secrets are resolved only inside the daemon**, at fill time, and are masked
   at every sink.
4. **Refs are bound to node identity**, not tree position.
5. **Every wait is condition-based.** The only fixed delay in the codebase is
   the rate-limit jitter.
6. **Every run ends with verification.** An unverified run is reported as
   `unverified`, never as success.
7. **Policy files are validated with zod `.strict()`.** An unknown key is an
   error, which is how the forbidden capabilities are rejected at load time.
8. **The compiled flow has no `bv` runtime dependency.** It is a plain
   Playwright script.

---

## 5. Dependency injection

Every module that touches the outside world takes its dependency as a
parameter:

- `Clock` — `src/core/clock.ts`
- `Browser` / `BrowserContext` — passed into the daemon's handlers
- `fetch`-like functions — the compliance and research layers
- `fs` operations — wrapped in small helpers with injectable roots
- `LlmClient` — the interface in `src/llm/client.ts`

This is what lets the safety modules be unit-tested exhaustively and the
browser-dependent modules be tested against the local fixture site.

---

## 6. Run artifacts

```text
.bv/runs/<runId>/
├── audit.jsonl        # append-only, one JSON object per line, secrets masked
├── trace.zip          # Playwright trace, post-processed for secrets
├── network.har        # HAR with redacted headers
├── result.json        # final status, verification result, counters
├── report.html        # human-readable report
└── steps/NNN/
    ├── aria.txt       # full snapshot for this step
    ├── screenshot.png # screenshot for this step
    ├── state.json     # url, storage hash, cookies (redacted)
    └── net.json       # network slice for this step
```

The **compact** snapshot that the CLI returns is derived from `aria.txt`; the
full tree is always written to disk so a run can be re-inspected without
re-running it.
