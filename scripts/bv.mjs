#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) =>
  function __init() {
    if (err) throw err[0];
    try {
      return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
    } catch (e) {
      throw ((err = [e]), e);
    }
  };
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/exit.ts
var EXIT;
var init_exit = __esm({
  'src/core/exit.ts'() {
    'use strict';
    EXIT = {
      /** The command succeeded. */
      OK: 0,
      /** The command ran but the operation failed (action failed, verification failed
       *  in a non-classified way, a run did not complete). */
      FAILURE: 1,
      /** The command line was malformed: unknown option, missing argument, bad value. */
      USAGE: 2,
      /** A policy rule denied the action. */
      POLICY_DENIED: 3,
      /** The action needs human approval that was not given. */
      NEEDS_APPROVAL: 4,
      /** A prompt-injection finding blocked the action or the content. */
      INJECTION_BLOCK: 5,
      /** Verification ran but the success condition was not met. */
      VERIFICATION_FAILED: 6,
    };
  },
});

// src/version.ts
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
function findManifest() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        if (parsed.name === 'browser-verified') return parsed;
      } catch {}
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const require2 = createRequire(import.meta.url);
    return require2('../../package.json');
  } catch {
    return {};
  }
}
var manifest, VERSION, DESCRIPTION;
var init_version = __esm({
  'src/version.ts'() {
    'use strict';
    manifest = findManifest();
    VERSION = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    DESCRIPTION =
      typeof manifest.description === 'string'
        ? manifest.description
        : 'Browser-verified: safety-first browser automation with evidence and self-repair.';
  },
});

// src/core/paths.ts
import { mkdir, chmod, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join as join2, resolve as resolve2 } from 'path';
function bvRoot(cwd = process.cwd()) {
  return join2(resolve2(cwd), BV_DIR);
}
function policyPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'policy.yaml');
}
function vaultPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'vault.enc');
}
function daemonInfoPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'daemon.json');
}
function daemonTokenPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'daemon.token');
}
function runsRoot(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'runs');
}
function runDir(runId, cwd = process.cwd()) {
  return join2(runsRoot(cwd), runId);
}
function stepDir(runId, step, cwd = process.cwd()) {
  return join2(runDir(runId, cwd), 'steps', String(step).padStart(3, '0'));
}
function auditPath(runId, cwd = process.cwd()) {
  return join2(runDir(runId, cwd), 'audit.jsonl');
}
async function writePrivateFile(path, contents) {
  await mkdir(join2(path, '..'), { recursive: true });
  await writeFile(path, contents, { encoding: 'utf8', mode: 384 });
  try {
    await chmod(path, 384);
  } catch {}
}
async function ensureBvDir(cwd = process.cwd()) {
  const root = bvRoot(cwd);
  await mkdir(join2(root, 'runs'), { recursive: true });
  return root;
}
function absPath(p, cwd = process.cwd()) {
  return isAbsolute(p) ? p : join2(resolve2(cwd), p);
}
var BV_DIR;
var init_paths = __esm({
  'src/core/paths.ts'() {
    'use strict';
    BV_DIR = '.bv';
  },
});

