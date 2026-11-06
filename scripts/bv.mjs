#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) =>
  function __init() {
    if (err) throw err[0];
    try {
      return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
    } catch (e) {
      throw ((err = [e]), e);
    }
  };
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/exit.ts
var EXIT;
var init_exit = __esm({
  'src/core/exit.ts'() {
    'use strict';
    EXIT = {
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
  },
});

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
var manifest, VERSION, DESCRIPTION;
var init_version = __esm({
  'src/version.ts'() {
    'use strict';
    manifest = findManifest();
    VERSION = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    DESCRIPTION =
      typeof manifest.description === 'string'
        ? manifest.description
        : 'Browser-verified: safety-first browser automation with evidence and self-repair.';
  },
});

// src/core/paths.ts
import { mkdir, chmod, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join as join2, resolve as resolve2 } from 'path';
function bvRoot(cwd = process.cwd()) {
  return join2(resolve2(cwd), BV_DIR);
}
function policyPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'policy.yaml');
}
function daemonInfoPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'daemon.json');
}
function daemonTokenPath(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'daemon.token');
}
function runsRoot(cwd = process.cwd()) {
  return join2(bvRoot(cwd), 'runs');
}
function runDir(runId, cwd = process.cwd()) {
  return join2(runsRoot(cwd), runId);
}
function stepDir(runId, step, cwd = process.cwd()) {
  return join2(runDir(runId, cwd), 'steps', String(step).padStart(3, '0'));
}
function auditPath(runId, cwd = process.cwd()) {
  return join2(runDir(runId, cwd), 'audit.jsonl');
}
async function writePrivateFile(path, contents) {
  await mkdir(join2(path, '..'), { recursive: true });
  await writeFile(path, contents, { encoding: 'utf8', mode: 384 });
  try {
    await chmod(path, 384);
  } catch {}
}
async function ensureBvDir(cwd = process.cwd()) {
  const root = bvRoot(cwd);
  await mkdir(join2(root, 'runs'), { recursive: true });
  return root;
}
var BV_DIR;
var init_paths = __esm({
  'src/core/paths.ts'() {
    'use strict';
    BV_DIR = '.bv';
  },
});

