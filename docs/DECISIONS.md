# Architecture decisions

Each entry records a non-trivial decision: what was chosen, what was rejected, and why.
Newest first.

---

## D-0001 — Snapshot source: CDP `Accessibility.getFullAXTree` + `DOM` domains, not `page.locator` scraping

**Decision.** Perception (M02) reads the accessibility tree through the CDP
`Accessibility.getFullAXTree` command, cross-referenced with `DOM.describeNode` /
`DOM.getBoxModel` for geometry, and with a small in-page evaluation pass for
computed-style facts the AX tree cannot express (text colour vs background,
`font-size: 0`, `content:` pseudo-elements).

**Alternatives rejected.**

- `page.locator('*')` + `innerText` scraping: no roles, no accessible names, no
  hidden-vs-visible distinction that matches the accessibility contract. Would
  also be dramatically slower on large pages.
- Playwright's `ariaSnapshot()` YAML: attractive, but it is a string format
  without stable node identity, so we cannot attach refs, detect changes, or
  diff structurally. Refs must survive across steps while the element exists,
  which requires a node-keyed tree we own.

**Reason.** We need (a) stable per-node identity for refs, (b) structural diffing,
(c) computed-style facts for the injection guard, and (d) cross-frame traversal.
Only the AX tree plus targeted DOM/CDP lookups gives all four. The trade-off is
that we own the ref-stability logic; see D-0002.

**Cost.** More code than consuming a YAML snapshot. We compensate by keeping the
AX node → ref map keyed on a stable node identity, not on tree position.

---

## D-0002 — Ref identity is derived from a per-page node key, not AX node id

**Decision.** A ref (`e12`) is allocated from a monotonically increasing counter
within a page context and bound to a _node key_ — a stable, opaque identity for
the underlying DOM node. The node key is built from the AX node's
`backendDOMNodeId` (via CDP `DOM.describeNode`, which yields a `DOM.NodeId` for
the same document) combined with the frame id.

**Alternatives rejected.**

- AX `nodeId` alone: AX node ids are regenerated on every tree fetch, so refs
  would churn between snapshots. That breaks the requirement that refs survive
  across steps.
- Tree path (`/html/body/main/button[2]`): breaks under any DOM mutation above
  the element — exactly the case refs must survive.

**Reason.** `backendDOMNodeId` is stable for the lifetime of the DOM node and is
re-issued consistently across CDP calls. Combined with the frame id it is unique
across same- and cross-origin frames.

**Caveat.** `backendDOMNodeId` is only stable within a document that has not been
navigated. A navigation invalidates every ref; the snapshot layer detects this
(the document token changes) and re-allocates refs, reporting the change in the
diff header rather than silently reusing stale refs.

---

## D-0003 — The daemon owns the browser; every other command is a thin HTTP client

**Decision.** `bv session start` spawns a detached Node process holding the
Playwright `Browser`. It listens on `127.0.0.1` on a random port with a random
bearer token. `daemon.json` (mode 0600) records the port, token hash, pid and
session name. Every other `bv` command is an HTTP client to that daemon.

**Alternatives rejected.**

- One-shot Playwright per command: loses session state (cookies, storage, open
  tabs) between commands, which is the entire point of a session.
- A long-lived CLI process the user keeps open: brittle over SSH/CI, and it
  blocks the agent's shell.

**Reason.** The daemon survives client crashes (a key acceptance criterion),
lets several commands share one browser, and keeps Playwright's `Browser` object
on one process so `browser.contexts()` and popup handling are straightforward.

**Security consequence.** The bearer token gates every request. The daemon binds
to loopback only. See D-0004.

---

## D-0004 — Daemon auth uses a bearer token compared in constant time

**Decision.** The daemon generates a 32-byte random token. It stores a SHA-256
hash of the token in `daemon.json` and compares incoming `Authorization: Bearer
<token>` headers with `crypto.timingSafeEqual` against the stored hash.

**Alternatives rejected.**

- Storing the raw token in `daemon.json`: a readable-file attacker gets the
  token directly.
- Unix domain sockets: not portable to Windows, where this project must run.

**Reason.** Hash-at-rest limits the damage from a file-read leak; constant-time
comparison avoids a timing oracle. Loopback-only binding plus a 0600 file means
an attacker already needs local code execution, but defence in depth is cheap.

**Known limitation.** `daemon.json` stores the hash, not the token — so a client
must be able to read the _token_ from somewhere. Decision: the token is stored
in a separate file `daemon.token` (mode 0600) alongside `daemon.json`, and the
hash in `daemon.json` verifies it. Recorded honestly in `KNOWN_LIMITATIONS.md`.

---

## D-0005 — Playwright is launched with an honest, configurable User-Agent