// src/core/daemon-info.ts
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { readFile as readFile2, writeFile as writeFile3 } from 'fs/promises';
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function tokenMatches(presented, storedHash) {
  const presentedHash = hashToken(presented);
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
async function writeDaemonInfo(info, token, cwd) {
  await writePrivateFile(daemonTokenPath(cwd), token);
  await writePrivateFile(
    daemonInfoPath(cwd),
    `${JSON.stringify(info, null, 2)}
`,
  );
}
async function readDaemonInfo(cwd) {
  try {
    const raw = await readFile2(daemonInfoPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || typeof parsed.tokenHash !== 'string') {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
async function readDaemonToken(cwd) {
  try {
    return (await readFile2(daemonTokenPath(cwd), 'utf8')).trim();
  } catch {
    return void 0;
  }
}
async function clearDaemonInfo(cwd) {
  const { rm } = await import('fs/promises');
  await rm(daemonInfoPath(cwd), { force: true });
  await rm(daemonTokenPath(cwd), { force: true });
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
function daemonBaseUrl(info) {
  return `http://127.0.0.1:${info.port}`;
}
var init_daemon_info = __esm({
  'src/core/daemon-info.ts'() {
    'use strict';
    init_paths();
  },
});

// src/actions/locate.ts
function parseTarget(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  if (/^(?:f\d+)?e\d+$/.test(trimmed)) {
    return { ref: trimmed };
  }
  if (/^[#.[]/.test(trimmed)) {
    return { css: trimmed };
  }
  const descriptor = {};
  const pattern =
    /(role|name|label|text|testid|css)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  let match;
  let matched = false;
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true;
    const key = match[1] ?? '';
    const raw = match[2] ?? '';
    const value = unquote(raw);
    switch (key) {
      case 'role':
        descriptor.role = value;
        break;
      case 'name':
        descriptor.name = value;
        break;
      case 'label':
        descriptor.label = value;
        break;
      case 'text':
        descriptor.text = value;
        break;
      case 'testid':
        descriptor.testId = value;
        break;
      case 'css':
        descriptor.css = value;
        break;
      default:
        break;
    }
  }
  if (matched) return descriptor;
  return { text: trimmed };
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return value;
}
function strategyOrder(target) {
  const order = [];
  if (target.ref !== void 0) order.push('ref');
  if (target.role !== void 0 && target.name !== void 0) order.push('role');
  if (target.label !== void 0) order.push('label');
  if (target.text !== void 0) order.push('text');
  if (target.testId !== void 0) order.push('testid');
  if (target.css !== void 0) order.push('css');
  return order;
}
function locatorFor(page, strategy, target) {
  switch (strategy) {
    case 'ref':
      return target.ref !== void 0 ? page.getByRef(target.ref) : void 0;
    case 'role':
      return target.role !== void 0 && target.name !== void 0
        ? page.getByRole(target.role, {
            name: target.name,
          })
        : void 0;
    case 'label':
      return target.label !== void 0 ? page.getByLabel(target.label) : void 0;
    case 'text':
      return target.text !== void 0 ? page.getByText(target.text) : void 0;
    case 'testid':
      return target.testId !== void 0 ? page.getByTestId(target.testId) : void 0;
    case 'css':
      return target.css !== void 0 ? page.locator(target.css) : void 0;
    case 'fresh-snapshot':
      return void 0;
    default:
      return void 0;
  }
}
async function locate(page, target, options = {}) {
  const attempted = [];
  const failures = [];
  const timeout = options.timeoutMs ?? 1e4;
  for (const strategy of strategyOrder(target)) {
    const locator = locatorFor(page, strategy, target);
    if (locator === void 0) continue;
    attempted.push(strategy);
    try {
      await locator.first().waitFor({ state: 'attached', timeout });
      const count = await locator.count();
      if (count === 1) {
        return { locator, strategy, attempted, failures };
      }
      if (count === 0) {
        failures.push({ strategy, reason: 'no element matched' });
      } else {
        failures.push({ strategy, reason: `matched ${count} elements (ambiguous)` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? (err.message.split('\n')[0] ?? 'unknown error') : String(err);
      failures.push({ strategy, reason: message });
    }
  }
  return { locator: void 0, strategy: void 0, attempted, failures };
}
var init_locate = __esm({
  'src/actions/locate.ts'() {
    'use strict';
  },
});

// src/safety/policy.ts
import { z } from 'zod';
import YAML from 'yaml';
import { mkdir as mkdir3, readFile as readFile3, writeFile as writeFile4 } from 'fs/promises';
import { dirname as dirname4 } from 'path';
function defaultPolicy() {
  return PolicySchema.parse({
    version: 1,
    domains: { allow: [], deny: [] },
    ownedOrigins: [],
    actionClasses: {
      approvalRequired: ['submit', 'destructive', 'financial', 'messaging', 'upload'],
      deny: [],
    },
    budgets: {
      maxSteps: 80,
      maxRetriesPerStep: 2,
      maxSeconds: 600,
      maxTokens: 2e5,
    },
    rate: { maxRpsPerDomain: 1, jitterMs: [300, 1200] },
    compliance: {
      respectRobots: true,
      userAgentSuffix: 'BrowserVerified/1.0 (+@url:`https://your-site/contact`)',
      captcha: 'human_handoff',
      evalReadonly: false,
    },
    secrets: { maskInLogs: true },
    memory: { ttlDays: 30 },
  });
}
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
async function loadPolicy(cwd = process.cwd()) {
  const path = policyPath(cwd);
  let raw;
  try {
    raw = await readFile3(path, 'utf8');
  } catch {
    return defaultPolicy();
  }
  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`the policy at ${path} is not valid YAML: ${messageOf(err)}`);
  }
  try {
    return validatePolicy(parsed);
  } catch (err) {
    throw new Error(`the policy at ${path} is not valid: ${messageOf(err)}`);
  }
}
function rejectForbiddenKeys(raw) {
  if (typeof raw !== 'object' || raw === null) return;
  const walk = (node, path) => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      const forbidden = FORBIDDEN_KEYS.find((f) => f.key.toLowerCase() === key.toLowerCase());
      if (forbidden !== void 0) {
        throw new Error(
          `policy key "${keyPath}" is not allowed: ${forbidden.because}. browser-verified does not implement these capabilities and will not accept a policy that asks for them.`,
        );
      }
      walk(value, keyPath);
    }
  };
  walk(raw, '');
}
function validatePolicy(raw) {
  rejectForbiddenKeys(raw);
  const result = PolicySchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const details = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
  throw new PolicyLoadError(
    `invalid policy:
${details}`,
    issues,
  );
}
var ACTION_CLASSES,
  URL_MARKER,
  DomainSchema,
  ActionClassesSchema,
  BudgetsSchema,
  RateSchema,
  ComplianceSchema,
  SecretsSchema,
  LlmSchema,
  MemorySchema,
  PolicySchema,
  FORBIDDEN_KEYS,
  PolicyLoadError;
var init_policy = __esm({
  'src/safety/policy.ts'() {
    'use strict';
    init_paths();
    ACTION_CLASSES = [
      'read',
      'navigate',
      'input',
      'submit',
      'destructive',
      'financial',
      'messaging',
      'download',
      'upload',
    ];
    URL_MARKER = '@url:';
    DomainSchema = z.array(z.string().min(1));
    ActionClassesSchema = z
      .object({
        /** Classes that require an explicit approval. */
        approvalRequired: z.array(z.enum(ACTION_CLASSES)).default([]),
        /** Classes that are always denied. */
        deny: z.array(z.enum(ACTION_CLASSES)).default([]),
      })
      .strict();
    BudgetsSchema = z
      .object({
        maxSteps: z.number().int().positive().default(80),
        maxRetriesPerStep: z.number().int().min(0).default(2),
        maxSeconds: z.number().int().positive().default(600),
        maxTokens: z.number().int().positive().default(2e5),
      })
      .strict();
    RateSchema = z
      .object({
        maxRpsPerDomain: z.number().positive().default(1),
        /** The jitter window in milliseconds. */
        jitterMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([300, 1200]),
      })
      .strict();
    ComplianceSchema = z
      .object({
        /** Respect robots.txt. */
        respectRobots: z.boolean().default(true),
        /** The honest user-agent suffix, including a contact URL. */
        userAgentSuffix: z
          .string()
          .default('BrowserVerified/1.0 (+@url:`https://your-site/contact`)'),
        /** What to do when a challenge is detected. */
        captcha: z.enum(['human_handoff', 'deny']).default('human_handoff'),
        /** Allow `eval-readonly`. Off by default: it is the most powerful primitive. */
        evalReadonly: z.boolean().default(false),
      })
      .strict();
    SecretsSchema = z
      .object({
        /** Mask secret values in logs, audit and JSON output. */
        maskInLogs: z.boolean().default(true),
      })
      .strict();
    LlmSchema = z
      .object({
        /** The model used for each tier. */
        tiers: z
          .object({
            nav: z.string().min(1),
            plan: z.string().min(1),
            verify: z.string().min(1),
          })
          .strict(),
        /** How many times the executor may escalate from `nav` to `plan`. */
        maxEscalations: z.number().int().min(0).default(2),
      })
      .strict();
    MemorySchema = z
      .object({
        /** How long a playbook entry stays valid, in days. */
        ttlDays: z.number().int().positive().default(30),
      })
      .strict();
    PolicySchema = z
      .object({
        version: z.literal(1),
        domains: z
          .object({
            allow: DomainSchema.default([]),
            deny: DomainSchema.default([]),
          })
          .strict()
          .default({ allow: [], deny: [] }),
        /** Origins the operator owns. */
        ownedOrigins: z.array(z.string().min(1)).default([]),
        actionClasses: ActionClassesSchema.default({
          approvalRequired: ['submit', 'destructive', 'financial', 'messaging', 'upload'],
          deny: [],
        }),
        budgets: BudgetsSchema.default({
          maxSteps: 80,
          maxRetriesPerStep: 2,
          maxSeconds: 600,
          maxTokens: 2e5,
        }),
        rate: RateSchema.default({ maxRpsPerDomain: 1, jitterMs: [300, 1200] }),
        compliance: ComplianceSchema.default({
          respectRobots: true,
          userAgentSuffix: 'BrowserVerified/1.0 (+@url:`https://your-site/contact`)',
          captcha: 'human_handoff',
          evalReadonly: false,
        }),
        secrets: SecretsSchema.default({ maskInLogs: true }),
        llm: LlmSchema.optional(),
        memory: MemorySchema.default({ ttlDays: 30 }),
      })
      .strict();
    FORBIDDEN_KEYS = [
      {
        key: 'stealth',
        because: 'fingerprint spoofing and bot-detection evasion are out of scope',
      },
      { key: 'fingerprint', because: 'fingerprint spoofing is out of scope' },
      { key: 'userAgentRandomize', because: 'the user agent must be honest' },
      { key: 'randomizeUserAgent', because: 'the user agent must be honest' },
      { key: 'captchaSolver', because: 'CAPTCHA solving is out of scope; use a human handoff' },
      { key: 'solveCaptcha', because: 'CAPTCHA solving is out of scope; use a human handoff' },
      { key: 'proxyPool', because: 'rotating proxy pools are out of scope' },
      { key: 'proxyRotation', because: 'rotating proxy pools are out of scope' },
      { key: 'proxies', because: 'rotating proxy pools are out of scope' },
      { key: 'credentialStuffing', because: 'credential stuffing is out of scope' },
      { key: 'massAccountCreation', because: 'mass account creation is out of scope' },
      { key: 'webdriverMasking', because: 'navigator.webdriver masking is out of scope' },
      { key: 'bypassWaf', because: 'bypassing a WAF is out of scope' },
      { key: 'bypassPaywall', because: 'bypassing a paywall is out of scope' },
    ];
    PolicyLoadError = class extends Error {
      issues;
      constructor(message, issues = []) {
        super(message);
        this.name = 'PolicyLoadError';
        this.issues = issues;
      }
    };
  },
});

// src/safety/classify.ts
function matchesAny(patterns, text) {
  if (text === void 0 || text.length === 0) return false;
  return patterns.some((p) => p.test(text));
}
function classifyAction(intent) {
  const label = intent.name ?? intent.text;
  if (intent.kind === 'goto' || intent.kind === 'back' || intent.kind === 'reload') {
    return 'navigate';
  }
  if (intent.kind === 'download') return 'download';
  if (intent.kind === 'upload' || intent.isFileInput === true) return 'upload';
  if (intent.kind === 'eval-readonly' || intent.kind === 'read' || intent.kind === 'snapshot') {
    return 'read';
  }
  const isInput =
    intent.kind === 'fill' ||
    intent.kind === 'type' ||
    intent.kind === 'select' ||
    intent.kind === 'check' ||
    intent.kind === 'uncheck' ||
    intent.kind === 'press';
  if (isInput) {
    if (intent.role !== void 0 && SUBMIT_ROLES.has(intent.role)) {
      const formMethod = (intent.formMethod ?? ASSUMED_FORM_METHOD).toUpperCase();
      if (formMethod === 'GET') return 'navigate';
      if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';
      if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
      if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
      return 'submit';
    }
    if (intent.inputType !== void 0 && SENSITIVE_INPUT_TYPES.has(intent.inputType)) {
      return 'input';
    }
    if (intent.inputType !== void 0 && EMAIL_INPUT_TYPES.has(intent.inputType)) {
      return 'input';
    }
    if (intent.role !== void 0 && INPUT_ROLES.has(intent.role)) {
      return 'input';
    }
    if (intent.role !== void 0 && TOGGLE_ROLES.has(intent.role)) {
      return 'input';
    }
    if (intent.inForm === true) {
      return 'input';
    }
    return 'input';
  }
  if (intent.kind === 'click' || intent.kind === 'dblclick' || intent.kind === 'hover') {
    if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';
    if (intent.role !== void 0 && LINK_ROLES.has(intent.role)) {
      return 'navigate';
    }
    if (intent.role !== void 0 && READ_ROLES.has(intent.role)) {
      return 'read';
    }
    if (intent.role !== void 0 && SUBMIT_ROLES.has(intent.role)) {
      const formMethod = (intent.formMethod ?? ASSUMED_FORM_METHOD).toUpperCase();
      if (formMethod === 'GET') return 'navigate';
      if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
      if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
      if (matchesAny(UPLOAD_PATTERNS, label)) return 'upload';
      return 'submit';
    }
    if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
    if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
    if (matchesAny(UPLOAD_PATTERNS, label)) return 'upload';
    if (matchesAny(SUBMIT_PATTERNS, label)) return 'submit';
    if (intent.inForm === true) return 'submit';
    return 'submit';
  }
  const method = (intent.method ?? '').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    if (matchesAny(DESTRUCTIVE_PATTERNS, label)) return 'destructive';
    if (matchesAny(FINANCIAL_PATTERNS, label)) return 'financial';
    if (matchesAny(MESSAGING_PATTERNS, label)) return 'messaging';
    return 'submit';
  }
  if (method === 'GET' || method === 'HEAD') return 'read';
  return 'submit';
}
var DESTRUCTIVE_PATTERNS,
  FINANCIAL_PATTERNS,
  MESSAGING_PATTERNS,
  UPLOAD_PATTERNS,
  SUBMIT_PATTERNS,
  SENSITIVE_INPUT_TYPES,
  EMAIL_INPUT_TYPES,
  ASSUMED_FORM_METHOD,
  READ_ROLES,
  SUBMIT_ROLES,
  LINK_ROLES,
  INPUT_ROLES,
  TOGGLE_ROLES;
var init_classify = __esm({
  'src/safety/classify.ts'() {
    'use strict';
    DESTRUCTIVE_PATTERNS = [
      /\bdelete\b/i,
      /\bremove\b/i,
      /\bdestroy\b/i,
      /\berase\b/i,
      /\bwipe\b/i,
      /\bclear\s+(all|everything)\b/i,
      /\bdrop\b/i,
      /\bpurge\b/i,
      /\btruncate\b/i,
      /\breset\b/i,
      /\brevoke\b/i,
      /\bterminate\b/i,
      /\bdisable\b/i,
      /\bdeactivate\b/i,
      /\bunsubscribe\b/i,
      /\bclose\s+account\b/i,
    ];
    FINANCIAL_PATTERNS = [
      /\bpay\b/i,
      /\bpayment\b/i,
      /\bpurchase\b/i,
      /\bbuy\b/i,
      /\bcheckout\b/i,
      /\bplace\s+order\b/i,
      /\bsubscribe\b/i,
      /\bdonate\b/i,
      /\btip\b/i,
      /\btransfer\b/i,
      /\bwithdraw\b/i,
      /\bdeposit\b/i,
      /\bwire\b/i,
      /\binvoice\b/i,
      /\bbilling\b/i,
      /\bcard\b/i,
      /\bcredit\s+card\b/i,
      /\bconfirm\s+order\b/i,
      /\bupgrade\b/i,
      /\brenew\b/i,
      /\bprice\b/i,
    ];
    MESSAGING_PATTERNS = [
      /\bsend\b/i,
      /\bemail\b/i,
      /\be-mail\b/i,
      /\bmessage\b/i,
      /\bpost\b/i,
      /\bpublish\b/i,
      /\bshare\b/i,
      /\btweet\b/i,
      /\bcomment\b/i,
      /\breply\b/i,
      /\bforward\b/i,
      /\bnotify\b/i,
      /\bsubscribe\s+to\s+the\s+newsletter\b/i,
      /\bcontact\s+us\b/i,
      /\breport\b/i,
      /\bflag\b/i,
      /\bmention\b/i,
      /\bmessage\s+the\b/i,
    ];
    UPLOAD_PATTERNS = [
      /\bupload\b/i,
      /\battach\b/i,
      /\bchoose\s+file\b/i,
      /\bselect\s+file\b/i,
      /\bbrowse\b/i,
      /\bimport\b/i,
    ];
    SUBMIT_PATTERNS = [
      /\bsubmit\b/i,
      /\bsign\s?in\b/i,
      /\bsign\s?up\b/i,
      /\blog\s?in\b/i,
      /\bregister\b/i,
      /\bcontinue\b/i,
      /\bnext\b/i,
      /\bconfirm\b/i,
      /\bapply\b/i,
      /\bcreate\b/i,
      /\bsave\b/i,
      /\bsearch\b/i,
      /\bsubscribe\b/i,
      /\bplace\b/i,
    ];
    SENSITIVE_INPUT_TYPES = /* @__PURE__ */ new Set(['password', 'file']);
    EMAIL_INPUT_TYPES = /* @__PURE__ */ new Set(['email']);
    ASSUMED_FORM_METHOD = 'POST';
    READ_ROLES = /* @__PURE__ */ new Set([
      'article',
      'definition',
      'figure',
      'img',
      'list',
      'listitem',
      'paragraph',
      'region',
      'table',
      'term',
      'heading',
      'banner',
      'complementary',
      'contentinfo',
      'navigation',
      'main',
      'group',
      'note',
      'status',
      'timer',
      'tooltip',
      'document',
      'log',
    ]);
    SUBMIT_ROLES = /* @__PURE__ */ new Set(['button']);
    LINK_ROLES = /* @__PURE__ */ new Set(['link']);
    INPUT_ROLES = /* @__PURE__ */ new Set([
      'textbox',
      'searchbox',
      'combobox',
      'spinbutton',
      'slider',
    ]);
    TOGGLE_ROLES = /* @__PURE__ */ new Set([
      'checkbox',
      'radio',
      'switch',
      'menuitem',
      'tab',
      'option',
    ]);
  },
});

// src/safety/evaluator.ts
function normalizePattern(pattern) {
  const value = pattern.toLowerCase().replace(/^\.+/, '').replace(/\/+$/, '');
  if (value.startsWith('*.')) {
    return { kind: 'suffix', value: value.slice(1) };
  }
  return { kind: 'exact', value };
}
function hostOf(url) {
  if (url === void 0) return void 0;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return void 0;
  }
}
function matchDomains(host, patterns) {
  if (host === void 0) return { matched: false };
  const lower = host.toLowerCase();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    let comparable = pattern;
    if (pattern.toLowerCase().startsWith(URL_MARKER)) {
      const url = pattern.slice(URL_MARKER.length).trim().replace(/^`|`$/g, '');
      const parsedHost = hostOf(url);
      if (parsedHost === void 0) continue;
      comparable = parsedHost;
    }
    const normalized = normalizePattern(comparable);
    if (normalized.kind === 'suffix') {
      if (lower === normalized.value.slice(1) || lower.endsWith(normalized.value)) {
        return { matched: true, pattern: raw };
      }
    } else if (lower === normalized.value || lower === `www.${normalized.value}`) {
      return { matched: true, pattern: raw };
    }
  }
  return { matched: false };
}
function normalizeOrigin(value) {
  let raw = value.trim();
  if (raw.toLowerCase().startsWith(URL_MARKER)) {
    raw = raw.slice(URL_MARKER.length).trim().replace(/^`|`$/g, '');
  }
  try {
    const parsed = new URL(raw);
    return parsed.origin.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
function isDeniedClass(actionClass, policy) {
  return policy.actionClasses.deny.includes(actionClass);
}
function requiresApproval(actionClass, policy) {
  return policy.actionClasses.approvalRequired.includes(actionClass);
}
function evaluate(intent, ctx) {
  const { policy } = ctx;
  const reasons = [];
  const ruleIds = [];
  const actionClass = classifyAction(intent);
  if (isDeniedClass(actionClass, policy)) {
    reasons.push(`the "${actionClass}" action class is denied by policy`);
    ruleIds.push(`policy.deny.${actionClass}`);
    return { verdict: 'deny', reasons, ruleIds, actionClass };
  }
  const effectiveUrl = intent.url ?? ctx.url;
  const targetHost = hostOf(effectiveUrl);
  if (targetHost !== void 0) {
    const denied = matchDomains(targetHost, policy.domains.deny);
    if (denied.matched) {
      reasons.push(`the host "${targetHost}" is denied by policy`);
      ruleIds.push('policy.domain.deny');
      return { verdict: 'deny', reasons, ruleIds, actionClass };
    }
  }
  if (effectiveUrl !== void 0 && policy.domains.allow.length > 0) {
    const allowed = matchDomains(targetHost, policy.domains.allow);
    if (!allowed.matched) {
      reasons.push(`the host "${targetHost ?? 'unknown'}" is not in the policy's allowed domains`);
      ruleIds.push('policy.domain.allow');
      return { verdict: 'deny', reasons, ruleIds, actionClass };
    }
  }
  if (intent.kind === 'eval-readonly' && policy.compliance.evalReadonly !== true) {
    reasons.push('eval-readonly is disabled; set compliance.evalReadonly to enable it');
    ruleIds.push('policy.eval_readonly.disabled');
    return { verdict: 'deny', reasons, ruleIds, actionClass };
  }
  if (requiresApproval(actionClass, policy)) {
    if (ctx.approved === true) {
      reasons.push(`the "${actionClass}" action class was approved`);
      ruleIds.push(`policy.approval.granted.${actionClass}`);
      return { verdict: 'allow', reasons, ruleIds, actionClass };
    }
    if (ctx.nonInteractive) {
      reasons.push(
        `the "${actionClass}" action class requires approval and this session is non-interactive`,
      );
      ruleIds.push(`policy.approval.required.${actionClass}`);
      return { verdict: 'deny', reasons, ruleIds, actionClass };
    }
    reasons.push(`the "${actionClass}" action class requires approval`);
    ruleIds.push(`policy.approval.required.${actionClass}`);
    return { verdict: 'needs_approval', reasons, ruleIds, actionClass };
  }
  if (ctx.tainted === true && (actionClass === 'submit' || actionClass === 'messaging')) {
    reasons.push('the action would send content derived from the page');
    ruleIds.push('policy.tainted.submit');
    return { verdict: 'needs_approval', reasons, ruleIds, actionClass };
  }
  reasons.push(`the "${actionClass}" action class is allowed by policy`);
  ruleIds.push(`policy.allow.${actionClass}`);
  return { verdict: 'allow', reasons, ruleIds, actionClass };
}
var init_evaluator = __esm({
  'src/safety/evaluator.ts'() {
    'use strict';
    init_classify();
    init_policy();
  },
});

// src/safety/planlock.ts
import { z as z2 } from 'zod';
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
var ConditionSchema, PlanSchema, PlanLock;
var init_planlock = __esm({
  'src/safety/planlock.ts'() {
    'use strict';
    init_policy();
    init_evaluator();
    ConditionSchema = z2.lazy(() =>
      z2.union([
        z2.object({ all: z2.array(ConditionSchema) }).strict(),
        z2.object({ any: z2.array(ConditionSchema) }).strict(),
        z2.object({ not: ConditionSchema }).strict(),
        z2.object({ type: z2.literal('url_matches'), pattern: z2.string().min(1) }).strict(),
        z2.object({ type: z2.literal('text_visible'), text: z2.string().min(1) }).strict(),
        z2
          .object({
            type: z2.literal('element'),
            role: z2.string().min(1),
            name: z2.string().optional(),
            min: z2.number().int().min(0).optional(),
            max: z2.number().int().min(0).optional(),
          })
          .strict(),
        z2
          .object({
            type: z2.literal('network_response'),
            urlPattern: z2.string().min(1),
            status: z2.number().int(),
          })
          .strict(),
        z2
          .object({ type: z2.literal('storage'), key: z2.string().min(1), matches: z2.string() })
          .strict(),
        z2.object({ type: z2.literal('llm_judged'), claim: z2.string().min(1) }).strict(),
      ]),
    );
    PlanSchema = z2
      .object({
        goal: z2.string().min(1),
        successCondition: ConditionSchema,
        allowedOrigins: z2.array(z2.string().min(1)).default([]),
        allowedActionClasses: z2.array(z2.enum(ACTION_CLASSES)).default([]),
        maxSteps: z2.number().int().positive().default(80),
        createdAt: z2.string().min(1),
      })
      .strict();
    PlanLock = class {
      plan;
      stepsUsed = 0;
      /** The current plan. */
      get current() {
        return this.plan;
      }
      /** True when a plan is set. */
      get hasPlan() {
        return this.plan !== void 0;
      }
      /** How many steps have been taken under the current plan. */
      get steps() {
        return this.stepsUsed;
      }
      /**
       * Set the plan.
       *
       * Setting a plan resets the step counter.
       */
      set(plan) {
        this.plan = plan;
        this.stepsUsed = 0;
      }
      /** Remove the plan. */
      clear() {
        this.plan = void 0;
        this.stepsUsed = 0;
      }
      /**
       * Amend the plan.
       *
       * Amending requires approval: the caller must pass `approved: true`, which
       * the approval gate sets after a human has agreed. Amending is also
       * audit-logged by the caller.
       */
      amend(changes, options) {
        if (this.plan === void 0) {
          return { ok: false, reason: 'no plan is set' };
        }
        if (!options.approved) {
          return { ok: false, reason: 'amending a plan requires approval' };
        }
        const merged = PlanSchema.safeParse({
          ...this.plan,
          ...changes,
          createdAt: this.plan.createdAt,
        });
        if (!merged.success) {
          const firstIssue = merged.error.issues[0];
          return {
            ok: false,
            reason: `the amended plan is invalid: ${firstIssue.message}`,
          };
        }
        this.plan = merged.data;
        return { ok: true, plan: merged.data };
      }
      /**
       * Check an action against the plan.
       *
       * The checks, in order:
       *  1. a plan must be set,
       *  2. the step budget must not be exceeded,
       *  3. the action class must be in `allowedActionClasses`,
       *  4. the target origin must be in `allowedOrigins`.
       */
      check(options) {
        const plan = this.plan;
        if (plan === void 0) {
          return {
            allowed: false,
            reason: 'no plan is set: run `bv plan set <file>` before acting',
            ruleId: 'plan.not_set',
          };
        }
        if (this.stepsUsed >= plan.maxSteps) {
          return {
            allowed: false,
            reason: `the plan's step budget of ${plan.maxSteps} is exhausted`,
            ruleId: 'plan.budget_exhausted',
          };
        }
        if (!plan.allowedActionClasses.includes(options.actionClass)) {
          return {
            allowed: false,
            reason: `the "${options.actionClass}" action class is not in the plan`,
            ruleId: 'plan.off_plan.action_class',
          };
        }
        const target = options.url ?? options.currentUrl;
        if (target !== void 0 && plan.allowedOrigins.length > 0) {
          const targetOrigin = normalizeOrigin(originOf(target));
          const allowed = plan.allowedOrigins.some((o) => normalizeOrigin(o) === targetOrigin);
          if (!allowed) {
            return {
              allowed: false,
              reason: `the origin "${targetOrigin}" is not in the plan`,
              ruleId: 'plan.off_plan.origin',
            };
          }
        }
        return { allowed: true };
      }
      /** Record that a step was taken. */
      recordStep() {
        this.stepsUsed += 1;
      }
    };
  },
});

// src/core/daemon.ts
import { createServer } from 'http';
import { randomBytes as randomBytes3 } from 'crypto';
import { once } from 'events';
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function startDaemon(options) {
  const token = options.token ?? randomBytes3(32).toString('hex');
  const tokenHash = hashToken(token);
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const server = createServer((req, res) => {
    void handleRequest(req, res, options, tokenHash, maxBodyBytes);
  });
  await new Promise((resolve5, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve5());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('daemon failed to bind a port');
  }
  const info = {
    version: 1,
    port: address.port,
    pid: options.pid ?? process.pid,
    tokenHash,
    session: options.session ?? 'default',
    startedAt: /* @__PURE__ */ new Date().toISOString(),
    headed: options.headed ?? false,
    browser: options.browser ?? 'chromium',
  };
  return {
    port: address.port,
    token,
    info,
    server,
    close: async () => {
      await new Promise((resolve5) => {
        server.close(() => resolve5());
        server.closeAllConnections?.();
      });
    },
  };
}
async function handleRequest(req, res, options, tokenHash, maxBodyBytes) {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  try {
    const header = req.headers['authorization'];
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(presented, tokenHash)) {
      send(401, { ok: false, error: 'unauthorized: invalid or missing bearer token' });
      return;
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      send(200, { ok: true, data: { version: VERSION, status: 'ok' } });
      return;
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: `method not allowed: ${req.method ?? 'unknown'}` });
      return;
    }
    const raw = await readBody(req, maxBodyBytes);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
      send(400, { ok: false, error: 'missing "method" in request body' });
      return;
    }
    const handler = options.handlers[parsed.method];
    if (handler === void 0) {
      send(404, { ok: false, error: `unknown method: ${parsed.method}` });
      return;
    }
    const result = await handler(parsed);
    send(200, {
      ok: true,
      ...(result.data !== void 0 ? { data: result.data } : {}),
      ...(result.exitCode !== void 0 ? { exitCode: result.exitCode } : {}),
      ...(result.reasons !== void 0 ? { reasons: result.reasons } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(500, { ok: false, error: message });
  }
}
var init_daemon = __esm({
  'src/core/daemon.ts'() {
    'use strict';
    init_daemon_info();
    init_version();
  },
});

// src/core/browser.ts
import { chromium } from 'playwright';
async function launchChromium(options = {}) {
  const headless = options.headed !== true;
  const launchOptions = { headless };
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Executable doesn't exist")) throw err;
    return chromium.launch({ ...launchOptions, channel: 'chromium' });
  }
}
var init_browser = __esm({
  'src/core/browser.ts'() {
    'use strict';
  },
});

// src/core/contexts.ts
var SessionState;
var init_contexts = __esm({
  'src/core/contexts.ts'() {
    'use strict';
    SessionState = class {
      browser;
      context;
      pages = [];
      /** The index of the active page. */
      activeIndex = 0;
      /** Pages that were opened by the page rather than by the user. */
      popupPages = /* @__PURE__ */ new Set();
      constructor(browser) {
        this.browser = browser;
      }
      /** Create the context if it does not exist. */
      async ensureContext(options = {}) {
        if (this.context !== void 0) return this.context;
        const contextOptions = {};
        if (options.userAgent !== void 0) contextOptions.userAgent = options.userAgent;
        this.context = await this.browser.newContext(contextOptions);
        return this.context;
      }
      /** The active page, creating one if needed. */
      async activePage() {
        const context = await this.ensureContext();
        const existing = this.pages[this.activeIndex];
        if (existing !== void 0 && !existing.isClosed()) return existing;
        const page = await context.newPage();
        this.pages.push(page);
        this.activeIndex = this.pages.length - 1;
        return page;
      }
      /** Register a page that Playwright reports as a popup. */
      registerPopup(page) {
        this.popupPages.add(page);
        this.pages.push(page);
      }
      /** Forget closed pages and return the list of live tabs. */
      async tabs() {
        this.pages = this.pages.filter((p) => !p.isClosed());
        if (this.activeIndex >= this.pages.length) {
          this.activeIndex = Math.max(0, this.pages.length - 1);
        }
        const infos = [];
        for (const [index, page] of this.pages.entries()) {
          let url = '';
          let title = '';
          try {
            url = page.url();
            title = await page.title().catch(() => '');
          } catch {}
          infos.push({
            index,
            url,
            title,
            active: index === this.activeIndex,
            popup: this.popupPages.has(page),
          });
        }
        return infos;
      }
      /** Switch to a tab by index. */
      selectTab(index) {
        const page = this.pages[index];
        if (page === void 0) {
          throw new Error(`no tab with index ${index}`);
        }
        this.activeIndex = index;
        return page;
      }
      /** Close a tab by index. */
      async closeTab(index) {
        const page = this.pages[index];
        if (page === void 0) {
          throw new Error(`no tab with index ${index}`);
        }
        await page.close().catch(() => void 0);
        this.pages = this.pages.filter((_, i) => i !== index);
        if (this.activeIndex >= this.pages.length) {
          this.activeIndex = Math.max(0, this.pages.length - 1);
        }
      }
      /** List the frames of the active page. */
      async frames(page) {
        const target = page ?? (await this.activePage());
        return target.frames().map((frame, index) => ({
          url: frame.url(),
          ...(frame.name() !== '' ? { name: frame.name() } : {}),
          isMain: frame === target.mainFrame(),
          index,
        }));
      }
      /** Save the storage state of the context. */
      async storageState() {
        if (this.context === void 0) return null;
        return this.context.storageState();
      }
      /**
       * Restore a storage state into a live context.
       *
       * Playwright can only apply a storage state when *creating* a context, so
       * restoring into a running context is done explicitly:
       *  - cookies via `context.addCookies()`,
       *  - localStorage via an init script that seeds it before any page script
       *    runs.
       *
       * sessionStorage is not restorable: it is per-tab and dies with the tab.
       * This is recorded in docs/KNOWN_LIMITATIONS.md.
       */
      async restoreStorageState(state) {
        if (state === null || state === void 0) return;
        const context = await this.ensureContext();
        if (typeof state !== 'object' || state === null) return;
        const typed = state;
        if (Array.isArray(typed.cookies)) {
          const valid = typed.cookies.filter((c) => typeof c === 'object' && c !== null);
          if (valid.length > 0) {
            await context.addCookies(valid);
          }
        }
        if (Array.isArray(typed.origins)) {
          const seed = typed.origins
            .filter(
              (o) =>
                typeof o === 'object' &&
                o !== null &&
                typeof o.origin === 'string' &&
                Array.isArray(o.localStorage),
            )
            .map((o) => ({
              origin: o.origin,
              localStorage: o.localStorage.filter(
                (e) => typeof e === 'object' && e !== null && typeof e.name === 'string',
              ),
            }))
            .filter((o) => o.localStorage.length > 0);
          if (seed.length > 0) {
            await context.addInitScript((entries) => {
              for (const entry of entries) {
                try {
                  const loc = window.location;
                  if (loc.origin !== entry.origin) continue;
                  for (const item of entry.localStorage) {
                    window.localStorage.setItem(item.name, item.value);
                  }
                } catch {}
              }
            }, seed);
          }
        }
      }
      /** Close everything. */
      async close() {
        await this.context?.close().catch(() => void 0);
        this.context = void 0;
        this.pages = [];
      }
    };
  },
});

// src/perception/snapshot.ts
function normalizeSnapshot(raw) {
  if (!Array.isArray(raw)) return [];
  const roots = [];
  for (const item of raw) {
    const node = normalizeNode(item);
    if (node !== void 0) roots.push(node);
  }
  return roots;
}
function normalizeNode(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return void 0;
  const source = raw;
  const role = typeof source['role'] === 'string' ? source['role'] : void 0;
  if (role === void 0) return void 0;
  const node = { role };
  const name = source['name'];
  if (typeof name === 'string') node.name = name;
  const text = source['text'];
  if (typeof text === 'string') node.text = text;
  const ref = source['ref'];
  if (typeof ref === 'string') node.ref = ref;
  const level = source['level'];
  if (typeof level === 'number') node.level = level;
  for (const flag of ['checked', 'expanded', 'selected', 'pressed', 'disabled']) {
    const value = source[flag];
    if (typeof value === 'boolean') node[flag] = value;
  }
  const cursor = source['cursor'];
  if (typeof cursor === 'string') node.cursor = cursor === 'pointer';
  const children = source['children'];
  if (Array.isArray(children)) {
    const normalizedChildren = [];
    for (const child of children) {
      const normalized = normalizeNode(child);
      if (normalized !== void 0) normalizedChildren.push(normalized);
    }
    if (normalizedChildren.length > 0) node.children = normalizedChildren;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key in node) continue;
    if (value === null || value === void 0) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      node[key] = value;
    }
  }
  return node;
}
function countNodes(roots) {
  let total = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      total += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return total;
}
function walkNodes(roots, visit) {
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      visit(node, parent);
      if (node.children) walk(node.children, node);
    }
  };
  walk(roots, void 0);
}
function nodeIdentity(node) {
  const parts = [node.role];
  if (node.name !== void 0) parts.push(`name=${node.name}`);
  if (node.ref !== void 0) parts.push(`ref=${node.ref}`);
  return parts.join('|');
}
function nodeLooseIdentity(node) {
  const parts = [node.role];
  if (node.name !== void 0) parts.push(`name=${node.name}`);
  else if (node.text !== void 0) parts.push(`text=${node.text}`);
  return parts.join('|');
}
var init_snapshot = __esm({
  'src/perception/snapshot.ts'() {
    'use strict';
  },
});

