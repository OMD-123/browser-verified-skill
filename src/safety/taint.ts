/**
 * Taint tracking (M07).
 *
 * Everything read from the page, the network, a file or a download is a
 * `Tainted<string>` carrying provenance. Values derived from tainted text stay
 * tainted — including values produced by an LLM.
 *
 * Taint is cleared only by:
 *  (a) an explicit approval, or
 *  (b) a deterministic validator that narrows the value to a known set
 *      (a zod enum, a numeric regex).
 *
 * The CLI is the trust boundary: values passed on the command line are
 * registered as user-trusted, because a human typed them.
 */
import { randomUUID } from 'node:crypto';

/** The unique brand for tainted strings. */
export type TaintedBrand = 'Tainted';

/** A string that carries provenance. */
export type Tainted<T extends string = string> = T & { readonly __tainted?: TaintedBrand };

/** Where a tainted value came from. */
export type TaintSource =
  | 'page-text'
  | 'page-attribute'
  | 'network-response'
  | 'network-request'
  | 'file'
  | 'download'
  | 'model-output'
  | 'user';

/** The provenance record for a tainted value. */
export interface TaintRecord {
  /** The unique id of this value. */
  readonly id: string;
  /** Where the value came from. */
  readonly source: TaintSource;
  /** The URL it came from, when it came from the web. */
  readonly url?: string;
  /** The origin it came from, when it came from the web. */
  readonly origin?: string;
  /** How it was obtained, e.g. `textbox[name=email]`. */
  readonly via?: string;
  /** When it was captured. */
  readonly capturedAt: string;
  /** The values this one was derived from, when it is a derivation. */
  readonly derivedFrom?: readonly string[];
}

/** The registry of tainted values. */
class TaintRegistry {
  private records = new Map<string, TaintRecord>();
  private values = new Map<string, string>();

  /** Register a value as tainted and return its id. */
  register(record: Omit<TaintRecord, 'id'>): string {
    const id = randomUUID();
    this.records.set(id, { id, ...record });
    return id;
  }

  /** Record that a value is derived from other tainted values. */
  derive(value: string, fromIds: readonly string[], record: Omit<TaintRecord, 'id'>): string {
    const id = this.register({ ...record, derivedFrom: [...fromIds] });
    this.values.set(value, id);
    return id;
  }

  /** Mark a value as user-trusted: it is not tainted. */
  trust(value: string): void {
    this.values.delete(value);
  }

  /** The taint id for a value, if it is tainted. */
  idOf(value: string): string | undefined {
    return this.values.get(value);
  }

  /** The record for a taint id. */
  record(id: string): TaintRecord | undefined {
    return this.records.get(id);
  }

  /** True when the value is tainted. */
  isTainted(value: string): boolean {
    return this.values.has(value);
  }

  /** The provenance of a value, if it is tainted. */
  provenance(value: string): TaintRecord | undefined {
    const id = this.values.get(value);
    return id === undefined ? undefined : this.records.get(id);
  }

  /** Every tainted value id. */
  ids(): string[] {
    return [...this.records.keys()];
  }

  /** Forget everything. */
  clear(): void {
    this.records.clear();
    this.values.clear();
  }
}

/** The process-wide taint registry. */
const registry = new TaintRegistry();

/** The taint registry, for tests and for dependency injection. */
export function taintRegistry(): TaintRegistry {
  return registry;
}

/** Options for registering tainted content. */
export interface TaintOptions {
  /** Where the value came from. */
  source: TaintSource;
  /** The URL it came from. */
  url?: string;
  /** The origin it came from. */
  origin?: string;
  /** How it was obtained. */
  via?: string;
  /** When it was captured. Defaults to now. */
  capturedAt?: string;
  /** Ids of the values this was derived from. */
  derivedFrom?: readonly string[];
}

/**
 * Register a value as tainted.
 *
 * Returns the tainted value, which is the same string branded so the
 * compiler tracks it.
 */