// src/core/daemon-info.ts
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { readFile as readFile2, writeFile as writeFile3 } from 'fs/promises';
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function tokenMatches(presented, storedHash) {
  const presentedHash = hashToken(presented);
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
async function writeDaemonInfo(info, token, cwd) {
  await writePrivateFile(daemonTokenPath(cwd), token);
  await writePrivateFile(
    daemonInfoPath(cwd),
    `${JSON.stringify(info, null, 2)}
`,
  );
}
async function readDaemonInfo(cwd) {
  try {
    const raw = await readFile2(daemonInfoPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || typeof parsed.tokenHash !== 'string') {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
async function readDaemonToken(cwd) {
  try {
    return (await readFile2(daemonTokenPath(cwd), 'utf8')).trim();
  } catch {
    return void 0;
  }
}
async function clearDaemonInfo(cwd) {
  const { rm } = await import('fs/promises');
  await rm(daemonInfoPath(cwd), { force: true });
  await rm(daemonTokenPath(cwd), { force: true });
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
function daemonBaseUrl(info) {
  return `http://127.0.0.1:${info.port}`;
}
var init_daemon_info = __esm({
  'src/core/daemon-info.ts'() {
    'use strict';
    init_paths();
  },
});

// src/actions/locate.ts
function parseTarget(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  if (/^(?:f\d+)?e\d+$/.test(trimmed)) {
    return { ref: trimmed };
  }
  if (/^[#.[]/.test(trimmed)) {
    return { css: trimmed };
  }
  const descriptor = {};
  const pattern =
    /(role|name|label|text|testid|css)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  let match;
  let matched = false;
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true;
    const key = match[1] ?? '';
    const raw = match[2] ?? '';
    const value = unquote(raw);
    switch (key) {
      case 'role':
        descriptor.role = value;
        break;
      case 'name':
        descriptor.name = value;
        break;
      case 'label':
        descriptor.label = value;
        break;
      case 'text':
        descriptor.text = value;
        break;
      case 'testid':
        descriptor.testId = value;
        break;
      case 'css':
        descriptor.css = value;
        break;
      default:
        break;
    }
  }
  if (matched) return descriptor;
  return { text: trimmed };
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return value;
}
function strategyOrder(target) {
  const order = [];
  if (target.ref !== void 0) order.push('ref');
  if (target.role !== void 0 && target.name !== void 0) order.push('role');
  if (target.label !== void 0) order.push('label');
  if (target.text !== void 0) order.push('text');
  if (target.testId !== void 0) order.push('testid');
  if (target.css !== void 0) order.push('css');
  return order;
}
function locatorFor(page, strategy, target) {
  switch (strategy) {
    case 'ref':
      return target.ref !== void 0 ? page.getByRef(target.ref) : void 0;
    case 'role':
      return target.role !== void 0 && target.name !== void 0
        ? page.getByRole(target.role, {
            name: target.name,
          })
        : void 0;
    case 'label':
      return target.label !== void 0 ? page.getByLabel(target.label) : void 0;
    case 'text':
      return target.text !== void 0 ? page.getByText(target.text) : void 0;
    case 'testid':
      return target.testId !== void 0 ? page.getByTestId(target.testId) : void 0;
    case 'css':
      return target.css !== void 0 ? page.locator(target.css) : void 0;
    case 'fresh-snapshot':
      return void 0;
    default:
      return void 0;
  }
}
async function locate(page, target, options = {}) {
  const attempted = [];
  const failures = [];
  const timeout = options.timeoutMs ?? 1e4;
  for (const strategy of strategyOrder(target)) {
    const locator = locatorFor(page, strategy, target);
    if (locator === void 0) continue;
    attempted.push(strategy);
    try {
      await locator.first().waitFor({ state: 'attached', timeout });
      const count = await locator.count();
      if (count === 1) {
        return { locator, strategy, attempted, failures };
      }
      if (count === 0) {
        failures.push({ strategy, reason: 'no element matched' });
      } else {
        failures.push({ strategy, reason: `matched ${count} elements (ambiguous)` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? (err.message.split('\n')[0] ?? 'unknown error') : String(err);
      failures.push({ strategy, reason: message });
    }
  }
  return { locator: void 0, strategy: void 0, attempted, failures };
}
var init_locate = __esm({
  'src/actions/locate.ts'() {
    'use strict';
  },
});

// src/core/daemon.ts
import { createServer } from 'http';
import { randomBytes as randomBytes2 } from 'crypto';
import { once } from 'events';
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.length;
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function startDaemon(options) {
  const token = options.token ?? randomBytes2(32).toString('hex');
  const tokenHash = hashToken(token);
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const server = createServer((req, res) => {
    void handleRequest(req, res, options, tokenHash, maxBodyBytes);
  });
  await new Promise((resolve5, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve5());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('daemon failed to bind a port');
  }
  const info = {
    version: 1,
    port: address.port,
    pid: options.pid ?? process.pid,
    tokenHash,
    session: options.session ?? 'default',
    startedAt: /* @__PURE__ */ new Date().toISOString(),
    headed: options.headed ?? false,
    browser: options.browser ?? 'chromium',
  };
  return {
    port: address.port,
    token,
    info,
    server,
    close: async () => {
      await new Promise((resolve5) => {
        server.close(() => resolve5());
        server.closeAllConnections?.();
      });
    },
  };
}
async function handleRequest(req, res, options, tokenHash, maxBodyBytes) {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  try {
    const header = req.headers['authorization'];
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(presented, tokenHash)) {
      send(401, { ok: false, error: 'unauthorized: invalid or missing bearer token' });
      return;
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      send(200, { ok: true, data: { version: VERSION, status: 'ok' } });
      return;
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: `method not allowed: ${req.method ?? 'unknown'}` });
      return;
    }
    const raw = await readBody(req, maxBodyBytes);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
      send(400, { ok: false, error: 'missing "method" in request body' });
      return;
    }
    const handler = options.handlers[parsed.method];
    if (handler === void 0) {
      send(404, { ok: false, error: `unknown method: ${parsed.method}` });
      return;
    }
    const result = await handler(parsed);
    send(200, {
      ok: true,
      ...(result.data !== void 0 ? { data: result.data } : {}),
      ...(result.exitCode !== void 0 ? { exitCode: result.exitCode } : {}),
      ...(result.reasons !== void 0 ? { reasons: result.reasons } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(500, { ok: false, error: message });
  }
}
var init_daemon = __esm({
  'src/core/daemon.ts'() {
    'use strict';
    init_daemon_info();
    init_version();
  },
});

// src/core/contexts.ts
var SessionState;
var init_contexts = __esm({
  'src/core/contexts.ts'() {
    'use strict';
    SessionState = class {
      browser;
      context;
      pages = [];
      /** The index of the active page. */
      activeIndex = 0;
      /** Pages that were opened by the page rather than by the user. */
      popupPages = /* @__PURE__ */ new Set();
      constructor(browser) {
        this.browser = browser;
      }
      /** Create the context if it does not exist. */
      async ensureContext(options = {}) {
        if (this.context !== void 0) return this.context;
        const contextOptions = {};
        if (options.userAgent !== void 0) contextOptions.userAgent = options.userAgent;
        this.context = await this.browser.newContext(contextOptions);
        return this.context;
      }
      /** The active page, creating one if needed. */
      async activePage() {
        const context = await this.ensureContext();
        const existing = this.pages[this.activeIndex];
        if (existing !== void 0 && !existing.isClosed()) return existing;
        const page = await context.newPage();
        this.pages.push(page);
        this.activeIndex = this.pages.length - 1;
        return page;
      }
      /** Register a page that Playwright reports as a popup. */
      registerPopup(page) {
        this.popupPages.add(page);
        this.pages.push(page);
      }
      /** Forget closed pages and return the list of live tabs. */
      async tabs() {
        this.pages = this.pages.filter((p) => !p.isClosed());
        if (this.activeIndex >= this.pages.length) {
          this.activeIndex = Math.max(0, this.pages.length - 1);
        }
        const infos = [];
        for (const [index, page] of this.pages.entries()) {
          let url = '';
          let title = '';
          try {
            url = page.url();
            title = await page.title().catch(() => '');
          } catch {}
          infos.push({
            index,
            url,
            title,
            active: index === this.activeIndex,
            popup: this.popupPages.has(page),
          });
        }
        return infos;
      }
      /** Switch to a tab by index. */
      selectTab(index) {
        const page = this.pages[index];
        if (page === void 0) {
          throw new Error(`no tab with index ${index}`);
        }
        this.activeIndex = index;
        return page;
      }
      /** Close a tab by index. */
      async closeTab(index) {
        const page = this.pages[index];
        if (page === void 0) {
          throw new Error(`no tab with index ${index}`);
        }
        await page.close().catch(() => void 0);
        this.pages = this.pages.filter((_, i) => i !== index);
        if (this.activeIndex >= this.pages.length) {
          this.activeIndex = Math.max(0, this.pages.length - 1);
        }
      }
      /** List the frames of the active page. */
      async frames(page) {
        const target = page ?? (await this.activePage());
        return target.frames().map((frame, index) => ({
          url: frame.url(),
          ...(frame.name() !== '' ? { name: frame.name() } : {}),
          isMain: frame === target.mainFrame(),
          index,
        }));
      }
      /** Save the storage state of the context. */
      async storageState() {
        if (this.context === void 0) return null;
        return this.context.storageState();
      }
      /**
       * Restore a storage state into a live context.
       *
       * Playwright can only apply a storage state when *creating* a context, so
       * restoring into a running context is done explicitly:
       *  - cookies via `context.addCookies()`,
       *  - localStorage via an init script that seeds it before any page script
       *    runs.
       *
       * sessionStorage is not restorable: it is per-tab and dies with the tab.
       * This is recorded in docs/KNOWN_LIMITATIONS.md.
       */
      async restoreStorageState(state) {
        if (state === null || state === void 0) return;
        const context = await this.ensureContext();
        if (typeof state !== 'object' || state === null) return;
        const typed = state;
        if (Array.isArray(typed.cookies)) {
          const valid = typed.cookies.filter((c) => typeof c === 'object' && c !== null);
          if (valid.length > 0) {
            await context.addCookies(valid);
          }
        }
        if (Array.isArray(typed.origins)) {
          const seed = typed.origins
            .filter(
              (o) =>
                typeof o === 'object' &&
                o !== null &&
                typeof o.origin === 'string' &&
                Array.isArray(o.localStorage),
            )
            .map((o) => ({
              origin: o.origin,
              localStorage: o.localStorage.filter(
                (e) => typeof e === 'object' && e !== null && typeof e.name === 'string',
              ),
            }))
            .filter((o) => o.localStorage.length > 0);
          if (seed.length > 0) {
            await context.addInitScript((entries) => {
              for (const entry of entries) {
                try {
                  const loc = window.location;
                  if (loc.origin !== entry.origin) continue;
                  for (const item of entry.localStorage) {
                    window.localStorage.setItem(item.name, item.value);
                  }
                } catch {}
              }
            }, seed);
          }
        }
      }
      /** Close everything. */
      async close() {
        await this.context?.close().catch(() => void 0);
        this.context = void 0;
        this.pages = [];
      }
    };
  },
});

// src/perception/snapshot.ts
function normalizeSnapshot(raw) {
  if (!Array.isArray(raw)) return [];
  const roots = [];
  for (const item of raw) {
    const node = normalizeNode(item);
    if (node !== void 0) roots.push(node);
  }
  return roots;
}
function normalizeNode(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return void 0;
  const source = raw;
  const role = typeof source['role'] === 'string' ? source['role'] : void 0;
  if (role === void 0) return void 0;
  const node = { role };
  const name = source['name'];
  if (typeof name === 'string') node.name = name;
  const text = source['text'];
  if (typeof text === 'string') node.text = text;
  const ref = source['ref'];
  if (typeof ref === 'string') node.ref = ref;
  const level = source['level'];
  if (typeof level === 'number') node.level = level;
  for (const flag of ['checked', 'expanded', 'selected', 'pressed', 'disabled']) {
    const value = source[flag];
    if (typeof value === 'boolean') node[flag] = value;
  }
  const cursor = source['cursor'];
  if (typeof cursor === 'string') node.cursor = cursor === 'pointer';
  const children = source['children'];
  if (Array.isArray(children)) {
    const normalizedChildren = [];
    for (const child of children) {
      const normalized = normalizeNode(child);
      if (normalized !== void 0) normalizedChildren.push(normalized);
    }
    if (normalizedChildren.length > 0) node.children = normalizedChildren;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key in node) continue;
    if (value === null || value === void 0) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      node[key] = value;
    }
  }
  return node;
}
function countNodes(roots) {
  let total = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      total += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return total;
}
function walkNodes(roots, visit) {
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      visit(node, parent);
      if (node.children) walk(node.children, node);
    }
  };
  walk(roots, void 0);
}
function nodeIdentity(node) {
  const parts = [node.role];
  if (node.name !== void 0) parts.push(`name=${node.name}`);
  if (node.ref !== void 0) parts.push(`ref=${node.ref}`);
  return parts.join('|');
}
function nodeLooseIdentity(node) {
  const parts = [node.role];
  if (node.name !== void 0) parts.push(`name=${node.name}`);
  else if (node.text !== void 0) parts.push(`text=${node.text}`);
  return parts.join('|');
}
var init_snapshot = __esm({
  'src/perception/snapshot.ts'() {
    'use strict';
  },
});

// src/perception/diff.ts
function indexNodes(roots) {
  const index = /* @__PURE__ */ new Map();
  walkNodes(roots, (node) => {
    const key = nodeIdentity(node);
    if (!index.has(key)) index.set(key, node);
  });
  return index;
}
function indexLoose(roots) {
  const index = /* @__PURE__ */ new Map();
  walkNodes(roots, (node) => {
    const key = nodeLooseIdentity(node);
    const list = index.get(key);
    if (list === void 0) {
      index.set(key, [node]);
    } else {
      list.push(node);
    }
  });
  return index;
}
function computeDepths(roots) {
  const depths = /* @__PURE__ */ new Map();
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      depths.set(nodeIdentity(node), depth);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return depths;
}
function diffSnapshots(previous, current) {
  const previousIndex = previous ? indexNodes(previous.roots) : /* @__PURE__ */ new Map();
  const currentIndex = indexNodes(current.roots);
  const depths = computeDepths(current.roots);
  const changes = [];
  const navigated = previous !== void 0 && previous.documentToken !== current.documentToken;
  const previousLoose = previous ? indexLoose(previous.roots) : /* @__PURE__ */ new Map();
  const pairedPrevious = /* @__PURE__ */ new Set();
  const pairedCurrent = /* @__PURE__ */ new Set();
  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== void 0) {
      pairedPrevious.add(previousNode);
      pairedCurrent.add(currentNode);
      continue;
    }
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const free = candidates.find((c) => !pairedPrevious.has(c));
    if (free !== void 0) {
      pairedPrevious.add(free);
      pairedCurrent.add(currentNode);
    }
  }
  for (const [key, node] of currentIndex) {
    if (pairedCurrent.has(node)) continue;
    const change = {
      kind: 'added',
      role: node.role,
      depth: depths.get(key) ?? 0,
    };
    if (node.ref !== void 0) change.ref = node.ref;
    if (node.name !== void 0) change.name = node.name;
    if (node.text !== void 0) change.text = node.text;
    changes.push(change);
  }
  for (const node of previousIndex.values()) {
    if (pairedPrevious.has(node)) continue;
    const change = {
      kind: 'removed',
      role: node.role,
      depth: 0,
    };
    if (node.ref !== void 0) change.ref = node.ref;
    if (node.name !== void 0) change.name = node.name;
    if (node.text !== void 0) change.text = node.text;
    changes.push(change);
  }
  for (const [key, currentNode] of currentIndex) {
    const previousNode = previousIndex.get(key);
    if (previousNode !== void 0) {
      reportTextChange(previousNode, currentNode, depths, changes);
      reportNameChange(previousNode, currentNode, depths, changes);
      reportStateChanges(previousNode, currentNode, depths, changes);
      continue;
    }
    const candidates = previousLoose.get(nodeLooseIdentity(currentNode)) ?? [];
    const looseMatch = candidates.find(
      (c) => !changes.some((ch) => ch.ref === c.ref && ch.kind === 'removed'),
    );
    if (looseMatch === void 0) continue;
    reportTextChange(looseMatch, currentNode, depths, changes);
    reportNameChange(looseMatch, currentNode, depths, changes);
    reportStateChanges(looseMatch, currentNode, depths, changes);
    if (looseMatch.ref !== currentNode.ref) {
      changes.push({
        kind: 'changed',
        role: currentNode.role,
        field: 'ref',
        before: looseMatch.ref ?? '',
        after: currentNode.ref ?? '',
        depth: depths.get(key) ?? 0,
        ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
        ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
      });
    }
  }
  changes.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const order = { added: 0, changed: 1, removed: 2 };
    return order[a.kind] - order[b.kind];
  });
  let interactive = 0;
  let frames = 0;
  walkNodes(current.roots, (node) => {
    if (INTERACTIVE_ROLES.has(node.role)) interactive += 1;
    if (node.role === 'iframe') frames += 1;
  });
  return {
    header: {
      url: current.url,
      title: current.title,
      nodes: currentIndex.size,
      interactive,
      changes: changes.length,
      frames,
    },
    changes,
    navigated,
  };
}
function reportTextChange(previousNode, currentNode, depths, changes) {
  if (previousNode.text === currentNode.text) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'text',
    before: previousNode.text ?? '',
    after: currentNode.text ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
    ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
  });
}
function reportNameChange(previousNode, currentNode, depths, changes) {
  if (previousNode.name === currentNode.name) return;
  changes.push({
    kind: 'changed',
    role: currentNode.role,
    field: 'name',
    before: previousNode.name ?? '',
    after: currentNode.name ?? '',
    depth: depths.get(nodeIdentity(currentNode)) ?? 0,
    ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
  });
}
function reportStateChanges(previousNode, currentNode, depths, changes) {
  for (const flag of STATE_FLAGS) {
    const before = previousNode[flag];
    const after = currentNode[flag];
    if (before === after) continue;
    changes.push({
      kind: 'changed',
      role: currentNode.role,
      field: 'state',
      state: { key: flag, before, after },
      depth: depths.get(nodeIdentity(currentNode)) ?? 0,
      ...(currentNode.ref !== void 0 ? { ref: currentNode.ref } : {}),
      ...(currentNode.name !== void 0 ? { name: currentNode.name } : {}),
    });
  }
}
var INTERACTIVE_ROLES, STATE_FLAGS;
var init_diff = __esm({
  'src/perception/diff.ts'() {
    'use strict';
    init_snapshot();
    INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
      'button',
      'checkbox',
      'combobox',
      'link',
      'menuitem',
      'option',
      'radio',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
    ]);
    STATE_FLAGS = ['checked', 'expanded', 'selected', 'pressed', 'disabled'];
  },
});

