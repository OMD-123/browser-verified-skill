/**
 * A tiny injectable clock.
 *
 * Every module that needs "now" takes a `Clock` so tests can control time
 * without sleeping.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** An ISO-8601 timestamp for the current instant. */
  iso(): string;
  /** Sleep for the given milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** A clock that can be advanced manually. Useful in tests. */
export function createFakeClock(startMs = 0): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    sleep: () => Promise.resolve(),
    advance(ms: number) {
      current += ms;
    },
  };
}