// src/perception/diff.ts
function indexNodes(roots) {
  const index = /* @__PURE__ */ new Map();
  walkNodes(roots, (node) => {
    const key = nodeIdentity(node);
    if (!index.has(key)) index.set(key, node);
  });
  return index;
}
function indexLoose(roots) {
  const index = /* @__PURE__ */ new Map();
  walkNodes(roots, (node) => {
    const key = nodeLooseIdentity(node);
    const list = index.get(key);
    if (list === void 0) {
      index.set(key, [node]);
    } else {
      list.push(node);
    }
  });
  return index;
}
function computeDepths(roots) {
  const depths = /* @__PURE__ */ new Map();
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      depths.set(nodeIdentity(node), depth);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return depths;
}
function diffSnapshots(previous, current) {
  const previousIndex = previous ? indexNodes(previous.roots) : /* @__PURE__ */ new Map();
  const currentIndex = indexNodes(current.roots);
  const depths = computeDepths(current.roots);
  const changes = [];
  const navigated = previous !== void 0 && previous.documentToken !== current.documentToken;
  const previousLoose = previous ? indexLoose(previous.roots) : /* @__PURE__ */ new Map();
  const pairedPrevious = /* @__PURE__ */ new Set();
  const pairedCurrent = /* @__PURE__ */ new Set();
  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== void 0) {
      pairedPrevious.add(previousNode);
      pairedCurrent.add(currentNode);
      continue;
    }
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const free = candidates.find((c) => !pairedPrevious.has(c));
    if (free !== void 0) {
      pairedPrevious.add(free);
      pairedCurrent.add(currentNode);
    }
  }
  for (const [key, node] of currentIndex) {
    if (pairedCurrent.has(node)) continue;
    const change = {
      kind: 'added',
      role: node.role,
      depth: depths.get(key) ?? 0,
    };
    if (node.ref !== void 0) change.ref = node.ref;
    if (node.name !== void 0) change.name = node.name;
    if (node.text !== void 0) change.text = node.text;
    changes.push(change);
  }
  for (const node of previousIndex.values()) {
    if (pairedPrevious.has(node)) continue;
    const change = {
      kind: 'removed',
      role: node.role,
      depth: 0,
    };
    if (node.ref !== void 0) change.ref = node.ref;
    if (node.name !== void 0) change.name = node.name;
    if (node.text !== void 0) change.text = node.text;
    changes.push(change);
  }
  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== void 0) {
      reportTextChange(previousNode, currentNode, depths, changes);
      reportNameChange(previousNode, currentNode, depths, changes);
      reportStateChanges(previousNode, currentNode, depths, changes);
      continue;
    }
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const looseMatch = candidates.find(
      (c) => !changes.some((ch) => ch.ref === c.ref && ch.kind === 'removed'),
    );
    if (looseMatch === void 0) continue;
    reportTextChange(looseMatch, currentNode, depths, changes);
    reportNameChange(looseMatch, currentNode, depths, changes);
    reportStateChanges(looseMatch, currentNode, depths, changes);
    if (looseMatch.ref !== currentNode.ref) {
      changes.push({
        kind: 'changed',
        role: currentNode.role,
        field: 'ref',
        before: looseMatch.ref ?? '',
        after: currentNode.ref ?? '',
        depth: depths.get(key) ?? 0,
        ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
        ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
      });
    }
  }
  changes.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const order = { added: 0, changed: 1, removed: 2 };
    return order[a.kind] - order[b.kind];
  });
  let interactive = 0;
  let frames = 0;
  walkNodes(current.roots, (node) => {
    if (INTERACTIVE_ROLES.has(node.role)) interactive += 1;
    if (node.role === 'iframe') frames += 1;
  });
  return {
    header: {
      url: current.url,
      title: current.title,
      nodes: currentIndex.size,
      interactive,
      changes: changes.length,
      frames,
    },
    changes,
    navigated,
  };
}
function reportTextChange(previousNode, currentNode, depths, changes) {
  if (previousNode.text === currentNode.text) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'text',
    before: previousNode.text ?? '',
    after: currentNode.text ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
    ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
  });
}
function reportNameChange(previousNode, currentNode, depths, changes) {
  if (previousNode.name === currentNode.name) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'name',
    before: previousNode.name ?? '',
    after: currentNode.name ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
  });
}
function reportStateChanges(previousNode, currentNode, depths, changes) {
  for (const flag of STATE_FLAGS) {
    const before = previousNode[flag];
    const after = currentNode[flag];
    if (before === after) continue;
    changes.push({
      kind: 'changed',
      role: currentNode.role,
      field: 'state',
      state: { key: flag, before, after },
      depth: depths.get(nodeIdentity(currentNode)) ?? 0,
      ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
      ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
    });
  }
}
var INTERACTIVE_ROLES, STATE_FLAGS;
var init_diff = __esm({
  'src/perception/diff.ts'() {
    'use strict';
    init_snapshot();
    INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
      'button',
      'checkbox',
      'combobox',
      'link',
      'menuitem',
      'option',
      'radio',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
    ]);
    STATE_FLAGS = ['checked', 'expanded', 'selected', 'pressed', 'disabled'];
  },
});

// src/perception/prune.ts
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\u2026 [${text.length - maxLength} more chars]`;
}
function collapseSimilarSiblings(children, maxSimilar) {
  const result = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index];
    if (node === void 0) break;
    const collapsible =
      node.children === void 0 &&
      node.role !== 'heading' &&
      (node.name !== void 0 || node.text !== void 0);
    if (!collapsible) {
      result.push(node);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < children.length) {
      const candidate = children[end];
      if (candidate === void 0) break;
      if (
        candidate.role !== node.role ||
        candidate.name !== node.name ||
        candidate.text !== node.text ||
        candidate.children !== void 0
      ) {
        break;
      }
      end += 1;
    }
    const runLength = end - index;
    if (runLength <= maxSimilar) {
      for (let i = index; i < end; i++) {
        const item = children[i];
        if (item !== void 0) result.push(item);
      }
    } else {
      const keep = maxSimilar;
      for (let i = 0; i < keep; i++) {
        const item = children[index + i];
        if (item !== void 0) result.push(item);
      }
      result.push({
        role: 'note',
        text: `\u2026 +${runLength - keep} similar items`,
      });
    }
    index = end;
  }
  return result;
}
function dropDecorative(node) {
  if (!DECORATIVE_ROLES.has(node.role)) return node;
  if (node.children === void 0 || node.children.length === 0) {
    const hasText = node.text !== void 0 && node.text.trim().length > 0;
    const hasName = node.name !== void 0 && node.name.trim().length > 0;
    if (!hasText && !hasName) return void 0;
    return node;
  }
  const kept = node.children.map((c) => dropDecorative(c)).filter((c) => c !== void 0);
  if (kept.length === 0) return void 0;
  if (kept.length === 1 && node.name === void 0 && node.text === void 0) {
    return kept[0];
  }
  return { ...node, children: kept };
}
function pruneSnapshot(roots, options = {}) {
  const maxTextLength = options.maxTextLength ?? 120;
  const maxSimilar = options.maxSimilarSiblings ?? 3;
  const charsPerToken = options.charsPerToken ?? 4;
  const before = countNodes(roots);
  const pruneNode = (node) => {
    const kept = dropDecorative(node);
    if (kept === void 0) return void 0;
    const next = { ...kept };
    if (next.text !== void 0) {
      next.text = truncateText(next.text, maxTextLength);
    }
    if (next.name !== void 0 && next.name.length > maxTextLength * 2) {
      next.name = truncateText(next.name, maxTextLength * 2);
    }
    if (next.children !== void 0) {
      const prunedChildren = next.children.map((c) => pruneNode(c)).filter((c) => c !== void 0);
      const collapsed = collapseSimilarSiblings(prunedChildren, maxSimilar);
      if (collapsed.length > 0) {
        next.children = collapsed;
      } else {
        delete next.children;
      }
    }
    return next;
  };
  const prunedRoots = roots.map((r) => pruneNode(r)).filter((r) => r !== void 0);
  let budgetApplied = false;
  const maxTokens = options.maxTokens;
  if (maxTokens !== void 0 && maxTokens > 0) {
    let estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    while (estimate > maxTokens && prunedRoots.length > 0) {
      const removed = removeLeastValuable(prunedRoots);
      if (!removed) break;
      budgetApplied = true;
      estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    }
  }
  return { roots: prunedRoots, before, after: countNodes(prunedRoots), budgetApplied };
}
function estimateTreeTokens(roots, charsPerToken = 4) {
  let chars = 0;
  walkNodes(roots, (node) => {
    chars += node.role.length;
    if (node.name !== void 0) chars += node.name.length + 6;
    if (node.text !== void 0) chars += node.text.length + 6;
    if (node.ref !== void 0) chars += node.ref.length + 6;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'role' || key === 'name' || key === 'text' || key === 'ref') continue;
      if (key === 'children') continue;
      if (typeof value === 'boolean') chars += key.length + 4;
    }
  });
  return Math.ceil(chars / charsPerToken);
}
function removeLeastValuable(roots) {
  let target;
  let deepest = -1;
  const search = (nodes, depth, parent2) => {
    nodes.forEach((node, index2) => {
      if (node.children) {
        search(node.children, depth + 1, node);
      }
      const meaningful = node.ref !== void 0 || node.name !== void 0 || node.text !== void 0;
      if (!meaningful && parent2 !== void 0 && depth > deepest) {
        deepest = depth;
        target = { parent: parent2, index: index2, depth };
      }
    });
  };
  search(roots, 0);
  if (target === void 0) {
    let leaf;
    const findLeaf = (nodes, depth, parent3) => {
      nodes.forEach((node, index3) => {
        if (node.children && node.children.length > 0) {
          findLeaf(node.children, depth + 1, node);
        } else if (parent3 !== void 0 && depth > deepest) {
          deepest = depth;
          leaf = { parent: parent3, index: index3, depth };
        }
      });
    };
    findLeaf(roots, 0);
    if (leaf === void 0) return false;
    const { parent: parent2, index: index2 } = leaf;
    parent2.children?.splice(index2, 1);
    if (parent2.children?.length === 0) delete parent2.children;
    return true;
  }
  const { parent, index } = target;
  parent.children?.splice(index, 1);
  if (parent.children?.length === 0) delete parent.children;
  return true;
}
var DECORATIVE_ROLES;
var init_prune = __esm({
  'src/perception/prune.ts'() {
    'use strict';
    init_snapshot();
    DECORATIVE_ROLES = /* @__PURE__ */ new Set(['generic', 'none', 'presentation']);
  },
});

// src/perception/render.ts
function renderHeader(header, notes = [], options = {}) {
  const parts = [];
  if (options.previousUrl === void 0 || options.previousUrl !== header.url) {
    parts.push(`url=${header.url}`);
  }
  parts.push(`title=${truncate(header.title, 50)}`);
  if (header.frames > 0) parts.push(`frames=${header.frames}`);
  if (header.changes > 0) parts.push(`changes=${header.changes}`);
  if (notes.length > 0) parts.push(notes.join(' '));
  return parts.join(' | ');
}
function renderChange(change) {
  const indent = '  '.repeat(Math.min(change.depth, 6));
  const ref = change.ref !== void 0 ? `[${change.ref}]` : '';
  switch (change.kind) {
    case 'added': {
      const label = change.name ?? change.text ?? '';
      return `${indent}+ ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'removed': {
      const label = change.name ?? change.text ?? '';
      return `${indent}- ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'changed': {
      if (change.field === 'text') {
        return `${indent}~ ${change.role}${ref} text: ${truncate(
          change.before ?? '',
          50,
        )} \u2192 ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'name') {
        return `${indent}~ ${change.role}${ref} name: ${truncate(
          change.before ?? '',
          50,
        )} \u2192 ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'state' && change.state !== void 0) {
        return `${indent}~ ${change.role}${ref} ${change.state.key}: ${String(
          change.state.before,
        )} \u2192 ${String(change.state.after)}`;
      }
      if (change.field === 'ref') {
        return `${indent}~ ${change.role} ref: ${change.before} \u2192 ${change.after}`;
      }
      return `${indent}~ ${change.role}${ref} changed`;
    }
    default:
      return `${indent}? ${change.role}${ref}`;
  }
}
function renderDiff(diff, options = {}) {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const lines = [renderHeader(diff.header, options.notes, options)];
  if (diff.navigated) {
    lines.push('(page navigated: all previous refs are invalid)');
  }
  if (diff.changes.length === 0) {
    lines.push('(no changes)');
    return lines.join('\n');
  }
  const shown = diff.changes.slice(0, maxChanges);
  for (const change of shown) {
    lines.push(renderChange(change));
  }
  if (diff.changes.length > shown.length) {
    lines.push(`\u2026 ${diff.changes.length - shown.length} more changes`);
  }
  return lines.join('\n');
}
function renderTree(roots, options = {}) {
  const maxLineLength = options.maxLineLength ?? 160;
  const lines = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const indent = '  '.repeat(Math.min(depth, 12));
      const ref = node.ref !== void 0 ? `[${node.ref}]` : '';
      const label = node.name ?? node.text ?? '';
      const state = describeState(node);
      let line = `${indent}${node.role}${ref}${state}`;
      if (label !== '') line += ` ${label}`;
      lines.push(truncate(line, maxLineLength));
      if (node.children !== void 0) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return lines.join('\n');
}
function describeState(node) {
  const parts = [];
  if (node.checked === true) parts.push('checked');
  if (node.expanded === true) parts.push('expanded');
  if (node.selected === true) parts.push('selected');
  if (node.pressed === true) parts.push('pressed');
  if (node.disabled === true) parts.push('disabled');
  if (node.level !== void 0) parts.push(`h${node.level}`);
  return parts.length > 0 ? ` (${parts.join(',')})` : '';
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\u2026`;
}
var DEFAULT_MAX_CHANGES;
var init_render = __esm({
  'src/perception/render.ts'() {
    'use strict';
    DEFAULT_MAX_CHANGES = 40;
  },
});

