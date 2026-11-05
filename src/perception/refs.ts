/**
 * Ref handling.
 *
 * Playwright's `mode: 'ai'` snapshot already hands out refs (`e9`, `f2e3`) that
 * are stable while the element exists and resolvable with `page.getByRef()`.
 * This module adds the parts Playwright does not provide:
 *
 *  - validating a user-supplied ref before it is used,
 *  - detecting that a ref belongs to a frame,
 *  - tracking which refs are currently valid (so a stale ref is reported
 *    clearly instead of failing obscurely).
 */

/** The shape of a Playwright aria ref: `e12` or `f2e12`. */
const REF_PATTERN = /^(?:f(\d+))?e(\d+)$/;

/** A parsed ref. */
export interface ParsedRef {
  /** The ref as written, e.g. `f2e12`. */
  raw: string;
  /** The frame index, when the ref belongs to a frame. */
  frameIndex?: number;
  /** The element index within the frame. */
  elementIndex: number;
  /** True when the ref points into a frame. */
  isFrame: boolean;
}

/** Parse a ref, returning undefined when it is not a valid ref. */
export function parseRef(ref: string): ParsedRef | undefined {
  const match = REF_PATTERN.exec(ref.trim());
  if (match === null) return undefined;
  const frame = match[1];
  const element = match[2];
  if (element === undefined) return undefined;
  const elementIndex = Number(element);
  if (!Number.isFinite(elementIndex)) return undefined;
  if (frame === undefined) {
    return { raw: ref, elementIndex, isFrame: false };
  }
  const frameIndex = Number(frame);
  if (!Number.isFinite(frameIndex)) return undefined;
  return { raw: ref, frameIndex, elementIndex, isFrame: true };
}

/** True when the string looks like a ref. */
export function isRef(value: string): boolean {
  return REF_PATTERN.test(value.trim());
}

/**
 * A registry of refs seen in the most recent snapshot.
 *
 * It lets the CLI answer "is this ref still valid?" without touching the
 * browser, and it lets the daemon detect stale refs before acting.
 */
export class RefRegistry {
  private refs = new Map<string, { role: string; name?: string; frame?: number }>();

  /** Replace the registry contents with the refs from a fresh snapshot. */
  reset(): void {
    this.refs.clear();
  }

  /** Record a ref. */
  add(ref: string, role: string, name?: string, frame?: number): void {
    this.refs.set(ref, {
      role,
      ...(name !== undefined ? { name } : {}),
      ...(frame !== undefined ? { frame } : {}),
    });
  }

  /** True when the ref was seen in the latest snapshot. */
  has(ref: string): boolean {
    return this.refs.has(ref);
  }

  /** Look up a ref. */
  get(ref: string): { role: string; name?: string; frame?: number } | undefined {
    return this.refs.get(ref);
  }

  /** All known refs. */
  all(): string[] {
    return [...this.refs.keys()];
  }

  /** How many refs are known. */
  get size(): number {
    return this.refs.size;
  }
}