// src/perception/prune.ts
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\u2026 [${text.length - maxLength} more chars]`;
}
function collapseSimilarSiblings(children, maxSimilar) {
  const result = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index];
    if (node === void 0) break;
    const collapsible =
      node.children === void 0 &&
      node.role !== 'heading' &&
      (node.name !== void 0 || node.text !== void 0);
    if (!collapsible) {
      result.push(node);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < children.length) {
      const candidate = children[end];
      if (candidate === void 0) break;
      if (
        candidate.role !== node.role ||
        candidate.name !== node.name ||
        candidate.text !== node.text ||
        candidate.children !== void 0
      ) {
        break;
      }
      end += 1;
    }
    const runLength = end - index;
    if (runLength <= maxSimilar) {
      for (let i = index; i < end; i++) {
        const item = children[i];
        if (item !== void 0) result.push(item);
      }
    } else {
      const keep = maxSimilar;
      for (let i = 0; i < keep; i++) {
        const item = children[index + i];
        if (item !== void 0) result.push(item);
      }
      result.push({
        role: 'note',
        text: `\u2026 +${runLength - keep} similar items`,
      });
    }
    index = end;
  }
  return result;
}
function dropDecorative(node) {
  if (!DECORATIVE_ROLES.has(node.role)) return node;
  if (node.children === void 0 || node.children.length === 0) {
    const hasText = node.text !== void 0 && node.text.trim().length > 0;
    const hasName = node.name !== void 0 && node.name.trim().length > 0;
    if (!hasText && !hasName) return void 0;
    return node;
  }
  const kept = node.children.map((c) => dropDecorative(c)).filter((c) => c !== void 0);
  if (kept.length === 0) return void 0;
  if (kept.length === 1 && node.name === void 0 && node.text === void 0) {
    return kept[0];
  }
  return { ...node, children: kept };
}
function pruneSnapshot(roots, options = {}) {
  const maxTextLength = options.maxTextLength ?? 120;
  const maxSimilar = options.maxSimilarSiblings ?? 3;
  const charsPerToken = options.charsPerToken ?? 4;
  const before = countNodes(roots);
  const pruneNode = (node) => {
    const kept = dropDecorative(node);
    if (kept === void 0) return void 0;
    const next = { ...kept };
    if (next.text !== void 0) {
      next.text = truncateText(next.text, maxTextLength);
    }
    if (next.name !== void 0 && next.name.length > maxTextLength * 2) {
      next.name = truncateText(next.name, maxTextLength * 2);
    }
    if (next.children !== void 0) {
      const prunedChildren = next.children.map((c) => pruneNode(c)).filter((c) => c !== void 0);
      const collapsed = collapseSimilarSiblings(prunedChildren, maxSimilar);
      if (collapsed.length > 0) {
        next.children = collapsed;
      } else {
        delete next.children;
      }
    }
    return next;
  };
  const prunedRoots = roots.map((r) => pruneNode(r)).filter((r) => r !== void 0);
  let budgetApplied = false;
  const maxTokens = options.maxTokens;
  if (maxTokens !== void 0 && maxTokens > 0) {
    let estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    while (estimate > maxTokens && prunedRoots.length > 0) {
      const removed = removeLeastValuable(prunedRoots);
      if (!removed) break;
      budgetApplied = true;
      estimate = estimateTreeTokens(prunedRoots, charsPerToken);
    }
  }
  return { roots: prunedRoots, before, after: countNodes(prunedRoots), budgetApplied };
}
function estimateTreeTokens(roots, charsPerToken = 4) {
  let chars = 0;
  walkNodes(roots, (node) => {
    chars += node.role.length;
    if (node.name !== void 0) chars += node.name.length + 6;
    if (node.text !== void 0) chars += node.text.length + 6;
    if (node.ref !== void 0) chars += node.ref.length + 6;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'role' || key === 'name' || key === 'text' || key === 'ref') continue;
      if (key === 'children') continue;
      if (typeof value === 'boolean') chars += key.length + 4;
    }
  });
  return Math.ceil(chars / charsPerToken);
}
function removeLeastValuable(roots) {
  let target;
  let deepest = -1;
  const search = (nodes, depth, parent2) => {
    nodes.forEach((node, index2) => {
      if (node.children) {
        search(node.children, depth + 1, node);
      }
      const meaningful = node.ref !== void 0 || node.name !== void 0 || node.text !== void 0;
      if (!meaningful && parent2 !== void 0 && depth > deepest) {
        deepest = depth;
        target = { parent: parent2, index: index2, depth };
      }
    });
  };
  search(roots, 0);
  if (target === void 0) {
    let leaf;
    const findLeaf = (nodes, depth, parent3) => {
      nodes.forEach((node, index3) => {
        if (node.children && node.children.length > 0) {
          findLeaf(node.children, depth + 1, node);
        } else if (parent3 !== void 0 && depth > deepest) {
          deepest = depth;
          leaf = { parent: parent3, index: index3, depth };
        }
      });
    };
    findLeaf(roots, 0);
    if (leaf === void 0) return false;
    const { parent: parent2, index: index2 } = leaf;
    parent2.children?.splice(index2, 1);
    if (parent2.children?.length === 0) delete parent2.children;
    return true;
  }
  const { parent, index } = target;
  parent.children?.splice(index, 1);
  if (parent.children?.length === 0) delete parent.children;
  return true;
}
var DECORATIVE_ROLES;
var init_prune = __esm({
  'src/perception/prune.ts'() {
    'use strict';
    init_snapshot();
    DECORATIVE_ROLES = /* @__PURE__ */ new Set(['generic', 'none', 'presentation']);
  },
});

// src/perception/render.ts
function renderHeader(header, notes = [], options = {}) {
  const parts = [];
  if (options.previousUrl === void 0 || options.previousUrl !== header.url) {
    parts.push(`url=${header.url}`);
  }
  parts.push(`title=${truncate(header.title, 50)}`);
  if (header.frames > 0) parts.push(`frames=${header.frames}`);
  if (header.changes > 0) parts.push(`changes=${header.changes}`);
  if (notes.length > 0) parts.push(notes.join(' '));
  return parts.join(' | ');
}
function renderChange(change) {
  const indent = '  '.repeat(Math.min(change.depth, 6));
  const ref = change.ref !== void 0 ? `[${change.ref}]` : '';
  switch (change.kind) {
    case 'added': {
      const label = change.name ?? change.text ?? '';
      return `${indent}+ ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'removed': {
      const label = change.name ?? change.text ?? '';
      return `${indent}- ${change.role}${ref} ${label}`.trimEnd();
    }
    case 'changed': {
      if (change.field === 'text') {
        return `${indent}~ ${change.role}${ref} text: ${truncate(
          change.before ?? '',
          50,
        )} \u2192 ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'name') {
        return `${indent}~ ${change.role}${ref} name: ${truncate(
          change.before ?? '',
          50,
        )} \u2192 ${truncate(change.after ?? '', 50)}`;
      }
      if (change.field === 'state' && change.state !== void 0) {
        return `${indent}~ ${change.role}${ref} ${change.state.key}: ${String(
          change.state.before,
        )} \u2192 ${String(change.state.after)}`;
      }
      if (change.field === 'ref') {
        return `${indent}~ ${change.role} ref: ${change.before} \u2192 ${change.after}`;
      }
      return `${indent}~ ${change.role}${ref} changed`;
    }
    default:
      return `${indent}? ${change.role}${ref}`;
  }
}
function renderDiff(diff, options = {}) {
  const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const lines = [renderHeader(diff.header, options.notes, options)];
  if (diff.navigated) {
    lines.push('(page navigated: all previous refs are invalid)');
  }
  if (diff.changes.length === 0) {
    lines.push('(no changes)');
    return lines.join('\n');
  }
  const shown = diff.changes.slice(0, maxChanges);
  for (const change of shown) {
    lines.push(renderChange(change));
  }
  if (diff.changes.length > shown.length) {
    lines.push(`\u2026 ${diff.changes.length - shown.length} more changes`);
  }
  return lines.join('\n');
}
function renderTree(roots, options = {}) {
  const maxLineLength = options.maxLineLength ?? 160;
  const lines = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const indent = '  '.repeat(Math.min(depth, 12));
      const ref = node.ref !== void 0 ? `[${node.ref}]` : '';
      const label = node.name ?? node.text ?? '';
      const state = describeState(node);
      let line = `${indent}${node.role}${ref}${state}`;
      if (label !== '') line += ` ${label}`;
      lines.push(truncate(line, maxLineLength));
      if (node.children !== void 0) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return lines.join('\n');
}
function describeState(node) {
  const parts = [];
  if (node.checked === true) parts.push('checked');
  if (node.expanded === true) parts.push('expanded');
  if (node.selected === true) parts.push('selected');
  if (node.pressed === true) parts.push('pressed');
  if (node.disabled === true) parts.push('disabled');
  if (node.level !== void 0) parts.push(`h${node.level}`);
  return parts.length > 0 ? ` (${parts.join(',')})` : '';
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\u2026`;
}
var DEFAULT_MAX_CHANGES;
var init_render = __esm({
  'src/perception/render.ts'() {
    'use strict';
    DEFAULT_MAX_CHANGES = 40;
  },
});

// src/actions/waits.ts
async function waitForCondition(locator, condition, options = {}) {
  const timeout = options.timeoutMs ?? 1e4;
  const started = Date.now();
  try {
    switch (condition) {
      case 'attached':
        await locator.waitFor({ state: 'attached', timeout });
        break;
      case 'detached':
        await locator.waitFor({ state: 'detached', timeout });
        break;
      case 'visible':
        await locator.waitFor({ state: 'visible', timeout });
        break;
      case 'hidden':
        await locator.waitFor({ state: 'hidden', timeout });
        break;
      case 'stable':
        await waitForStable(locator, timeout);
        break;
      case 'enabled':
        await waitForEnabled(locator, timeout);
        break;
      case 'disabled':
        await waitForDisabled(locator, timeout);
        break;
      case 'checked':
        await waitForChecked(locator, timeout);
        break;
      case 'receives-events':
        await waitForReceivesEvents(locator, timeout);
        break;
      default:
        return {
          satisfied: false,
          condition,
          durationMs: Date.now() - started,
          reason: `unknown wait condition: ${String(condition)}`,
        };
    }
    return { satisfied: true, condition, durationMs: Date.now() - started };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'timed out') : String(err);
    return {
      satisfied: false,
      condition,
      durationMs: Date.now() - started,
      reason: message,
    };
  }
}
async function waitForStable(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const first = await locator.boundingBox();
    await evaluateFrames(locator, 2);
    const second = await locator.boundingBox();
    if (first !== null && second !== null && sameBox(first, second)) {
      await evaluateFrames(locator, 2);
      const third = await locator.boundingBox();
      if (third !== null && sameBox(second, third)) return;
    }
  }
  throw new Error(`element did not become stable within ${timeout}ms`);
}
function sameBox(a, b) {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
async function evaluateFrames(locator, frames) {
  await locator.evaluate(async (element, count) => {
    const ownerDocument = element.ownerDocument;
    const view = ownerDocument.defaultView;
    if (view === null) return;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve5) => {
        view.requestAnimationFrame(() => resolve5());
      });
    }
  }, frames);
}
async function waitForEnabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become enabled within ${timeout}ms`);
}
async function waitForDisabled(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isDisabled().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become disabled within ${timeout}ms`);
}
async function waitForChecked(locator, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isChecked().catch(() => false)) return;
    await delay(50);
  }
  throw new Error(`element did not become checked within ${timeout}ms`);
}
async function waitForReceivesEvents(locator, timeout) {
  const deadline = Date.now() + timeout;
  let lastReason = 'unknown';
  while (Date.now() < deadline) {
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { ok: false, reason: 'element has no size' };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topElement = element.ownerDocument.elementFromPoint(x, y);
      if (topElement === null) {
        return { ok: false, reason: 'no element at the centre point' };
      }
      if (element === topElement || element.contains(topElement)) {
        return { ok: true, reason: '' };
      }
      return {
        ok: false,
        reason: `covered by <${topElement.tagName.toLowerCase()}>`,
      };
    });
    if (result.ok) return;
    lastReason = result.reason;
    await delay(50);
  }
  throw new Error(`element did not receive events within ${timeout}ms: ${lastReason}`);
}
function delay(ms) {
  return new Promise((resolve5) => setTimeout(resolve5, ms));
}
var init_waits = __esm({
  'src/actions/waits.ts'() {
    'use strict';
  },
});