// src/actions/waits.ts
async function waitForCondition(locator, condition, options = {}) {
  const timeout = options.timeoutMs ?? 1e4;
  const started = Date.now();
  try {
    switch (condition) {
      case 'attached':
        await locator.waitFor({ state: 'attached', timeout });
        break;
      case 'detached':
        await locator.waitFor({ state: 'detached', timeout });
        break;
      case 'visible':
        await locator.waitFor({ state: 'visible', timeout });
        break;
      case 'hidden':
        await locator.waitFor({ state: 'hidden', timeout });
        break;
      case 'stable':
        await waitForStable(locator, timeout);
        break;
      case 'enabled':
        await waitForEnabled(locator, timeout);
        break;
      case 'disabled':
        await waitForDisabled(locator, timeout);
        break;
      case 'checked':
        await waitForChecked(locator, timeout);
        break;
      case 'receives-events':
        await waitForReceivesEvents(locator, timeout);
        break;
      default:
        return {
          satisfied: false,
          condition,
          durationMs: Date.now() - started,
          reason: `unknown wait condition: ${String(condition)}`,
        };
    }
    return { satisfied: true, condition, durationMs: Date.now() - started };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'timed out') : String(err);
    return {
      satisfied: false,
      condition,
      durationMs: Date.now() - started,
      reason: message,
    };
  }
}
async function waitForStable(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const first = await locator.boundingBox();
    await evaluateFrames(locator, 2);
    const second = await locator.boundingBox();
    if (first !== null && second !== null && sameBox(first, second)) {
      await evaluateFrames(locator, 2);
      const third = await locator.boundingBox();
      if (third !== null && sameBox(second, third)) return;
    }
  }
  throw new Error(`element did not become stable within ${timeout}ms`);
}
function sameBox(a, b) {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
async function evaluateFrames(locator, frames) {
  await locator.evaluate(async (element, count) => {
    const ownerDocument = element.ownerDocument;
    const view = ownerDocument.defaultView;
    if (view === null) return;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve5) => {
        view.requestAnimationFrame(() => resolve5());
      });
    }
  }, frames);
}
async function waitForEnabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become enabled within ${timeout}ms`);
}
async function waitForDisabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isDisabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become disabled within ${timeout}ms`);
}
async function waitForChecked(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isChecked().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become checked within ${timeout}ms`);
}
async function waitForReceivesEvents(locator, timeout) {
  const deadline = Date.now() + timeout;
  let lastReason = 'unknown';
  while (Date.now() < deadline) {
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { ok: false, reason: 'element has no size' };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topElement = element.ownerDocument.elementFromPoint(x, y);
      if (topElement === null) {
        return { ok: false, reason: 'no element at the centre point' };
      }
      if (element === topElement || element.contains(topElement)) {
        return { ok: true, reason: '' };
      }
      return {
        ok: false,
        reason: `covered by <${topElement.tagName.toLowerCase()}>`,
      };
    });
    if (result.ok) return;
    lastReason = result.reason;
    await delay(50);
  }
  throw new Error(`element did not receive events within ${timeout}ms: ${lastReason}`);
}
function delay(ms) {
  return new Promise((resolve5) => setTimeout(resolve5, ms));
}
var init_waits = __esm({
  'src/actions/waits.ts'() {
    'use strict';
  },
});

// src/actions/act.ts
async function performAction(page, request, options = {}) {
  const timeout = options.timeoutMs ?? request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const started = Date.now();
  const urlBefore = page.url();
  const located = await locate(page, request.target, { timeoutMs: timeout });
  const base = {
    ok: false,
    kind: request.kind,
    strategy: located.strategy,
    attempted: located.attempted,
    failures: located.failures,
    message: '',
    durationMs: 0,
    urlBefore,
    urlAfter: urlBefore,
    titleAfter: '',
  };
  if (located.locator === void 0) {
    const detail = located.failures.map((f) => `${f.strategy}: ${f.reason}`).join('; ');
    return {
      ...base,
      message: `could not locate the target (${detail || 'no strategies available'})`,
      durationMs: Date.now() - started,
    };
  }
  try {
    const message = await execute(page, located.locator, request, timeout);
    return {
      ...base,
      ok: true,
      message,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'action failed') : String(err);
    return {
      ...base,
      message: `action failed: ${message}`,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  }
}
async function scrollIntoClearView(locator, timeout) {
  await locator
    .evaluate((element) => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => void 0);
  const deadline = Date.now() + Math.min(timeout, 5e3);
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    const cover = await locator
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topElement = element.ownerDocument.elementFromPoint(x, y);
        if (topElement === null) return null;
        if (element === topElement || element.contains(topElement)) return null;
        const coverRect = topElement.getBoundingClientRect();
        return { bottom: coverRect.bottom, top: coverRect.top };
      })
      .catch(() => null);
    if (cover === null) {
      await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5e3) });
      return;
    }
    const delta = await locator.evaluate((element, coverBottom) => {
      const rect = element.getBoundingClientRect();
      const needed = coverBottom - rect.top + 4;
      if (needed <= 0) return 0;
      const before = window.scrollY;
      window.scrollBy(0, -needed);
      return window.scrollY - before;
    }, cover.bottom);
    if (delta === 0) {
      break;
    }
  }
  await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5e3) });
}
async function execute(page, locator, request, timeout) {
  const options = { timeout, ...(request.force === true ? { force: true } : {}) };
  switch (request.kind) {
    case 'click':
      await scrollIntoClearView(locator, timeout);
      await locator.click(options);
      return 'clicked';
    case 'dblclick':
      await scrollIntoClearView(locator, timeout);
      await locator.dblclick(options);
      return 'double-clicked';
    case 'hover':
      await scrollIntoClearView(locator, timeout);
      await locator.hover(options);
      return 'hovered';
    case 'type':
      await scrollIntoClearView(locator, timeout);
      await locator.click({ timeout }).catch(() => void 0);
      await locator.pressSequentially(request.value ?? '', {
        timeout,
        delay: 20,
      });
      return 'typed';
    case 'fill':
      await scrollIntoClearView(locator, timeout);
      await locator.fill(request.value ?? '', options);
      return 'filled';
    case 'select':
      await scrollIntoClearView(locator, timeout);
      await locator.selectOption(request.value ?? '', { timeout });
      return 'selected';
    case 'check':
      await scrollIntoClearView(locator, timeout);
      await locator.check(options);
      return 'checked';
    case 'uncheck':
      await scrollIntoClearView(locator, timeout);
      await locator.uncheck(options);
      return 'unchecked';
    case 'press':
      await locator.press(request.value ?? 'Enter', { timeout });
      return `pressed ${request.value ?? 'Enter'}`;
    case 'scroll':
      await scrollIntoClearView(locator, timeout);
      return 'scrolled into view';
    case 'upload':
      await locator.setInputFiles(request.value ?? '', { timeout });
      return 'uploaded';
    case 'focus':
      await locator.focus({ timeout });
      return 'focused';
    default: {
      const exhaustive = request.kind;
      throw new Error(`unsupported action kind: ${String(exhaustive)}`);
    }
  }
}
var DEFAULT_ACTION_TIMEOUT_MS;
var init_act = __esm({
  'src/actions/act.ts'() {
    'use strict';
    init_locate();
    init_waits();
    DEFAULT_ACTION_TIMEOUT_MS = 1e4;
  },
});

// src/core/session.ts
function countAll(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countAll(node.children);
  }
  return total;
}
function buildUserAgent(contact) {
  const suffix = contact !== void 0 && contact.length > 0 ? ` (+${contact})` : '';
  return `BrowserVerified/${VERSION}${suffix}`;
}
var BrowserSession;
var init_session = __esm({
  'src/core/session.ts'() {
    'use strict';
    init_browser();
    init_contexts();
    init_snapshot();
    init_diff();
    init_prune();
    init_render();
    init_act();
    init_version();
    BrowserSession = class {
      store;
      userAgent;
      headed;
      browser;
      state;
      lastSnapshot;
      stepCounter = 0;
      consoleMessages = [];
      pageErrors = [];
      failedRequests = [];
      actionTimeoutMs;
      onClose;
      constructor(options) {
        this.store = options.store;
        this.userAgent = options.userAgent;
        this.headed = options.headed;
        this.actionTimeoutMs = options.actionTimeoutMs ?? 1e4;
        this.onClose = options.onClose;
        this.browser = void 0;
        this.state = void 0;
      }
      /** Launch the browser. */
      async launch() {
        if (this.browser !== void 0) return;
        this.browser = await launchChromium({ headed: this.headed });
        this.state = new SessionState(this.browser);
      }
      /** The Playwright browser. */
      get browserInstance() {
        if (this.browser === void 0) throw new Error('the session browser is not running');
        return this.browser;
      }
      /** The session's context and page state. */
      get sessionState() {
        if (this.state === void 0) throw new Error('the session browser is not running');
        return this.state;
      }
      /** The active page. */
      async page() {
        if (this.state === void 0) await this.launch();
        await this.sessionState.ensureContext({ userAgent: this.userAgent });
        const page = await this.sessionState.activePage();
        this.attachListeners(page);
        return page;
      }
      /** Attach console/error/request listeners to a page. */
      attachListeners(page) {
        const marker = /* @__PURE__ */ Symbol.for('bv.listeners');
        const marked = page;
        if (marked[marker] === true) return;
        marked[marker] = true;
        page.on('console', (message) => {
          this.consoleMessages.push({
            type: message.type(),
            text: message.text(),
            timestamp: Date.now(),
          });
        });
        page.on('pageerror', (error) => {
          this.pageErrors.push(error.message);
        });
        page.on('requestfailed', (request) => {
          this.failedRequests.push(
            `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`,
          );
        });
        page.on('popup', (popup) => {
          this.sessionState.registerPopup(popup);
          this.attachListeners(popup);
        });
      }
      /** The next step number. */
      nextStep() {
        this.stepCounter += 1;
        return this.stepCounter;
      }
      /**
       * Capture a snapshot of the active page.
       *
       * The full tree is written to the run store; the returned object carries
       * both the full and pruned trees so the caller can render either.
       */
      async capture(options = {}) {
        const page = await this.page();
        const raw = await page.ariaSnapshotJSON({ mode: 'ai' });
        const tree = normalizeSnapshot(raw);
        const url = page.url();
        const title = await page.title().catch(() => '');
        const documentToken = await this.documentToken(page);
        const snapshot = {
          roots: tree,
          url,
          title,
          nodeCount: countAll(tree),
          prunedCount: 0,
          capturedAt: /* @__PURE__ */ new Date().toISOString(),
          documentToken,
        };
        const pruned = pruneSnapshot(tree, {
          ...(options.maxTokens !== void 0 ? { maxTokens: options.maxTokens } : {}),
        });
        snapshot.prunedCount = pruned.after;
        const diff = diffSnapshots(this.lastSnapshot, {
          roots: pruned.roots,
          url,
          title,
          documentToken,
        });
        const step = this.nextStep();
        const path = await this.store.writeSnapshot(step, renderTree(pruned.roots));
        const previousUrl = this.lastSnapshot?.url;
        this.lastSnapshot = { roots: pruned.roots, documentToken, url };
        return {
          tree,
          pruned: pruned.roots,
          snapshot,
          path,
          estimatedTokens: estimateTreeTokens(pruned.roots),
          diff,
          ...(previousUrl !== void 0 ? { previousUrl } : {}),
        };
      }
      /**
       * A document token that changes whenever the document is replaced.
       *
       * Playwright's refs are invalidated by a navigation; this token lets the
       * perception layer detect that and report it instead of silently reusing
       * stale refs.
       */
      async documentToken(page) {
        try {
          const token = await page.evaluate(() => {
            const w = window;
            if (typeof w.__bvDocToken !== 'string') {
              w.__bvDocToken = Math.random().toString(36).slice(2);
            }
            return w.__bvDocToken;
          });
          return token;
        } catch {
          return 'unknown';
        }
      }
      /**
       * Perform an action and record it.
       */
      async act(request) {
        const page = await this.page();
        const consoleBefore = this.consoleMessages.length;
        const errorsBefore = this.pageErrors.length;
        const outcome = await performAction(page, request, { timeoutMs: this.actionTimeoutMs });
        const step = this.nextStep();
        const record = {
          step,
          action: request.kind,
          durationMs: outcome.durationMs,
          urlBefore: outcome.urlBefore,
          urlAfter: outcome.urlAfter,
          ok: outcome.ok,
          timestamp: /* @__PURE__ */ new Date().toISOString(),
          ...(request.target.name !== void 0
            ? { target: request.target.name }
            : request.target.text !== void 0
              ? { target: request.target.text }
              : request.target.ref !== void 0
                ? { target: request.target.ref }
                : request.target.testId !== void 0
                  ? { target: request.target.testId }
                  : request.target.label !== void 0
                    ? { target: request.target.label }
                    : request.target.css !== void 0
                      ? { target: request.target.css }
                      : {}),
          ...(outcome.strategy !== void 0 ? { strategy: outcome.strategy } : {}),
          ...(outcome.message !== '' ? { message: outcome.message } : {}),
        };
        const capture = await this.capture();
        record.snapshotPath = capture.path;
        const newConsoleErrors = this.consoleMessages
          .slice(consoleBefore)
          .filter((m) => m.type === 'error')
          .map((m) => m.text);
        const newPageErrors = this.pageErrors.slice(errorsBefore);
        record.consoleErrors = [...newConsoleErrors, ...newPageErrors];
        await this.store.recordStep(record);
        return {
          ...outcome,
          step: record,
          diff: renderDiff(capture.diff, {
            ...(capture.previousUrl !== void 0 ? { previousUrl: capture.previousUrl } : {}),
          }),
        };
      }
      /** Navigate the active page. */
      async goto(url) {
        const page = await this.page();
        try {
          await page.goto(url, { timeout: 3e4, waitUntil: 'domcontentloaded' });
          const step = this.nextStep();
          await this.store.recordStep({
            step,
            action: 'goto',
            target: url,
            durationMs: 0,
            urlBefore: page.url(),
            urlAfter: page.url(),
            ok: true,
            timestamp: /* @__PURE__ */ new Date().toISOString(),
            message: `navigated to ${url}`,
          });
          return { ok: true, url: page.url(), message: `navigated to ${url}` };
        } catch (err) {
          const message =
            err instanceof Error
              ? (err.message.split('\n')[0] ?? 'navigation failed')
              : String(err);
          return { ok: false, url: page.url(), message: `navigation failed: ${message}` };
        }
      }
      /** The console errors seen since the last call. */
      drainConsoleErrors() {
        const errors = this.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text);
        this.consoleMessages = [];
        this.pageErrors = [];
        this.failedRequests = [];
        return errors;
      }
      /** The failed requests seen since the last call. */
      drainFailedRequests() {
        const failed = [...this.failedRequests];
        this.failedRequests = [];
        return failed;
      }
      /** The list of tabs. */
      async tabs() {
        return this.sessionState.tabs();
      }
      /** The current storage state. */
      async storageState() {
        return this.sessionState.storageState();
      }
      /** Close the session. */
      async close() {
        if (this.state !== void 0) {
          await this.state.close().catch(() => void 0);
        }
        await this.browser?.close().catch(() => void 0);
        this.browser = void 0;
        this.state = void 0;
        this.onClose?.();
      }
      /** The user agent the session applies. */
      get ua() {
        return this.userAgent;
      }
      /** The browser name. */
      get browserName() {
        return 'chromium';
      }
    };
  },
});

// src/core/runstore/store.ts
import {
  appendFile,
  mkdir as mkdir5,
  readFile as readFile6,
  writeFile as writeFile6,
} from 'fs/promises';
import { join as join4 } from 'path';
import { randomUUID } from 'crypto';
function newRunId(now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
var RunStore;
var init_store = __esm({
  'src/core/runstore/store.ts'() {
    'use strict';
    init_paths();
    RunStore = class {
      runId;
      cwd;
      startedAt;
      constructor(runId, cwd, startedAt = /* @__PURE__ */ new Date().toISOString()) {
        this.runId = runId;
        this.cwd = cwd;
        this.startedAt = startedAt;
      }
      /** The root directory of the run. */
      get dir() {
        return runDir(this.runId, this.cwd);
      }
      /** Create the run's directories. */
      async init() {
        await mkdir5(join4(this.dir, 'steps'), { recursive: true });
      }
      /** Append a line to the audit log. */
      async audit(record) {
        await mkdir5(this.dir, { recursive: true });
        const line = `${JSON.stringify({ ts: /* @__PURE__ */ new Date().toISOString(), ...record })}
`;
        await appendFile(auditPath(this.runId, this.cwd), line, 'utf8');
      }
      /** Read the audit log. */
      async readAudit() {
        try {
          const raw = await readFile6(auditPath(this.runId, this.cwd), 'utf8');
          return raw
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      }
      /** Write the full snapshot text for a step. */
      async writeSnapshot(step, text) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir5(dir, { recursive: true });
        const path = join4(dir, 'aria.txt');
        await writeFile6(path, text, 'utf8');
        return path;
      }
      /** Write the screenshot for a step. */
      async writeScreenshot(step, data) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir5(dir, { recursive: true });
        const path = join4(dir, 'screenshot.png');
        await writeFile6(path, data);
        return path;
      }
      /** Write the state snapshot for a step. */
      async writeState(step, state) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir5(dir, { recursive: true });
        const path = join4(dir, 'state.json');
        await writeFile6(
          path,
          `${JSON.stringify(state, null, 2)}
`,
          'utf8',
        );
        return path;
      }
      /** Write the network slice for a step. */
      async writeNetwork(step, network) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir5(dir, { recursive: true });
        const path = join4(dir, 'net.json');
        await writeFile6(
          path,
          `${JSON.stringify(network, null, 2)}
`,
          'utf8',
        );
        return path;
      }
      /** Write a step record to the audit log and return it. */
      async recordStep(record) {
        await this.audit({ type: 'step', ...record });
      }
      /** Write the final result. */
      async writeResult(result) {
        await mkdir5(this.dir, { recursive: true });
        await writeFile6(
          join4(this.dir, 'result.json'),
          `${JSON.stringify(result, null, 2)}
`,
          'utf8',
        );
      }
      /** Read the final result. */
      async readResult() {
        try {
          const raw = await readFile6(join4(this.dir, 'result.json'), 'utf8');
          return JSON.parse(raw);
        } catch {
          return void 0;
        }
      }
      /** The run's start time. */
      get started() {
        return this.startedAt;
      }
    };
  },
});

// src/safety/approvals.ts
import {
  createHmac,
  randomBytes as randomBytes4,
  timingSafeEqual as timingSafeEqual3,
} from 'crypto';
function hashAction(action) {
  const payload = JSON.stringify({
    kind: action.kind,
    target: action.target,
    value: action.value ?? null,
    url: action.url ?? null,
  });
  return createHmac('sha256', 'bv-action').update(payload).digest('hex').slice(0, 32);
}
var TOKEN_TTL_MS, MAX_PENDING, ApprovalStore;
var init_approvals = __esm({
  'src/safety/approvals.ts'() {
    'use strict';
    TOKEN_TTL_MS = 15 * 60 * 1e3;
    MAX_PENDING = 100;
    ApprovalStore = class {
      key;
      pending = /* @__PURE__ */ new Map();
      tokens = /* @__PURE__ */ new Map();
      used = /* @__PURE__ */ new Set();
      constructor(key) {
        this.key = key ?? randomBytes4(32);
      }
      /** The server key, for deriving the HMAC. */
      get serverKey() {
        return this.key;
      }
      /**
       * Record a request for approval.
       *
       * Returns the request, which carries the action id the user must approve.
       */
      request(request) {
        const full = {
          actionId: request.actionId,
          actionHash: request.actionHash,
          description: request.description,
          requestedAt: request.requestedAt ?? /* @__PURE__ */ new Date().toISOString(),
        };
        this.pending.set(full.actionId, full);
        if (this.pending.size > MAX_PENDING) {
          let oldestId = '';
          let oldestAt = '';
          for (const [id, req] of this.pending) {
            if (oldestId === '' || req.requestedAt < oldestAt) {
              oldestId = id;
              oldestAt = req.requestedAt;
            }
          }
          this.pending.delete(oldestId);
        }
        return full;
      }
      /** Look up a pending request. */
      getPending(actionId) {
        return this.pending.get(actionId);
      }
      /** Every pending request. */
      listPending() {
        return [...this.pending.values()];
      }
      /**
       * Issue an approval token for a pending request.
       *
       * The token is bound to the request's action hash. Issuing a token removes
       * the pending request, so a second token cannot be issued for the same
       * request.
       */
      issue(actionId, now = Date.now()) {
        const request = this.pending.get(actionId);
        if (request === void 0) return void 0;
        const issuedAt = new Date(now).toISOString();
        const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
        const nonce = randomBytes4(8).toString('hex');
        const signature = this.sign(actionId, request.actionHash, issuedAt, nonce);
        const token = {
          token: `${nonce}.${signature}`,
          actionId,
          actionHash: request.actionHash,
          issuedAt,
          expiresAt,
        };
        this.tokens.set(token.token, token);
        this.pending.delete(actionId);
        return token;
      }
      /**
       * Consume a token.
       *
       * The token is removed on success, so it cannot be used twice.
       */
      consume(token, expected, now = Date.now()) {
        const stored = this.tokens.get(token);
        if (stored === void 0) {
          const usedAlready = this.used.has(token);
          this.used.add(token);
          return {
            ok: false,
            reason: usedAlready
              ? 'this approval token has already been used'
              : 'unknown approval token',
            ruleId: usedAlready ? 'approval.replayed' : 'approval.unknown_token',
          };
        }
        if (stored.actionId !== expected.actionId) {
          return {
            ok: false,
            reason: 'this approval token was issued for a different action',
            ruleId: 'approval.action_mismatch',
          };
        }
        if (stored.actionHash !== expected.actionHash) {
          return {
            ok: false,
            reason: 'this approval token was issued for a different version of the action',
            ruleId: 'approval.action_hash_mismatch',
          };
        }
        if (Date.parse(stored.expiresAt) <= now) {
          this.tokens.delete(token);
          return {
            ok: false,
            reason: 'this approval token has expired',
            ruleId: 'approval.expired',
          };
        }
        this.tokens.delete(token);
        this.used.add(token);
        return { ok: true, actionId: stored.actionId };
      }
      /** How many tokens are outstanding. */
      get pendingTokenCount() {
        return this.tokens.size;
      }
      /** Remove every pending request and token. */
      clear() {
        this.pending.clear();
        this.tokens.clear();
        this.used.clear();
      }
      /** Sign the token payload. */
      sign(actionId, actionHash, issuedAt, nonce) {
        const payload = `${actionId}\0${actionHash}\0${issuedAt}\0${nonce}`;
        return createHmac('sha256', this.key).update(payload).digest('base64url').slice(0, 32);
      }
    };
  },
});

// src/safety/taint.ts
import { randomUUID as randomUUID2 } from 'crypto';
function isTainted(value) {
  return registry.isTainted(value);
}
function provenanceOf(value) {
  return registry.provenance(value);
}
function checkSink(value, sink) {
  if (!isTainted(value)) {
    return { allowed: true };
  }
  const record = provenanceOf(value);
  const origin = record?.origin ?? record?.url ?? 'the page';
  return {
    allowed: false,
    reason: `the value came from ${origin} and cannot be used at the ${sink} sink without approval`,
    ruleId: `taint.${sink}`,
  };
}
function sinkForField(options) {
  const name = (options.name ?? '').toLowerCase();
  const inputType = (options.inputType ?? '').toLowerCase();
  if (inputType === 'password') return 'password-field';
  if (inputType === 'file') return 'file-path';
  if (options.role === 'textbox' || options.role === 'combobox' || options.role === 'searchbox') {
    if (/otp|one[\s-]?time|verification\s+code|2fa|mfa|auth(entication)?\s+code|pin\b/.test(name)) {
      return 'otp-field';
    }
    if (/card|cvv|cvc|expiry|expiration|iban|account\s+number|routing/.test(name)) {
      return 'card-field';
    }
    if (/recipient|to\b|cc\b|bcc\b|email\s+to|send\s+to/.test(name)) {
      return 'email-recipient-field';
    }
  }
  return void 0;
}
var TaintRegistry, registry;
var init_taint = __esm({
  'src/safety/taint.ts'() {
    'use strict';
    TaintRegistry = class {
      records = /* @__PURE__ */ new Map();
      values = /* @__PURE__ */ new Map();
      /** Register a value as tainted and return its id. */
      register(record) {
        const id = randomUUID2();
        this.records.set(id, { id, ...record });
        return id;
      }
      /** Record that a value is derived from other tainted values. */
      derive(value, fromIds, record) {
        const id = this.register({ ...record, derivedFrom: [...fromIds] });
        this.values.set(value, id);
        return id;
      }
      /** Mark a value as user-trusted: it is not tainted. */
      trust(value) {
        this.values.delete(value);
      }
      /** The taint id for a value, if it is tainted. */
      idOf(value) {
        return this.values.get(value);
      }
      /** The record for a taint id. */
      record(id) {
        return this.records.get(id);
      }
      /** True when the value is tainted. */
      isTainted(value) {
        return this.values.has(value);
      }
      /** The provenance of a value, if it is tainted. */
      provenance(value) {
        const id = this.values.get(value);
        return id === void 0 ? void 0 : this.records.get(id);
      }
      /** Every tainted value id. */
      ids() {
        return [...this.records.keys()];
      }
      /** Forget everything. */
      clear() {
        this.records.clear();
        this.values.clear();
      }
    };
    registry = new TaintRegistry();
  },
});

// src/safety/injection/detectors.ts
import { randomBytes as randomBytes5 } from 'crypto';
function severityRank(severity) {
  return SEVERITY_ORDER[severity];
}
function worstSeverity(findings) {
  let worst;
  for (const finding of findings) {
    if (worst === void 0 || severityRank(finding.severity) > severityRank(worst)) {
      worst = finding.severity;
    }
  }
  return worst;
}
function allInstructionPhrases(extra = []) {
  const multilingual = Object.values(MULTILINGUAL_INSTRUCTION_PHRASES).flat();
  return [...DEFAULT_INSTRUCTION_PHRASES, ...multilingual, ...extra];
}
function findInvisibleCharacters(text) {
  const hits = [];
  for (const { char, name } of INVISIBLE_CHARACTERS) {
    let index = text.indexOf(char);
    while (index !== -1) {
      hits.push({ char, name, index });
      index = text.indexOf(char, index + char.length);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
function findBase64Blobs(text) {
  const pattern = new RegExp(`[A-Za-z0-9+/]{${BASE64_MIN_LENGTH},}={0,2}`, 'g');
  const hits = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[0];
    const hasPadding = candidate.endsWith('=');
    const hasMixedCase = /[a-z]/.test(candidate) && /[A-Z]/.test(candidate);
    const hasDigit = /\d/.test(candidate);
    const hasSymbol = /[+/]/.test(candidate);
    if (hasPadding || (hasMixedCase && hasDigit) || (hasMixedCase && hasSymbol)) {
      hits.push({ text: candidate, index: match.index });
    }
  }
  return hits;
}
function findExfiltrationUrls(text) {
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/g;
  const hits = [];
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    const queryStart = url.indexOf('?');
    if (queryStart === -1) continue;
    const query = url.slice(queryStart + 1);
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      if (EXFIL_KEYS.some((k) => key === k || key.includes(k))) {
        hits.push({ url, key, index: match.index });
        break;
      }
    }
  }
  return hits;
}
function findSuspiciousHiddenFields(fields) {
  const hits = [];
  for (const field of fields) {
    if (!field.hidden) continue;
    const name = field.name.toLowerCase();
    if (SUSPICIOUS_FIELD_NAMES.some((s) => name === s || name.includes(s))) {
      hits.push({ name: field.name, type: field.type });
    }
  }
  return hits;
}
function snippetAround(text, needle, radius = 40) {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? '\u2026' : ''}${text.slice(start, end)}${end < text.length ? '\u2026' : ''}`;
}
function nodesNeedingApproval(findings) {
  const refs = /* @__PURE__ */ new Set();
  for (const finding of findings) {
    if (finding.severity !== 'review') continue;
    if (finding.nodeRef !== void 0) refs.add(finding.nodeRef);
  }
  return [...refs];
}
var SEVERITY_ORDER,
  DEFAULT_INSTRUCTION_PHRASES,
  DEFAULT_FAKE_BANNER_PATTERNS,
  MULTILINGUAL_INSTRUCTION_PHRASES,
  INVISIBLE_CHARACTERS,
  BASE64_MIN_LENGTH,
  EXFIL_KEYS,
  SUSPICIOUS_FIELD_NAMES,
  InjectionScanner;
