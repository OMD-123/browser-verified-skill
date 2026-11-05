import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The subset of the package manifest this module needs. */
interface Manifest {
  version?: unknown;
  description?: unknown;
  name?: unknown;
}

/**
 * Find the `browser-verified` package manifest.
 *
 * Walks up from this module's directory looking for a `package.json` whose
 * `name` is `browser-verified`. This works from `src/` (source runs) and from
 * `scripts/` (the bundled CLI), without hard-coding a relative depth.
 */
function findManifest(): Manifest {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Manifest;
        if (parsed.name === 'browser-verified') return parsed;
      } catch {
        // Unreadable or malformed: keep walking up.
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: resolve through Node's module resolution, which handles the
  // bundled case where the manifest is a sibling of the bundle.
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json') as Manifest;
  } catch {
    return {};
  }
}

const manifest = findManifest();

/** The package version, used in the user agent and `--version` output. */
export const VERSION: string = typeof manifest.version === 'string' ? manifest.version : '0.0.0';

/** The package description. */
export const DESCRIPTION: string =
  typeof manifest.description === 'string'
    ? manifest.description
    : 'Browser-verified: safety-first browser automation with evidence and self-repair.';