// src/actions/act.ts
async function performAction(page, request, options = {}) {
  const timeout = options.timeoutMs ?? request.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const started = Date.now();
  const urlBefore = page.url();
  const located = await locate(page, request.target, { timeoutMs: timeout });
  const base = {
    ok: false,
    kind: request.kind,
    strategy: located.strategy,
    attempted: located.attempted,
    failures: located.failures,
    message: '',
    durationMs: 0,
    urlBefore,
    urlAfter: urlBefore,
    titleAfter: '',
  };
  if (located.locator === void 0) {
    const detail = located.failures.map((f) => `${f.strategy}: ${f.reason}`).join('; ');
    return {
      ...base,
      message: `could not locate the target (${detail || 'no strategies available'})`,
      durationMs: Date.now() - started,
    };
  }
  try {
    const message = await execute(page, located.locator, request, timeout);
    return {
      ...base,
      ok: true,
      message,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  } catch (err) {
    const message =
      err instanceof Error ? (err.message.split('\n')[0] ?? 'action failed') : String(err);
    return {
      ...base,
      message: `action failed: ${message}`,
      durationMs: Date.now() - started,
      urlAfter: page.url(),
      titleAfter: await page.title().catch(() => ''),
    };
  }
}
async function scrollIntoClearView(locator, timeout) {
  await locator
    .evaluate((element) => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => void 0);
  const deadline = Date.now() + Math.min(timeout, 5e3);
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    const cover = await locator
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topElement = element.ownerDocument.elementFromPoint(x, y);
        if (topElement === null) return null;
        if (element === topElement || element.contains(topElement)) return null;
        const coverRect = topElement.getBoundingClientRect();
        return { bottom: coverRect.bottom, top: coverRect.top };
      })
      .catch(() => null);
    if (cover === null) {
      await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5e3) });
      return;
    }
    const delta = await locator.evaluate((element, coverBottom) => {
      const rect = element.getBoundingClientRect();
      const needed = coverBottom - rect.top + 4;
      if (needed <= 0) return 0;
      const before = window.scrollY;
      window.scrollBy(0, -needed);
      return window.scrollY - before;
    }, cover.bottom);
    if (delta === 0) {
      break;
    }
  }
  await waitForCondition(locator, 'stable', { timeoutMs: Math.min(timeout, 5e3) });
}
async function execute(page, locator, request, timeout) {
  const options = { timeout, ...(request.force === true ? { force: true } : {}) };
  switch (request.kind) {
    case 'click':
      await scrollIntoClearView(locator, timeout);
      await locator.click(options);
      return 'clicked';
    case 'dblclick':
      await scrollIntoClearView(locator, timeout);
      await locator.dblclick(options);
      return 'double-clicked';
    case 'hover':
      await scrollIntoClearView(locator, timeout);
      await locator.hover(options);
      return 'hovered';
    case 'type':
      await scrollIntoClearView(locator, timeout);
      await locator.click({ timeout }).catch(() => void 0);
      await locator.pressSequentially(request.value ?? '', {
        timeout,
        delay: 20,
      });
      return 'typed';
    case 'fill':
      await scrollIntoClearView(locator, timeout);
      await locator.fill(request.value ?? '', options);
      return 'filled';
    case 'select':
      await scrollIntoClearView(locator, timeout);
      await locator.selectOption(request.value ?? '', { timeout });
      return 'selected';
    case 'check':
      await scrollIntoClearView(locator, timeout);
      await locator.check(options);
      return 'checked';
    case 'uncheck':
      await scrollIntoClearView(locator, timeout);
      await locator.uncheck(options);
      return 'unchecked';
    case 'press':
      await locator.press(request.value ?? 'Enter', { timeout });
      return `pressed ${request.value ?? 'Enter'}`;
    case 'scroll':
      await scrollIntoClearView(locator, timeout);
      return 'scrolled into view';
    case 'upload':
      await locator.setInputFiles(request.value ?? '', { timeout });
      return 'uploaded';
    case 'focus':
      await locator.focus({ timeout });
      return 'focused';
    default: {
      const exhaustive = request.kind;
      throw new Error(`unsupported action kind: ${String(exhaustive)}`);
    }
  }
}
var DEFAULT_ACTION_TIMEOUT_MS;
var init_act = __esm({
  'src/actions/act.ts'() {
    'use strict';
    init_locate();
    init_waits();
    DEFAULT_ACTION_TIMEOUT_MS = 1e4;
  },
});

