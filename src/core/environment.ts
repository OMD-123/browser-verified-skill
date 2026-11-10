/**
 * The daemon's environment (Phase 0, gap 7).
 *
 * ## The problem
 *
 * The daemon was spawned with `env: process.env`. That is the whole
 * environment of whatever started it, which in practice is the
 * operator's shell, or the agent's shell.
 *
 * Two things are wrong with that.
 *
 * **Secrets leak.** `ANTHROPIC_API_KEY` was forwarded to a browser
 * process that has no use for it. A page could not read it directly,
 * but a crash dump, a log line, or a child process could.
 *
 * **The agent's environment is the operator's environment.** If the
 * agent can set a variable and the daemon reads it, the agent can
 * influence the tool's behaviour without going through the policy.
 *
 * ## The rule
 *
 * The daemon gets:
 *
 *   - `PATH`, `HOME` and `TMPDIR`, because the browser needs them
 *   - the proxy variables, because the network needs them
 *   - the model key, and ONLY when Mode B is on
 *   - the locale and timezone, because a page may depend on them
 *
 * Nothing else. In particular, no other secret the operator happened to
 * have in their shell.
 */
import { platform } from 'node:os';

/** The variables that are always passed. */
const ALWAYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'];

/** The proxy variables. A network that cannot reach its proxy is useless. */
const PROXY = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/** The locale and timezone. A page may depend on them. */
const LOCALE = ['LANG', 'LANGUAGE', 'LC_ALL', 'TZ'];

/**
 * The environment for the daemon.
 *
 * `modelKey` is the key to forward, if any. It is passed explicitly
 * rather than read from the ambient environment, so the caller decides.
 */
export function daemonEnvironment(options: {
  /** The environment to build from. The parent's, normally. */
  source?: NodeJS.ProcessEnv;
  /** The model key to forward, if Mode B is on. */
  modelKey?: string | undefined;
  /** Whether Mode B is on. */
  modeB?: boolean;
  /** The platform. Defaults to this one. */
  platformName?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const platformName = options.platformName ?? platform();
  const env: NodeJS.ProcessEnv = {};

  const copy = (names: readonly string[]): void => {
    for (const name of names) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
  };

  copy(ALWAYS);
  copy(PROXY);
  copy(LOCALE);

  // The model key goes in only when Mode B is on. Mode A does not need
  // it, so Mode A does not get it.
  if (options.modeB === true && options.modelKey !== undefined) {
    env['ANTHROPIC_API_KEY'] = options.modelKey;
    const base = source['ANTHROPIC_BASE_URL'];
    if (base !== undefined) env['ANTHROPIC_BASE_URL'] = base;
  } else {
    // Even in Mode A, a key in the ambient environment must not be
    // forwarded. The caller passes the key explicitly when it wants it.
    delete env['ANTHROPIC_API_KEY'];
    delete env['ANTHROPIC_BASE_URL'];
  }

  // On Windows, some tools need these to find the system root.
  if (isWindows(platformName)) {
    const appData = source['APPDATA'];
    if (appData !== undefined) env['APPDATA'] = appData;
    const localAppData = source['LOCALAPPDATA'];
    if (localAppData !== undefined) env['LOCALAPPDATA'] = localAppData;
  }

  return env;
}

/**
 * Whether the platform is Windows.
 *
 * The platform is a parameter so the mapping can be tested for every
 * platform, not just the one the test happens to run on. A branch that
 * only runs on Windows would otherwise never run on the Linux CI runner
 * that is the one that checks the coverage.
 */
export function isWindows(platformName: NodeJS.Platform): boolean {
  return platformName === 'win32';
}

/**
 * The names that must never be forwarded.
 *
 * Exported so a test can check the daemon's environment against them,
 * and so the list is one thing rather than a rule spread around.
 */
export const NEVER_FORWARDED: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
];