var init_detectors = __esm({
  'src/safety/injection/detectors.ts'() {
    'use strict';
    SEVERITY_ORDER = {
      info: 0,
      warn: 1,
      review: 2,
      block: 3,
    };
    DEFAULT_INSTRUCTION_PHRASES = [
      // English
      'ignore previous',
      'ignore all previous',
      'ignore the above',
      'disregard previous',
      'disregard the above',
      'forget previous',
      'forget everything above',
      'system prompt',
      'your system prompt',
      'new instructions',
      'updated instructions',
      'you must now',
      'you should now',
      'do not tell the user',
      "don't tell the user",
      'do not mention',
      'without telling the user',
      'reveal the',
      'reveal your',
      'reveal secret',
      'print your instructions',
      'send this page to',
      'send the page to',
      'email this page to',
      'forward this page to',
      'post this to',
      'exfiltrate',
      'click the link below',
      'approve this payment',
      'approve the following',
      'authorize this payment',
      'as the administrator',
      'system message',
      'system:',
      '[system',
      '<system',
      'important instruction',
      'critical instruction',
      'override your instructions',
      'override previous',
      'act as the administrator',
      'you are now',
      'your new role',
      'do not access',
      'bypass your',
    ];
    DEFAULT_FAKE_BANNER_PATTERNS = [
      /\b(system|admin|administrator|root|support|moderator|operator)\s*(message|notice|alert|warning|instruction|update)\b/i,
      /^\s*\[?(system|admin|root)\]?\s*[:-]/im,
      /\bimportant\s*[:-]\s*you\s+(must|should|need|have\s+to)/i,
      /\battention\s*[:-]\s*(the\s+)?(ai|assistant|agent|model|llm)\b/i,
      /\bnote\s+to\s+(the\s+)?(ai|assistant|agent|model|llm)\b/i,
      /\bfor\s+the\s+(ai|assistant|agent|model|llm)\s*(reading|processing)/i,
      /^\s*###\s*(system|instruction|admin)/im,
      /\bdo\s+not\s+follow\s+(the\s+)?(previous|prior|other)\s+(instruction|direction)/i,
    ];
    MULTILINGUAL_INSTRUCTION_PHRASES = {
      es: [
        'ignora las instrucciones',
        'ignora anteriores',
        'no le digas al usuario',
        'revela tus instrucciones',
        'envia esta pagina a',
      ],
      fr: [
        'ignore les instructions',
        'ignorez les instructions precedentes',
        'ne dites pas a l utilisateur',
        'revelez vos instructions',
        'envoyez cette page a',
      ],
      de: [
        'ignoriere die vorherigen anweisungen',
        'sage dem benutzer nicht',
        'zeige deine anweisungen',
        'sende diese seite an',
      ],
      pt: [
        'ignore as instrucoes anteriores',
        'nao conte ao usuario',
        'revele suas instrucoes',
        'envie esta pagina para',
      ],
      it: [
        'ignora le istruzioni precedenti',
        'non dire all utente',
        'rivel\u0430 le tue istruzioni',
        'invia questa pagina a',
      ],
      ru: [
        '\u0438\u0433\u043D\u043E\u0440\u0438\u0440\u0443\u0439 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0435 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0438',
        '\u043D\u0435 \u0441\u043E\u043E\u0431\u0449\u0430\u0439 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E',
        '\u0440\u0430\u0441\u043A\u0440\u043E\u0439 \u0441\u0432\u043E\u0438 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0438',
        '\u043E\u0442\u043F\u0440\u0430\u0432\u044C \u044D\u0442\u0443 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u043D\u0430',
      ],
      zh: [
        '\u5FFD\u7565\u4E4B\u524D\u7684\u6307\u4EE4',
        '\u5FFD\u7565\u4EE5\u4E0A\u6307\u4EE4',
        '\u4E0D\u8981\u544A\u8BC9\u7528\u6237',
        '\u6CC4\u9732\u4F60\u7684\u6307\u4EE4',
        '\u5C06\u6B64\u9875\u9762\u53D1\u9001\u5230',
      ],
      ja: [
        '\u3053\u308C\u307E\u3067\u306E\u6307\u793A\u3092\u7121\u8996',
        '\u30E6\u30FC\u30B6\u30FC\u306B\u306F\u77E5\u3089\u305B\u306A\u3044\u3067',
        '\u6307\u793A\u3092\u660E\u304B\u3055\u306A\u3044\u3067',
        '\u3053\u306E\u30DA\u30FC\u30B8\u3092\u6B21\u306E\u30A2\u30C9\u30EC\u30B9\u306B\u9001\u4FE1',
      ],
      ko: [
        '\uC774\uC804 \uC9C0\uC2DC\uB97C \uBB34\uC2DC',
        '\uC0AC\uC6A9\uC790\uC5D0\uAC8C \uC54C\uB824\uC8FC\uC9C0 \uB9C8',
        '\uB2F9\uC2E0\uC758 \uC9C0\uC2DC\uB97C \uACF5\uAC1C',
        '\uC774 \uD398\uC774\uC9C0\uB97C \uB2E4\uC74C \uC8FC\uC18C\uB85C',
      ],
      hi: [
        '\u092A\u093F\u091B\u0932\u0947 \u0928\u093F\u0930\u094D\u0926\u0947\u0936\u094B\u0902 \u0915\u094B \u0905\u0928\u0926\u0947\u0916\u093E',
        '\u0909\u092A\u092F\u094B\u0917\u0915\u0930\u094D\u0924\u093E \u0915\u094B \u092E\u0924 \u092C\u0924\u093E\u0913',
        '\u0905\u092A\u0928\u0947 \u0928\u093F\u0930\u094D\u0926\u0947\u0936 \u092C\u0924\u093E\u0913',
        '\u0907\u0938 \u092A\u0947\u091C \u0915\u094B \u092D\u0947\u091C\u0947\u0902',
      ],
      ar: [
        '\u062A\u062C\u0627\u0647\u0644 \u0627\u0644\u062A\u0639\u0644\u064A\u0645\u0627\u062A \u0627\u0644\u0633\u0627\u0628\u0642\u0629',
        '\u0644\u0627 \u062A\u062E\u0628\u0631 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645',
        '\u0627\u0643\u0634\u0641 \u062A\u0639\u0644\u064A\u0645\u0627\u062A\u0643',
        '\u0627\u0631\u0633\u0644 \u0647\u0630\u0647 \u0627\u0644\u0635\u0641\u062D\u0629 \u0625\u0644\u0649',
      ],
    };
    INVISIBLE_CHARACTERS = [
      { char: '\u200B', name: 'ZERO WIDTH SPACE' },
      { char: '\u200C', name: 'ZERO WIDTH NON-JOINER' },
      { char: '\u200D', name: 'ZERO WIDTH JOINER' },
      { char: '\u200E', name: 'LEFT-TO-RIGHT MARK' },
      { char: '\u200F', name: 'RIGHT-TO-LEFT MARK' },
      { char: '\u202A', name: 'LEFT-TO-RIGHT EMBEDDING' },
      { char: '\u202B', name: 'RIGHT-TO-LEFT EMBEDDING' },
      { char: '\u202C', name: 'POP DIRECTIONAL FORMATTING' },
      { char: '\u202D', name: 'LEFT-TO-RIGHT OVERRIDE' },
      { char: '\u202E', name: 'RIGHT-TO-LEFT OVERRIDE' },
      { char: '\u2060', name: 'WORD JOINER' },
      { char: '\u2061', name: 'FUNCTION APPLICATION' },
      { char: '\u2062', name: 'INVISIBLE TIMES' },
      { char: '\u2063', name: 'INVISIBLE SEPARATOR' },
      { char: '\u2064', name: 'INVISIBLE PLUS' },
      { char: '\uFEFF', name: 'ZERO WIDTH NO-BREAK SPACE (BOM)' },
      { char: '\xAD', name: 'SOFT HYPHEN' },
    ];
    BASE64_MIN_LENGTH = 16;
    EXFIL_KEYS = [
      'token',
      'access_token',
      'auth',
      'authorization',
      'apikey',
      'api_key',
      'key',
      'secret',
      'password',
      'passwd',
      'pwd',
      'session',
      'sessionid',
      'cookie',
      'data',
      'payload',
      'body',
      'content',
      'page',
      'html',
      'text',
      'email',
      'user',
      'username',
      'prompt',
      'instructions',
      'context',
      'creds',
      'credentials',
    ];
    SUSPICIOUS_FIELD_NAMES = [
      'prompt',
      'instruction',
      'instructions',
      'system',
      'sysmsg',
      'admin',
      'override',
      'secret',
      'token',
      'apikey',
      'api_key',
      'password',
      'passwd',
      'credential',
      'session',
      'role',
      'directive',
      'context',
    ];
    InjectionScanner = class {
      phrases;
      bannerPatterns;
      constructor(options = {}) {
        this.phrases = allInstructionPhrases(options.extraPhrases ?? []);
        this.bannerPatterns = options.fakeBannerPatterns ?? DEFAULT_FAKE_BANNER_PATTERNS;
      }
      /**
       * Scan a list of content pieces.
       *
       * The findings are returned with sequential ids (`f-1`, `f-2`, …).
       */
      scan(contents) {
        const findings = [];
        let counter = 0;
        const nextId = () => {
          counter += 1;
          return `f-${counter}`;
        };
        for (const content of contents) {
          const text = content.text;
          if (text.length === 0) continue;
          const ref = content.ref;
          const invisible = findInvisibleCharacters(text);
          if (invisible.length > 0) {
            findings.push({
              id: nextId(),
              kind: 'invisible-characters',
              severity: 'block',
              evidenceSnippet: `${invisible.length} hidden character(s): ${invisible
                .slice(0, 3)
                .map((h) => h.name)
                .join(', ')}`,
              ...(ref !== void 0 ? { nodeRef: ref } : {}),
            });
          }
          const lowered = text.toLowerCase();
          for (const phrase of this.phrases) {
            if (!lowered.includes(phrase.toLowerCase())) continue;
            findings.push({
              id: nextId(),
              kind: 'instruction-phrase',
              severity: 'review',
              evidenceSnippet: snippetAround(text, phrase),
              ...(ref !== void 0 ? { nodeRef: ref } : {}),
            });
            break;
          }
          for (const pattern of this.bannerPatterns) {
            if (!pattern.test(text)) continue;
            findings.push({
              id: nextId(),
              kind: 'fake-system-banner',
              severity: 'block',
              evidenceSnippet: snippetAround(text, pattern.source),
              ...(ref !== void 0 ? { nodeRef: ref } : {}),
            });
            break;
          }
          const blobs = findBase64Blobs(text);
          if (blobs.length > 0) {
            const first = blobs[0];
            findings.push({
              id: nextId(),
              kind: 'base64-blob',
              severity: 'warn',
              evidenceSnippet: `${blobs.length} base64-like blob(s), first: ${first.text.slice(0, 32)}\u2026`,
              ...(ref !== void 0 ? { nodeRef: ref } : {}),
            });
          }
          const exfil = findExfiltrationUrls(text);
          if (exfil.length > 0) {
            const first = exfil[0];
            findings.push({
              id: nextId(),
              kind: 'exfiltration-url',
              severity: 'block',
              evidenceSnippet: `${first.url.slice(0, 80)} (key: ${first.key})`,
              ...(ref !== void 0 ? { nodeRef: ref } : {}),
            });
          }
        }
        return { findings, worstSeverity: worstSeverity(findings) };
      }
      /**
       * Scan a DOM-derived structure: hidden text, comments, attributes and
       * hidden fields.
       */
      scanDom(dom) {
        const contents = [];
        for (const node of dom.hiddenText) {
          contents.push({ text: node.text, ...(node.ref !== void 0 ? { ref: node.ref } : {}) });
        }
        for (const node of dom.ariaHiddenText) {
          contents.push({ text: node.text, ...(node.ref !== void 0 ? { ref: node.ref } : {}) });
        }
        for (const comment of dom.comments) {
          contents.push({ text: comment });
        }
        for (const attribute of dom.attributes) {
          contents.push({
            text: attribute.value,
            ...(attribute.ref !== void 0 ? { ref: attribute.ref } : {}),
          });
        }
        for (const value of dom.cssContent) {
          contents.push({ text: value });
        }
        for (const value of dom.noscript) {
          contents.push({ text: value });
        }
        const result = this.scan(contents);
        const hiddenFields = findSuspiciousHiddenFields(dom.hiddenFields);
        if (hiddenFields.length > 0) {
          const extra = [
            {
              id: `f-${result.findings.length + 1}`,
              kind: 'suspicious-hidden-field',
              severity: 'review',
              evidenceSnippet: hiddenFields
                .slice(0, 3)
                .map((f) => `${f.name} (${f.type})`)
                .join(', '),
            },
          ];
          return {
            findings: [...result.findings, ...extra],
            worstSeverity: worstSeverity([...result.findings, ...extra]),
          };
        }
        return result;
      }
    };
  },
});

