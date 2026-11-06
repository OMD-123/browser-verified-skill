/**
 * The policy schema and the action classifier.
 *
 * The policy is the outermost control: it decides whether an action may
 * happen at all. It is validated with zod `.strict()`, so a policy that tries
 * to enable a forbidden capability (fingerprint spoofing, proxy rotation,
 * CAPTCHA solving, credential stuffing) **fails to load** with a clear error
 * rather than being silently ignored.
 *
 * The classifier is conservative by construction: when it cannot determine an
 * action class with confidence, the result is `needs_approval`, never
 * `allow`.
 */
import { z } from 'zod';
import YAML from 'yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { policyPath } from '../core/paths.js';

/** The action classes the policy understands. */
export const ACTION_CLASSES = [
  'read',
  'navigate',
  'input',
  'submit',
  'destructive',
  'financial',
  'messaging',
  'download',
  'upload',
] as const;

/** An action class. */
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** The verdict of a policy evaluation. */
export type PolicyVerdict = 'allow' | 'deny' | 'needs_approval';

/** The outcome of evaluating an action against the policy. */
export interface PolicyDecision {
  /** What to do. */
  verdict: PolicyVerdict;
  /** Human-readable reasons. */
  reasons: string[];
  /** Machine-readable rule identifiers, e.g. `policy.deny.destructive`. */
  ruleIds: string[];
  /** The class the action was assigned. */
  actionClass: ActionClass;
}

/** A domain or origin pattern. */
export type DomainPattern = string;

/** The `@url:` marker prefix for an explicit URL pattern. */
export const URL_MARKER = '@url:';

/**
 * The domain allow/deny schema.
 *
 * Entries are either plain host patterns (`example.com`, `*.example.com`) or
 * explicit URLs using the `@url:` marker.
 */
export const DomainSchema = z.array(z.string().min(1));

/** The action class configuration. */
export const ActionClassesSchema = z
  .object({
    /** Classes that require an explicit approval. */
    approvalRequired: z.array(z.enum(ACTION_CLASSES)).default([]),
    /** Classes that are always denied. */
    deny: z.array(z.enum(ACTION_CLASSES)).default([]),
  })
  .strict();

/** The run budget schema. */
export const BudgetsSchema = z
  .object({
    maxSteps: z.number().int().positive().default(80),
    maxRetriesPerStep: z.number().int().min(0).default(2),
    maxSeconds: z.number().int().positive().default(600),
    maxTokens: z.number().int().positive().default(200_000),
  })
  .strict();

/** The rate limit schema. */
export const RateSchema = z
  .object({
    maxRpsPerDomain: z.number().positive().default(1),
    /** The jitter window in milliseconds. */
    jitterMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([300, 1200]),
  })
  .strict();
/** The compliance schema. */
export const ComplianceSchema = z
  .object({
    /** Respect robots.txt. */
    respectRobots: z.boolean().default(true),
    /** The honest user-agent suffix, including a contact URL. */
    userAgentSuffix: z.string().default('BrowserVerified/1.0 (+@url:`https://your-site/contact`)'),
    /** What to do when a challenge is detected. */
    captcha: z.enum(['human_handoff', 'deny']).default('human_handoff'),
    /** Allow `eval-readonly`. Off by default: it is the most powerful primitive. */
    evalReadonly: z.boolean().default(false),
  })
  .strict();

/** The secrets schema. */
export const SecretsSchema = z
  .object({
    /** Mask secret values in logs, audit and JSON output. */
    maskInLogs: z.boolean().default(true),
  })
  .strict();

/** The LLM tier schema. */
export const LlmSchema = z
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

/** The site-memory schema. */
export const MemorySchema = z
  .object({
    /** How long a playbook entry stays valid, in days. */
    ttlDays: z.number().int().positive().default(30),
  })
  .strict();

/**
 * The policy schema.
 *
 * `.strict()` on every nested object: an unknown key anywhere is an error.
 */
export const PolicySchema = z
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
      maxTokens: 200_000,
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

/** A validated policy. */
export type Policy = z.infer<typeof PolicySchema>;

/** The default policy, used when no policy file exists. */
export function defaultPolicy(): Policy {
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
      maxTokens: 200_000,
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

/**
 * Keys that would enable a forbidden capability.
 *
 * These are rejected explicitly with a helpful message, because `.strict()`
 * alone would only say "unrecognized key".
 */
const FORBIDDEN_KEYS: { key: string; because: string }[] = [
  { key: 'stealth', because: 'fingerprint spoofing and bot-detection evasion are out of scope' },
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

/**
 * The message of a thrown value.
 *
 * Anything can be thrown, so this never assumes an `Error`.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load the policy from `.bv/policy.yaml`.
 *
 * A missing file yields the default policy. A malformed file is an error:
 * silently falling back to defaults would quietly drop the user's safety
 * rules, which is the wrong failure direction.
 */
export async function loadPolicy(cwd: string = process.cwd()): Promise<Policy> {
  const path = policyPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return defaultPolicy();
  }

  let parsed: unknown;
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

/**
 * Write the default policy to `.bv/policy.yaml`.
 *
 * The file is not overwritten when one already exists, so re-running `bv
 * init` never destroys a customised policy.
 */
export async function writeDefaultPolicy(
  cwd: string = process.cwd(),
): Promise<{ path: string; created: boolean }> {
  const path = policyPath(cwd);
  try {
    await readFile(path, 'utf8');
    return { path, created: false };
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, YAML.stringify(defaultPolicy()), { encoding: 'utf8' });
    return { path, created: true };
  }
}

/**
 * Reject a policy that enables a forbidden capability.
 *
 * Runs before zod validation so the error message names the offending key
 * and says why it is refused.
 */
export function rejectForbiddenKeys(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;

  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      const forbidden = FORBIDDEN_KEYS.find((f) => f.key.toLowerCase() === key.toLowerCase());
      if (forbidden !== undefined) {
        throw new Error(
          `policy key "${keyPath}" is not allowed: ${forbidden.because}. ` +
            'browser-verified does not implement these capabilities and will not accept a policy that asks for them.',
        );
      }
      walk(value, keyPath);
    }
  };

  walk(raw, '');
}

/** A policy that failed to load. */
export class PolicyLoadError extends Error {
  readonly issues: readonly { path: string; message: string }[];

  constructor(message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'PolicyLoadError';
    this.issues = issues;
  }
}

/**
 * Validate a raw policy object.
 *
 * Throws `PolicyLoadError` with a readable message when the policy is
 * invalid, including a hint about which key is wrong.
 */
export function validatePolicy(raw: unknown): Policy {
  rejectForbiddenKeys(raw);

  const result = PolicySchema.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  const details = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
  throw new PolicyLoadError(`invalid policy:\n${details}`, issues);
}
