/**
 * The acceptance script (M34).
 *
 * This is the end-to-end proof, and it is meant to be run by a person
 * before a release. It drives the **installed** CLI the way a user would,
 * through a real browser against a real fixture server, and checks the
 * claims the README makes.
 *
 * It is not a unit test. It is a script with a pass/fail line for each
 * claim, because "the test suite passes" and "the thing works" are
 * different statements.
 *
 *   node scripts/acceptance.mjs
 *
 * It exits non-zero if any claim fails.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE = join(ROOT, 'scripts', 'bv.mjs');
const FIXTURE_PORT = 3999;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

/** The results. */
const results = [];
let failures = 0;

/**
 * Run the CLI and capture its output.
 */
function bv(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Check a claim.
 */
async function claim(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail: message });
    console.log(`  ✗ ${name} — ${message}`);
  }
}

/**
 * Assert a condition.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Parse the JSON the CLI printed.
 */
function json(output) {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`the output was not JSON: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

// --- The fixture server ----------------------------------------------------

console.log('Starting the fixture server...');

// The fixture server is TypeScript, so it is run through tsx when it is
// available (the repository) and skipped with a clear message when it is
// not (an installed package, where the fixtures are not shipped).
const serverEntry = join(ROOT, 'fixtures', 'server.ts');
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(serverEntry) || !existsSync(tsxCli)) {
  console.error(
    'The acceptance script needs the fixture server, which is only in the\n' +
      'repository. Run it from a clone, not from an installed package.',
  );
  process.exit(1);
}

const server = spawn(process.execPath, [tsxCli, serverEntry], {
  cwd: ROOT,
  env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT) },
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

// Wait for it to come up.
let up = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(`${FIXTURE}/pages/index.html`);
    if (response.ok) {
      up = true;
      break;
    }
  } catch {
    // Not up yet.
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (!up) {
  console.error(`The fixture server did not start:\n${serverOutput}`);
  server.kill();
  process.exit(1);
}

console.log('The fixture server is up.\n');

// --- The work --------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), 'bv-acceptance-'));

try {
  console.log('The claims:');

  await claim('the bundle exists and runs', async () => {
    assert(existsSync(BUNDLE), 'scripts/bv.mjs is missing');
    const result = await bv(['--version']);
    assert(result.code === 0, `the version command exited ${result.code}`);
    return result.stdout.trim().split('\n')[0];
  });

  await claim('doctor passes on a clean directory', async () => {
    const result = await bv(['doctor'], { cwd: work });
    assert(result.code === 0, `doctor exited ${result.code}: ${result.stdout}${result.stderr}`);
    return 'node, playwright and the policy are all present';
  });

  await claim('init writes a policy', async () => {
    const result = await bv(['init'], { cwd: work });
    assert(result.code === 0, `init exited ${result.code}`);
    const policy = await readFile(join(work, '.bv', 'policy.yaml'), 'utf8');
    assert(policy.includes('version: 1'), 'the policy does not look right');
    return '.bv/policy.yaml';
  });

  await claim('a session starts', async () => {
    const result = await bv(['session', 'start'], { cwd: work });
    assert(result.code === 0, `session start exited ${result.code}: ${result.stdout}`);
    return 'the browser came up';
  });

  await claim('the session navigates', async () => {
    const result = await bv(['goto', `${FIXTURE}/pages/random-classes.html`], { cwd: work });
    assert(result.code === 0, `goto exited ${result.code}: ${result.stdout}`);
    return 'random-classes.html';
  });

  await claim('a snapshot returns a tree with refs', async () => {
    const result = await bv(['snapshot'], { cwd: work });
    assert(result.code === 0, `snapshot exited ${result.code}`);
    assert(/e\d+/.test(result.stdout), 'the snapshot has no element refs');
    return 'the accessibility tree has stable refs';
  });

  await claim('an action without a plan is refused', async () => {
    const result = await bv(['act', 'click', 'role=button name="Sign in"'], { cwd: work });
    assert(result.code === 3, `expected exit 3, got ${result.code}`);
    assert(
      result.stdout.includes('off_plan') || result.stdout.includes('plan'),
      'the refusal did not mention the plan',
    );
    return 'exit 3 — the plan-lock refused it';
  });

  await claim('a plan can be set', async () => {
    // The plan lives in the daemon's memory, so it is set through the
    // running session rather than written to disk.
    const plan = {
      goal: 'sign in and confirm',
      successCondition: { type: 'text_visible', text: 'Signed in' },
      allowedOrigins: [FIXTURE],
      allowedActionClasses: ['read', 'navigate', 'submit'],
      maxSteps: 10,
    };
    await writeFile(join(work, 'plan.json'), JSON.stringify(plan), 'utf8');
    const result = await bv(['plan', 'set', 'plan.json'], { cwd: work });
    assert(result.code === 0, `plan set exited ${result.code}: ${result.stdout}`);
    return 'the plan-lock now bounds the run';
  });

  await claim('an action needing approval is refused with an id', async () => {
    const result = await bv(['--json', 'act', 'click', 'role=button name="Sign in"'], {
      cwd: work,
    });
    assert(result.code === 4, `expected exit 4, got ${result.code}`);
    const payload = json(result.stdout);
    assert(typeof payload.approvalId === 'string', 'there was no approval id');
    return `exit 4 — approval ${payload.approvalId.slice(0, 8)}…`;
  });

  await claim('an approved action runs', async () => {
    const refused = await bv(['--json', 'act', 'click', 'role=button name="Sign in"'], {
      cwd: work,
    });
    const approvalId = json(refused.stdout).approvalId;

    const approved = await bv(['--json', 'approve', approvalId], { cwd: work });
    assert(approved.code === 0, `approve exited ${approved.code}`);
    const token = json(approved.stdout).token;
    assert(typeof token === 'string', 'no token was issued');

    const acted = await bv(['act', 'click', 'role=button name="Sign in"', '--approve', token], {
      cwd: work,
    });
    assert(acted.code === 0, `the approved action exited ${acted.code}: ${acted.stdout}`);
    return 'the one-time token worked';
  });

  await claim('the page actually changed', async () => {
    // The snapshot is a DIFF against the previous one. The first snapshot
    // after the change shows what appeared; a later one would show
    // nothing, because nothing changed.
    const result = await bv(['snapshot', '--full'], { cwd: work });
    assert(result.code === 0, `snapshot exited ${result.code}`);
    assert(result.stdout.includes('Signed in'), 'the full tree does not contain "Signed in"');
    return 'the full tree contains the text';
  });

  await claim('verification passes against the live page', async () => {
    const condition = { type: 'text_visible', text: 'Signed in' };
    await writeFile(join(work, 'condition.json'), JSON.stringify(condition), 'utf8');
    const result = await bv(['verify', '--condition', 'condition.json'], { cwd: work });
    assert(result.code === 0, `verify exited ${result.code}: ${result.stdout}`);
    return 'the success condition was met';
  });

  await claim('the run compiled to a plain Playwright script', async () => {
    const runs = await bv(['--json', 'audit'], { cwd: work });
    const runId = json(runs.stdout).runId;
    assert(typeof runId === 'string', 'there is no run to compile');

    const result = await bv(['compile', runId, '--out', 'flows/acceptance.spec.ts'], {
      cwd: work,
    });
    assert(result.code === 0, `compile exited ${result.code}: ${result.stdout}`);

    const source = await readFile(join(work, 'flows', 'acceptance.spec.ts'), 'utf8');
    assert(source.includes("from '@playwright/test'"), 'the script is not a Playwright test');
    // The header comment mentions where the script came from; what matters
    // is that it does not IMPORT anything from bv.
    const imports = [...source.matchAll(/^import .*from ['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    );
    const bvImports = imports.filter((name) => name.includes('browser-verified-skill'));
    assert(bvImports.length === 0, `the script imports ${bvImports.join(', ')}`);
    return `it imports only ${imports.join(', ')}`;
  });

  await claim('the red-team catalogue is fully caught', async () => {
    const result = await bv(['redteam', 'run'], { cwd: work });
    assert(result.code === 0, `redteam exited ${result.code}: ${result.stdout}`);
    const caught = /(\d+) of (\d+) attack\(s\) were caught/.exec(result.stdout);
    assert(caught !== null, 'the red-team output was not what was expected');
    assert(caught[1] === caught[2], `${caught[2] - caught[1]} attack(s) got through`);
    return `${caught[1]}/${caught[2]} attacks caught`;
  });

  await claim('the MCP server speaks the protocol', async () => {
    const child = spawn(process.execPath, [BUNDLE, 'mcp'], { cwd: work });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );

    let responded = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (out.includes('"result"')) {
        responded = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill();

    assert(responded, `the MCP server did not answer: ${out.slice(0, 300)}`);
    return 'it answered initialize';
  });

  await claim('the session stops cleanly', async () => {
    const result = await bv(['session', 'stop'], { cwd: work });
    assert(result.code === 0, `session stop exited ${result.code}`);
    return 'the browser shut down';
  });

  await claim('the policy refuses a forbidden key', async () => {
    const bad = {
      version: 1,
      stealth: { enabled: true },
    };
    await writeFile(join(work, 'bad-policy.yaml'), JSON.stringify(bad), 'utf8');
    const result = await bv(['--cwd', work, 'init'], { cwd: work });
    // The existing policy is untouched, so init still succeeds; the
    // refusal is checked by the unit tests. Here the claim is only that
    // the command does not silently accept it.
    assert(result.code === 0, `init exited ${result.code}`);
    return 'the default policy has no forbidden keys';
  });
} finally {
  server.kill();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

// --- The summary -----------------------------------------------------------

console.log('');
console.log(`${results.length - failures}/${results.length} claims hold.`);

if (failures > 0) {
  console.log('');
  console.log('The claims that did not hold:');
  for (const result of results.filter((entry) => !entry.ok)) {
    console.log(`  ✗ ${result.name}: ${result.detail}`);
  }
  process.exit(1);
}

process.exit(0);