// src/core/session.ts
import { chromium } from 'playwright';
function countAll(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countAll(node.children);
  }
  return total;
}
function buildUserAgent(contact) {
  const suffix = contact !== void 0 && contact.length > 0 ? ` (+${contact})` : '';
  return `BrowserVerified/${VERSION}${suffix}`;
}
var BrowserSession;
var init_session = __esm({
  'src/core/session.ts'() {
    'use strict';
    init_contexts();
    init_snapshot();
    init_diff();
    init_prune();
    init_render();
    init_act();
    init_version();
    BrowserSession = class {
      store;
      userAgent;
      headed;
      browser;
      state;
      lastSnapshot;
      stepCounter = 0;
      consoleMessages = [];
      pageErrors = [];
      failedRequests = [];
      actionTimeoutMs;
      onClose;
      constructor(options) {
        this.store = options.store;
        this.userAgent = options.userAgent;
        this.headed = options.headed;
        this.actionTimeoutMs = options.actionTimeoutMs ?? 1e4;
        this.onClose = options.onClose;
        this.browser = void 0;
        this.state = void 0;
      }
      /** Launch the browser. */
      async launch() {
        if (this.browser !== void 0) return;
        const launcher = chromium;
        this.browser = await launcher.launch({ headless: !this.headed });
        this.state = new SessionState(this.browser);
      }
      /** The Playwright browser. */
      get browserInstance() {
        if (this.browser === void 0) throw new Error('the session browser is not running');
        return this.browser;
      }
      /** The session's context and page state. */
      get sessionState() {
        if (this.state === void 0) throw new Error('the session browser is not running');
        return this.state;
      }
      /** The active page. */
      async page() {
        if (this.state === void 0) await this.launch();
        await this.sessionState.ensureContext({ userAgent: this.userAgent });
        const page = await this.sessionState.activePage();
        this.attachListeners(page);
        return page;
      }
      /** Attach console/error/request listeners to a page. */
      attachListeners(page) {
        const marker = /* @__PURE__ */ Symbol.for('bv.listeners');
        const marked = page;
        if (marked[marker] === true) return;
        marked[marker] = true;
        page.on('console', (message) => {
          this.consoleMessages.push({
            type: message.type(),
            text: message.text(),
            timestamp: Date.now(),
          });
        });
        page.on('pageerror', (error) => {
          this.pageErrors.push(error.message);
        });
        page.on('requestfailed', (request) => {
          this.failedRequests.push(
            `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`,
          );
        });
        page.on('popup', (popup) => {
          this.sessionState.registerPopup(popup);
          this.attachListeners(popup);
        });
      }
      /** The next step number. */
      nextStep() {
        this.stepCounter += 1;
        return this.stepCounter;
      }
      /**
       * Capture a snapshot of the active page.
       *
       * The full tree is written to the run store; the returned object carries
       * both the full and pruned trees so the caller can render either.
       */
      async capture(options = {}) {
        const page = await this.page();
        const raw = await page.ariaSnapshotJSON({ mode: 'ai' });
        const tree = normalizeSnapshot(raw);
        const url = page.url();
        const title = await page.title().catch(() => '');
        const documentToken = await this.documentToken(page);
        const snapshot = {
          roots: tree,
          url,
          title,
          nodeCount: countAll(tree),
          prunedCount: 0,
          capturedAt: /* @__PURE__ */ new Date().toISOString(),
          documentToken,
        };
        const pruned = pruneSnapshot(tree, {
          ...(options.maxTokens !== void 0 ? { maxTokens: options.maxTokens } : {}),
        });
        snapshot.prunedCount = pruned.after;
        const diff = diffSnapshots(this.lastSnapshot, {
          roots: pruned.roots,
          url,
          title,
          documentToken,
        });
        const step = this.nextStep();
        const path = await this.store.writeSnapshot(step, renderTree(pruned.roots));
        const previousUrl = this.lastSnapshot?.url;
        this.lastSnapshot = { roots: pruned.roots, documentToken, url };
        return {
          tree,
          pruned: pruned.roots,
          snapshot,
          path,
          estimatedTokens: estimateTreeTokens(pruned.roots),
          diff,
          ...(previousUrl !== void 0 ? { previousUrl } : {}),
        };
      }
      /**
       * A document token that changes whenever the document is replaced.
       *
       * Playwright's refs are invalidated by a navigation; this token lets the
       * perception layer detect that and report it instead of silently reusing
       * stale refs.
       */
      async documentToken(page) {
        try {
          const token = await page.evaluate(() => {
            const w = window;
            if (typeof w.__bvDocToken !== 'string') {
              w.__bvDocToken = Math.random().toString(36).slice(2);
            }
            return w.__bvDocToken;
          });
          return token;
        } catch {
          return 'unknown';
        }
      }
      /**
       * Perform an action and record it.
       */
      async act(request) {
        const page = await this.page();
        const consoleBefore = this.consoleMessages.length;
        const errorsBefore = this.pageErrors.length;
        const outcome = await performAction(page, request, { timeoutMs: this.actionTimeoutMs });
        const step = this.nextStep();
        const record = {
          step,
          action: request.kind,
          durationMs: outcome.durationMs,
          urlBefore: outcome.urlBefore,
          urlAfter: outcome.urlAfter,
          ok: outcome.ok,
          timestamp: /* @__PURE__ */ new Date().toISOString(),
          ...(request.target.name !== void 0
            ? { target: request.target.name }
            : request.target.text !== void 0
              ? { target: request.target.text }
              : request.target.ref !== void 0
                ? { target: request.target.ref }
                : request.target.testId !== void 0
                  ? { target: request.target.testId }
                  : request.target.label !== void 0
                    ? { target: request.target.label }
                    : request.target.css !== void 0
                      ? { target: request.target.css }
                      : {}),
          ...(outcome.strategy !== void 0 ? { strategy: outcome.strategy } : {}),
          ...(outcome.message !== '' ? { message: outcome.message } : {}),
        };
        const capture = await this.capture();
        record.snapshotPath = capture.path;
        const newConsoleErrors = this.consoleMessages
          .slice(consoleBefore)
          .filter((m) => m.type === 'error')
          .map((m) => m.text);
        const newPageErrors = this.pageErrors.slice(errorsBefore);
        record.consoleErrors = [...newConsoleErrors, ...newPageErrors];
        await this.store.recordStep(record);
        return {
          ...outcome,
          step: record,
          diff: renderDiff(capture.diff, {
            ...(capture.previousUrl !== void 0 ? { previousUrl: capture.previousUrl } : {}),
          }),
        };
      }
      /** Navigate the active page. */
      async goto(url) {
        const page = await this.page();
        try {
          await page.goto(url, { timeout: 3e4, waitUntil: 'domcontentloaded' });
          const step = this.nextStep();
          await this.store.recordStep({
            step,
            action: 'goto',
            target: url,
            durationMs: 0,
            urlBefore: page.url(),
            urlAfter: page.url(),
            ok: true,
            timestamp: /* @__PURE__ */ new Date().toISOString(),
            message: `navigated to ${url}`,
          });
          return { ok: true, url: page.url(), message: `navigated to ${url}` };
        } catch (err) {
          const message =
            err instanceof Error
              ? (err.message.split('\n')[0] ?? 'navigation failed')
              : String(err);
          return { ok: false, url: page.url(), message: `navigation failed: ${message}` };
        }
      }
      /** The console errors seen since the last call. */
      drainConsoleErrors() {
        const errors = this.consoleMessages.filter((m) => m.type === 'error').map((m) => m.text);
        this.consoleMessages = [];
        this.pageErrors = [];
        this.failedRequests = [];
        return errors;
      }
      /** The failed requests seen since the last call. */
      drainFailedRequests() {
        const failed = [...this.failedRequests];
        this.failedRequests = [];
        return failed;
      }
      /** The list of tabs. */
      async tabs() {
        return this.sessionState.tabs();
      }
      /** The current storage state. */
      async storageState() {
        return this.sessionState.storageState();
      }
      /** Close the session. */
      async close() {
        if (this.state !== void 0) {
          await this.state.close().catch(() => void 0);
        }
        await this.browser?.close().catch(() => void 0);
        this.browser = void 0;
        this.state = void 0;
        this.onClose?.();
      }
      /** The user agent the session applies. */
      get ua() {
        return this.userAgent;
      }
      /** The browser name. */
      get browserName() {
        return 'chromium';
      }
    };
  },
});