export function taint(value: string, options: TaintOptions): Tainted<string> {
  if (options.source === 'user') {
    registry.trust(value);
    return value;
  }
  const derivedFrom = options.derivedFrom ?? [];
  const record = {
    source: options.source,
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    ...(options.via !== undefined ? { via: options.via } : {}),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  };
  if (derivedFrom.length > 0) {
    registry.derive(value, derivedFrom, record);
  } else {
    registry.register(record);
    // Bind the value to the record so `provenanceOf` can find it.
    registry.derive(value, [], record);
  }
  return value;
}

/** True when the value is tainted. */
export function isTainted(value: string): boolean {
  return registry.isTainted(value);
}

/** The provenance of a tainted value. */
export function provenanceOf(value: string): TaintRecord | undefined {
  return registry.provenance(value);
}

/**
 * Mark a value as user-trusted.
 *
 * This is the CLI boundary: a value the human typed on the command line is
 * trusted by definition.
 */
export function trust(value: string): string {
  registry.trust(value);
  return value;
}

/**
 * Derive a new tainted value from tainted inputs.
 *
 * A value derived from tainted text stays tainted, even when the derivation was
 * performed by an LLM.
 */
export function derive(
  value: string,
  from: readonly string[],
  options: Omit<TaintOptions, 'derivedFrom'>,
): Tainted<string> {
  const fromIds = from.map((v) => registry.idOf(v)).filter((id): id is string => id !== undefined);
  return taint(value, { ...options, derivedFrom: fromIds });
}

/**
 * Clear taint from a value, but only through a deterministic validator.
 *
 * A validator narrows the value to a known set. It must return the narrowed
 * value or `undefined` when the value is not acceptable. A validator that
 * merely inspects the value (and always succeeds) must not be used to clear
 * taint — that is what `approveTaint` is for.
 */
export function narrow<T extends string>(
  value: string,
  validator: (candidate: string) => T | undefined,
): { ok: true; value: T } | { ok: false; reason: string } {
  const narrowed = validator(value);
  if (narrowed === undefined) {
    return { ok: false, reason: 'the value did not pass the validator' };
  }
  registry.trust(narrowed);
  return { ok: true, value: narrowed };
}

/**
 * Clear taint from a value by explicit approval.
 *
 * The approval is recorded so the audit log shows that a human released the
 * value.
 */
export function approveTaint(value: string, approvedBy: string): void {
  registry.trust(value);
  registry.register({
    source: 'user',
    via: `approved by ${approvedBy}`,
    capturedAt: new Date().toISOString(),
  });
}

/** A validator that accepts only one of a fixed set of values. */
export function enumValidator(
  allowed: readonly string[],
): (candidate: string) => string | undefined {
  const set = new Set(allowed.map((v) => v.toLowerCase()));
  return (candidate: string) => {
    const lowered = candidate.toLowerCase();
    return set.has(lowered) ? lowered : undefined;
  };
}

/** A validator that accepts only a number matching a pattern. */
export function numericValidator(
  pattern: RegExp = /^\d+(\.\d+)?$/,
): (candidate: string) => string | undefined {
  return (candidate: string) => (pattern.test(candidate.trim()) ? candidate.trim() : undefined);
}

/** The kinds of sink that can refuse tainted input. */
export type TaintSink =
  | 'cross-origin-navigation'
  | 'password-field'
  | 'card-field'
  | 'otp-field'
  | 'email-recipient-field'
  | 'file-path'
  | 'shell'
  | 'eval'
  | 'message-body';

/** The result of a sink check. */
export type SinkCheck =
  | {
      /** The value may reach the sink. */
      allowed: true;
    }
  | {
      /** The value may not reach the sink. */
      allowed: false;
      /** The reason it was refused. */
      reason: string;
      /** The rule id, for auditing. */
      ruleId: string;
    };

/**
 * Check whether a value may reach a sink.
 *
 * A tainted value is refused at every listed sink unless it has been
 * explicitly approved (which clears the taint) or narrowed by a deterministic
 * validator (which also clears the taint).
 */
export function checkSink(value: string, sink: TaintSink): SinkCheck {
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

/** The sink that applies to a field, by its role, name and input type. */
export function sinkForField(options: {
  role?: string;
  name?: string;
  inputType?: string;
}): TaintSink | undefined {
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
  return undefined;
}
