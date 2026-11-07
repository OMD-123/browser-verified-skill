# Security model

`browser-verified` (CLI: `bv`) is a browser-automation toolkit built for
**verified, auditable, replayable** automation. It is explicitly **not** a
stealth, evasion, or bulk-abuse tool.

This document states what the toolkit protects against, what it does **not**
protect against, and where the boundaries of its guarantees are.

---

## 1. Threat model

The toolkit assumes:

- **T1 — Hostile page content.** Any page may contain text crafted to influence
  an automated agent: hidden instructions, fake system banners, poisoned
  attributes, forged protocol tags, exfiltration URLs.
- **T2 — Compromised or careless third-party sites.** Pages may be slow, may
  change structure without notice, may serve malicious filenames, may redirect
  to disallowed origins.
- **T3 — Untrusted values flowing into sinks.** Text read from a page may end up
  in a field that causes money to move, credentials to leak, or a message to be
  sent to an attacker's address.
- **T4 — The host agent itself may be wrong.** An LLM may hallucinate a target,
  misread the page, or try to act outside its brief.
- **T5 — A local attacker reading files.** Someone with read access to the
  workspace may try to harvest secrets from run artifacts.

Out of scope: an attacker with code execution as the user, a malicious
`node_modules` dependency, a compromised kernel, or a hostile _local_ user who
can read the vault passphrase from the environment.

---

## 2. Controls, by layer

### 2.1 Policy engine (`src/safety/policy.ts`)

Every action is classified into an action class by a pure function using the
element's role, accessible name, text, form context and the HTTP method that
would result. Classes: `read`, `navigate`, `input`, `submit`, `destructive`,
`financial`, `messaging`, `download`, `upload`.

The classifier is **conservative by construction**: when it cannot determine a
class with confidence, the result is `needs_approval`, never `allow`. An
unknown button is not silently allowed.

Verdicts are `allow | deny | needs_approval`, each carrying machine-readable
`ruleIds` and human-readable `reasons`.

### 2.2 Approval gate (`src/safety/approvals.ts`)

Actions in a class listed under `actionClasses.approvalRequired` (and any action
the classifier could not confidently classify) require approval. Approval is
obtained either:

- interactively, from a TTY prompt that shows the exact action, target and
  resolved URL; or
- by issuing a one-time token with `bv approve <actionId>`.

Tokens are `HMAC-SHA256(serverKey, actionId‖actionHash‖issuedAt‖nonce)`, bound to
the **exact action hash** that was presented when approval was requested, and
**consumed atomically** on use. A token therefore cannot be replayed, and cannot
be used to approve a different action.

In non-interactive mode the default is **deny**.

### 2.3 Plan-lock (`src/safety/planlock.ts`)

Before acting, a plan must be set (`bv plan set plan.json`). The plan declares
the goal, a success condition, the allowed origins, the allowed action classes
and a step budget. Any action outside that envelope is denied with the reason
`off_plan`. Amending a plan requires approval and is audit-logged.

The lock is enforced **inside the daemon**, at the point where the action is
about to execute — not in the CLI process — so no code path can reach the
browser without passing the gate.

### 2.4 Taint tracking (`src/safety/taint.ts`)

Everything read from a page, from the network, from a file, or from a download is
a `Tainted<string>` carrying provenance (source URL, origin, capture path,
timestamp). Values _derived_ from tainted text stay tainted, including values
produced by an LLM.

Sinks that refuse tainted input without explicit approval:

| Sink                                                       | Behaviour with tainted input      |
| ---------------------------------------------------------- | --------------------------------- |
| Navigation to a different origin                           | denied (`taint:cross_origin_nav`) |
| Typing into password / card / OTP / email-recipient fields | denied                            |
| File paths (upload)                                        | denied                            |
| Shell / `eval`                                             | denied                            |
| Messaging / submit bodies containing tainted free text     | denied                            |

Taint is cleared only by (a) explicit approval, or (b) a deterministic validator
that narrows the value to a known set (a zod enum, a numeric regex) — never by
an LLM's say-so.

Values passed on the **command line** are treated as user-trusted, because the
human typed them. The CLI is the trust boundary.

### 2.5 Injection guard (`src/safety/injection/`)