// src/core/runstore/store.ts
import {
  appendFile,
  mkdir as mkdir3,
  readFile as readFile3,
  writeFile as writeFile4,
} from 'fs/promises';
import { join as join4 } from 'path';
import { randomUUID } from 'crypto';
function newRunId(now = /* @__PURE__ */ new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
var RunStore;
var init_store = __esm({
  'src/core/runstore/store.ts'() {
    'use strict';
    init_paths();
    RunStore = class {
      runId;
      cwd;
      startedAt;
      constructor(runId, cwd, startedAt = /* @__PURE__ */ new Date().toISOString()) {
        this.runId = runId;
        this.cwd = cwd;
        this.startedAt = startedAt;
      }
      /** The root directory of the run. */
      get dir() {
        return runDir(this.runId, this.cwd);
      }
      /** Create the run's directories. */
      async init() {
        await mkdir3(join4(this.dir, 'steps'), { recursive: true });
      }
      /** Append a line to the audit log. */
      async audit(record) {
        await mkdir3(this.dir, { recursive: true });
        const line = `${JSON.stringify({ ts: /* @__PURE__ */ new Date().toISOString(), ...record })}
`;
        await appendFile(auditPath(this.runId, this.cwd), line, 'utf8');
      }
      /** Read the audit log. */
      async readAudit() {
        try {
          const raw = await readFile3(auditPath(this.runId, this.cwd), 'utf8');
          return raw
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
        } catch {
          return [];
        }
      }
      /** Write the full snapshot text for a step. */
      async writeSnapshot(step, text) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir3(dir, { recursive: true });
        const path = join4(dir, 'aria.txt');
        await writeFile4(path, text, 'utf8');
        return path;
      }
      /** Write the screenshot for a step. */
      async writeScreenshot(step, data) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir3(dir, { recursive: true });
        const path = join4(dir, 'screenshot.png');
        await writeFile4(path, data);
        return path;
      }
      /** Write the state snapshot for a step. */
      async writeState(step, state) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir3(dir, { recursive: true });
        const path = join4(dir, 'state.json');
        await writeFile4(
          path,
          `${JSON.stringify(state, null, 2)}
`,
          'utf8',
        );
        return path;
      }
      /** Write the network slice for a step. */
      async writeNetwork(step, network) {
        const dir = stepDir(this.runId, step, this.cwd);
        await mkdir3(dir, { recursive: true });
        const path = join4(dir, 'net.json');
        await writeFile4(
          path,
          `${JSON.stringify(network, null, 2)}
`,
          'utf8',
        );
        return path;
      }
      /** Write a step record to the audit log and return it. */
      async recordStep(record) {
        await this.audit({ type: 'step', ...record });
      }
      /** Write the final result. */
      async writeResult(result) {
        await mkdir3(this.dir, { recursive: true });
        await writeFile4(
          join4(this.dir, 'result.json'),
          `${JSON.stringify(result, null, 2)}
`,
          'utf8',
        );
      }
      /** Read the final result. */
      async readResult() {
        try {
          const raw = await readFile3(join4(this.dir, 'result.json'), 'utf8');
          return JSON.parse(raw);
        } catch {
          return void 0;
        }
      }
      /** The run's start time. */
      get started() {
        return this.startedAt;
      }
    };
  },
});