// src/safety/gate.ts
function actionHashFor(intent) {
  const target = intent.name ?? intent.text ?? intent.ref ?? intent.css ?? '';
  return hashAction({
    kind: intent.kind,
    target,
    ...(intent.value !== void 0 ? { value: intent.value } : {}),
  });
}
function evaluateAction(input, gate) {
  const reasons = [];
  const ruleIds = [];
  const actionClass = classifyAction(input.intent);
  const planDecision = gate.planLock.check({
    actionClass,
    ...(input.intent.url !== void 0 ? { url: input.intent.url } : {}),
    currentUrl: input.currentUrl,
  });
  if (!planDecision.allowed) {
    return {
      allowed: false,
      actionClass,
      // `planDecision` is narrowed to the refusal variant, so both fields
      // are present.
      reasons: [planDecision.reason],
      ruleIds: [planDecision.ruleId],
      next: 'off_plan',
      plan: planDecision,
    };
  }
  const decision = evaluate(
    {
      kind: input.intent.kind,
      ...(input.intent.url !== void 0 ? { url: input.intent.url } : {}),
      ...(input.intent.value !== void 0 ? { value: input.intent.value } : {}),
      ...(input.intent.role !== void 0 ? { role: input.intent.role } : {}),
      ...(input.intent.name !== void 0 ? { name: input.intent.name } : {}),
      ...(input.intent.text !== void 0 ? { text: input.intent.text } : {}),
      ...(input.intent.ref !== void 0 ? { ref: input.intent.ref } : {}),
      ...(input.intent.inForm !== void 0 ? { inForm: input.intent.inForm } : {}),
      ...(input.intent.formMethod !== void 0 ? { formMethod: input.intent.formMethod } : {}),
      ...(input.intent.method !== void 0 ? { method: input.intent.method } : {}),
    },
    {
      policy: gate.policy,
      url: input.currentUrl,
      nonInteractive: !input.interactive,
      tainted: input.tainted === true,
      approved: false,
    },
  );
  reasons.push(...decision.reasons);
  ruleIds.push(...decision.ruleIds);
  const suspectRefs = nodesNeedingApproval(input.findings ?? []);
  if (input.targetRef !== void 0 && suspectRefs.includes(input.targetRef)) {
    reasons.push(
      `the target node ${input.targetRef} has an injection-suspect finding; it needs review before it is acted on`,
    );
    ruleIds.push('injection.review_required');
  }
  if (input.tainted && input.sink !== void 0) {
    const sinkDecision = checkSink(input.intent.value ?? '', input.sink);
    if (!sinkDecision.allowed) {
      reasons.push(sinkDecision.reason);
      ruleIds.push(sinkDecision.ruleId);
    }
  }
  const taintedSinkRefused = ruleIds.some((id) => id.startsWith('taint.'));
  const needsApproval =
    decision.verdict === 'needs_approval' ||
    taintedSinkRefused ||
    ruleIds.includes('injection.review_required');
  if (decision.verdict === 'deny') {
    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'deny',
    };
  }
  if (needsApproval) {
    if (ruleIds.length === 0) {
      reasons.push(`the ${actionClass} action class requires an explicit approval`);
      ruleIds.push('policy.approval_required');
    }
    if (input.approvalToken !== void 0) {
      const hash2 = actionHashFor(input.intent);
      const consumed = gate.approvals.consume(input.approvalToken, {
        actionId: hash2,
        actionHash: hash2,
      });
      if (consumed.ok) {
        return {
          allowed: true,
          actionClass,
          reasons,
          ruleIds,
          next: 'proceed',
        };
      }
      reasons.push(consumed.reason);
      ruleIds.push(consumed.ruleId);
    }
    const hash = actionHashFor(input.intent);
    const request = gate.approvals.request({
      actionId: hash,
      actionHash: hash,
      description: describeAction(input.intent, actionClass),
    });
    return {
      allowed: false,
      actionClass,
      reasons,
      ruleIds,
      next: 'needs_approval',
      approval: request,
    };
  }
  return {
    allowed: true,
    actionClass,
    reasons,
    ruleIds,
    next: 'proceed',
  };
}
function describeAction(intent, actionClass) {
  const target =
    intent.name ?? intent.text ?? intent.ref ?? intent.css ?? intent.label ?? '(unknown target)';
  const parts = [`${intent.kind} on ${target}`];
  if (intent.value !== void 0 && intent.value.length > 0) {
    parts.push(
      `value="${intent.value.length > 60 ? `${intent.value.slice(0, 60)}\u2026` : intent.value}"`,
    );
  }
  parts.push(`class=${actionClass}`);
  return parts.join(', ');
}
var init_gate = __esm({
  'src/safety/gate.ts'() {
    'use strict';
    init_evaluator();
    init_classify();
    init_taint();
    init_approvals();
    init_detectors();
  },
});

// src/safety/element-facts.ts
function implicitRole(tag, type) {
  switch (tag) {
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      switch ((type ?? 'text').toLowerCase()) {
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'button':
        case 'submit':
        case 'reset':
        case 'file':
          return 'button';
        default:
          return 'textbox';
      }
    }
    default:
      return void 0;
  }
}
function isFormControl(tag) {
  return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button';
}
function accessibleName(raw) {
  if (raw.ariaLabel !== void 0 && raw.ariaLabel.length > 0) return raw.ariaLabel;
  if (raw.tag === 'input' || raw.tag === 'textarea') {
    if (raw.labelText !== void 0 && raw.labelText.length > 0) return raw.labelText;
    if (raw.wrappingLabelText !== void 0 && raw.wrappingLabelText.length > 0) {
      return raw.wrappingLabelText;
    }
    if (raw.placeholder !== void 0 && raw.placeholder.length > 0) return raw.placeholder;
  }
  return void 0;
}
function effectiveFormMethod(formMethod) {
  if (formMethod === void 0) return 'POST';
  const upper = formMethod.toUpperCase();
  return upper === 'GET' ? 'GET' : 'POST';
}
function computeElementFacts(raw) {
  const facts = {};
  if (raw.role !== void 0 && raw.role.length > 0) {
    facts.role = raw.role;
  } else if (isFormControl(raw.tag)) {
    facts.role = implicitRole(raw.tag, raw.type);
  }
  const name = accessibleName(raw);
  if (name !== void 0 && name.length > 0) facts.name = name;
  if (raw.text !== void 0 && raw.text.length > 0) {
    facts.text = raw.text.slice(0, 200);
  }
  if (raw.type !== void 0) facts.inputType = raw.type;
  if (raw.tag === 'input' && (raw.type ?? '').toLowerCase() === 'file') {
    facts.isFileInput = true;
  }
  if (raw.inForm === true) {
    facts.inForm = true;
    facts.formMethod = effectiveFormMethod(raw.formMethod);
  }
  if (raw.html !== void 0 && raw.html.length > 0) {
    facts.html = raw.html.slice(0, 500);
  }
  return facts;
}
var init_element_facts = __esm({
  'src/safety/element-facts.ts'() {
    'use strict';
  },
});

// src/safety/inspect.ts
async function inspectTarget(page, target) {
  const locator = await resolveLocator(page, target);
  if (locator === void 0) return {};
  let raw;
  try {
    raw = await locator.evaluate(collectRawElement);
  } catch {
    return {};
  }
  return computeElementFacts(raw);
}
function collectRawElement(element) {
  const el = element;
  const raw = { tag: el.tagName.toLowerCase() };
  const role = el.getAttribute('role');
  if (role !== null) raw.role = role;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null) raw.ariaLabel = ariaLabel;
  const id = el.getAttribute('id') ?? '';
  if (id.length > 0) raw.id = id;
  const type = el.getAttribute('type');
  if (type !== null) raw.type = type;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null) raw.placeholder = placeholder;
  const text = (el.textContent ?? '').trim();
  if (text.length > 0) raw.text = text;
  if (id.length > 0) {
    const label = el.ownerDocument.querySelector(`label[for="${id}"]`);
    if (label !== null) {
      const labelText = (label.textContent ?? '').trim();
      if (labelText.length > 0) raw.labelText = labelText;
    }
  }
  const wrapping = el.closest('label');
  if (wrapping !== null) {
    const wrappingText = (wrapping.textContent ?? '').trim();
    if (wrappingText.length > 0) raw.wrappingLabelText = wrappingText;
  }
  const form = el.closest('form');
  if (form !== null) {
    raw.inForm = true;
    const method = form.getAttribute('method');
    if (method !== null) raw.formMethod = method.toUpperCase();
  }
  const html = el.outerHTML;
  if (html.length > 0) raw.html = html;
  return raw;
}
async function resolveLocator(page, target) {
  const candidates = [];
  if (target.ref !== void 0) {
    try {
      candidates.push(page.getByRef(target.ref));
    } catch {}
  }
  if (target.role !== void 0) {
    candidates.push(
      page.getByRole(target.role, {
        ...(target.name !== void 0 ? { name: target.name } : {}),
      }),
    );
  }
  if (target.label !== void 0) candidates.push(page.getByLabel(target.label));
  if (target.text !== void 0) candidates.push(page.getByText(target.text));
  if (target.testId !== void 0) candidates.push(page.getByTestId(target.testId));
  if (target.css !== void 0) candidates.push(page.locator(target.css));
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count > 0) return candidate.first();
  }
  return void 0;
}
var init_inspect = __esm({
  'src/safety/inspect.ts'() {
    'use strict';
    init_element_facts();
  },
});

