# Known limitations

This file is the honest list. It is written as the code is written, and it
is updated whenever a limitation is found or fixed.

## Not built yet

These are planned for later phases and do not exist in the current build:

- **Verification and evidence (M12).** There is no `bv verify` command and no
  success-condition DSL yet. A run is not "verified" — it is simply a run.
- **Evidence-first extraction (M13).** `bv extract` does not exist.
- **Time-travel (M14).** `bv rewind` does not exist. Step artifacts are
  recorded, but they cannot be used to branch a run.
- **Recorder, compiler, replay, heal and drift (M15).** `bv compile`,
  `bv replay` and `bv drift` do not exist. Actions are not yet recorded as
  a normalised IR, so a run cannot be turned into a Playwright script.
- **Site memory (M16).** `bv memory` does not exist, and
  `.bv/playbooks.sqlite` is not created.
- **Interaction engine and profiles (M17).** `fill` is instant; there is no
  `--mode per_char`, no environment profiles, and no messy-user mode.
- **Test mode (M18).** `bv test` does not exist. There is no axe-core scan,
  no viewport matrix, no visual regression and no bug report.
- **Differential runner (M19).** `bv diff` does not exist.
- **Research mode (M20).** `bv research` does not exist.
- **API discovery (M21).** `bv discover-api` does not exist.
- **Mode B, the autonomous loop (M22).** `bv run --goal` does not exist.
  Every command in the current build is Mode A: the host agent drives, and
  `bv` needs no LLM and no API key.
- **MCP wrapper (Phase 7).** `bv mcp` does not exist.

## The injection guard is heuristic and will miss novel attacks

The guard detects known patterns: hidden text, `aria-hidden` text, HTML
comments, zero-width and bidirectional control characters, instructions in
attributes and `alt`/`title`/`placeholder`, instruction-like phrases,
fake system banners, base64 blobs, exfiltration-style URLs and suspicious
hidden form fields.

It will miss:

- An attack phrased in a way that is not on the phrase list.
- An attack split across several nodes, where no single node matches.
- An attack carried entirely in a form's _value_ rather than its visible
  text.
- An attack in a cross-origin iframe, whose contents are not scanned.
- An attack that is only revealed after a user interaction.

The phrase list is configurable (`policy.compliance.instructionPhrases`), so
it can be extended — but it can never be complete.

The guard is a **speed bump, not a wall**. The real defences are the
plan-lock, the domain allow-list, the taint tracker and the approval gate,
which do not depend on recognising the attack.

## The policy's domain allow-list is only as good as its entries

A policy with `domains.allow: []` allows every domain. This is documented
and deliberate — an empty allow-list means "no restriction" — but it means
a default policy that is edited carelessly can reach anywhere. The default
policy ships with `localhost`, `127.0.0.1` and `*.example.com`.

## robots.txt is advisory for owned origins

`ownedOrigins` is exempt from robots.txt, by design: it is for sites the
operator owns. The exemption is checked against the origin, not the path,
so an owned origin is trusted entirely.

## Time-travel cannot restore in-page or server-side state

Not built yet, but the limitation is known and will be documented in full
when it is: restoring a step's storage state and navigating to its URL does
not restore JavaScript state, open sockets, service workers, or anything the
server computed. The `KNOWN_LIMITATIONS` entry will say so plainly.

## Secret redaction is best-effort against unusual encodings

The redaction replaces the literal secret string wherever it appears in an
artifact. It will not catch:

- The secret encoded (base64, URL-encoded, hex) in an artifact.
- The secret split across two fields.
- The secret in a screenshot as _pixels_ — though the password fields
  themselves are masked via Playwright's `mask` option, so the value in a
  password field is not visible; a secret echoed into a _non_-masked field
  would be visible.

The trace archive is post-processed rather than being written with the
secret already removed, because Playwright records it internally. The
post-processing is what makes the "grep the run directory and find
nothing" test meaningful, but it is a post-processing step and not a
guarantee from the recorder.

## The approval gate needs a headed browser to be usable interactively

A `needs_approval` refusal can be resolved with a token in a headless
session, but the token has to be issued by something that can prompt a
human. The intended flow is `bv session start --headed`, then
`bv approve <id>`.

## The daemon trusts its own descriptor file

The daemon binds to `127.0.0.1` and requires a bearer token stored in
`.bv/daemon.token` with owner-only permissions. It does not verify that
the client process is the same user. On a shared machine, another user who
can read `.bv/daemon.token` can drive the session. The file permissions
are the protection; there is no additional authentication.

## The browser is Chromium

Firefox and WebKit are optional per the brief and are not installed or
tested. The locator chain, the ARIA snapshot and the diffing are all
verified against Chromium only.

## Coverage thresholds are per-directory

See `docs/DECISIONS.md` (D-0031). The security-critical directory
(`src/safety/**`) requires 100% branch coverage and meets it. The other
directories carry their own thresholds, which are set to what the code
actually achieves today and are raised as later phases add tests. The
global ≥85% figure from the brief applies to the finished project, not to
a partially built one.

## The `evaluate` callback in the inspector is not instrumented

The browser-side callback in `src/safety/inspect.ts` runs inside the
browser, so the coverage tool cannot see it. It is excluded with a `v8
ignore` comment. The rules it feeds live in `src/safety/element-facts.ts`,
where they are covered — see `docs/DECISIONS.md` (D-0033).
