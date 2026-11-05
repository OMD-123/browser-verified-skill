/**
 * Typed errors that carry a CLI exit code.
 *
 * Every failure path in `bv` throws a `BvError` so the CLI can map it to one
 * of the documented exit codes without guessing.
 */
import { EXIT, type ExitCode } from './exit.js';

/** The base error type for all expected failures. */
export class BvError extends Error {
  readonly exitCode: ExitCode;
  /** Machine-readable reason codes, e.g. `policy.deny`, `plan.off_plan`. */
  readonly reasons: readonly string[];
  /** Extra structured detail for `--json` output. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: {
      exitCode?: ExitCode;
      reasons?: readonly string[];
      detail?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BvError';
    this.exitCode = options.exitCode ?? EXIT.FAILURE;
    this.reasons = options.reasons ?? [];
    this.detail = options.detail ?? {};
  }
}

/** The command line was wrong: unknown option, missing argument, bad value. */
export class UsageError extends BvError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { exitCode: EXIT.USAGE, detail });
    this.name = 'UsageError';
  }
}

/** A policy rule denied the action. */
export class PolicyDeniedError extends BvError {
  constructor(message: string, reasons: readonly string[], detail: Record<string, unknown> = {}) {
    super(message, { exitCode: EXIT.POLICY_DENIED, reasons, detail });
    this.name = 'PolicyDeniedError';
  }
}

/** The action needs approval that was not granted. */
export class NeedsApprovalError extends BvError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { exitCode: EXIT.NEEDS_APPROVAL, detail });
    this.name = 'NeedsApprovalError';
  }
}

/** A prompt-injection finding blocked the action or the content. */
export class InjectionBlockedError extends BvError {
  constructor(message: string, reasons: readonly string[], detail: Record<string, unknown> = {}) {
    super(message, { exitCode: EXIT.INJECTION_BLOCK, reasons, detail });
    this.name = 'InjectionBlockedError';
  }
}

/** Verification ran but the success condition was not met. */
export class VerificationFailedError extends BvError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, { exitCode: EXIT.VERIFICATION_FAILED, detail });
    this.name = 'VerificationFailedError';
  }
}

/** Normalise any thrown value into a `BvError`. */
export function toBvError(err: unknown): BvError {
  if (err instanceof BvError) return err;
  if (err instanceof Error) {
    return new BvError(err.message, { cause: err });
  }
  return new BvError(String(err));
}