// src/core/daemon-process.ts
var daemon_process_exports = {};
__export(daemon_process_exports, {
  runDaemonProcess: () => runDaemonProcess,
});
async function scanForFindings(session, scanner) {
  const page = await session.page();
  const visible = await page
    .locator('body')
    .innerText({ timeout: 2e3 })
    .catch(() => '');
  const dom = await collectDomSignals(page);
  const result = scanner.scanDom(dom);
  const textResult = scanner.scan([{ text: visible }]);
  return [...result.findings, ...textResult.findings];
}
async function collectDomSignals(page) {
  const raw = await page
    .evaluate(() => {
      const out = {
        hiddenText: [],
        ariaHiddenText: [],
        comments: [],
        attributes: [],
        cssContent: [],
        noscript: [],
        hiddenFields: [],
      };
      const push = (bucket, value) => {
        const list = out[bucket];
        if (Array.isArray(list)) list.push(value);
      };
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const text = (el.textContent ?? '').trim();
        if (text.length === 0) continue;
        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          style.fontSize === '0px' ||
          (rect.width === 0 && rect.height === 0) ||
          rect.top < -1e3 ||
          rect.left < -1e3;
        if (hidden) {
          push('hiddenText', { text: text.slice(0, 2e3) });
        }
        if (el.getAttribute('aria-hidden') === 'true') {
          push('ariaHiddenText', { text: text.slice(0, 2e3) });
        }
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
      let comment = walker.nextNode();
      while (comment !== null) {
        const text = (comment.textContent ?? '').trim();
        if (text.length > 0) push('comments', text.slice(0, 2e3));
        comment = walker.nextNode();
      }
      const attributeNames = ['alt', 'title', 'aria-label', 'placeholder', 'content', 'value'];
      for (const el of all) {
        for (const name of attributeNames) {
          const value = el.getAttribute(name);
          if (value !== null && value.trim().length > 0) {
            push('attributes', { attribute: name, value: value.slice(0, 1e3) });
          }
        }
      }
      for (const meta of Array.from(document.querySelectorAll('meta'))) {
        const content = meta.getAttribute('content');
        if (content !== null && content.trim().length > 0) {
          push('attributes', { attribute: 'meta', value: content.slice(0, 1e3) });
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (rules === void 0) continue;
        for (const rule of Array.from(rules)) {
          const text = rule.cssText;
          const match = /content:\s*("[^"]*"|'[^']*')/.exec(text);
          if (match?.[1] !== void 0) {
            push('cssContent', match[1].slice(1, -1));
          }
        }
      }
      for (const el of Array.from(document.querySelectorAll('noscript'))) {
        const text = (el.textContent ?? '').trim();
        if (text.length > 0) push('noscript', text.slice(0, 2e3));
      }
      for (const el of Array.from(document.querySelectorAll('input[type="hidden"]'))) {
        const name = el.getAttribute('name') ?? '';
        if (/token|secret|key|password|pass|auth|credit|ssn|card/i.test(name)) {
          push('hiddenFields', { name, value: (el.getAttribute('value') ?? '').slice(0, 200) });
        }
      }
      return out;
    })
    .catch(() => void 0);
  if (raw === void 0) {
    return {
      hiddenText: [],
      ariaHiddenText: [],
      comments: [],
      attributes: [],
      cssContent: [],
      noscript: [],
      hiddenFields: [],
    };
  }
  return raw;
}
async function runDaemonProcess(options) {
  await ensureBvDir(options.cwd);
  const runId = options.runId ?? newRunId();
  const store = new RunStore(runId, options.cwd);
  await store.init();
  const userAgent = buildUserAgent(options.contactUrl);
  let session;
  const policy = await loadPolicy(options.cwd);
  const planLock = new PlanLock();
  const approvals = new ApprovalStore();
  const scanner = new InjectionScanner();
  const getSession = async () => {
    if (session === void 0) {
      session = new BrowserSession({
        store,
        userAgent,
        headed: options.headed,
      });
      await session.launch();
    }
    return session;
  };
  const handlers = {
    snapshot: async (request) => {
      const s = await getSession();
      const params = request.params ?? {};
      const maxTokens = typeof params['maxTokens'] === 'number' ? params['maxTokens'] : void 0;
      const full = params['full'] === true;
      const capture = await s.capture({
        full,
        ...(maxTokens !== void 0 ? { maxTokens } : {}),
      });
      return {
        data: {
          header: capture.diff.header,
          diff: renderDiff(capture.diff, {
            ...(capture.previousUrl !== void 0 ? { previousUrl: capture.previousUrl } : {}),
          }),
          tree: full ? renderTree(capture.pruned) : void 0,
          snapshotPath: capture.path,
          estimatedTokens: capture.estimatedTokens,
          nodeCount: capture.snapshot.nodeCount,
          prunedCount: capture.snapshot.prunedCount,
          navigated: capture.diff.navigated,
        },
      };
    },
    // --- The plan-lock ----------------------------------------------------
    'plan.set': async (request) => {
      const params = request.params ?? {};
      const raw = params['plan'];
      const parsed = PlanSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return {
          data: { ok: false, error: `the plan is not valid: ${issues}` },
          exitCode: EXIT.USAGE,
        };
      }
      planLock.set(parsed.data);
      return {
        data: {
          ok: true,
          plan: parsed.data,
          message: `plan set: ${parsed.data.goal}`,
        },
      };
    },
    'plan.show': async () => ({
      data: { plan: planLock.current },
    }),
    'plan.amend': async (request) => {
      const params = request.params ?? {};
      const patch = params['patch'];
      const current = planLock.current;
      if (current === void 0) {
        return {
          data: { ok: false, error: 'no plan is set' },
          exitCode: EXIT.FAILURE,
        };
      }
      const p = patch ?? {};
      const amended = {
        ...current,
        ...(p.goal !== void 0 ? { goal: p.goal } : {}),
        ...(p.maxSteps !== void 0 ? { maxSteps: p.maxSteps } : {}),
        allowedOrigins: [
          ...current.allowedOrigins,
          ...(p.addOrigins ?? []).filter((o) => !current.allowedOrigins.includes(o)),
        ],
        allowedActionClasses: [
          ...current.allowedActionClasses,
          ...(p.addClasses ?? []).filter(
            (c) => ACTION_CLASS_SET.has(c) && !current.allowedActionClasses.includes(c),
          ),
        ],
      };
      const hash = hashAction({
        kind: 'plan.amend',
        target: JSON.stringify(amended),
      });
      const token = params['approvalToken'];
      if (typeof token !== 'string') {
        const request2 = approvals.request({
          actionId: hash,
          actionHash: hash,
          description: `amend the plan to: ${amended.goal}`,
        });
        return {
          data: {
            ok: false,
            error: 'amending a plan requires an approval',
            approvalId: request2.actionId,
            approvalDescription: request2.description,
          },
          exitCode: EXIT.NEEDS_APPROVAL,
        };
      }
      const consumed = approvals.consume(token, { actionId: hash, actionHash: hash });
      if (!consumed.ok) {
        return {
          data: { ok: false, error: consumed.reason, ruleId: consumed.ruleId },
          exitCode: EXIT.POLICY_DENIED,
        };
      }
      const result = planLock.amend(amended, { approved: true });
      if (!result.ok) {
        return {
          data: { ok: false, error: result.reason },
          exitCode: EXIT.POLICY_DENIED,
        };
      }
      return {
        data: { ok: true, plan: result.plan, message: `plan amended: ${result.plan.goal}` },
      };
    },
    // --- Approvals --------------------------------------------------------
    'approve.issue': async (request) => {
      const params = request.params ?? {};
      const actionId = params['actionId'];
      if (typeof actionId !== 'string') {
        return {
          data: { ok: false, error: 'actionId is required' },
          exitCode: EXIT.USAGE,
        };
      }
      const pending = approvals.getPending(actionId);
      if (pending === void 0) {
        return { data: { ok: false, error: `no pending action with id ${actionId}` } };
      }
      const token = approvals.issue(actionId);
      if (token === void 0) {
        return { data: { ok: false, error: `could not issue a token for ${actionId}` } };
      }
      return {
        data: { ok: true, token: token.token, description: pending.description },
      };
    },
    'approve.list': async () => ({
      data: { pending: approvals.listPending() },
    }),
    act: async (request) => {
      const s = await getSession();
      const params = request.params ?? {};
      const kind = params['kind'];
      if (typeof kind !== 'string' || !ACTION_KINDS2.includes(kind)) {
        return {
          data: { error: `unknown action kind: ${String(kind)}` },
          exitCode: EXIT.USAGE,
        };
      }
      const targetInput = params['target'];
      const target =
        typeof targetInput === 'object' && targetInput !== null
          ? targetInput
          : parseTarget(typeof targetInput === 'string' ? targetInput : '');
      const value = typeof params['value'] === 'string' ? params['value'] : void 0;
      const page = await s.page();
      const facts = await inspectTarget(page, target);
      const currentUrl = page.url();
      const tainted = value !== void 0 && isTainted(value);
      const sink = sinkForField({
        ...(facts.role !== void 0 ? { role: facts.role } : {}),
        ...(facts.name !== void 0 ? { name: facts.name } : {}),
        ...(facts.inputType !== void 0 ? { inputType: facts.inputType } : {}),
      });
      const findings = await scanForFindings(s, scanner);
      const verdict = evaluateAction(
        {
          intent: {
            kind,
            ...(value !== void 0 ? { value } : {}),
            ...(facts.role !== void 0 ? { role: facts.role } : {}),
            ...(facts.name !== void 0 ? { name: facts.name } : {}),
            ...(facts.text !== void 0 ? { text: facts.text } : {}),
            ...(facts.inputType !== void 0 ? { inputType: facts.inputType } : {}),
            ...(facts.isFileInput !== void 0 ? { isFileInput: facts.isFileInput } : {}),
            ...(facts.inForm !== void 0 ? { inForm: facts.inForm } : {}),
            ...(facts.formMethod !== void 0 ? { formMethod: facts.formMethod } : {}),
            ...(target.ref !== void 0 ? { ref: target.ref } : {}),
            ...(target.css !== void 0 ? { css: target.css } : {}),
            ...(target.label !== void 0 ? { label: target.label } : {}),
            ...(kind === 'goto' ? { url: target.css ?? '' } : {}),
          },
          currentUrl,
          tainted,
          ...(sink !== void 0 ? { sink } : {}),
          ...(target.ref !== void 0 ? { targetRef: target.ref } : {}),
          findings,
          interactive: options.headed,
          ...(typeof params['approvalToken'] === 'string'
            ? { approvalToken: params['approvalToken'] }
            : {}),
        },
        { policy, planLock, approvals },
      );
      if (!verdict.allowed) {
        const exitCode =
          verdict.next === 'needs_approval' ? EXIT.NEEDS_APPROVAL : EXIT.POLICY_DENIED;
        return {
          data: {
            ok: false,
            denied: true,
            next: verdict.next,
            actionClass: verdict.actionClass,
            reasons: verdict.reasons,
            ruleIds: verdict.ruleIds,
            ...(verdict.approval !== void 0
              ? {
                  approvalId: verdict.approval.actionId,
                  approvalDescription: verdict.approval.description,
                }
              : {}),
          },
          exitCode,
        };
      }
      planLock.recordStep();
      const outcome = await s.act({
        kind,
        target,
        ...(value !== void 0 ? { value } : {}),
        ...(params['force'] === true ? { force: true } : {}),
      });
      return {
        data: {
          ok: outcome.ok,
          kind: outcome.kind,
          strategy: outcome.strategy,
          attempted: outcome.attempted,
          failures: outcome.failures,
          message: outcome.message,
          durationMs: outcome.durationMs,
          urlBefore: outcome.urlBefore,
          urlAfter: outcome.urlAfter,
          diff: outcome.diff,
          step: outcome.step,
        },
        ...(outcome.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },
    goto: async (request) => {
      const s = await getSession();
      const url = (request.params ?? {})['url'];
      if (typeof url !== 'string') {
        return { data: { error: 'missing url' }, exitCode: EXIT.USAGE };
      }
      const result = await s.goto(url);
      return {
        data: result,
        ...(result.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },
    tabs: async () => {
      const s = await getSession();
      return { data: { tabs: await s.tabs() } };
    },
    'tab.select': async (request) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        s.sessionState.selectTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },
    'tab.close': async (request) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        await s.sessionState.closeTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },
    'storage.state': async () => {
      const s = await getSession();
      return { data: { state: await s.storageState() } };
    },
    'page.info': async () => {
      const s = await getSession();
      const page = await s.page();
      return {
        data: {
          url: page.url(),
          title: await page.title().catch(() => ''),
          userAgent: s.ua,
          runId: store.runId,
          runDir: store.dir,
        },
      };
    },
    'console.drain': async () => {
      const s = await getSession();
      return {
        data: { errors: s.drainConsoleErrors(), failedRequests: s.drainFailedRequests() },
      };
    },
    stop: async () => {
      const s = await getSession().catch(() => void 0);
      await s?.close();
      return { data: { ok: true } };
    },
  };
  const daemon = await startDaemon({
    handlers,
    session: options.session,
    headed: options.headed,
    browser: 'chromium',
  });
  const info = daemon.info;
  await writeDaemonInfo(info, daemon.token, options.cwd);
  await store.audit({
    type: 'session_start',
    session: options.session,
    pid: info.pid,
    port: info.port,
    headed: options.headed,
    userAgent,
    runId: store.runId,
  });
  const shutdown = async () => {
    await daemon.close().catch(() => void 0);
    await session?.close().catch(() => void 0);
    await clearDaemonInfo(options.cwd).catch(() => void 0);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise((resolve5) => {
    daemon.server.once('close', () => resolve5());
  });
}
var ACTION_CLASS_SET, ACTION_KINDS2;
var init_daemon_process = __esm({
  'src/core/daemon-process.ts'() {
    'use strict';
    init_daemon();
    init_daemon_info();
    init_session();
    init_store();
    init_paths();
    init_render();
    init_locate();
    init_exit();
    init_policy();
    init_planlock();
    init_approvals();
    init_gate();
    init_inspect();
    init_taint();
    init_taint();
    init_detectors();
    ACTION_CLASS_SET = new Set(ACTION_CLASSES);
    ACTION_KINDS2 = [
      'click',
      'dblclick',
      'hover',
      'type',
      'fill',
      'select',
      'check',
      'uncheck',
      'press',
      'scroll',
      'upload',
      'focus',
    ];
  },
});

// src/cli/main.ts
init_exit();
import { Command, CommanderError } from 'commander';

// src/core/errors.ts
init_exit();
var BvError = class extends Error {
  exitCode;
  /** Machine-readable reason codes, e.g. `policy.deny`, `plan.off_plan`. */
  reasons;
  /** Extra structured detail for `--json` output. */
  detail;
  constructor(message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = 'BvError';
    this.exitCode = options.exitCode ?? EXIT.FAILURE;
    this.reasons = options.reasons ?? [];
    this.detail = options.detail ?? {};
  }
};
var UsageError = class extends BvError {
  constructor(message, detail = {}) {
    super(message, { exitCode: EXIT.USAGE, detail });
    this.name = 'UsageError';
  }
};
var SessionError = class extends BvError {
  constructor(message, detail = {}) {
    super(message, { exitCode: EXIT.FAILURE, detail });
    this.name = 'SessionError';
  }
};
function toBvError(err) {
  if (err instanceof BvError) return err;
  if (err instanceof Error) {
    return new BvError(err.message, { cause: err });
  }
  return new BvError(String(err));
}

// src/core/output.ts
init_exit();
function ok(data, lines = []) {
  return { data, lines, code: EXIT.OK };
}
function fail(data, lines, code = EXIT.FAILURE) {
  return { data, lines, code };
}
function printResult(result, opts) {
  if (opts.json) {
    const payload =
      result.extra && typeof result.data === 'object' && result.data !== null
        ? { ...result.data, ...result.extra }
        : result.data;
    opts.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
    if (result.lines.length > 0) {
      opts.stderr.write(`${result.lines.join('\n')}
`);
    }
    return;
  }
  if (result.lines.length > 0) {
    opts.stdout.write(`${result.lines.join('\n')}
`);
  }
}

// src/cli/main.ts
init_version();

// src/cli/commands/doctor.ts
import { access, constants, readdir, stat } from 'fs/promises';
import { join as join3 } from 'path';
import { homedir as homedir2 } from 'os';
init_exit();
init_paths();

// src/cli/helpers.ts
var rootProgram;
function setRootProgram(program) {
  rootProgram = program;
}
function globalOptions(_cmd) {
  const opts = rootProgram?.opts() ?? {};
  return {
    json: opts.json === true,
    cwd: opts.cwd ?? process.cwd(),
  };
}
var emittedCode;
function emit(_cmd, result) {
  const global = globalOptions();
  printResult(result, {
    json: global.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = result.code;
  emittedCode = result.code;
}

// src/cli/commands/doctor.ts
var MIN_NODE_MAJOR = 20;
function playwrightBrowserDirs() {
  const home = homedir2();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    return local ? [join3(local, 'ms-playwright')] : [];
  }
  if (process.platform === 'darwin') {
    return [join3(home, 'Library', 'Caches', 'ms-playwright')];
  }
  return [join3(home, '.cache', 'ms-playwright')];
}
async function findChromium() {
  for (const dir of playwrightBrowserDirs()) {
    try {
      const entries = await readdir(dir);
      const chromium2 = entries.filter((e) => e.startsWith('chromium-'));
      if (chromium2.length > 0) {
        const full = join3(dir, chromium2.sort().at(-1) ?? chromium2[0] ?? '');
        const info = await stat(full).catch(() => void 0);
        if (info?.isDirectory()) return full;
      }
    } catch {}
  }
  return void 0;
}
async function runDoctor(cwd) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is older than the required v${MIN_NODE_MAJOR}`,
          fix: 'install Node 20 or newer',
        },
  );
  const chromium2 = await findChromium();
  checks.push(
    chromium2
      ? { name: 'playwright-chromium', status: 'ok', detail: chromium2 }
      : {
          name: 'playwright-chromium',
          status: 'fail',
          detail: 'no Chromium build found in the Playwright browser cache',
          fix: 'bv doctor --install',
        },
  );
  const root = bvRoot(cwd);
  try {
    await access(root, constants.W_OK);
    checks.push({ name: 'runtime-dir', status: 'ok', detail: root });
  } catch {
    const exists = await stat(root).then(
      () => true,
      () => false,
    );
    if (exists) {
      checks.push({
        name: 'runtime-dir',
        status: 'fail',
        detail: `${root} exists but is not writable`,
        fix: 'fix the directory permissions, or remove it and run `bv init`',
      });
    } else {
      checks.push({
        name: 'runtime-dir',
        status: 'warn',
        detail: `${root} does not exist yet`,
        fix: 'bv init',
      });
    }
  }
  const policy = policyPath(cwd);
  const policyExists = await stat(policy).then(
    () => true,
    () => false,
  );
  checks.push(
    policyExists
      ? { name: 'policy', status: 'ok', detail: policy }
      : {
          name: 'policy',
          status: 'warn',
          detail: 'no policy file: the default policy will be used',
          fix: 'bv init',
        },
  );
  const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
  checks.push({
    name: 'anthropic-key',
    status: hasKey ? 'ok' : 'warn',
    detail: hasKey
      ? 'ANTHROPIC_API_KEY is set (Mode B available)'
      : 'ANTHROPIC_API_KEY is not set: Mode B is unavailable, Mode A is unaffected',
  });
  return checks;
}
async function installBrowsers() {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const cli = join3(process.cwd(), 'node_modules', 'playwright', 'cli.js');
  await execFileAsync(process.execPath, [cli, 'install', 'chromium'], { cwd: process.cwd() });
}
function registerDoctor(program) {
  program
    .command('doctor')
    .description('check the environment: node, playwright browsers, permissions, policy')
    .option('--install', 'install the Playwright browsers if they are missing', false)
    .action(async (options, cmd) => {
      const global = cmd.parent?.opts() ?? {};
      const cwd = global.cwd ?? process.cwd();
      if (options.install === true) {
        try {
          await installBrowsers();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const result2 = fail(
            { checks: [], error: 'install_failed', message },
            [`Browser installation failed: ${message}`],
            EXIT.FAILURE,
          );
          emit(cmd, result2);
          return;
        }
      }
      const checks = await runDoctor(cwd);
      const failed = checks.filter((c) => c.status === 'fail');
      const lines = [];
      for (const check of checks) {
        const mark = check.status === 'ok' ? '\u2713' : check.status === 'warn' ? '!' : '\u2717';
        lines.push(`${mark} ${check.name}: ${check.detail}`);
        if (check.fix !== void 0 && check.status !== 'ok') {
          lines.push(`    fix: ${check.fix}`);
        }
      }
      lines.push(
        failed.length === 0
          ? 'All checks passed.'
          : `${failed.length} check(s) failed. Fix the items above before running a session.`,
      );
      const result =
        failed.length === 0
          ? ok({ checks }, lines)
          : fail({ checks, failed: failed.map((c) => c.name) }, lines, EXIT.FAILURE);
      emit(cmd, result);
    });
}

// src/cli/commands/init.ts
import { copyFile, mkdir as mkdir2, readFile, writeFile as writeFile2 } from 'fs/promises';
import { existsSync as existsSync2 } from 'fs';
import { dirname as dirname2, resolve as resolve3 } from 'path';
import { fileURLToPath as fileURLToPath2 } from 'url';
init_exit();
init_paths();
function packagedPolicyPath() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  const candidates = [
    resolve3(here, '..', '..', '..', 'policies', 'default.yaml'),
    resolve3(here, '..', '..', '..', '..', 'policies', 'default.yaml'),
    resolve3(here, '..', 'policies', 'default.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync2(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}
async function runInit(cwd) {
  const root = bvRoot(cwd);
  await mkdir2(runsRoot(cwd), { recursive: true });
  const policy = policyPath(cwd);
  let policyCreated = false;
  const existing = await readFile(policy, 'utf8').catch(() => void 0);
  if (existing === void 0) {
    const packaged = packagedPolicyPath();
    const content = await readFile(packaged, 'utf8').catch(() => void 0);
    if (content === void 0) {
      await writeFile2(
        policy,
        [
          'version: 1',
          'domains:',
          '  allow: [localhost, 127.0.0.1]',
          '  deny: []',
          'ownedOrigins: []',
          'actionClasses:',
          '  approvalRequired: [submit, destructive, financial, messaging, upload]',
          '  deny: []',
          'budgets:',
          '  maxSteps: 80',
          '  maxRetriesPerStep: 2',
          '  maxSeconds: 600',
          '  maxTokens: 200000',
          'rate:',
          '  maxRpsPerDomain: 1',
          '  jitterMs: [300, 1200]',
          'compliance:',
          '  respectRobots: true',
          '  captcha: human_handoff',
          'secrets:',
          '  maskInLogs: true',
          '',
        ].join('\n'),
        'utf8',
      );
    } else {
      await copyFile(packaged, policy);
    }
    policyCreated = true;
  }
  return { root, policyCreated, policyPath: policy };
}
function registerInit(program) {
  program
    .command('init')
    .description('create .bv/ and write a default policy')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const result = await runInit(global.cwd);
        const lines = [
          `runtime directory: ${result.root}`,
          result.policyCreated
            ? `policy written: ${result.policyPath}`
            : `policy kept (already exists): ${result.policyPath}`,
          'next: bv session start --headed',
        ];
        emit(cmd, ok(result, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail(
            { error: 'init_failed', message },
            [`Could not initialise: ${message}`],
            EXIT.FAILURE,
          ),
        );
      }
    });
}

// src/cli/commands/session.ts
import { spawn } from 'child_process';
import { existsSync as existsSync3 } from 'fs';
import { fileURLToPath as fileURLToPath3 } from 'url';
import { dirname as dirname3, resolve as resolve4 } from 'path';
init_exit();

// src/core/client.ts
init_daemon_info();
var DEFAULT_TIMEOUT_MS = 12e4;
async function connectDaemon(cwd) {
  const info = await readDaemonInfo(cwd);
  if (info === void 0) {
    throw new SessionError('no running session found. Start one with `bv session start`.');
  }
  if (!isProcessAlive(info.pid)) {
    throw new SessionError(
      `the session process (pid ${info.pid}) is no longer running. Start a new one with \`bv session start\`.`,
    );
  }
  const token = await readDaemonToken(cwd);
  if (token === void 0) {
    throw new SessionError(
      'the session token is missing. Stop the stale session with `bv session stop` and start a new one.',
    );
  }
  const baseUrl = daemonBaseUrl(info);
  return createClient(baseUrl, token, info.port);
}
function createClient(baseUrl, token, port) {
  const call = async (method, params = {}, options = {}) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SessionError(`could not reach the session daemon: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SessionError(
        `the session daemon returned a non-JSON response (${response.status})`,
      );
    }
    if (!body.ok) {
      const err = new Error(body.error ?? 'the session daemon reported an unknown error');
      Object.assign(err, { reasons: body.reasons ?? [], exitCode: body.exitCode });
      throw err;
    }
    return body.data;
  };
  const health = async () => {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  return { port, call, health };
}

// src/cli/commands/session.ts
init_daemon_info();
init_paths();
function daemonEntry() {
  const here = dirname3(fileURLToPath3(import.meta.url));
  const sourceEntry = resolve4(here, '..', '..', 'core', 'daemon-entry.ts');
  const tsxCli = resolve4(here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync3(sourceEntry)) {
    if (existsSync3(tsxCli)) {
      return { command: process.execPath, args: [tsxCli, sourceEntry] };
    }
    return { command: 'tsx', args: [sourceEntry] };
  }
  const bundle = resolve4(here, '..', '..', '..', 'scripts', 'bv.mjs');
  if (existsSync3(bundle)) {
    return { command: process.execPath, args: [bundle] };
  }
  throw new UsageError(
    'could not locate the session daemon entry point. Reinstall browser-verified or run from the repository.',
  );
}
function spawnDaemon(options) {
  const entry = daemonEntry();
  const args = [
    ...entry.args,
    '--daemon',
    '--cwd',
    options.cwd,
    '--session',
    options.session,
    ...(options.headed ? ['--headed'] : []),
    ...(options.contact !== void 0 ? ['--contact', options.contact] : []),
    ...(options.runId !== void 0 ? ['--run-id', options.runId] : []),
  ];
  const child = spawn(entry.command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (child.pid === void 0) {
    throw new Error('failed to spawn the session daemon');
  }
  return child.pid;
}
async function waitForDaemon(cwd, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readDaemonInfo(cwd);
    if (info !== void 0 && isProcessAlive(info.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UsageError('the session daemon did not start within 30s');
}
function registerSession(program) {
  const session = program
    .command('session')
    .description('start, stop and inspect browser sessions');
  session
    .command('start')
    .description('start a browser session (a detached daemon)')
    .option('--headed', 'run the browser headed (required for human handoff)', false)
    .option('--session <name>', 'the session name', 'default')
    .option('--contact <url>', 'the contact URL included in the honest user agent')
    .option('--run-id <id>', 'use a specific run id')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        await ensureBvDir(global.cwd);
        const existing = await readDaemonInfo(global.cwd);
        if (existing !== void 0 && isProcessAlive(existing.pid)) {
          emit(
            cmd,
            fail(
              { error: 'session_exists', pid: existing.pid, port: existing.port },
              [
                `a session is already running (pid ${existing.pid}). Stop it first with \`bv session stop\`.`,
              ],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        if (existing !== void 0) {
          await clearDaemonInfo(global.cwd);
        }
        const pid = spawnDaemon({
          cwd: global.cwd,
          headed: options.headed === true,
          session: options.session ?? 'default',
          ...(options.contact !== void 0 ? { contact: options.contact } : {}),
          ...(options.runId !== void 0 ? { runId: options.runId } : {}),
        });
        await waitForDaemon(global.cwd);
        const info = await readDaemonInfo(global.cwd);
        const lines = [
          `session "${info?.session ?? 'default'}" started (pid ${pid})`,
          `port: ${info?.port ?? '?'}`,
          `headed: ${(options.headed ?? false) ? 'yes' : 'no'}`,
          info?.headed === false && (options.headed ?? false) ? '' : '',
          `run dir: ${info === void 0 ? '?' : '.bv/runs'}`,
        ].filter((line) => line !== '');
        emit(
          cmd,
          ok(
            {
              pid,
              port: info?.port,
              session: info?.session,
              headed: info?.headed,
              startedAt: info?.startedAt,
            },
            lines,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail(
            { error: 'session_start_failed', message },
            [`Could not start the session: ${message}`],
            EXIT.FAILURE,
          ),
        );
      }
    });
  session
    .command('stop')
    .description('stop the running session')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === void 0) {
        emit(cmd, ok({ stopped: false }, ['no session is running']));
        return;
      }
      if (!isProcessAlive(info.pid)) {
        await clearDaemonInfo(global.cwd);
        emit(
          cmd,
          ok({ stopped: false }, ['the session was no longer running (stale state cleared)']),
        );
        return;
      }
      try {
        const client = await connectDaemon(global.cwd);
        await client.call('stop');
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      if (isProcessAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {}
      }
      await clearDaemonInfo(global.cwd);
      emit(cmd, ok({ stopped: true, pid: info.pid }, [`session stopped (pid ${info.pid})`]));
    });
  session
    .command('status')
    .description('show the status of the running session')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === void 0) {
        emit(cmd, ok({ running: false }, ['no session is running']));
        return;
      }
      const alive = isProcessAlive(info.pid);
      let page;
      if (alive) {
        try {
          const client = await connectDaemon(global.cwd);
          page = await client.call('page.info');
        } catch {
          page = void 0;
        }
      }
      const lines = [
        `running: ${alive ? 'yes' : 'no (stale)'}`,
        `pid: ${info.pid}`,
        `port: ${info.port}`,
        `session: ${info.session}`,
        `headed: ${info.headed ? 'yes' : 'no'}`,
        `started: ${info.startedAt}`,
      ];
      if (page !== void 0) {
        const p = page;
        lines.push(`url: ${p.url ?? ''}`);
        lines.push(`title: ${p.title ?? ''}`);
        lines.push(`user agent: ${p.userAgent ?? ''}`);
      }
      emit(cmd, ok({ running: alive, ...info, page }, lines));
    });
}

