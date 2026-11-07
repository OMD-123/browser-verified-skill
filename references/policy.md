# The policy reference

The policy lives at `.bv/policy.yaml`. It is validated with a **strict**
schema: an unknown key is a hard error, not a warning. That is deliberate
— a typo in a policy key should be loud, because a silently ignored
`allowedOrigins` is a policy that does not restrict anything.

## The forbidden keys

Some keys are rejected **before** the schema is applied, with a message
that says why:

| Key                                        | Why it is refused                                               |
| ------------------------------------------ | --------------------------------------------------------------- |
| `stealth`, `fingerprint`                   | fingerprint spoofing and bot-detection evasion are out of scope |
| `userAgentRandomize`, `randomizeUserAgent` | the user agent must be honest                                   |
| `captchaSolver`, `solveCaptcha`            | CAPTCHA solving is out of scope; use a human handoff            |
| `proxyPool`, `proxyRotation`, `proxies`    | rotating proxy pools are out of scope                           |
| `credentialStuffing`                       | credential stuffing is out of scope                             |
| `massAccountCreation`                      | mass account creation is out of scope                           |
| `webdriverMasking`                         | `navigator.webdriver` masking is out of scope                   |
| `bypassWaf`                                | bypassing a WAF is out of scope                                 |
| `bypassPaywall`                            | bypassing a paywall is out of scope                             |

These are refused **wherever they appear**, including nested inside
another key.

## The schema

```yaml
version: 1 # must be exactly 1

domains:
  allow: [] # hosts the session may touch
  deny: [] # hosts it may not

ownedOrigins: [] # origins you own

actionClasses:
  approvalRequired: [] # classes that need an explicit approval
  deny: [] # classes that are always refused

budgets:
  maxSteps: 80
  maxRetriesPerStep: 2
  maxSeconds: 600
  maxTokens: 200000

rate:
  maxRpsPerDomain: 1
  jitterMs: [300, 1200]

compliance:
  respectRobots: true
  userAgentSuffix: 'BrowserVerifiedSkill/1.0 (+@url:`https://your-site/contact`)`'
  captcha: human_handoff # or `deny`
  evalReadonly: false

secrets:
  maskInLogs: true

llm: # optional; Mode B only
  tiers:
    nav: claude-haiku-5-5
    plan: claude-sonnet-5-5
    verify: claude-sonnet-5-5
  maxEscalations: 2

memory:
  ttlDays: 30
```

## The action classes

Every action is classified into exactly one of these, by a pure function
that looks at the intent, the role, the accessible name, the input type
and the form method:

| Class         | What it is                     | The usual treatment                      |
| ------------- | ------------------------------ | ---------------------------------------- |
| `read`        | reading the page               | allowed                                  |
| `navigate`    | a link, a GET form, a `goto`   | allowed                                  |
| `input`       | filling a field                | allowed unless the policy says otherwise |
| `submit`      | pressing a button that submits | **approval by default**                  |
| `destructive` | delete, cancel, remove         | **approval by default**                  |
| `financial`   | pay, refund, transfer          | **approval by default**                  |
| `messaging`   | send, post, share              | **approval by default**                  |
| `download`    | downloading a file             | allowed unless the policy says otherwise |
| `upload`      | uploading a file               | **approval by default**                  |

The classification is **conservative**: an unrecognised click target with
no useful evidence is classified as `submit`, so it needs an approval
rather than being waved through.

## Domain entries

A domain entry may be:

- a plain host: `example.com`
- a wildcard: `*.example.com`
- an explicit URL: ``@url:`http://localhost:3000` ``

The `@url:` marker is explicit, because a bare `localhost:3000` is
ambiguous: it could be a host with a port or something else. A path in a
`@url:` entry is stripped to its origin.

## What the policy cannot do

The policy **cannot** relax the plan-lock. The plan is a separate thing,
set with `bv plan set`, and the plan is checked first. A policy that
allows everything still cannot widen the plan, because the policy has no
key for it.
