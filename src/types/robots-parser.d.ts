/**
 * Ambient types for `robots-parser`.
 *
 * The package ships an `index.d.ts` that begins with a bodyless
 * `declare module 'robots-parser';`, which discards the rest of the file —
 * including its `export default`. The result is that the module resolves to
 * a namespace with no callable signature.
 *
 * This file declares the module properly so the default export is callable
 * and the `Robot` interface is available. It matches the runtime shape,
 * which was verified against the installed `robots-parser@3.0.1`:
 * `module.exports = function (url, contents) { return new Robots(url, contents); }`.
 */
declare module 'robots-parser' {
  /** A parsed robots.txt. */
  export interface Robot {
    /** Whether a URL may be visited. `undefined` when the URL does not belong to this robots.txt. */
    isAllowed(url: string, ua?: string): boolean | undefined;
    /** The opposite of `isAllowed`. */
    isDisallowed(url: string, ua?: string): boolean | undefined;
    /** The line number of the matching directive, 1-based; -1 when there is none. */
    getMatchingLineNumber(url: string, ua?: string): number;
    /** The crawl delay in seconds, when the robots.txt declares one. */
    getCrawlDelay(ua?: string): number | undefined;
    /** The sitemaps the robots.txt lists. */
    getSitemaps(): string[];
    /** The preferred host, when the robots.txt declares one. */
    getPreferredHost(): string | null;
  }

  /** Parse a robots.txt. */
  export default function robotsParser(url: string, robotstxt: string): Robot;
}