// src/cli/commands/perception.ts
init_exit();
init_locate();
var ACTION_KINDS = [
  'click',
  'dblclick',
  'hover',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'upload',
  'focus',
];
function registerPerception(program) {
  program
    .command('snapshot')
    .description('capture the page as a compact, diffed accessibility tree')
    .option('--full', 'return the full tree instead of only the changes', false)
    .option('--max-tokens <n>', 'approximate token budget for the pruned tree')
    .option('--expand <ref>', 'expand a collapsed node by ref')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const maxTokens = options.maxTokens !== void 0 ? Number(options.maxTokens) : void 0;
        if (maxTokens !== void 0 && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
          throw new UsageError('--max-tokens must be a positive number');
        }
        const payload = await client.call('snapshot', {
          full: options.full === true,
          ...(maxTokens !== void 0 ? { maxTokens } : {}),
          ...(options.expand !== void 0 ? { expand: options.expand } : {}),
        });
        const lines = [
          payload.diff,
          `full snapshot: ${payload.snapshotPath}`,
          `estimated tokens: ${payload.estimatedTokens} (estimate)`,
        ];
        if (options.full === true && payload.tree !== void 0) {
          lines.push(payload.tree);
        }
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('act')
    .description('perform an action on the page')
    .argument('<kind>', `one of: ${ACTION_KINDS.join(', ')}`)
    .argument('<target>', 'a ref (e12), or a descriptor (role=button name="Sign in")')
    .argument('[value]', 'the value to type, fill, select, press or upload')
    .option('--dry-run', 'report what would happen without doing it', false)
    .option('--force', 'skip actionability checks', false)
    .option('--approve <token>', 'an approval token for this exact action')
    .action(async (kind, target, value, options, cmd) => {
      const global = globalOptions(cmd);
      if (!ACTION_KINDS.includes(kind)) {
        const message = `unknown action kind "${kind}". Expected one of: ${ACTION_KINDS.join(', ')}`;
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }
      try {
        const client = await connectDaemon(global.cwd);
        const descriptor = parseTarget(target);
        if (options.dryRun === true) {
          const lines2 = [
            `dry run: would ${kind} ${describeTarget(descriptor)}`,
            value !== void 0 ? `value: ${value}` : '',
          ].filter((line) => line !== '');
          emit(
            cmd,
            ok(
              {
                dryRun: true,
                kind,
                target: descriptor,
                ...(value !== void 0 ? { value } : {}),
              },
              lines2,
            ),
          );
          return;
        }
        const payload = await client.call('act', {
          kind,
          target: descriptor,
          ...(value !== void 0 ? { value } : {}),
          force: options.force === true,
          ...(typeof options.approve === 'string' ? { approvalToken: options.approve } : {}),
        });
        if (payload.denied === true) {
          const lines2 = [
            `refused: ${payload.reasons?.join('; ') ?? 'the policy did not allow this action'}`,
            `class: ${payload.actionClass ?? 'unknown'}`,
            ...(payload.ruleIds !== void 0 && payload.ruleIds.length > 0
              ? [`rules: ${payload.ruleIds.join(', ')}`]
              : []),
            ...(payload.approvalId !== void 0
              ? [
                  `approval id: ${payload.approvalId}`,
                  `run \`bv approve ${payload.approvalId}\` to approve this exact action`,
                ]
              : []),
          ];
          const code = payload.next === 'needs_approval' ? EXIT.NEEDS_APPROVAL : EXIT.POLICY_DENIED;
          emit(cmd, fail(payload, lines2, code));
          return;
        }
        const lines = [
          payload.ok ? `ok: ${payload.message}` : `failed: ${payload.message}`,
          `strategy: ${payload.strategy ?? 'none'}`,
          `url: ${payload.urlBefore} \u2192 ${payload.urlAfter}`,
          payload.diff,
        ];
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('goto')
    .description('navigate the active tab to a URL')
    .argument('<url>', 'the URL to navigate to')
    .action(async (url, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('goto', {
          url,
        });
        const lines = [payload.message, `url: ${payload.url}`];
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('tab')
    .description('list, select or close tabs')
    .argument('[action]', 'list (default), select or close')
    .argument('[index]', 'the tab index, for select and close')
    .action(async (action, index, cmd) => {
      const global = globalOptions(cmd);
      const verb = action ?? 'list';
      try {
        const client = await connectDaemon(global.cwd);
        if (verb === 'list') {
          const payload = await client.call('tabs');
          const lines = payload.tabs.map(
            (t) =>
              `${t.index}${t.active ? '*' : ' '} ${t.title || '(untitled)'} ${t.url}${t.popup ? ' [popup]' : ''}`,
          );
          if (lines.length === 0) lines.push('(no tabs)');
          emit(cmd, ok(payload, lines));
          return;
        }
        if (verb === 'select' || verb === 'close') {
          const parsed = Number(index);
          if (!Number.isInteger(parsed)) {
            throw new UsageError(`\`bv tab ${verb}\` needs a tab index`);
          }
          const payload = await client.call(verb === 'select' ? 'tab.select' : 'tab.close', {
            index: parsed,
          });
          emit(cmd, ok(payload, [`tab ${verb}ed: ${parsed}`]));
          return;
        }
        throw new UsageError(`unknown tab action "${verb}". Expected list, select or close.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}
function describeTarget(descriptor) {
  const parts = [];
  if (descriptor.ref !== void 0) parts.push(`ref=${descriptor.ref}`);
  if (descriptor.role !== void 0) parts.push(`role=${descriptor.role}`);
  if (descriptor.name !== void 0) parts.push(`name=${descriptor.name}`);
  if (descriptor.label !== void 0) parts.push(`label=${descriptor.label}`);
  if (descriptor.text !== void 0) parts.push(`text=${descriptor.text}`);
  if (descriptor.testId !== void 0) parts.push(`testid=${descriptor.testId}`);
  if (descriptor.css !== void 0) parts.push(`css=${descriptor.css}`);
  return parts.length > 0 ? parts.join(' ') : '(empty)';
}

// src/cli/commands/safety.ts
import { readFile as readFile5 } from 'fs/promises';
init_exit();
init_paths();
init_planlock();

// src/safety/vault.ts
init_paths();
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as randomBytes2,
  scryptSync,
  timingSafeEqual as timingSafeEqual2,
} from 'crypto';
import { mkdir as mkdir4, readFile as readFile4, writeFile as writeFile5 } from 'fs/promises';
import { dirname as dirname5 } from 'path';
var VAULT_MAGIC = 'BVV1';
var SALT_LENGTH = 16;
var IV_LENGTH = 12;
var KEY_LENGTH = 32;
var SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}
function encryptVault(contents, passphrase) {
  const salt = randomBytes2(SALT_LENGTH);
  const iv = randomBytes2(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(contents), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    magic: VAULT_MAGIC,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}
function decryptVault(file, passphrase) {
  if (file.version !== 1) {
    throw new Error(`unsupported vault version: ${String(file.version)}`);
  }
  if (file.magic !== VAULT_MAGIC) {
    throw new Error('this file is not a browser-verified vault');
  }
  const salt = Buffer.from(file.salt, 'hex');
  const iv = Buffer.from(file.iv, 'hex');
  const tag = Buffer.from(file.tag, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}
var Vault = class {
  contents = { secrets: {} };
  loaded = false;
  /**
   * Load the vault from disk.
   *
   * Returns false when there is no vault file yet.
   */
  async load(passphrase, cwd) {
    let raw;
    try {
      raw = await readFile4(vaultPath(cwd), 'utf8');
    } catch {
      this.contents = { secrets: {} };
      this.loaded = true;
      return false;
    }
    const file = JSON.parse(raw);
    this.contents = decryptVault(file, passphrase);
    this.loaded = true;
    return true;
  }
  /** Write the vault to disk. */
  async save(passphrase, cwd) {
    const path = vaultPath(cwd);
    await mkdir4(dirname5(path), { recursive: true });
    const file = encryptVault(this.contents, passphrase);
    await writeFile5(path, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 384 });
  }
  /** Store a secret. */
  set(name, value) {
    this.contents.secrets[name] = { value, storedAt: /* @__PURE__ */ new Date().toISOString() };
  }
  /** Read a secret. */
  get(name) {
    return this.contents.secrets[name]?.value;
  }
  /** Remove a secret. */
  remove(name) {
    if (this.contents.secrets[name] === void 0) return false;
    delete this.contents.secrets[name];
    return true;
  }
  /** The names of the stored secrets, and when they were stored. */
  list() {
    return Object.entries(this.contents.secrets)
      .map(([name, entry]) => ({ name, storedAt: entry.storedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /** How many secrets are stored. */
  get size() {
    return Object.keys(this.contents.secrets).length;
  }
  /** True when the vault has been loaded. */
  get isLoaded() {
    return this.loaded;
  }
  /**
   * Resolve `{{secret:name}}` placeholders in a string.
   *
   * This is the only place a secret value is produced. The caller must be
   * inside the daemon, filling a field.
   */
  resolve(value) {
    const used = [];
    const missing = [];
    const resolved = value.replace(/\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g, (match, name) => {
      const secret = this.get(name);
      if (secret === void 0) {
        missing.push(name);
        return match;
      }
      used.push(name);
      return secret;
    });
    return { resolved, used, missing };
  }
  /** True when the string contains a secret placeholder. */
  static hasPlaceholder(value) {
    return /\{\{secret:[a-zA-Z0-9_.-]+\}\}/.test(value);
  }
};
function passphraseFromEnv() {
  const value = process.env['BV_VAULT_PASSPHRASE'];
  return value !== void 0 && value.length > 0 ? value : void 0;
}

// src/cli/commands/safety.ts
function registerSafety(program) {
  const plan = program
    .command('plan')
    .description('set, show or amend the plan-lock that bounds every action');
  plan
    .command('set')
    .description('set the plan from a JSON file')
    .argument('<file>', 'the plan JSON file')
    .action(async (file, cmd) => {
      const global = globalOptions(cmd);
      try {
        const raw = await readFile5(absPath(file, global.cwd), 'utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new UsageError(`the plan file is not valid JSON: ${message}`);
        }
        const withTimestamp =
          typeof parsed === 'object' && parsed !== null && !('createdAt' in parsed)
            ? { ...parsed, createdAt: /* @__PURE__ */ new Date().toISOString() }
            : parsed;
        const result = PlanSchema.safeParse(withTimestamp);
        if (!result.success) {
          const issues = result.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          throw new UsageError(`the plan is not valid: ${issues}`);
        }
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('plan.set', { plan: result.data });
        emit(cmd, ok(payload, [payload.message]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  plan
    .command('show')
    .description('show the current plan')
    .action(async (cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('plan.show');
        if (payload.plan === void 0) {
          emit(
            cmd,
            fail(
              { error: 'no plan is set' },
              ['no plan is set. Run `bv plan set <file>` before acting.'],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        const lines = [
          `goal: ${payload.plan.goal}`,
          `origins: ${payload.plan.allowedOrigins.join(', ') || '(any)'}`,
          `classes: ${payload.plan.allowedActionClasses.join(', ') || '(none)'}`,
          `max steps: ${payload.plan.maxSteps}`,
          `success: ${JSON.stringify(payload.plan.successCondition)}`,
        ];
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  plan
    .command('amend')
    .description('amend the current plan (requires an approval)')
    .option('--approve <token>', 'an approval token for this amendment')
    .option('--goal <goal>', 'the new goal')
    .option('--add-origin <origin>', 'add an allowed origin (repeatable)')
    .option('--add-class <class>', 'add an allowed action class (repeatable)')
    .option('--max-steps <n>', 'the new step budget')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('plan.amend', {
          patch: {
            ...(options.goal !== void 0 ? { goal: options.goal } : {}),
            ...(options.maxSteps !== void 0 ? { maxSteps: Number(options.maxSteps) } : {}),
            ...(options.addOrigin !== void 0 ? { addOrigins: options.addOrigin } : {}),
            ...(options.addClass !== void 0 ? { addClasses: options.addClass } : {}),
          },
          ...(options.approve !== void 0 ? { approvalToken: options.approve } : {}),
        });
        emit(cmd, ok(payload, [payload.message]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('approve')
    .description('approve a pending action and print a one-time token')
    .argument('<actionId>', 'the action id from the refusal')
    .action(async (actionId, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('approve.issue', { actionId });
        if (!payload.ok) {
          emit(
            cmd,
            fail(
              { error: `no pending action with id ${actionId}` },
              [`no pending action with id ${actionId}`],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        const lines = [
          `approved: ${payload.description}`,
          `token: ${payload.token}`,
          '',
          'The token is valid for this exact action only, and only once.',
        ];
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  const vault = program.command('vault').description('manage the encrypted secrets vault');
  vault
    .command('set')
    .description('store a secret')
    .argument('<name>', 'the secret name')
    .argument('[value]', 'the secret value (prompted for when omitted)')
    .action(async (name, value, cmd) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === void 0) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const secret = value ?? (await readSecretFromStdin(name));
        if (secret === void 0 || secret.length === 0) {
          throw new UsageError('no secret value was given');
        }
        const store = new Vault();
        await store.load(passphrase, global.cwd);
        store.set(name, secret);
        await store.save(passphrase, global.cwd);
        emit(cmd, ok({ name }, [`stored secret "${name}"`]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  vault
    .command('list')
    .description('list the stored secret names')
    .action(async (cmd) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === void 0) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const store = new Vault();
        await store.load(passphrase, global.cwd);
        const secrets = store.list();
        const lines = secrets.map((s) => `${s.name} (stored ${s.storedAt})`);
        if (lines.length === 0) lines.push('(the vault is empty)');
        emit(cmd, ok({ secrets }, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  vault
    .command('rm')
    .description('remove a secret')
    .argument('<name>', 'the secret name')
    .action(async (name, cmd) => {
      const global = globalOptions(cmd);
      try {
        const passphrase = passphraseFromEnv();
        if (passphrase === void 0) {
          throw new UsageError(
            'the vault passphrase is required. Set BV_VAULT_PASSPHRASE in the environment.',
          );
        }
        const store = new Vault();
        await store.load(passphrase, global.cwd);
        const removed = store.remove(name);
        if (removed) await store.save(passphrase, global.cwd);
        emit(
          cmd,
          removed
            ? ok({ name }, [`removed secret "${name}"`])
            : fail(
                { error: `no secret named "${name}"` },
                [`no secret named "${name}"`],
                EXIT.FAILURE,
              ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('dryrun-report')
    .description('print what would have been sent, from the last dry run')
    .option('--run <runId>', 'the run to read (defaults to the most recent)')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('dryrun.report', {
          ...(options.run !== void 0 ? { runId: options.run } : {}),
        });
        emit(cmd, ok(payload, [payload.report]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}
async function readSecretFromStdin(name) {
  if (process.stdin.isTTY !== true) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text.length > 0 ? text : void 0;
  }
  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`value for ${name}: `);
    return answer.length > 0 ? answer : void 0;
  } finally {
    rl.close();
  }
}

// src/cli/main.ts
function buildProgram() {
  const program = new Command();
  program
    .name('bv')
    .description(DESCRIPTION)
    .version(VERSION, '-V, --version', 'print the version and exit')
    .option('--json', 'emit machine-readable JSON on stdout', false)
    .option('--cwd <dir>', 'working directory that holds .bv/', process.cwd())
    .showHelpAfterError('(run with --help for usage)')
    .enablePositionalOptions();
  registerDoctor(program);
  registerInit(program);
  registerSession(program);
  registerPerception(program);
  registerSafety(program);
  setRootProgram(program);
  return program;
}
function mapCommanderError(err) {
  switch (err.code) {
    case 'commander.helpDisplayed':
    case 'commander.version':
      return EXIT.OK;
    default:
      return EXIT.USAGE;
  }
}
async function run(argv) {
  if (argv.includes('--daemon')) {
    await runDaemonFromArgv(argv);
    return EXIT.OK;
  }
  const program = buildProgram();
  program.exitOverride();
  let handled = false;
  program.hook('preAction', (_thisCommand, actionCommand) => {
    handled = actionCommand !== program;
  });
  let result = { data: null, lines: [], code: EXIT.OK };
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (!handled) {
      program.outputHelp();
      result = { data: null, lines: [], code: EXIT.USAGE };
    }
  } catch (err) {
    if (err instanceof CommanderError) {
      const code = mapCommanderError(err);
      if (err.code === 'commander.help') program.outputHelp();
      result = {
        data: { error: 'UsageError', message: err.message, reasons: [] },
        lines: err.code === 'commander.help' ? [] : [err.message],
        code,
      };
    } else {
      const bvErr = toBvError(err);
      result = {
        data: {
          error: bvErr.name,
          message: bvErr.message,
          reasons: bvErr.reasons,
          ...bvErr.detail,
        },
        lines: [bvErr.message],
        code: bvErr.exitCode,
      };
    }
  }
  if (handled) return emittedCode ?? result.code;
  const opts = globalOptions(program);
  printResult(result, {
    json: opts.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return result.code;
}
async function main(argv = process.argv) {
  const code = await run(argv.slice(2));
  process.exitCode = code;
}
async function runDaemonFromArgv(argv) {
  const { runDaemonProcess: runDaemonProcess2 } = await Promise.resolve().then(
    () => (init_daemon_process(), daemon_process_exports),
  );
  const options = parseDaemonArgs(argv);
  await runDaemonProcess2(options);
}
function parseDaemonArgs(argv) {
  let cwd = process.cwd();
  let session = 'default';
  let headed = false;
  let contact;
  let runId;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value !== void 0) {
        cwd = value;
        i++;
      }
    } else if (arg === '--session') {
      const value = argv[i + 1];
      if (value !== void 0) {
        session = value;
        i++;
      }
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--contact') {
      const value = argv[i + 1];
      if (value !== void 0) {
        contact = value;
        i++;
      }
    } else if (arg === '--run-id') {
      const value = argv[i + 1];
      if (value !== void 0) {
        runId = value;
        i++;
      }
    }
  }
  return {
    cwd,
    session,
    headed,
    ...(contact !== void 0 ? { contact } : {}),
    ...(runId !== void 0 ? { runId } : {}),
  };
}

// src/cli/bundle.ts
await main(process.argv);
