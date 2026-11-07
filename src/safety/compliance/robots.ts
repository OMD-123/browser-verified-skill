/**
 * robots.txt handling (M11).
 *
 * A `robots.txt` is fetched once per origin, cached, and evaluated per URL.
 * When a path is disallowed, the action is denied with the reason `robots`,
 * unless the origin is in the policy's `ownedOrigins`.
 *
 * The parser is `robots-parser`. Note that it requires a **full URL**, not a
 * path: passing a bare path returns `undefined`, which is why
 * `evaluateRobots` always builds an absolute URL.
 */
import robotsParser, { type Robot } from 'robots-parser';

/** A cached robots.txt. */
export interface RobotsCacheEntry {
  /** The robots.txt text. */
  body: string;
  /** When it was fetched. */
  fetchedAt: number;
  /** The parsed rules. */
  parser: Robot;
}

/** The robots.txt cache, keyed by origin. */
export class RobotsCache {
  private entries = new Map<string, RobotsCacheEntry>();

  /** How long a robots.txt is cached, in milliseconds. */
  constructor(private readonly ttlMs: number = 60 * 60 * 1000) {}

  /** Get a cached entry, if it is still fresh. */
  get(origin: string): RobotsCacheEntry | undefined {
    const entry = this.entries.get(origin);
    if (entry === undefined) return undefined;
    // `>=` rather than `>`: a zero TTL must expire immediately, even within
    // the same millisecond.
    if (Date.now() - entry.fetchedAt >= this.ttlMs) {
      this.entries.delete(origin);
      return undefined;
    }
    return entry;
  }

  /** Store a robots.txt. */
  set(origin: string, body: string): RobotsCacheEntry {
    const entry: RobotsCacheEntry = {
      body,
      fetchedAt: Date.now(),
      parser: robotsParser(`${origin}/robots.txt`, body),
    };
    this.entries.set(origin, entry);
    return entry;
  }

  /** Whether an origin has a fresh cached entry. */
  has(origin: string): boolean {
    return this.get(origin) !== undefined;
  }

  /** Remove every cached entry. */
  clear(): void {
    this.entries.clear();
  }

  /** How many entries are cached. */
  get size(): number {
    return this.entries.size;
  }
}

/** The result of a robots.txt evaluation. */
export interface RobotsVerdict {
  /** Whether the URL may be visited. */
  allowed: boolean;
  /** The reason, when it is not allowed. */
  reason?: string;
  /** The crawl delay in seconds, when the robots.txt declares one. */
  crawlDelaySeconds?: number;
}

/**
 * Evaluate a URL against a robots.txt.
 *
 * When the robots.txt has no matching rule for the URL, the URL is allowed:
 * robots.txt restricts, it does not grant.
 */
export function evaluateRobots(
  entry: RobotsCacheEntry | undefined,
  url: string,
  userAgent: string,
): RobotsVerdict {
  if (entry === undefined) return { allowed: true };

  // `robots-parser` returns undefined when the URL does not belong to the
  // robots.txt's host. That is not a disallow.
  const allowed = entry.parser.isAllowed(url, userAgent);
  const crawlDelay = entry.parser.getCrawlDelay(userAgent);

  if (allowed === false) {
    return {
      allowed: false,
      reason: `the path is disallowed by ${new URL(url).origin}/robots.txt`,
      ...(crawlDelay !== undefined ? { crawlDelaySeconds: crawlDelay } : {}),
    };
  }

  return {
    allowed: true,
    ...(crawlDelay !== undefined ? { crawlDelaySeconds: crawlDelay } : {}),
  };
}

/**
 * Fetch a robots.txt.
 *
 * A missing or unreachable robots.txt means "no restrictions", which is what
 * the standard specifies. The failure is recorded rather than thrown, so a
 * broken robots.txt never silently becomes "everything allowed" without
 * being noted.
 */
export async function fetchRobots(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: string; ok: boolean; status: number }> {
  try {
    const response = await fetchImpl(`${origin}/robots.txt`, {
      headers: { accept: 'text/plain' },
      redirect: 'follow',
    });
    if (!response.ok) {
      return { body: '', ok: false, status: response.status };
    }
    return { body: await response.text(), ok: true, status: response.status };
  } catch {
    return { body: '', ok: false, status: 0 };
  }
}

/**
 * The robot's name used when matching `User-agent` rules.
 *
 * The honest user agent is `BrowserVerifiedSkill/<version> (+<contact>)`, so
 * robots.txt rules that match `BrowserVerified` or `*` apply.
 */
export function robotsUserAgent(userAgentSuffix: string): string {
  // `robots-parser` matches the user agent by the product token, so the
  // version and the contact suffix are dropped.
  const match = /^([A-Za-z][A-Za-z0-9-]*)/.exec(userAgentSuffix);
  return match?.[1] ?? 'BrowserVerifiedSkill';
}