**Decision.** The default user agent is `BrowserVerified/<version> (+<contact-url>)`,
where the contact URL comes from `policy.compliance.userAgentSuffix` or the
`BV_CONTACT_URL` environment variable. It is applied at the **context** level via
`browser.newContext({ userAgent })`.

**Alternatives rejected.**

- The default Playwright/Chrome UA: it identifies automation only implicitly and
  hides that a human-agent-driven tool is responsible for the traffic.
- A randomised or spoofed UA: this is a stealth tool. Out of scope by design.

**Reason.** Honesty is a hard requirement of this project. The UA makes the tool
identifiable to site owners, which is what makes respectful crawling possible.

---

## D-0006 — TypeScript 5.9.3, not TypeScript 7

**Decision.** Pin `typescript@5.9.3`.

**Alternatives rejected.** `typescript@7.0.2` is the current `latest` on npm, but
`typescript-eslint@8.72.1` declares `typescript: ">=4.8.4 <6.1.0"`. Installing
TS 7 alongside it produces peer-dependency conflicts and an unsupported
combination.

**Reason.** `npm run lint` must be green and reproducible. When typescript-eslint
publishes TS 7 support, the pin can move. Recorded in `KNOWN_LIMITATIONS.md`.

---

## D-0007 — zod v4 (`.strict()` objects) for all validation, including policy

**Decision.** Use `zod@4.6.7`. Policy, plan, condition DSL, eval tasks and the
JSON-Schema-to-zod bridge all validate with zod. The policy schema uses
`.strict()` so unknown keys are a hard error.

**Alternatives rejected.** zod v3 (`zod/v3` subpath exists in v4): v3 is what most
existing code targets, but v4 is current and the `zod/v3` compatibility subpath
is available if a third-party schema needs it. JSON Schema → zod conversion is
written by hand against v4's API.

**Reason.** `.strict()` object schemas are how we reject policy keys that would
enable the forbidden behaviours (fingerprint spoofing, proxy rotation,
CAPTCHA solving). An unknown key must fail loudly, not be ignored.

---

## D-0008 — Taint is a branded type plus a runtime registry, not a type-only marker

**Decision.** `Tainted<string>` is a branded TypeScript type. The runtime
provenance lives in a registry (`Map<string, TaintRecord>`) keyed by a unique
value id that travels alongside the string. Values passed on the CLI command
line are registered as `user_trusted` at the boundary.

**Alternatives rejected.**

- Type-only branding: vanishes at runtime; a value coming back from JSON
  deserialization would be indistinguishable from a trusted one. Not safe.
