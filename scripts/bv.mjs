#!/usr/bin/env node

// src/cli/main.ts
import { Command } from 'commander';

// src/core/exit.ts
var EXIT = {
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
};

// src/core/errors.ts
var BvError = class extends Error {
  exitCode;
  /** Machine-readable reason codes, e.g. `policy.deny`, `plan.off_plan`. */
  reasons;
  /** Extra structured detail for `--json` output. */
  detail;
  constructor(message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = 'BvError';
    this.exitCode = options.exitCode ?? EXIT.FAILURE;
    this.reasons = options.reasons ?? [];
    this.detail = options.detail ?? {};
  }
};
function toBvError(err) {
  if (err instanceof BvError) return err;
  if (err instanceof Error) {
    return new BvError(err.message, { cause: err });
  }
  return new BvError(String(err));
}

// src/core/output.ts
function ok(data, lines = []) {
  return { data, lines, code: EXIT.OK };
}
function fail(data, lines, code = EXIT.FAILURE) {
  return { data, lines, code };
}
function printResult(result, opts) {
  if (opts.json) {
    const payload =
      result.extra && typeof result.data === 'object' && result.data !== null
        ? { ...result.data, ...result.extra }
        : result.data;
    opts.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
    if (result.lines.length > 0) {
      opts.stderr.write(`${result.lines.join('\n')}
`);
    }
    return;
  }
  if (result.lines.length > 0) {
    opts.stdout.write(`${result.lines.join('\n')}
`);
  }
}

// src/version.ts
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
function findManifest() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        if (parsed.name === 'browser-verified') return parsed;
      } catch {}
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const require2 = createRequire(import.meta.url);
    return require2('../../package.json');
  } catch {
    return {};
  }
}
var manifest = findManifest();
var VERSION = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
var DESCRIPTION =
  typeof manifest.description === 'string'
    ? manifest.description
    : 'Browser-verified: safety-first browser automation with evidence and self-repair.';

// src/cli/commands/doctor.ts
import { access, constants, readdir, stat } from 'fs/promises';
import { join as join3 } from 'path';
import { homedir as homedir2 } from 'os';

// src/core/paths.ts
import { mkdir, chmod, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join as join2, resolve as resolve2 } from 'path';
var BV_DIR = '.bv';
function bvRoot(cwd = process.cwd()) {
  return join2(resolve2(cwd), BV_DIR);
}
function policyPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'policy.yaml');
}
function runsRoot(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'runs');
}

