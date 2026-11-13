/**
 * The packaging tests (M31).
 *
 * These check that the **published artifact** works, not just the source
 * tree. The bug this file exists for: the installed package could not
 * start the daemon, because the bundle path was resolved against the
 * source layout rather than the installed one. The source tree passed
 * every other test; only an actual install caught it.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlaceholderContact } from '../../src/safety/contact.js';

const exec = promisify(execFile);

/** The repository root. */
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('the published artifact', () => {
  it('has a bundle', () => {
    expect(existsSync(join(ROOT, 'scripts', 'bv.mjs'))).toBe(true);
  });

  it('runs and prints its version', async () => {
    // The version is read from the manifest rather than hardcoded, so a
    // release bump does not silently break the test.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--version']);
    expect(stdout.trim()).toContain(manifest.version);
  });

  it('reports the same version in the manifest and the bundle', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--version']);
    expect(stdout.trim()).toBe(manifest.version);
  });

  it('lists every command', async () => {
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--help']);
    for (const command of [
      'doctor',
      'init',
      'session',
      'snapshot',
      'act',
      'plan',
      'approve',
      'verify',
      'extract',
      'compile',
      'replay',
      'mcp',
      'memory',
      'diff',
      'report',
      'test',
      'redteam',
      'discover-api',
      'research',
      'audit',
    ]) {
      expect(stdout, `the help does not mention "${command}"`).toContain(command);
    }
  });

  it('has a shebang, so it can be run as a command', async () => {
    const source = await readFile(join(ROOT, 'scripts', 'bv.mjs'), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('names every file it ships', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
      bin: Record<string, string>;
    };

    for (const path of manifest.files) {
      expect(existsSync(join(ROOT, path)), `${path} is listed but does not exist`).toBe(true);
    }

    for (const bin of Object.values(manifest.bin)) {
      expect(existsSync(join(ROOT, bin)), `${bin} is listed but does not exist`).toBe(true);
    }
  });

  it('does not list a file that does not exist', async () => {
    // The check above already covers this; this makes the intent explicit
    // and catches a glob that matches nothing.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    for (const path of manifest.files) {
      if (path.endsWith('/')) continue;
      expect(existsSync(join(ROOT, path))).toBe(true);
    }
  });

  it('ships the security model and the known limitations', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toContain('docs/SECURITY.md');
    expect(manifest.files).toContain('docs/KNOWN_LIMITATIONS.md');
    expect(existsSync(join(ROOT, 'docs', 'SECURITY.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'docs', 'KNOWN_LIMITATIONS.md'))).toBe(true);
  });

  it('ships a skill that an agent can read', async () => {
    expect(existsSync(join(ROOT, 'SKILL.md'))).toBe(true);
    const skill = await readFile(join(ROOT, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: browser-verified-skill');
    expect(skill).toContain('description:');
  });

  it('installs the native binding for every platform rolldown publishes', async () => {
    // rolldown ships its native binding as an optional dependency, one
    // package per platform. npm has a bug with optional dependencies
    // (npm/cli#4828): a lockfile generated on one platform resolves only
    // that platform's package, so CI on another platform fails with
    // 'Cannot find native binding'.
    //
    // The postinstall script installs the missing one explicitly, so it
    // has to know the name of every binding rolldown publishes.
    const script = await readFile(join(ROOT, 'scripts', 'ensure-native-binding.mjs'), 'utf8');

    const rolldownManifest = JSON.parse(
      await readFile(join(ROOT, 'node_modules', 'rolldown', 'package.json'), 'utf8'),
    ) as { optionalDependencies?: Record<string, string> };

    const bindings = Object.keys(rolldownManifest.optionalDependencies ?? {}).filter((name) =>
      name.includes('binding-'),
    );
    expect(bindings.length).toBeGreaterThan(0);

    const missing = bindings.filter((name) => !script.includes(name.replace('@rolldown/', '')));
    expect(missing, `the postinstall does not handle: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not run the postinstall as part of the install', async () => {
    // It used to. The native binding is needed to RUN THE TESTS, not to
    // use the tool, so every end user's install was running a dev-only
    // fix.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.['postinstall']).toBeUndefined();
  });

  it('pins playwright and @playwright/test to the same version', async () => {
    // A caret on @playwright/test let it resolve to a NEWER version than
    // the pinned `playwright`, and the two disagreed about which Chromium
    // build to download. CI installed chromium-1254 while the code looked
    // for chromium-1248, so every browser test failed to launch.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    const playwright = manifest.dependencies['playwright'];
    const test = manifest.devDependencies['@playwright/test'];

    expect(playwright).toBeDefined();
    expect(test).toBeDefined();

    // Both must be exact pins, and the same exact pin.
    expect(playwright).not.toMatch(/[~^><*]|\s-\s/);
    expect(test).not.toMatch(/[~^><*]|\s-\s/);
    expect(test).toBe(playwright);
  });

  it('has no coverage exclusions outside the browser callbacks', async () => {
    // The project excludes a few regions from the coverage requirement
    // with `v8 ignore`. Each one has to be justified: it is either code
    // that runs inside the browser (which the coverage tool cannot see),
    // or a safety net for a future change that is unreachable today.
    //
    // This test reads every exclusion and checks that it carries a
    // reason. A bare `v8 ignore` with no explanation is a hole.
    const files = await collectTypeScript(join(ROOT, 'src'));

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        if (!line.includes('v8 ignore')) return;

        // A `stop` marker closes a region that a `start` marker opened,
        // so it carries no reason of its own. The start marker does.
        if (line.includes('v8 ignore stop')) return;

        // The exclusion must say why. The reason is in the comment block
        // above it, so the whole block is read rather than just the line
        // before.
        const context = lines
          .slice(Math.max(0, index - 8), index + 1)
          .join(' ')
          .toLowerCase();
        const justified =
          context.includes('browser') ||
          context.includes('unreachable') ||
          context.includes('safety net') ||
          context.includes('future change');

        expect(
          justified,
          `${file.replace(ROOT, '.')}:${index + 1} excludes code without a reason: ${line.trim()}`,
        ).toBe(true);
      });
    }
  });

  it('has the command count the README claims', async () => {
    // The README says "27 commands". If a command is added or removed,
    // that number is wrong, and a reader who counts will notice.
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--help']);

    const commands = stdout
      .split('\n')
      .filter((line) => /^ {2}[a-z]/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== 'help');

    expect(commands.length).toBe(28);

    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(`${commands.length} commands`);
  });

  it('documents every command in the reference doc', async () => {
    // The reference doc is where a user is pointed for "the complete
    // reference". Seven commands were missing from it, so a reader would
    // have gone looking for bv doctor and bv test and found nothing.
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--help']);

    const commands = stdout
      .split('\n')
      .filter((line) => /^ {2}[a-z]/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== 'help');

    const reference = await readFile(join(ROOT, 'references', 'commands.md'), 'utf8');

    const missing = commands.filter((name) => !reference.includes(`bv ${name}`));
    expect(
      missing,
      `these commands are not in references/commands.md: ${missing.join(', ')}`,
    ).toEqual([]);

    // The README's command table too. bv dryrun-report was missing from
    // it, so a reader working from the README never found it.
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    const missingFromReadme = commands.filter((name) => !readme.includes(`bv ${name}`));
    expect(
      missingFromReadme,
      `these commands are not in the README: ${missingFromReadme.join(', ')}`,
    ).toEqual([]);
  });

  it('says only what is true about what is not built', async () => {
    // The KNOWN_LIMITATIONS file lists five things that are not built.
    // If one of them gets built, that list becomes a lie, and a reader
    // would look for a command that does not exist.
    const { stdout } = await exec(process.execPath, [join(ROOT, 'scripts', 'bv.mjs'), '--help']);

    const commandNames = stdout
      .split('\n')
      .filter((line) => /^ {2}[a-z]/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name !== 'help');

    const limitations = await readFile(join(ROOT, 'docs', 'KNOWN_LIMITATIONS.md'), 'utf8');

    const start = limitations.indexOf('## Not built yet');
    const section = limitations.slice(start, limitations.indexOf('\n## ', start + 10));

    // Every command named in that section as missing must really be
    // missing.
    for (const name of ['run', 'eval', 'resume']) {
      if (!section.includes(`bv ${name}`)) continue;
      expect(
        commandNames.includes(name),
        `the limitations say "bv ${name}" is not built, but it is`,
      ).toBe(false);
    }

    // And the claim that no LlmClient implementation talks to a provider.
    const llmSource = await readFile(join(ROOT, 'src', 'llm', 'client.ts'), 'utf8');
    const implementations = [...llmSource.matchAll(/implements LlmClient/g)].length;
    // The only one is UnavailableClient, which always rejects.
    expect(implementations).toBe(1);
    expect(llmSource).toContain('class UnavailableClient implements LlmClient');
    expect(llmSource).toContain('the model client is not available');
  });

  it('has the acceptance-claim count the README claims', async () => {
    // The README says the acceptance script checks "17 claims".
    const script = await readFile(join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8');
    const claims = script.match(/await claim\(/g) ?? [];

    expect(claims.length).toBe(17);

    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(`**${claims.length} claims**`);
  });

  it('has a demo command that an agent can run', async () => {
    // The demo is the agent's version of the video. It has to exist,
    // and it has to be runnable without a network.
    const demo = await readFile(join(ROOT, 'src', 'cli', 'commands', 'demo.ts'), 'utf8');

    // It runs the agent-readable script.
    expect(demo).toContain('demo-agent.sh');

    // And it is registered, so `bv demo` works.
    const main = await readFile(join(ROOT, 'src', 'cli', 'main.ts'), 'utf8');
    expect(main).toContain('registerDemo');
  });

  it('has a demo that runs against the fixture site', async () => {
    // The demo is documentation that executes. If it breaks, the
    // recording is a lie.
    const demo = await readFile(join(ROOT, 'scripts', 'demo.sh'), 'utf8');

    // It must start the fixture site itself, or it depends on something
    // that is not running.
    expect(demo).toContain('fixtures/server.ts');

    // It must exercise the things the recording claims to show.
    expect(demo).toContain('injected.html');
    expect(demo).toContain('--from-ref');
    expect(demo).toContain('approve');
    expect(demo).toContain('compile');
    expect(demo).toContain('verify');
  });

  it('has a video poster in the README that points at a playable file', async () => {
    // GitHub does NOT render a <video> tag in a README. It strips it and
    // renders an empty paragraph. Nor does the image syntax work: an
    // mp4 through ![](...) is a broken image.
    //
    // So the README shows a POSTER IMAGE that links to a playable mp4.
    // The poster is served from the repository; the video is served
    // from GitHub Pages, which serves mp4 as video/mp4 with range
    // support, so a browser can actually play it.
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');

    // No <video> tag: GitHub would strip it.
    expect(readme, 'a <video> tag is stripped by GitHub').not.toMatch(/<video\b/);

    // The README shows a GIF, which GitHub renders inline. It has to
    // be a real file.
    const gifs = [...readme.matchAll(/<img\s+src="(docs\/[^"]+\.gif)"/g)].map((m) => m[1] ?? '');
    expect(gifs.length, 'the README has no demo gif').toBeGreaterThan(0);

    for (const gif of gifs) {
      expect(existsSync(join(ROOT, gif)), `${gif} is missing`).toBe(true);
    }

    // A GIF that is too big is a GIF that does not get looked at, and
    // it makes the repository clone slow for everyone.
    for (const gif of gifs) {
      const size = statSync(join(ROOT, gif)).size;
      expect(
        size,
        `${gif} is ${Math.round(size / 1024)} KiB, which is too big for a README`,
      ).toBeLessThan(1_500_000);
    }

    // Each poster links to a playable URL, not to the repository file.
    // The repository file is served as octet-stream, so it downloads.
    const links = [...readme.matchAll(/<a href="(https?:\/\/[^"]+\.mp4)"/g)].map((m) => m[1] ?? '');
    expect(links.length, 'a poster does not link to a video').toBeGreaterThan(0);

    for (const link of links) {
      expect(link, 'the video link points at the repository file, which downloads').toMatch(
        /github\.io/,
      );
    }
  });

  it('describes an unserialisable tool result instead of stringifying it badly', async () => {
    // An object that cannot be serialised must never become
    // "[object Object]". A circular reference is the case that matters.
    const { toolText } = await import('../../src/mcp/server.js');

    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const described = toolText(circular);
    expect(described).not.toBe('[object Object]');
    expect(described).toContain('cannot be serialised');
    // The keys are named, so the reader can tell what they are looking at.
    expect(described).toContain('self');

    // The simple cases.
    expect(toolText(undefined)).toBe('(no result)');
    expect(toolText('plain')).toBe('plain');
    expect(toolText(42)).toBe('42');
    expect(toolText(true)).toBe('true');
    expect(toolText(null)).toBe('null');
  });

  it('generates a demo page that is already formatted', async () => {
    // The page is generated, and CI runs `prettier --check`. A
    // generated file that is not formatted fails the build, so the
    // generator formats its own output.
    const { renderPage } = await import('../../src/mcp/demo-page.js');

    const generated = await renderPage(join(ROOT, 'docs', 'index.html'));
    const onDisk = await readFile(join(ROOT, 'docs', 'index.html'), 'utf8');

    // The line endings are normalised before comparing. Git checks the
    // file out with CRLF on Windows, so a byte-for-byte comparison
    // fails there and passes on Linux -- which is the worst kind of
    // test failure.
    const normalise = (text: string): string => text.replace(/\r\n/g, '\n');

    expect(
      normalise(generated),
      'the generator and the file on disk disagree -- regenerate it',
    ).toBe(normalise(onDisk));

    // And it is already in Prettier's form. The line endings are
    // normalised first, because Git checks the file out with CRLF on
    // Windows and Prettier's endOfLine setting is 'lf'.
    const { check, resolveConfig } = await import('prettier');
    const filepath = join(ROOT, 'docs', 'index.html');
    const config = await resolveConfig(filepath);
    const result = await check(normalise(onDisk), {
      ...(config ?? {}),
      filepath,
      parser: 'html',
    });
    expect(result, 'the generated page is not Prettier-formatted').toBe(true);
  });

  it('finds the docs folder from the bundled CLI as well as the source', async () => {
    // The bundled CLI lives in scripts/bv.mjs and the source lives in
    // src/mcp/, so the depth differs. Both are tried, so a published
    // package still finds its videos.
    const { pagesRoot } = await import('../../src/mcp/demo-page.js');

    const root = pagesRoot();
    expect(existsSync(join(root, 'demo.mp4'))).toBe(true);
    expect(existsSync(join(root, 'agent-demo.mp4'))).toBe(true);
  });

  it('has a demo page that names both videos and links to the repo', async () => {
    const { renderPage, PAGE_VIDEOS } = await import('../../src/mcp/demo-page.js');

    const page = await renderPage();

    // Every video gets a section.
    for (const video of PAGE_VIDEOS) {
      expect(page).toContain(video.file);
      expect(page).toContain(video.title);
    }

    // It is a real HTML page, with a real player in it.
    expect(page).toContain('<video');
    expect(page).toContain('type="video/mp4"');
    expect(page).toContain('controls');

    // And it says where the repository is.
    expect(page).toContain('github.com/OMD-123/browser-verified-skill');
  });

  it('declares all four MCP tool annotations on every tool', async () => {
    // MCP lets a tool declare readOnlyHint, destructiveHint,
    // idempotentHint and openWorldHint, so a host can warn a user
    // before invoking it. A missing hint is worse than a wrong one: a
    // host that reads "unknown" has to assume the worst, and OpenAI's
    // directory rejects a tool where any of the four is missing.
    const { BROWSER_TOOLS } = await import('../../src/mcp/server.js');

    expect(BROWSER_TOOLS.length).toBeGreaterThan(0);

    for (const tool of BROWSER_TOOLS) {
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(typeof tool[hint], `${tool.name} is missing ${hint}`).toBe('boolean');
      }
    }

    // The values have to match the behaviour, not just be present.
    const byName = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool]));

    // A tool that only reads is read-only.
    expect(byName.get('snapshot')?.readOnlyHint).toBe(true);
    expect(byName.get('verify')?.readOnlyHint).toBe(true);
    expect(byName.get('extract')?.readOnlyHint).toBe(true);

    // A tool that acts on the page is not.
    expect(byName.get('act')?.readOnlyHint).toBe(false);
    expect(byName.get('act')?.destructiveHint).toBe(true);

    // And they are not idempotent: clicking twice is not clicking once.
    expect(byName.get('act')?.idempotentHint).toBe(false);

    // The tools that touch the open web say so.
    expect(byName.get('snapshot')?.openWorldHint).toBe(true);
    expect(byName.get('approve')?.openWorldHint).toBe(false);
  });

  it('packages the skill the way a skill marketplace wants it', async () => {
    // Agensi's own example is:
    //
    //     my-skill/
    //     ├── SKILL.md
    //     ├── scripts/run.py
    //     └── reference/notes.md
    //
    // So: ONE top-level folder, SKILL.md at its root, and only the files
    // the skill actually needs. A repository's .git and 150 TypeScript
    // files are not what a marketplace hands to an agent.
    const script = await readFile(join(ROOT, 'scripts', 'package-skill.sh'), 'utf8');
    expect(script).toContain('SKILL.md');
    expect(script).toContain('references');
    expect(script).toContain('skills');

    // It must not ship the repository.
    expect(script).not.toMatch(/cp -r src\b/);
    expect(script).not.toMatch(/cp -r test\b/);
    expect(script).not.toMatch(/cp -r \.git/);

    // The frontmatter a marketplace parses: name and description, both
    // required by the Agent Skills standard.
    const skill = await readFile(join(ROOT, 'SKILL.md'), 'utf8');
    const frontmatter = skill.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/^\s*name:\s*\S+/m);
    expect(frontmatter).toMatch(/^\s*description:/m);

    // And the name matches the folder the archive uses.
    expect(frontmatter).toMatch(/name:\s*browser-verified-skill/);
  });

  it('tells the agent how to install the CLI', async () => {
    // A skill that assumes `bv` exists is a skill that fails on a
    // machine that has never installed it -- which is every machine a
    // skill marketplace hands it to. The install step has to be in the
    // skill, not in the reader's head.
    const skill = await readFile(join(ROOT, 'SKILL.md'), 'utf8');

    expect(skill).toContain('npm install -g browser-verified-skill');
    expect(skill).toContain('bv --version');

    // And it has to be near the top, before the first command, not
    // buried at the bottom.
    const installAt = skill.indexOf('npm install -g browser-verified-skill');
    const firstCommand = skill.indexOf('bv session start');
    expect(installAt, 'the install step is missing').toBeGreaterThan(-1);
    expect(installAt, 'the install step comes after the first command').toBeLessThan(firstCommand);
  });

  it('has a demo page that actually plays the videos', async () => {
    // A README cannot play a video -- GitHub strips the <video> tag. A
    // web page can, and GitHub Pages serves an mp4 as video/mp4 with
    // range support. So the page is the place the videos live.
    const page = await readFile(join(ROOT, 'docs', 'index.html'), 'utf8');

    const videos = [...page.matchAll(/<source src="([^"]+)" type="video\/mp4"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(videos.length, 'the page has no playable video').toBe(2);

    for (const video of videos) {
      expect(existsSync(join(ROOT, 'docs', video)), `${video} is missing`).toBe(true);
    }

    // Each video has a poster, so it shows something before it plays.
    const posters = [...page.matchAll(/poster="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(posters.length).toBe(videos.length);
    for (const poster of posters) {
      expect(existsSync(join(ROOT, 'docs', poster)), `${poster} is missing`).toBe(true);
    }

    // And a fallback link, for a browser that cannot play the codec.
    expect(page).toContain('Download it');
  });

  it('has an agent demo where the agent refuses to work around a refusal', async () => {
    // The agent demo's whole claim is that Hermes, given a link, uses the
    // skill correctly -- including respecting a refusal it cannot get
    // around. The transcript has to actually show that.
    const session = await readFile(join(ROOT, 'docs', 'agent-session.md'), 'utf8');

    // It installed the skill from the link.
    expect(session).toContain('browser-verified-skill');

    // It filled the form.
    expect(session).toContain('Ada Lovelace');
    expect(session).toContain('ada@example.test');

    // It met the injection and hit exit 5.
    expect(session).toContain('fake-system-banner');

    // And it said, in its own words, that it did not work around it.
    expect(session).toMatch(/did \*\*not\*\* attempt approval/i);
    expect(session).toMatch(/did not work around it/i);
  });

  it('has an agent-readable demo that teaches the exit codes', async () => {
    // The point of the agent-readable demo is that an agent learns what
    // each exit code means. So the exit codes have to be in it.
    const agentDemo = await readFile(join(ROOT, 'scripts', 'demo-agent.sh'), 'utf8');

    expect(agentDemo).toContain('Exit code');
    expect(agentDemo).toContain('What an agent should take from this');

    // And the lesson has to name the codes it is teaching.
    expect(agentDemo).toContain('Exit 4 means a human must approve');
    expect(agentDemo).toContain('Exit 5 means stop');
    expect(agentDemo).toContain('Exit 3 means the plan does not cover this');
  });

  it('has the fixture page the demo needs', async () => {
    const page = await readFile(join(ROOT, 'fixtures', 'pages', 'injected.html'), 'utf8');

    // The payload has to be invisible to a sighted user and visible to
    // a snapshot. That is the whole point of the fixture.
    expect(page).toContain('opacity: 0');
    expect(page).toContain('Ignore all previous instructions');

    // And the scanner has to recognise it.
    expect(page.toLowerCase()).toContain('system:');
  });

  it('tells the same story about non-interactive approval everywhere', async () => {
    // The gap: SECURITY.md said the default in non-interactive mode was
    // "deny", while the README said the session "asks" for an approval,
    // and the code said needs_approval. Three stories. The code is
    // right: a denial and an approval request are different, and only
    // one of them can be satisfied out of band.
    const security = await readFile(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');

    // Neither doc may claim a non-interactive session denies outright.
    expect(security).not.toContain('In non-interactive mode the default is **deny**');
    expect(readme).not.toMatch(/non-interactive[^.]*default is \*\*deny\*\*/);

    // Both must say it asks for an approval.
    expect(security).toContain('needs approval');
    expect(readme).toContain('non-interactive session **asks** for an approval');
  });

  it('has a README tree that matches the real folders', async () => {
    // The tree is generated by scripts/generate-tree.ts, so it cannot
    // drift. This test checks the generated block is what the generator
    // would produce.
    const entries = await readdir(join(ROOT, 'src'), { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    const start = readme.indexOf('<!-- BEGIN GENERATED TREE -->');
    const end = readme.indexOf('<!-- END GENERATED TREE -->');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = readme.slice(start, end);

    // Every folder appears in the tree.
    for (const folder of folders) {
      expect(block, `the README tree does not list src/${folder}`).toContain(`${folder}/`);
    }

    // And nothing that is not a folder appears.
    const listed = [...block.matchAll(/├── ([a-z-]+)\//g)].map((match) => match[1] ?? '');
    for (const name of listed) {
      expect(folders, `the README tree lists src/${name}, which does not exist`).toContain(name);
    }
  });

  it('has a red-team count in the docs that matches the catalogue', async () => {
    // The catalogue is the source of truth. A doc that says a different
    // number is wrong, and a reader who counts will find it.
    const { CATALOGUE } = await import('../../src/testing/redteam.js');

    const security = await readFile(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');

    // Any "N attack" claim must be the catalogue's size.
    const claims = [...security.matchAll(/(\d+)\s+attack/g)].map((match) => match[1]);
    for (const claim of claims) {
      expect(Number(claim), `SECURITY.md says ${claim} attacks`).toBe(CATALOGUE.length);
    }

    const readmeClaims = [...readme.matchAll(/(\d+)\s+attack/g)].map((match) => match[1]);
    for (const claim of readmeClaims) {
      expect(Number(claim), `the README says ${claim} attacks`).toBe(CATALOGUE.length);
    }
  });

  it('has no placeholder contact in the shipped user agent', async () => {
    // The gap: the default user agent contained a literal `@url:` marker
    // and a placeholder URL. The marker is internal; the placeholder
    // goes nowhere. A site owner who reads the agent and tries to
    // contact it reaches a domain that is not theirs.
    const policy = await readFile(join(ROOT, 'policies', 'default.yaml'), 'utf8');
    const suffix = policy.match(/userAgentSuffix:\s*"(.+)"/)?.[1]?.trim() ?? '';

    expect(suffix).not.toContain('@url:');
    // The placeholder may be in the policy as an example, but it must
    // be one the session recognises as a placeholder.
    expect(isPlaceholderContact(suffix)).toBe(true);

    // And the code that reads it knows the same placeholders.
    const code = await readFile(join(ROOT, 'src', 'safety', 'contact.ts'), 'utf8');
    expect(code).toContain('your-site/contact');
  });

  it('does not run a dev-only fix on an end user', async () => {
    // The gap: the native-binding script was a `postinstall`, so every
    // end user's `npm install` ran a fix that only matters for running
    // the tests. It belongs in CI, not in an install.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(manifest.scripts?.postinstall).toBeUndefined();
    expect(manifest.scripts?.preinstall).toBeUndefined();
    expect(manifest.scripts?.install).toBeUndefined();

    // And the script itself is not shipped.
    expect(manifest.files ?? []).not.toContain('scripts/ensure-native-binding.mjs');
  });

  it('runs the native-binding script in CI instead', async () => {
    const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    // CI installs it explicitly, because the tests need it.
    expect(workflow).toContain('scripts/ensure-native-binding.mjs');

    // Every job that installs dependencies runs it. The count is the
    // number of `npm ci` lines, which the binding lines must match.
    const installs = (workflow.match(/npm ci/g) ?? []).length;
    const bindings = workflow.match(/node scripts\/ensure-native-binding\.mjs/g) ?? [];
    expect(bindings.length).toBe(installs);
  });

  it('has no native dependencies, as the README claims', async () => {
    // The README says there are no native dependencies. A native
    // dependency is one that compiles, which is the thing that broke CI.
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    const all = { ...manifest.dependencies, ...(manifest.optionalDependencies ?? {}) };

    // The known native modules. If one is added, the README is wrong and
    // CI will need a toolchain again.
    const native = ['better-sqlite3', 'sharp', 'canvas', 'node-sass', 'bcrypt', 'sqlite3'];

    for (const name of Object.keys(all)) {
      expect(
        native.includes(name),
        `"${name}" is a native dependency, and the README says there are none`,
      ).toBe(false);
    }
  });

  it('does not depend on a package it does not use', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // Every runtime dependency has to be one the code actually imports.
    // The check is deliberately loose about the exact import style; the
    // point is that a dependency nobody imports is dead weight in every
    // install.
    const all = {
      ...manifest.dependencies,
      ...(manifest.optionalDependencies ?? {}),
    };

    for (const name of Object.keys(all)) {
      // Every dependency is either imported somewhere in src/ or is a
      // peer of one that is.
      const imported = await importer.grep(join(ROOT, 'src'), name);
      expect(imported, `the dependency "${name}" is never imported`).toBe(true);
    }
  });
});

/**
 * Every TypeScript file under a directory.
 */
async function collectTypeScript(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');

  const found: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectTypeScript(entryPath)));
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(entryPath);
  }

  return found;
}

/**
 * Whether a module is imported anywhere under a directory.
 *
 * It is a method on an object rather than a bare function, so the
 * `unbound-method` rule does not complain about calling it detached.
 */
const importer = {
  grep: async (directory: string, name: string): Promise<boolean> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await importer.grep(entryPath, name)) return true;
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;

      const source = await readFile(entryPath, 'utf8');
      if (source.includes(`'${name}`) || source.includes(`"${name}`)) return true;
    }

    return false;
  },
};
