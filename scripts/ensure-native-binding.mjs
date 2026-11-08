/**
 * Ensure the native binding for the current platform is installed.
 *
 * ## Why this exists
 *
 * `rolldown` (a dependency of Vite, which Vitest uses) ships its native
 * binding as an **optional dependency**: one package per platform, e.g.
 * `@rolldown/binding-linux-x64-gnu`.
 *
 * npm has a long-standing bug with optional dependencies
 * ([npm/cli#4828](https://github.com/npm/cli/issues/4828)): when a
 * lockfile is generated on one platform and used on another, npm resolves
 * only the *generating* platform's package. The result on CI is:
 *
 *     Error: Cannot find native binding. npm has a bug related to
 *     optional dependencies.
 *       cause: Error: Cannot find module '@rolldown/binding-wasm32-wasi'
 *
 * The failure is silent until a test tries to start, and it only affects
 * the platforms that did not generate the lockfile — which is exactly the
 * set of platforms a CI matrix runs on.
 *
 * ## What this does
 *
 * After install, it checks whether the binding for the current platform is
 * present, and if not, installs it explicitly. It is idempotent, it never
 * fails the install (a missing binding should not break `npm install` for
 * someone who is not running the tests), and it does nothing at all when
 * the binding is already there.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The binding package for a platform and architecture.
 *
 * Returns undefined for a platform `rolldown` does not publish a binding
 * for, in which case there is nothing to install.
 */
function bindingFor(platform, arch) {
  if (platform === 'darwin') {
    return arch === 'arm64' ? '@rolldown/binding-darwin-arm64' : '@rolldown/binding-darwin-x64';
  }

  if (platform === 'win32') {
    return arch === 'arm64'
      ? '@rolldown/binding-win32-arm64-msvc'
      : '@rolldown/binding-win32-x64-msvc';
  }

  if (platform === 'freebsd') {
    return '@rolldown/binding-freebsd-x64';
  }

  if (platform === 'android') {
    return arch === 'arm64'
      ? '@rolldown/binding-android-arm64'
      : '@rolldown/binding-android-arm-eabi';
  }

  if (platform === 'openharmony') {
    return '@rolldown/binding-openharmony-arm64';
  }

  if (platform === 'linux') {
    // glibc and musl are the two Linux ABIs. The default is glibc; musl
    // is detected by the absence of a runtime glibc version.
    const report = process.report?.getReport?.();
    const isMusl = report?.header?.glibcVersionRuntime === undefined;

    if (arch === 'arm64') {
      return isMusl ? '@rolldown/binding-linux-arm64-musl' : '@rolldown/binding-linux-arm64-gnu';
    }
    if (arch === 'arm') return '@rolldown/binding-linux-arm-gnueabihf';
    if (arch === 'ppc64') return '@rolldown/binding-linux-ppc64-gnu';
    if (arch === 's390x') return '@rolldown/binding-linux-s390x-gnu';
    return isMusl ? '@rolldown/binding-linux-x64-musl' : '@rolldown/binding-linux-x64-gnu';
  }

  return undefined;
}

/**
 * Whether the binding for this platform is already installed.
 *
 * `rolldown` resolves the binding when it is loaded, so a successful
 * import means the binding is there.
 */
function isPresent() {
  try {
    require('rolldown');
    return true;
  } catch {
    return false;
  }
}

/** The package manager that ran the install, so the fix uses the same one. */
function packageManager() {
  const execPath = process.env['npm_execpath'] ?? '';
  if (execPath.includes('pnpm')) return 'pnpm';
  if (execPath.includes('yarn')) return 'yarn';
  return 'npm';
}

function main() {
  const binding = bindingFor(process.platform, process.arch);

  if (binding === undefined) {
    // An unsupported platform. Nothing to install, and nothing to complain
    // about — the tests may still work with a WASM build.
    return;
  }

  if (isPresent()) {
    return;
  }

  const manager = packageManager();

  try {
    execFileSync(manager, ['install', '--no-save', '--no-audit', '--no-fund', binding], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    console.log(`[browser-verified-skill] installed the missing native binding: ${binding}`);
  } catch {
    // A failed postinstall must not fail the install. If the tests are
    // what need the binding, they will say so clearly.
    console.warn(
      `[browser-verified-skill] could not install the native binding "${binding}". ` +
        'The test suite may not start on this platform.',
    );
  }
}

main();
