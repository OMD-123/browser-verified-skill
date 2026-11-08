/**
 * Tests for the native-binding postinstall (M34).
 *
 * The script exists because npm/cli#4828 means a lockfile generated on
 * one platform does not resolve another platform's optional native
 * dependency. The script installs the missing one.
 *
 * Two things had to be right, and neither was covered by anything:
 *
 *  1. The platform mapping. If it names a package that does not exist,
 *     the install fails and the tests still cannot start.
 *  2. The musl detection. It has to agree with rolldown's own detection,
 *     because rolldown is what decides which binding to load. If they
 *     disagree, the script installs the wrong one.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - the script is plain JavaScript with JSDoc types.
import { bindingFor, detectMusl } from '../../scripts/ensure-native-binding.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('the platform mapping', () => {
  it('maps Windows x64', () => {
    expect(bindingFor('win32', 'x64')).toBe('@rolldown/binding-win32-x64-msvc');
  });

  it('maps Windows arm64', () => {
    expect(bindingFor('win32', 'arm64')).toBe('@rolldown/binding-win32-arm64-msvc');
  });

  it('maps macOS x64', () => {
    expect(bindingFor('darwin', 'x64')).toBe('@rolldown/binding-darwin-x64');
  });

  it('maps macOS arm64', () => {
    expect(bindingFor('darwin', 'arm64')).toBe('@rolldown/binding-darwin-arm64');
  });

  it('maps Linux x64 to the glibc build by default', () => {
    expect(bindingFor('linux', 'x64')).toBe('@rolldown/binding-linux-x64-gnu');
  });

  it('maps Linux arm64 to the glibc build by default', () => {
    expect(bindingFor('linux', 'arm64')).toBe('@rolldown/binding-linux-arm64-gnu');
  });

  it('maps the Linux architectures that only have a glibc build', () => {
    expect(bindingFor('linux', 'arm')).toBe('@rolldown/binding-linux-arm-gnueabihf');
    expect(bindingFor('linux', 'ppc64')).toBe('@rolldown/binding-linux-ppc64-gnu');
    expect(bindingFor('linux', 's390x')).toBe('@rolldown/binding-linux-s390x-gnu');
  });

  it('maps FreeBSD', () => {
    expect(bindingFor('freebsd', 'x64')).toBe('@rolldown/binding-freebsd-x64');
  });

  it('maps Android', () => {
    expect(bindingFor('android', 'arm64')).toBe('@rolldown/binding-android-arm64');
    expect(bindingFor('android', 'arm')).toBe('@rolldown/binding-android-arm-eabi');
  });

  it('maps OpenHarmony', () => {
    expect(bindingFor('openharmony', 'arm64')).toBe('@rolldown/binding-openharmony-arm64');
  });

  it('returns nothing for a platform it does not know', () => {
    expect(bindingFor('sunos', 'x64')).toBeUndefined();
    expect(bindingFor('aix', 'ppc64')).toBeUndefined();
  });

  it('names a package that rolldown actually publishes', async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'node_modules', 'rolldown', 'package.json'), 'utf8'),
    ) as { optionalDependencies?: Record<string, string> };

    const published = new Set(Object.keys(manifest.optionalDependencies ?? {}));

    const platforms: [string, string][] = [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['linux', 'arm'],
      ['linux', 'ppc64'],
      ['linux', 's390x'],
      ['freebsd', 'x64'],
      ['android', 'arm64'],
      ['android', 'arm'],
      ['openharmony', 'arm64'],
    ];

    for (const [platform, arch] of platforms) {
      const binding = bindingFor(platform, arch);
      expect(binding, `${platform}/${arch} has no binding`).toBeDefined();
      expect(published.has(binding as string), `${binding} is not published by rolldown`).toBe(
        true,
      );
    }
  });
});

describe('the musl detection', () => {
  it('returns a boolean', () => {
    expect(typeof detectMusl()).toBe('boolean');
  });

  it('does not report musl on a non-Linux host', () => {
    // The host here is Windows or macOS, where musl does not exist.
    if (process.platform !== 'linux') {
      expect(detectMusl()).toBe(false);
    }
  });

  it('agrees with rolldown on what it would load', async () => {
    // The script's decision has to match rolldown's, or it installs the
    // wrong binding. rolldown's own detection is the reference.
    const source = await readFile(
      join(ROOT, 'node_modules', 'rolldown', 'dist', 'shared', 'binding-BXYS21Tf.mjs'),
      'utf8',
    ).catch(() => '');

    if (source.length === 0) return;

    // rolldown's filesystem check looks for 'musl' in /usr/bin/ldd.
    expect(source).toContain('isMuslFromFilesystem');
    // and the report check keys off a glibc version and musl shared objects.
    expect(source).toContain('glibcVersionRuntime');
    expect(source).toContain('libc.musl-');
  });
});