All page-derived text that will be sent to a model or handed to the host agent
is wrapped in a nonce-tagged envelope:

```
<untrusted_web_content origin="@url:`https://…`" nonce="<16 hex>">
…content…
</untrusted_web_content nonce="<same>">
```

The nonce is **regenerated per call** and never reused. Any occurrence of the
nonce, or of a forged closing tag, inside the content is escaped.

Detectors cover: hidden text (by computed style), `aria-hidden` text, HTML
comments, zero-width and bidi control characters, instruction-like phrases in
attributes and `<noscript>`, CSS `content:`, fake system/admin banners, base64
blobs, exfiltration-style URLs, and suspicious hidden form fields.

Severity → response:

| Severity | Response                                                                |
| -------- | ----------------------------------------------------------------------- |
| `info`   | logged only                                                             |
| `warn`   | annotated in the snapshot header                                        |
| `review` | **approval required** before acting on that node                        |
| `block`  | the node's text is **redacted** as `[REDACTED: injection-suspect f-12]` |

### 2.6 Secrets vault (`src/safety/vault.ts`)

Secrets are stored in an AES-256-GCM file (`.bv/vault.enc`) with a key derived
by scrypt from a passphrase supplied via `BV_VAULT_PASSPHRASE` or an interactive
prompt.

Placeholders of the form `{{secret:name}}` are resolved **only inside the
daemon, at fill time**. The resolved value is never returned to the CLI, never
written to the audit log, and never included in any model prompt.

Redaction is applied independently at five sinks — audit log, JSON output, human
log output, screenshots (via Playwright's `mask`), and the HAR recorder — plus a
post-processing pass over the trace archive. See `DECISIONS.md` D-0013 and
D-0014.

### 2.7 Network dry-run (`src/safety/dryrun.ts`)

`--dry-run` intercepts state-changing requests (`POST`, `PUT`, `PATCH`,
`DELETE`, and any `fetch` carrying a body), fulfils them with a synthetic `200`,
and records what **would** have been sent (method, URL, redacted headers, body
preview) to `dryrun.json`. `bv dryrun-report` prints that report. No request
reaches the network.

### 2.8 Compliance (`src/safety/compliance/`)

- **robots.txt** is fetched, cached per origin and evaluated per path. A
  disallowed path is denied with reason `robots`, unless the origin is listed in
  `ownedOrigins` (where the operator is the site owner and the rule does not
  bind them).
- **Rate limiting** is a per-domain token bucket with jitter from policy.
- **CAPTCHA / login wall / 2FA** detection triggers a **human handoff**: the run
  pauses, prints `Human needed at <url>`, and waits for `bv resume`. The browser
  must be headed. The human's steps are captured as an annotated segment of the
  run, reusable as a playbook.
- The **user agent is honest**: `BrowserVerified/<version> (+<contact-url>)`,
  applied at the context level.

### 2.9 The agent loop (Mode B)

`src/agent/loop.ts` is where a model decides what to do next. The important
property is where the gate sits:

> **The safety gate is inside the loop, not above it.**

Every action the model proposes goes through the same `evaluateAction` that
the CLI uses (`src/safety/gate.ts`). There is no "agent mode" that relaxes
the checks, and no path through the loop that skips them. A model that
proposes to click something it should not is refused exactly as a human's
would be, with the same exit code and the same rule id.

The loop also stops on its own, with specific reasons:

| Stop reason                  | Meaning                                 |
| ---------------------------- | --------------------------------------- |
| `the model finished`         | the model said it was done              |
| `the step budget ran out`    | it used its steps                       |
| `the model asked a question` | it needs a human                        |
| `the model repeated itself`  | it proposed the same action three times |
| `the model made no progress` | it kept failing or being refused        |
| `an error stopped the loop`  | including the budget running out        |

A refusal is fed back to the model with the approval id when there is one,
so the model can ask for the approval rather than guessing.

### 2.10 Skills are data, and untrusted skills are marked

`src/memory/skills.ts` reads skills as markdown with a frontmatter block.
They are **data, not code**: a skill can be reviewed, diffed and corrected by
the person who knows the site, without a rebuild.

Two rules:

- **A skill never bypasses the policy.** A skill can say where a button is;
  it cannot say that an action does not need approval. The gate does not
  read skills, so there is nothing for a skill to influence.
- **A skill is untrusted text.** It is written by someone, and that someone
  might be a page. A skill whose frontmatter says `untrusted: true` is
  rendered with a marker _before_ its body, so the agent knows what it is
  reading before it reads it.

### 2.11 Forbidden capabilities are rejected at configuration time

The policy schema is validated with zod `.strict()`, so a policy that tries to
enable fingerprint spoofing, stealth plugins, proxy rotation, CAPTCHA solving or
credential stuffing **fails to load** with a clear error. There is no code path
that implements them:

- No `navigator.webdriver` masking, no stealth plugins.
- No user-agent randomization — the UA is either the honest default or a value
  the operator sets explicitly.
- No proxy lists and no rotation. At most one static proxy, for geo-testing.
- No CAPTCHA solving. A challenge means handoff.
- No credential stuffing and no mass account creation.
- "Messy-user mode" (typos, double clicks, mid-flow refresh/back) is permitted
  **only** on origins listed under `ownedOrigins`, enforced in code.

---

## 3. What is **not** protected against

Stated plainly, because a security model that overclaims is worse than none.

- **The injection guard is heuristic.** It detects the patterns it knows. A novel
  phrasing, an indirect injection through image alt text that avoids the
  instruction lexicon, or an attack split across several nodes can pass.
  Treat the guard as a **speed bump and an evidence source**, not as a trust
  boundary.

  The red-team suite (`test/redteam/guards.test.ts`) builds twelve payloads
  that each attack the guard differently, and asserts that every one is
  caught. It is a regression test, not a proof: a payload that is not in the
  suite has not been tried. When the suite found six payloads that got
  through, they were fixed and written up in `KNOWN_LIMITATIONS.md` — that
  is the pattern to expect, not an exception.

- **A compromised host agent can still act.** If the model running `bv` is
  convinced to approve a malicious action, the approval gate will faithfully
  record that a human approved it. The gate prevents _accidental_ and
  _unreviewed_ actions; it does not prevent a persuaded operator.
- **Time-travel cannot restore state.** `bv rewind` restores cookies, storage
  state and navigation. It cannot restore in-page JavaScript state or any
  server-side state. A rewound run is a _branch_, not a rewind of reality.
- **Trace redaction has gaps.** Post-processing a trace archive is text
  substitution; secrets embedded in binary resources or compressed sub-resources
  may survive. See `KNOWN_LIMITATIONS.md`.
- **The vault protects secrets at rest, not while in use.** A secret resolved
  for a fill exists in browser memory. A page that reads it (which is the point)
  can exfiltrate it.
- **robots.txt is advisory.** Respecting it is a politeness contract and a
  signal of intent, not an access control. `bv` also does not defeat
  authentication, paywalls, WAFs or rate limits — it refuses to.
- **No protection against a hostile local user.** Anyone who can read the
  workspace as the same user can read `.bv/daemon.token` and the vault
  passphrase from the environment.

---

## 4. Reporting a vulnerability

`bv` is a security tool, so it takes its own security seriously. Please report
issues privately to the maintainers listed in `package.json` rather than in a
public issue. Include a run id (`.bv/runs/<runId>/`) and the relevant
`audit.jsonl` lines, which contain no secrets.

---

## 5. Data handling summary

| Data             | Where it lives                            | Lifetime         | Protection                                 |
| ---------------- | ----------------------------------------- | ---------------- | ------------------------------------------ |
| Secret values    | `.bv/vault.enc`                           | until removed    | AES-256-GCM, scrypt KDF                    |
| Resolved secrets | browser memory only                       | per fill         | never returned to CLI, masked in artifacts |
| Page content     | `.bv/runs/<runId>/steps/*/aria.txt`       | until run pruned | taint-tracked, injection-scanned           |
| Screenshots      | `.bv/runs/<runId>/steps/*/screenshot.png` | until run pruned | secret fields masked                       |
| Network traffic  | `.bv/runs/<runId>/network.har`            | until run pruned | headers redacted                           |
| Audit trail      | `.bv/runs/<runId>/audit.jsonl`            | until run pruned | append-only, secrets masked                |
| Session state    | daemon memory                             | session lifetime | token-gated loopback HTTP                  |

`.bv/` is gitignored. Nothing under it should ever be committed.