- Wrapping values in a container everywhere: makes every call site noisy and
  breaks third-party APIs (Playwright's `fill()` takes a plain string).

**Reason.** The registry gives a runtime-checkable answer to "is this tainted?"
at every sink, while the branded type gives compile-time guidance. The CLI
boundary is the single place where trust is established, and it is explicit.

---

## D-0009 — Injection findings map to four severities that gate actions

**Decision.** Detectors emit findings with severities `info | warn | review |
block`. `review` requires approval before any action on the affected node;
`block` redacts the node's text in every output and in anything sent to a model.

**Alternatives rejected.** Binary "safe/unsafe": a heuristic detector will
produce false positives; a binary gate makes the tool unusable on legitimate
pages (a single HTML comment would block the run). Four levels let the operator
tune the response.

**Reason.** The tool must be usable on real pages while still refusing to act
on content that looks like an instruction. Severity escalation is the standard
way to reconcile those goals.

**Known limitation.** The detector list is heuristic and will miss novel
attacks. Measured against the Phase 6 red-team pack, and the misses are
published rather than hidden.

---

## D-0010 — No fixed sleeps anywhere except the rate-limit jitter

**Decision.** Every wait is condition-based: `attached`, `visible`, `stable`,
`enabled`, `receives-events`, and `networkidle` only when explicitly requested.

**Alternatives rejected.** `waitForTimeout(1000)`: makes runs slow, non-deterministic
and un-replayable. The only fixed delay in the codebase is the politeness jitter
in `throttle.ts`, which is explicitly rate limiting, not synchronisation.

**Reason.** Determinism is the basis of replay and of the flaky-test classifier.
A fixed sleep cannot be distinguished from a real wait, so it destroys the
signal needed to classify a failure as `timing`.

---

## D-0011 — Locator resolution chain order and its recording

**Decision.** The chain is `ref → role+name → label → text → test-id → CSS →
fresh-snapshot lookup`. The strategy that succeeded is recorded on every action
and becomes the basis for healing and drift reporting.

**Alternatives rejected.** Trying all strategies and taking the first that
_resolves_ (rather than the first that is _actionable_): an element can resolve
but be covered or disabled, so resolution success is not action success. The
chain must attempt the action, not merely find a node.

**Reason.** Recording the winning strategy makes the compiler emit the best
locator first with fallbacks as comments, and makes drift reporting meaningful
("`#login` → `button[name=signin]`").

---

## D-0012 — The compiled flow is a plain Playwright script, not a bv-specific format

**Decision.** `bv compile` emits a TypeScript file that imports `playwright`
directly and runs with `npx playwright test` or `tsx`. It does not import `bv`.

**Alternatives rejected.** Emitting a bv-specific DSL that requires `bv replay`:
replay would then cost a dependency on the daemon and the toolkit, defeating
the "replay for free, no LLM" promise.

**Reason.** The compiled artifact must be reviewable by a human, runnable in any
CI, and independent of this project. `bv replay` executes the compiled flow
through the same machinery (so it produces the same run artifacts) but the
artifact itself has no runtime dependency on `bv`.

---

## D-0013 — Redaction is applied at the sink, not only at the source

**Decision.** Secrets are masked in five independent places: the audit log, JSON
output, human log output, Playwright `mask` for screenshots, and the HAR
recorder. Each is implemented separately; none relies on another.

**Alternatives rejected.** Redacting only when writing the audit log: values
leak through error messages (Playwright echoes the value it tried to fill),
through screenshots, and through the HAR.

**Reason.** The acceptance criterion is "grep `.bv/runs/**` for the secret string
and find zero matches". Defending each sink independently is the only way to
make that test meaningful rather than a coincidence.

---

## D-0014 — Trace redaction: post-process the zip, and pause tracing around secret fills

**Decision.** Two layers: (1) tracing is started and stopped around steps that
fill secret fields, so those steps contribute no trace chunk at all; (2) the
finished `trace.zip` is post-processed — its `trace.trace` file is rewritten
with registered secret values replaced by `[REDACTED]`.

**Alternatives rejected.**

- Post-processing alone: the trace stores values in many formats (URL-encoded,
  base64 in some resources) and a pure text replace misses encodings.
- Trace exclusion alone: the surrounding step's DOM snapshot can still contain a
  previously-typed secret that is still present in the DOM.

**Reason.** Layer 1 removes the bulk; layer 2 catches the residue. Known gaps
(binary resources, compressed sub-resources) are listed in `KNOWN_LIMITATIONS.md`.

---

## D-0015 — The condition DSL is deterministic-first; `llm_judged` is Mode B only

**Decision.** `bv verify` evaluates deterministic conditions in-process with no
model call. The `llm_judged` condition is only available in Mode B, and the
verifier receives only the condition text and fresh evidence — never the
executor's narration.

**Alternatives rejected.** Asking the model to judge everything: unverifiable and
expensive; a run whose success depends on a model's opinion cannot be replayed.

**Reason.** "A run without passing verification is `unverified`, never done"
requires a checker that is independent of the thing being checked.

---

## D-0016 — Cross-origin frames are supported via frame refs, not by inlining

**Decision.** Each frame gets its own ref namespace. `bv act click <ref>` where
the ref belongs to a frame resolves through `frameLocator`/`page.frame()`.

**Alternatives rejected.** Flattening all frames into one tree: it destroys the
ability to reason about which document a node came from and makes taint
provenance ambiguous.

**Reason.** Cross-origin iframes are common and the acceptance criteria require
them to appear "with correct refs". Namespacing keeps the origin of each node
explicit, which the taint tracker needs.

---

## D-0017 — Approval tokens are single-use, action-bound and HMAC-signed

**Decision.** `bv approve <actionId>` issues a token = `HMAC-SHA256(serverKey,
actionId || actionHash || issuedAt || nonce)`. The daemon records the nonce;
consuming a token deletes it. A token is valid only for the exact action hash
that was presented when approval was requested.

**Alternatives rejected.** A boolean "approved" flag in the session: it would
approve every subsequent action, including ones the human never saw.

**Reason.** "An approval never covers a different action" and "approvals cannot
be replayed" are both hard requirements, so the token must bind to the action
_and_ be consumed atomically.

---

## D-0018 — `.bv/` is gitignored; nothing runtime is committed

**Decision.** All runtime state lives under `.bv/` (policy, vault, playbooks,
runs). `.gitignore` excludes it. The _default_ policy is committed at
`policies/default.yaml` and copied into `.bv/policy.yaml` by `bv init`.

**Alternatives rejected.** Committing a user's policy or vault: a vault in git
history is a leaked vault.

**Reason.** A skill folder may be shared; it must never carry a user's secrets
or their specific policy edits.

---

## D-0019 — `eval-readonly` is disabled by default and off-policy without an explicit flag

**Decision.** `bv act eval-readonly` exists but is refused unless the policy sets
`compliance.evalReadonly: true`. It can only read DOM/`document` state — it
cannot mutate, navigate or fetch.

**Alternatives rejected.** Allowing `eval` freely: it is the single most powerful
primitive in a browser tool and trivially defeats every other control.

**Reason.** Some tasks genuinely need a DOM read that no semantic locator
provides. Allowing it by default would make the policy layer theatre.

---

## D-0020 — The default policy's `ownedOrigins` uses an explicit `@url:` marker

**Decision.** Origin and domain values in policy may be written literally or as
`` @url:`http://localhost:3000` ``. The marker makes URLs unambiguous and lets
the loader strip a trailing path, so `` @url:`http://localhost:3000/app` `` is
normalised to the origin `http://localhost:3000`.

**Alternatives rejected.** Bare strings only: ambiguous between a domain, a host
and a URL, and easy to misconfigure in a way that widens access.

**Reason.** Policy files are hand-edited. Ambiguity in a security-relevant file
is a defect.

---

## D-0021 — Plan-lock is enforced in the daemon, not in the CLI

**Decision.** The plan and its lock live in the daemon's state. Every mutating
action is checked against the plan _inside_ the daemon before it executes.

**Alternatives rejected.** Checking in the CLI: the CLI is a separate process;
a bug or a crafted request could skip the check. Enforcing at the execution
point means no code path can act without passing the gate.

**Reason.** The plan-lock is a security control, and security controls belong at
the point of use.

---

## D-0022 — Coverage thresholds are configured per-glob, with 100% branches on `src/safety/**`

**Decision.** Vitest coverage thresholds: 85% lines overall; 100% branches on
`src/safety/**` decision code; 90% lines on `src/safety/**`.

**Alternatives rejected.** A single global threshold: it either fails the build
on innocuous code or lets safety code be under-tested.

**Reason.** The brief requires "exhaustive negative tests and 100% branch
coverage of decision code" for the security-critical modules specifically.

**Note.** Vitest applies glob-specific thresholds _in addition to_ the global
ones. The `src/safety/**` entry therefore raises the bar for those files without
lowering it elsewhere.

---

## D-0023 — `better-sqlite3` is used for the playbook store (synchronous, embedded)

**Decision.** `better-sqlite3@13.0.3` with the prebuilt binary (verified working
on this host's Node 22).

**Alternatives rejected.** `node:sqlite` (built into Node 22): still flagged
experimental in 22.x and its API differs; `sql.js` (WASM): in-memory only,
needs manual persistence.

**Reason.** The playbook store is small, local, and read on nearly every action
(selector confidence lookups). Synchronous access keeps the action path simple
and avoids an async DB layer in the hottest code path.

---

## D-0024 — Fixture server is dependency-free Node http with a second port for cross-origin frames

**Decision.** `fixtures/server.ts` uses only `node:http`. Cross-origin-style
iframes are served from a **second** instance of the same server on a different
port; the page asks the first server for that port via `/__cross-origin-port`.

**Alternatives rejected.** A single server faking `Origin` headers: a real
cross-origin frame is a different _port_, and the difference matters for
frame handling and taint provenance.

**Reason.** A genuine second origin exercises the code paths that matter, with
zero dependencies.

---

## D-0025 — Eval harness compares `bv` (diffed) against a naive full-snapshot baseline

**Decision.** The harness runs each task twice: arm A uses `bv` with diffing and
pruning; arm B sends the full snapshot every step. Token counts are **estimated**
(characters ÷ 4) and are labelled as estimates unless an Anthropic API key is
present to count them exactly.

**Alternatives rejected.** Counting tokens with a local BPE tokenizer as ground
truth: it would not match the provider's counting and would overstate precision.

**Reason.** The brief requires the numbers be real but allows estimates when
flagged. The comparison is fair because both arms measure the same pages with
the same tasks; only the snapshot delivery differs.

---

## D-0026 — Models are configuration, never constants, and prices live in `pricing.json`

**Decision.** `policy.llm.tiers` maps tier → model id; `pricing.json` (user
editable, gitignored by default with a committed example) maps model id → price
per million tokens. When `pricing.json` is absent, cost reporting shows tokens
only.

**Alternatives rejected.** Hardcoding model ids or prices in logic: they rot, and
the brief forbids it.

**Reason.** The tool must keep working when Anthropic renames a model or changes
pricing. The default tier ids in `policies/default.yaml` are checked against
the current Anthropic model list at build time and documented in
`KNOWN_LIMITATIONS.md` if they cannot be confirmed.
