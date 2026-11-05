/**
 * Process exit codes shared by every CLI command.
 *
 * These are part of the public contract of the `bv` binary: scripts branch on
 * them, so they must stay stable.
 */
export const EXIT = {
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
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function isExitCode(value: number): value is ExitCode {
  return Object.values(EXIT).includes(value as ExitCode);
}