// src/cli/helpers.ts
function globalOptions(cmd) {
  const opts = cmd.parent?.opts() ?? {};
  return {
    json: opts.json === true,
    cwd: opts.cwd ?? process.cwd(),
  };
}
function emit(cmd, result) {
  const global = globalOptions(cmd);
  printResult(result, {
    json: global.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

// src/cli/commands/doctor.ts
var MIN_NODE_MAJOR = 20;
function playwrightBrowserDirs() {
  const home = homedir2();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    return local ? [join3(local, 'ms-playwright')] : [];
  }
  if (process.platform === 'darwin') {
    return [join3(home, 'Library', 'Caches', 'ms-playwright')];
  }
  return [join3(home, '.cache', 'ms-playwright')];
}
async function findChromium() {
  for (const dir of playwrightBrowserDirs()) {
    try {
      const entries = await readdir(dir);
      const chromium = entries.filter((e) => e.startsWith('chromium-'));
      if (chromium.length > 0) {
        const full = join3(dir, chromium.sort().at(-1) ?? chromium[0] ?? '');
        const info = await stat(full).catch(() => void 0);
        if (info?.isDirectory()) return full;
      }
    } catch {}
  }
  return void 0;
}
async function runDoctor(cwd) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${process.versions.node} is older than the required v${MIN_NODE_MAJOR}`,
          fix: 'install Node 20 or newer',
        },
  );
  const chromium = await findChromium();
  checks.push(
    chromium
      ? { name: 'playwright-chromium', status: 'ok', detail: chromium }
      : {
          name: 'playwright-chromium',
          status: 'fail',
          detail: 'no Chromium build found in the Playwright browser cache',
          fix: 'bv doctor --install',
        },
  );
  const root = bvRoot(cwd);
  try {
    await access(root, constants.W_OK);
    checks.push({ name: 'runtime-dir', status: 'ok', detail: root });
  } catch {
    const exists = await stat(root).then(
      () => true,
      () => false,
    );
    if (exists) {
      checks.push({
        name: 'runtime-dir',
        status: 'fail',
        detail: `${root} exists but is not writable`,
        fix: 'fix the directory permissions, or remove it and run `bv init`',
      });
    } else {
      checks.push({
        name: 'runtime-dir',
        status: 'warn',
        detail: `${root} does not exist yet`,
        fix: 'bv init',
      });
    }
  }
  const policy = policyPath(cwd);
  const policyExists = await stat(policy).then(
    () => true,
    () => false,
  );
  checks.push(
    policyExists
      ? { name: 'policy', status: 'ok', detail: policy }
      : {
          name: 'policy',
          status: 'warn',
          detail: 'no policy file: the default policy will be used',
          fix: 'bv init',
        },
  );
  const hasKey = Boolean(process.env['ANTHROPIC_API_KEY']);
  checks.push({
    name: 'anthropic-key',
    status: hasKey ? 'ok' : 'warn',
    detail: hasKey
      ? 'ANTHROPIC_API_KEY is set (Mode B available)'
      : 'ANTHROPIC_API_KEY is not set: Mode B is unavailable, Mode A is unaffected',
  });
  return checks;
}
async function installBrowsers() {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const cli = join3(process.cwd(), 'node_modules', 'playwright', 'cli.js');
  await execFileAsync(process.execPath, [cli, 'install', 'chromium'], { cwd: process.cwd() });
}
function registerDoctor(program) {
  program
    .command('doctor')
    .description('check the environment: node, playwright browsers, permissions, policy')
    .option('--install', 'install the Playwright browsers if they are missing', false)
    .action(async (options, cmd) => {
      const global = cmd.parent?.opts() ?? {};
      const cwd = global.cwd ?? process.cwd();
      if (options.install === true) {
        try {
          await installBrowsers();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const result2 = fail(
            { checks: [], error: 'install_failed', message },
            [`Browser installation failed: ${message}`],
            EXIT.FAILURE,
          );
          emit(cmd, result2);
          return;
        }
      }
      const checks = await runDoctor(cwd);
      const failed = checks.filter((c) => c.status === 'fail');
      const lines = [];
      for (const check of checks) {
        const mark = check.status === 'ok' ? '\u2713' : check.status === 'warn' ? '!' : '\u2717';
        lines.push(`${mark} ${check.name}: ${check.detail}`);
        if (check.fix !== void 0 && check.status !== 'ok') {
          lines.push(`    fix: ${check.fix}`);
        }
      }
      lines.push(
        failed.length === 0
          ? 'All checks passed.'
          : `${failed.length} check(s) failed. Fix the items above before running a session.`,
      );
      const result =
        failed.length === 0
          ? ok({ checks }, lines)
          : fail({ checks, failed: failed.map((c) => c.name) }, lines, EXIT.FAILURE);
      emit(cmd, result);
    });
}

// src/cli/commands/init.ts
import { copyFile, mkdir as mkdir2, readFile, writeFile as writeFile2 } from 'fs/promises';
import { existsSync as existsSync2 } from 'fs';
import { dirname as dirname2, resolve as resolve3 } from 'path';
import { fileURLToPath as fileURLToPath2 } from 'url';
function packagedPolicyPath() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  const candidates = [
    resolve3(here, '..', '..', '..', 'policies', 'default.yaml'),
    resolve3(here, '..', '..', '..', '..', 'policies', 'default.yaml'),
    resolve3(here, '..', 'policies', 'default.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync2(candidate)) return candidate;
  }
  return candidates[0] ?? '';
}
async function runInit(cwd) {
  const root = bvRoot(cwd);
  await mkdir2(runsRoot(cwd), { recursive: true });
  const policy = policyPath(cwd);
  let policyCreated = false;
  const existing = await readFile(policy, 'utf8').catch(() => void 0);
  if (existing === void 0) {
    const packaged = packagedPolicyPath();
    const content = await readFile(packaged, 'utf8').catch(() => void 0);
    if (content === void 0) {
      await writeFile2(
        policy,
        [
          'version: 1',
          'domains:',
          '  allow: [localhost, 127.0.0.1]',
          '  deny: []',
          'ownedOrigins: []',
          'actionClasses:',
          '  approvalRequired: [submit, destructive, financial, messaging, upload]',
          '  deny: []',
          'budgets:',
          '  maxSteps: 80',
          '  maxRetriesPerStep: 2',
          '  maxSeconds: 600',
          '  maxTokens: 200000',
          'rate:',
          '  maxRpsPerDomain: 1',
          '  jitterMs: [300, 1200]',
          'compliance:',
          '  respectRobots: true',
          '  captcha: human_handoff',
          'secrets:',
          '  maskInLogs: true',
          '',
        ].join('\n'),
        'utf8',
      );
    } else {
      await copyFile(packaged, policy);
    }
    policyCreated = true;
  }
  return { root, policyCreated, policyPath: policy };
}
function registerInit(program) {
  program
    .command('init')
    .description('create .bv/ and write a default policy')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const result = await runInit(global.cwd);
        const lines = [
          `runtime directory: ${result.root}`,
          result.policyCreated
            ? `policy written: ${result.policyPath}`
            : `policy kept (already exists): ${result.policyPath}`,
          'next: bv session start --headed',
        ];
        emit(cmd, ok(result, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail(
            { error: 'init_failed', message },
            [`Could not initialise: ${message}`],
            EXIT.FAILURE,
          ),
        );
      }
    });
}

// src/cli/main.ts
function buildProgram() {
  const program = new Command();
  program
    .name('bv')
    .description(DESCRIPTION)
    .version(VERSION, '-V, --version', 'print the version and exit')
    .option('--json', 'emit machine-readable JSON on stdout', false)
    .option('--cwd <dir>', 'working directory that holds .bv/', process.cwd())
    .showHelpAfterError('(run with --help for usage)')
    .enablePositionalOptions();
  registerDoctor(program);
  registerInit(program);
  return program;
}
async function run(argv) {
  const program = buildProgram();
  program.exitOverride();
  let handled = false;
  program.hook('preAction', (_thisCommand, actionCommand) => {
    handled = actionCommand !== program;
  });
  let result = { data: null, lines: [], code: EXIT.OK };
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (!handled) {
      program.outputHelp();
      result = { data: null, lines: [], code: EXIT.USAGE };
    }
  } catch (err) {
    const bvErr = toBvError(err);
    const isHelp = bvErr.message.includes('(outputHelp)') || bvErr.message.includes('(version)');
    if (isHelp) {
      result = { data: null, lines: [], code: EXIT.OK };
    } else {
      result = {
        data: {
          error: bvErr.name,
          message: bvErr.message,
          reasons: bvErr.reasons,
          ...bvErr.detail,
        },
        lines: [bvErr.message],
        code: bvErr.exitCode,
      };
    }
  }
  if (handled) return result.code;
  const opts = globalOptions(program);
  printResult(result, {
    json: opts.json,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return result.code;
}
async function main(argv = process.argv) {
  const code = await run(argv.slice(2));
  process.exitCode = code;
}

// src/cli/bundle.ts
await main(process.argv);