// src/core/daemon-process.ts
var daemon_process_exports = {};
__export(daemon_process_exports, {
  runDaemonProcess: () => runDaemonProcess,
});
async function runDaemonProcess(options) {
  await ensureBvDir(options.cwd);
  const runId = options.runId ?? newRunId();
  const store = new RunStore(runId, options.cwd);
  await store.init();
  const userAgent = buildUserAgent(options.contactUrl);
  let session;
  const getSession = async () => {
    if (session === void 0) {
      session = new BrowserSession({
        store,
        userAgent,
        headed: options.headed,
      });
      await session.launch();
    }
    return session;
  };
  const handlers = {
    snapshot: async (request) => {
      const s = await getSession();
      const params = request.params ?? {};
      const maxTokens = typeof params['maxTokens'] === 'number' ? params['maxTokens'] : void 0;
      const full = params['full'] === true;
      const capture = await s.capture({
        full,
        ...(maxTokens !== void 0 ? { maxTokens } : {}),
      });
      return {
        data: {
          header: capture.diff.header,
          diff: renderDiff(capture.diff, {
            ...(capture.previousUrl !== void 0 ? { previousUrl: capture.previousUrl } : {}),
          }),
          tree: full ? renderTree(capture.pruned) : void 0,
          snapshotPath: capture.path,
          estimatedTokens: capture.estimatedTokens,
          nodeCount: capture.snapshot.nodeCount,
          prunedCount: capture.snapshot.prunedCount,
          navigated: capture.diff.navigated,
        },
      };
    },
    act: async (request) => {
      const s = await getSession();
      const params = request.params ?? {};
      const kind = params['kind'];
      if (typeof kind !== 'string' || !ACTION_KINDS2.includes(kind)) {
        return {
          data: { error: `unknown action kind: ${String(kind)}` },
          exitCode: EXIT.USAGE,
        };
      }
      const targetInput = params['target'];
      const target =
        typeof targetInput === 'object' && targetInput !== null
          ? targetInput
          : parseTarget(typeof targetInput === 'string' ? targetInput : '');
      const value = typeof params['value'] === 'string' ? params['value'] : void 0;
      const outcome = await s.act({
        kind,
        target,
        ...(value !== void 0 ? { value } : {}),
        ...(params['force'] === true ? { force: true } : {}),
      });
      return {
        data: {
          ok: outcome.ok,
          kind: outcome.kind,
          strategy: outcome.strategy,
          attempted: outcome.attempted,
          failures: outcome.failures,
          message: outcome.message,
          durationMs: outcome.durationMs,
          urlBefore: outcome.urlBefore,
          urlAfter: outcome.urlAfter,
          diff: outcome.diff,
          step: outcome.step,
        },
        ...(outcome.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },
    goto: async (request) => {
      const s = await getSession();
      const url = (request.params ?? {})['url'];
      if (typeof url !== 'string') {
        return { data: { error: 'missing url' }, exitCode: EXIT.USAGE };
      }
      const result = await s.goto(url);
      return {
        data: result,
        ...(result.ok ? {} : { exitCode: EXIT.FAILURE }),
      };
    },
    tabs: async () => {
      const s = await getSession();
      return { data: { tabs: await s.tabs() } };
    },
    'tab.select': async (request) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        s.sessionState.selectTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },
    'tab.close': async (request) => {
      const s = await getSession();
      const index = (request.params ?? {})['index'];
      if (typeof index !== 'number') {
        return { data: { error: 'missing index' }, exitCode: EXIT.USAGE };
      }
      try {
        await s.sessionState.closeTab(index);
        return { data: { ok: true, index } };
      } catch (err) {
        return {
          data: { ok: false, error: err instanceof Error ? err.message : String(err) },
          exitCode: EXIT.FAILURE,
        };
      }
    },
    'storage.state': async () => {
      const s = await getSession();
      return { data: { state: await s.storageState() } };
    },
    'page.info': async () => {
      const s = await getSession();
      const page = await s.page();
      return {
        data: {
          url: page.url(),
          title: await page.title().catch(() => ''),
          userAgent: s.ua,
          runId: store.runId,
          runDir: store.dir,
        },
      };
    },
    'console.drain': async () => {
      const s = await getSession();
      return {
        data: { errors: s.drainConsoleErrors(), failedRequests: s.drainFailedRequests() },
      };
    },
    stop: async () => {
      const s = await getSession().catch(() => void 0);
      await s?.close();
      return { data: { ok: true } };
    },
  };
  const daemon = await startDaemon({
    handlers,
    session: options.session,
    headed: options.headed,
    browser: 'chromium',
  });
  const info = daemon.info;
  await writeDaemonInfo(info, daemon.token, options.cwd);
  await store.audit({
    type: 'session_start',
    session: options.session,
    pid: info.pid,
    port: info.port,
    headed: options.headed,
    userAgent,
    runId: store.runId,
  });
  const shutdown = async () => {
    await daemon.close().catch(() => void 0);
    await session?.close().catch(() => void 0);
    await clearDaemonInfo(options.cwd).catch(() => void 0);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise((resolve5) => {
    daemon.server.once('close', () => resolve5());
  });
}
var ACTION_KINDS2;
var init_daemon_process = __esm({
  'src/core/daemon-process.ts'() {
    'use strict';
    init_daemon();
    init_daemon_info();
    init_session();
    init_store();
    init_paths();
    init_render();
    init_locate();
    init_exit();
    ACTION_KINDS2 = [
      'click',
      'dblclick',
      'hover',
      'type',
      'fill',
      'select',
      'check',
      'uncheck',
      'press',
      'scroll',
      'upload',
      'focus',
    ];
  },
});

// src/cli/main.ts
init_exit();
import { Command, CommanderError } from 'commander';

// src/core/errors.ts
init_exit();
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
var UsageError = class extends BvError {
  constructor(message, detail = {}) {
    super(message, { exitCode: EXIT.USAGE, detail });
    this.name = 'UsageError';
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
init_exit();
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

// src/cli/main.ts
init_version();

// src/cli/commands/doctor.ts
import { access, constants, readdir, stat } from 'fs/promises';
import { join as join3 } from 'path';
import { homedir as homedir2 } from 'os';
init_exit();
init_paths();

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
      const chromium2 = entries.filter((e) => e.startsWith('chromium-'));
      if (chromium2.length > 0) {
        const full = join3(dir, chromium2.sort().at(-1) ?? chromium2[0] ?? '');
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
  const chromium2 = await findChromium();
  checks.push(
    chromium2
      ? { name: 'playwright-chromium', status: 'ok', detail: chromium2 }
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
init_exit();
init_paths();
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

// src/cli/commands/session.ts
import { spawn } from 'child_process';
import { existsSync as existsSync3 } from 'fs';
import { fileURLToPath as fileURLToPath3 } from 'url';
import { dirname as dirname3, resolve as resolve4 } from 'path';
init_exit();

// src/core/client.ts
init_daemon_info();
var DEFAULT_TIMEOUT_MS = 12e4;
async function connectDaemon(cwd) {
  const info = await readDaemonInfo(cwd);
  if (info === void 0) {
    throw new UsageError('no running session found. Start one with `bv session start`.');
  }
  if (!isProcessAlive(info.pid)) {
    throw new UsageError(
      `the session process (pid ${info.pid}) is no longer running. Start a new one with \`bv session start\`.`,
    );
  }
  const token = await readDaemonToken(cwd);
  if (token === void 0) {
    throw new UsageError(
      'the session token is missing. Stop the stale session with `bv session stop` and start a new one.',
    );
  }
  const baseUrl = daemonBaseUrl(info);
  return createClient(baseUrl, token, info.port);
}
function createClient(baseUrl, token, port) {
  const call = async (method, params = {}, options = {}) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UsageError(`could not reach the session daemon: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new UsageError(`the session daemon returned a non-JSON response (${response.status})`);
    }
    if (!body.ok) {
      const err = new Error(body.error ?? 'the session daemon reported an unknown error');
      Object.assign(err, { reasons: body.reasons ?? [], exitCode: body.exitCode });
      throw err;
    }
    return body.data;
  };
  const health = async () => {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  return { port, call, health };
}

// src/cli/commands/session.ts
init_daemon_info();
init_paths();
function daemonEntry() {
  const here = dirname3(fileURLToPath3(import.meta.url));
  const sourceEntry = resolve4(here, '..', '..', 'core', 'daemon-entry.ts');
  const tsxCli = resolve4(here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync3(sourceEntry)) {
    if (existsSync3(tsxCli)) {
      return { command: process.execPath, args: [tsxCli, sourceEntry] };
    }
    return { command: 'tsx', args: [sourceEntry] };
  }
  const bundle = resolve4(here, '..', '..', '..', 'scripts', 'bv.mjs');
  if (existsSync3(bundle)) {
    return { command: process.execPath, args: [bundle] };
  }
  throw new UsageError(
    'could not locate the session daemon entry point. Reinstall browser-verified or run from the repository.',
  );
}
function spawnDaemon(options) {
  const entry = daemonEntry();
  const args = [
    ...entry.args,
    '--daemon',
    '--cwd',
    options.cwd,
    '--session',
    options.session,
    ...(options.headed ? ['--headed'] : []),
    ...(options.contact !== void 0 ? ['--contact', options.contact] : []),
    ...(options.runId !== void 0 ? ['--run-id', options.runId] : []),
  ];
  const child = spawn(entry.command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (child.pid === void 0) {
    throw new Error('failed to spawn the session daemon');
  }
  return child.pid;
}
async function waitForDaemon(cwd, timeoutMs = 3e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readDaemonInfo(cwd);
    if (info !== void 0 && isProcessAlive(info.pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new UsageError('the session daemon did not start within 30s');
}
function registerSession(program) {
  const session = program
    .command('session')
    .description('start, stop and inspect browser sessions');
  session
    .command('start')
    .description('start a browser session (a detached daemon)')
    .option('--headed', 'run the browser headed (required for human handoff)', false)
    .option('--session <name>', 'the session name', 'default')
    .option('--contact <url>', 'the contact URL included in the honest user agent')
    .option('--run-id <id>', 'use a specific run id')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        await ensureBvDir(global.cwd);
        const existing = await readDaemonInfo(global.cwd);
        if (existing !== void 0 && isProcessAlive(existing.pid)) {
          emit(
            cmd,
            fail(
              { error: 'session_exists', pid: existing.pid, port: existing.port },
              [
                `a session is already running (pid ${existing.pid}). Stop it first with \`bv session stop\`.`,
              ],
              EXIT.FAILURE,
            ),
          );
          return;
        }
        if (existing !== void 0) {
          await clearDaemonInfo(global.cwd);
        }
        const pid = spawnDaemon({
          cwd: global.cwd,
          headed: options.headed === true,
          session: options.session ?? 'default',
          ...(options.contact !== void 0 ? { contact: options.contact } : {}),
          ...(options.runId !== void 0 ? { runId: options.runId } : {}),
        });
        await waitForDaemon(global.cwd);
        const info = await readDaemonInfo(global.cwd);
        const lines = [
          `session "${info?.session ?? 'default'}" started (pid ${pid})`,
          `port: ${info?.port ?? '?'}`,
          `headed: ${(options.headed ?? false) ? 'yes' : 'no'}`,
          info?.headed === false && (options.headed ?? false) ? '' : '',
          `run dir: ${info === void 0 ? '?' : '.bv/runs'}`,
        ].filter((line) => line !== '');
        emit(
          cmd,
          ok(
            {
              pid,
              port: info?.port,
              session: info?.session,
              headed: info?.headed,
              startedAt: info?.startedAt,
            },
            lines,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit(
          cmd,
          fail(
            { error: 'session_start_failed', message },
            [`Could not start the session: ${message}`],
            EXIT.FAILURE,
          ),
        );
      }
    });
  session
    .command('stop')
    .description('stop the running session')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === void 0) {
        emit(cmd, ok({ stopped: false }, ['no session is running']));
        return;
      }
      if (!isProcessAlive(info.pid)) {
        await clearDaemonInfo(global.cwd);
        emit(
          cmd,
          ok({ stopped: false }, ['the session was no longer running (stale state cleared)']),
        );
        return;
      }
      try {
        const client = await connectDaemon(global.cwd);
        await client.call('stop');
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      if (isProcessAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {}
      }
      await clearDaemonInfo(global.cwd);
      emit(cmd, ok({ stopped: true, pid: info.pid }, [`session stopped (pid ${info.pid})`]));
    });
  session
    .command('status')
    .description('show the status of the running session')
    .action(async (_options, cmd) => {
      const global = globalOptions(cmd);
      const info = await readDaemonInfo(global.cwd);
      if (info === void 0) {
        emit(cmd, ok({ running: false }, ['no session is running']));
        return;
      }
      const alive = isProcessAlive(info.pid);
      let page;
      if (alive) {
        try {
          const client = await connectDaemon(global.cwd);
          page = await client.call('page.info');
        } catch {
          page = void 0;
        }
      }
      const lines = [
        `running: ${alive ? 'yes' : 'no (stale)'}`,
        `pid: ${info.pid}`,
        `port: ${info.port}`,
        `session: ${info.session}`,
        `headed: ${info.headed ? 'yes' : 'no'}`,
        `started: ${info.startedAt}`,
      ];
      if (page !== void 0) {
        const p = page;
        lines.push(`url: ${p.url ?? ''}`);
        lines.push(`title: ${p.title ?? ''}`);
        lines.push(`user agent: ${p.userAgent ?? ''}`);
      }
      emit(cmd, ok({ running: alive, ...info, page }, lines));
    });
}

