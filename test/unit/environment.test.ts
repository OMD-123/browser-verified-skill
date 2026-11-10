/**
 * The daemon's environment (Phase 0, gap 7).
 *
 * The gap: the daemon was spawned with `env: process.env`, so every
 * secret the operator had in their shell went to a browser process.
 *
 * These tests check what reaches the daemon and, more importantly, what
 * does NOT.
 */
import { describe, expect, it } from 'vitest';
import { daemonEnvironment, NEVER_FORWARDED } from '../../src/core/environment.js';

/** An environment with a bit of everything. */
function busyEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/op',
    TMPDIR: '/tmp',
    HTTP_PROXY: 'http://proxy.test:8080',
    HTTPS_PROXY: 'http://proxy.test:8080',
    NO_PROXY: 'localhost',
    LANG: 'en_GB.UTF-8',
    TZ: 'Europe/London',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.test',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp-secret',
    NPM_TOKEN: 'npm-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    SOME_RANDOM_SECRET: 'leaked',
  };
}

describe('the daemon environment', () => {
  it('passes the variables the browser needs', () => {
    const env = daemonEnvironment({ source: busyEnvironment() });

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/op');
    expect(env['TMPDIR']).toBe('/tmp');
  });

  it('passes the proxy variables', () => {
    const env = daemonEnvironment({ source: busyEnvironment() });

    expect(env['HTTP_PROXY']).toBe('http://proxy.test:8080');
    expect(env['HTTPS_PROXY']).toBe('http://proxy.test:8080');
    expect(env['NO_PROXY']).toBe('localhost');
  });

  it('passes the locale and timezone', () => {
    const env = daemonEnvironment({ source: busyEnvironment() });

    expect(env['LANG']).toBe('en_GB.UTF-8');
    expect(env['TZ']).toBe('Europe/London');
  });

  it('does not forward a secret the operator happened to have', () => {
    const env = daemonEnvironment({ source: busyEnvironment() });

    // None of the known secrets.
    for (const name of NEVER_FORWARDED) {
      expect(env[name], `${name} was forwarded to the daemon`).toBeUndefined();
    }

    // And nothing else either.
    expect(env['SOME_RANDOM_SECRET']).toBeUndefined();
  });

  it('does not forward the model key in Mode A', () => {
    // Mode A needs no key, so it gets none -- even when the ambient
    // environment has one.
    const env = daemonEnvironment({
      source: busyEnvironment(),
      modeB: false,
      modelKey: 'sk-ant-secret',
    });

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('forwards the model key in Mode B', () => {
    const env = daemonEnvironment({
      source: busyEnvironment(),
      modeB: true,
      modelKey: 'sk-ant-explicit',
    });

    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-explicit');
  });

  it('forwards no key at all in Mode B when there is none', () => {
    const env = daemonEnvironment({
      source: busyEnvironment(),
      modeB: true,
      modelKey: undefined,
    });

    // The ambient key is not used as a fallback. The caller decides.
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('does not forward the base url unless the key is forwarded', () => {
    const without = daemonEnvironment({
      source: busyEnvironment(),
      modeB: false,
    });
    expect(without['ANTHROPIC_BASE_URL']).toBeUndefined();

    const with_ = daemonEnvironment({
      source: busyEnvironment(),
      modeB: true,
      modelKey: 'k',
    });
    expect(with_['ANTHROPIC_BASE_URL']).toBe('https://api.anthropic.test');
  });

  it('forwards the Windows paths on Windows', () => {
    // The platform is a parameter, so this path is tested on every
    // platform rather than only on the one the test happens to run on.
    const env = daemonEnvironment({
      source: { ...busyEnvironment(), APPDATA: 'C:\\AppData', LOCALAPPDATA: 'C:\\Local' },
      platformName: 'win32',
    });

    expect(env['APPDATA']).toBe('C:\\AppData');
    expect(env['LOCALAPPDATA']).toBe('C:\\Local');
  });

  it('does not forward the Windows paths on Linux', () => {
    const env = daemonEnvironment({
      source: { ...busyEnvironment(), APPDATA: 'C:\\AppData', LOCALAPPDATA: 'C:\\Local' },
      platformName: 'linux',
    });

    expect(env['APPDATA']).toBeUndefined();
    expect(env['LOCALAPPDATA']).toBeUndefined();
  });

  it('forwards nothing that is not on the list', () => {
    const source = busyEnvironment();
    const env = daemonEnvironment({ source });

    const allowed = new Set([
      'PATH',
      'HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'ALL_PROXY',
      'all_proxy',
      'LANG',
      'LANGUAGE',
      'LC_ALL',
      'TZ',
      'APPDATA',
      'LOCALAPPDATA',
    ]);

    for (const name of Object.keys(env)) {
      expect(allowed.has(name), `${name} was forwarded but is not on the list`).toBe(true);
    }
  });
});
