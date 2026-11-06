/**
 * The per-domain rate limiter (M11).
 *
 * A token bucket per domain, with a jittered wait. This is **politeness**,
 * not evasion: the point is to avoid hammering a server, and the jitter
 * spreads a burst of requests so they do not arrive as a spike.
 *
 * There is no proxy rotation, no randomised fingerprint and no attempt to
 * look like anything other than what it is.
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** A jitter range in milliseconds. */
export interface JitterRange {
  /** The lowest wait. */
  min: number;
  /** The highest wait. */
  max: number;
}

/** The rate limit configuration. */
export interface RateLimitConfig {
  /** The maximum requests per second for one domain. */
  maxRpsPerDomain: number;
  /** The jitter range applied to each wait. */
  jitterMs: JitterRange;
}

/** A bucket for one domain. */
interface Bucket {
  /** The number of tokens currently in the bucket. */
  tokens: number;
  /** When the bucket was last refilled. */
  lastRefill: number;
}

/** A rate-limit decision. */
export interface RateLimitDecision {
  /** Whether the request may proceed now. */
  allowed: boolean;
  /** How long to wait before retrying, in milliseconds. */
  waitMs: number;
  /** The domain the decision applies to. */
  domain: string;
}

/**
 * The per-domain rate limiter.
 *
 * The clock and the sleep function are injected so the behaviour can be
 * tested without real delays.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = async (ms) => {
      await sleep(ms);
    },
  ) {}

  /**
   * Decide whether a request to a domain may proceed now.
   *
   * Pure: it does not consume a token.
   */
  check(domain: string): RateLimitDecision {
    // Refill before deciding, so time that has passed is accounted for even
    // when no request has been made recently.
    this.refill(domain);
    const bucket = this.bucketFor(domain);

    if (bucket.tokens >= 1) return { allowed: true, waitMs: 0, domain };

    // How long until one token is available?
    const intervalMs = 1000 / Math.max(0.01, this.config.maxRpsPerDomain);
    const waitMs = Math.ceil(intervalMs);
    return { allowed: false, waitMs: Math.max(0, waitMs), domain };
  }

  /**
   * Wait until a request to a domain may proceed, then consume a token.
   *
   * The jitter is applied on top of the bucket wait, so a burst of requests
   * is spread out rather than released together.
   */
  async acquire(domain: string): Promise<number> {
    const decision = this.check(domain);
    if (!decision.allowed) {
      await this.wait(decision.waitMs);
      this.refill(domain);
    }
    this.refill(domain);
    this.bucketFor(domain).tokens -= 1;

    const jitter = this.jitter();
    if (jitter > 0) await this.wait(jitter);
    return jitter;
  }

  /** The jitter to apply, drawn from the configured range. */
  jitter(): number {
    const { min, max } = this.config.jitterMs;
    if (max <= min) return Math.max(0, min);
    return Math.max(0, min + Math.floor(Math.random() * (max - min + 1)));
  }

  /** Refill a bucket according to elapsed time. */
  private refill(domain: string): void {
    const bucket = this.bucketFor(domain);
    const capacity = Math.max(1, Math.ceil(this.config.maxRpsPerDomain));
    const elapsed = this.now() - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (elapsed / 1000) * this.config.maxRpsPerDomain,
    );
    bucket.lastRefill = this.now();
  }

  /** Get or create a bucket for a domain. */
  private bucketFor(domain: string): Bucket {
    let bucket = this.buckets.get(domain);
    if (bucket === undefined) {
      bucket = {
        tokens: Math.max(1, Math.ceil(this.config.maxRpsPerDomain)),
        lastRefill: this.now(),
      };
      this.buckets.set(domain, bucket);
    }
    return bucket;
  }

  /** Forget every bucket. */
  reset(): void {
    this.buckets.clear();
  }

  /** How many domains are being tracked. */
  get size(): number {
    return this.buckets.size;
  }
}