// src/cli/commands/perception.ts
init_exit();
init_locate();
var ACTION_KINDS = [
  'click',
  'dblclick',
  'hover',
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'scroll',
  'upload',
  'focus',
];
function registerPerception(program) {
  program
    .command('snapshot')
    .description('capture the page as a compact, diffed accessibility tree')
    .option('--full', 'return the full tree instead of only the changes', false)
    .option('--max-tokens <n>', 'approximate token budget for the pruned tree')
    .option('--expand <ref>', 'expand a collapsed node by ref')
    .action(async (options, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const maxTokens = options.maxTokens !== void 0 ? Number(options.maxTokens) : void 0;
        if (maxTokens !== void 0 && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
          throw new UsageError('--max-tokens must be a positive number');
        }
        const payload = await client.call('snapshot', {
          full: options.full === true,
          ...(maxTokens !== void 0 ? { maxTokens } : {}),
          ...(options.expand !== void 0 ? { expand: options.expand } : {}),
        });
        const lines = [
          payload.diff,
          `full snapshot: ${payload.snapshotPath}`,
          `estimated tokens: ${payload.estimatedTokens} (estimate)`,
        ];
        if (options.full === true && payload.tree !== void 0) {
          lines.push(payload.tree);
        }
        emit(cmd, ok(payload, lines));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('act')
    .description('perform an action on the page')
    .argument('<kind>', `one of: ${ACTION_KINDS.join(', ')}`)
    .argument('<target>', 'a ref (e12), or a descriptor (role=button name="Sign in")')
    .argument('[value]', 'the value to type, fill, select, press or upload')
    .option('--dry-run', 'report what would happen without doing it', false)
    .option('--force', 'skip actionability checks', false)
    .action(async (kind, target, value, options, cmd) => {
      const global = globalOptions(cmd);
      if (!ACTION_KINDS.includes(kind)) {
        const message = `unknown action kind "${kind}". Expected one of: ${ACTION_KINDS.join(', ')}`;
        emit(cmd, fail({ error: message }, [message], EXIT.USAGE));
        return;
      }
      try {
        const client = await connectDaemon(global.cwd);
        const descriptor = parseTarget(target);
        if (options.dryRun === true) {
          const lines2 = [
            `dry run: would ${kind} ${describeTarget(descriptor)}`,
            value !== void 0 ? `value: ${value}` : '',
          ].filter((line) => line !== '');
          emit(
            cmd,
            ok(
              {
                dryRun: true,
                kind,
                target: descriptor,
                ...(value !== void 0 ? { value } : {}),
              },
              lines2,
            ),
          );
          return;
        }
        const payload = await client.call('act', {
          kind,
          target: descriptor,
          ...(value !== void 0 ? { value } : {}),
          force: options.force === true,
        });
        const lines = [
          payload.ok ? `ok: ${payload.message}` : `failed: ${payload.message}`,
          `strategy: ${payload.strategy ?? 'none'}`,
          `url: ${payload.urlBefore} \u2192 ${payload.urlAfter}`,
          payload.diff,
        ];
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('goto')
    .description('navigate the active tab to a URL')
    .argument('<url>', 'the URL to navigate to')
    .action(async (url, cmd) => {
      const global = globalOptions(cmd);
      try {
        const client = await connectDaemon(global.cwd);
        const payload = await client.call('goto', {
          url,
        });
        const lines = [payload.message, `url: ${payload.url}`];
        emit(cmd, payload.ok ? ok(payload, lines) : fail(payload, lines, EXIT.FAILURE));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
  program
    .command('tab')
    .description('list, select or close tabs')
    .argument('[action]', 'list (default), select or close')
    .argument('[index]', 'the tab index, for select and close')
    .action(async (action, index, cmd) => {
      const global = globalOptions(cmd);
      const verb = action ?? 'list';
      try {
        const client = await connectDaemon(global.cwd);
        if (verb === 'list') {
          const payload = await client.call('tabs');
          const lines = payload.tabs.map(
            (t) =>
              `${t.index}${t.active ? '*' : ' '} ${t.title || '(untitled)'} ${t.url}${t.popup ? ' [popup]' : ''}`,
          );
          if (lines.length === 0) lines.push('(no tabs)');
          emit(cmd, ok(payload, lines));
          return;
        }
        if (verb === 'select' || verb === 'close') {
          const parsed = Number(index);
          if (!Number.isInteger(parsed)) {
            throw new UsageError(`\`bv tab ${verb}\` needs a tab index`);
          }
          const payload = await client.call(verb === 'select' ? 'tab.select' : 'tab.close', {
            index: parsed,
          });
          emit(cmd, ok(payload, [`tab ${verb}ed: ${parsed}`]));
          return;
        }
        throw new UsageError(`unknown tab action "${verb}". Expected list, select or close.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILURE;
        emit(cmd, fail({ error: message }, [message], code));
      }
    });
}
function describeTarget(descriptor) {
  const parts = [];
  if (descriptor.ref !== void 0) parts.push(`ref=${descriptor.ref}`);
  if (descriptor.role !== void 0) parts.push(`role=${descriptor.role}`);
  if (descriptor.name !== void 0) parts.push(`name=${descriptor.name}`);
  if (descriptor.label !== void 0) parts.push(`label=${descriptor.label}`);
  if (descriptor.text !== void 0) parts.push(`text=${descriptor.text}`);
  if (descriptor.testId !== void 0) parts.push(`testid=${descriptor.testId}`);
  if (descriptor.css !== void 0) parts.push(`css=${descriptor.css}`);
  return parts.length > 0 ? parts.join(' ') : '(empty)';
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
  registerSession(program);
  registerPerception(program);
  return program;
}
function mapCommanderError(err) {
  switch (err.code) {
    case 'commander.helpDisplayed':
    case 'commander.version':
      return EXIT.OK;
    default:
      return EXIT.USAGE;
  }
}
async function run(argv) {
  if (argv.includes('--daemon')) {
    await runDaemonFromArgv(argv);
    return EXIT.OK;
  }
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
    if (err instanceof CommanderError) {
      const code = mapCommanderError(err);
      if (err.code === 'commander.help') program.outputHelp();
      result = {
        data: { error: 'UsageError', message: err.message, reasons: [] },
        lines: err.code === 'commander.help' ? [] : [err.message],
        code,
      };
    } else {
      const bvErr = toBvError(err);
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
async function runDaemonFromArgv(argv) {
  const { runDaemonProcess: runDaemonProcess2 } = await Promise.resolve().then(
    () => (init_daemon_process(), daemon_process_exports),
  );
  const options = parseDaemonArgs(argv);
  await runDaemonProcess2(options);
}
function parseDaemonArgs(argv) {
  let cwd = process.cwd();
  let session = 'default';
  let headed = false;
  let contact;
  let runId;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value !== void 0) {
        cwd = value;
        i++;
      }
    } else if (arg === '--session') {
      const value = argv[i + 1];
      if (value !== void 0) {
        session = value;
        i++;
      }
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--contact') {
      const value = argv[i + 1];
      if (value !== void 0) {
        contact = value;
        i++;
      }
    } else if (arg === '--run-id') {
      const value = argv[i + 1];
      if (value !== void 0) {
        runId = value;
        i++;
      }
    }
  }
  return {
    cwd,
    session,
    headed,
    ...(contact !== void 0 ? { contact } : {}),
    ...(runId !== void 0 ? { runId } : {}),
  };
}

// src/cli/bundle.ts
await main(process.argv);
