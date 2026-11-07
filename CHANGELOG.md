# Changelog

All notable changes to `browser-verified` are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-11-07

The first stable release. Every module in the map below is built, tested and documented.

### Added

**Perception**

- Accessibility-tree snapshots through CDP `Accessibility.getFullAXTree` + `DOM`, with
  stable element refs (`e12`) derived from a per-page node key.
- **Diffed snapshots**: each snapshot reports what changed since the last one, not the
  whole page.
- Token-budget pruning, `--full`, and `--expand <ref>` for collapsed nodes.

**Actions**

- A locator chain in a fixed order — `ref`, `role`+`name`, `label`, `text`, `testid`,
  `css` — so a page that changes its class names but keeps its accessible name still
  resolves.
- 12 action kinds: `click`, `dblclick`, `hover`, `type`, `fill`, `select`, `check`,
  `uncheck`, `press`, `scroll`, `upload`, `focus`.

**Safety** — `src/safety/**` at 100% branch coverage

- Policy engine with nine action classes and a strict, zod-validated schema.
- Plan-lock bounding the origins, action classes, step budget and success condition.
  Checked **before** the policy, and the policy cannot widen it.
- One-time approval tokens bound to an exact action.
- Taint tracking: a value read from the page cannot reach a sensitive sink, and the
  taint survives derivation.
- Prompt-injection guard: instruction phrases, bidi overrides, zero-width characters,
  hidden text, CSS content, fake system banners, base64 blobs, urgency framing,
  role-play framing and exfiltration URLs.
- AES-256-GCM secrets vault with scrypt, resolved inside the daemon at the moment of the
  fill.
- Network dry-run reporting exactly what would be sent.
- Compliance: `robots.txt`, honest user agent, rate limiting with jitter, CAPTCHA human
  handoff.
- Forbidden policy keys (`stealth`, `proxyPool`, `captchaSolver`, …) rejected at load
  time with an explanation.

**Proof**

- `bv verify` — success conditions evaluated against the live page. A run that did not
  verify is reported `unverified`, never as done.
- `bv extract` — every value carries its source and is re-read to confirm; an
  unconfirmable value comes back `null` rather than guessed.

**Reuse**

- `bv compile` — a run becomes plain Playwright that imports nothing from this tool.
- `bv replay` — deterministic, zero LLM cost.
- `bv replay --heal` and `bv drift` — repairs broken locators from the recorded
  fallbacks and reports every change.
- `bv rewind` — branches a run from an earlier step.

**QA**

- `bv test` — declarative check suites; failures first in the output.
- `bv redteam run` — the tool attacking its own guards against a catalogue of 16 known
  attacks.
- `bv diff` — compares two pages' accessibility trees.
- Accessibility scanning with axe-core, the viewport matrix, perf metrics, visual
  comparison, the flaky classifier and site health scoring.
- `bv discover-api`, `bv research`, `bv report`, `bv audit`.

**Agent integration**

- The MCP server — seven tools over stdio, through the same daemon and the same policy
  engine as the CLI.
- The agent loop, with **the safety gate inside it** rather than above it.
- Cost reporting from real token counts, with the budget state.
- Skills as data: markdown with a frontmatter block, reviewed and corrected without a
  rebuild, and marked when they came from an untrusted source.

**Packaging**

- A single-file bundled CLI, `scripts/bv.mjs`.
- `SKILL.md`, `references/`, `skills/`, and the security model shipped **with** the
  package.
- `npm run acceptance` — 17 end-to-end claims, checked against the installed CLI.

### Fixed

Issues found by the project's own tests and acceptance script during development:

- **A headless session could never obtain an approval.** The evaluator treated
  "non-interactive" as a denial rather than an approval request, so the approval
  mechanism was unusable in exactly the case it exists for. It now returns
  `needs_approval`, and the operator approves out of band.
- **The installed package could not start the daemon.** The bundle path was resolved
  against the source layout, which does not exist in `node_modules`. The daemon entry
  point is now found from `import.meta.url`.
- **Six of twelve prompt-injection payloads got past the guard.** The instruction
  lexicon was missing common phrasings. All twelve are now caught, and the catalogue is
  a permanent regression test.
- **Every click classified as a `submit`** in the agent loop, because the target
  descriptor reached the classifier whole and the role was lost.
- **Playwright's device descriptors carry a user agent**, so selecting a "Desktop Safari"
  profile silently disguised the client. The device user agent is now dropped unless the
  operator supplies an honest one.
- **Typing appended to a field's existing value** instead of replacing it.
- **axe's `include` and `exclude` belong in the context argument**, not the options. In
  the options they were ignored outright, so the scan was not filtering at all.

### Changed

- The compiled flow is plain Playwright, not a proprietary format.
- Redaction is applied at the sink, not only at the source.
- `bv` is a thin HTTP client; the daemon owns the browser.

### Removed

- Dead runtime dependencies: `p-limit`, `pino`, `pixelmatch`, `pngjs`.
- The unused `@modelcontextprotocol/sdk` dependency — the MCP server implements the
  protocol directly.

---

[1.0.0]: https://github.com/OMD-123/browser-verified/releases/tag/v1.0.0
