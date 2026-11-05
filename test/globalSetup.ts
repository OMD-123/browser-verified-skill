/**
 * Vitest global setup: starts the local fixture server once for the whole test
 * run and exposes its origin to every test file through an environment
 * variable.
 *
 * Tests never touch the public internet: every URL they need comes from this
 * server (or from a second instance of it, for cross-origin frames).
 *
 * Vitest 5 global-setup contract: the module exports `setup`, which receives
 * the project and returns a teardown function.
 */
import { startFixtureServerPair, type FixtureServer } from '../fixtures/server.js';

let primary: FixtureServer | undefined;
let secondary: FixtureServer | undefined;

export async function setup(): Promise<() => Promise<void>> {
  const pair = await startFixtureServerPair();
  primary = pair.primary;
  secondary = pair.secondary;

  process.env['BV_FIXTURE_ORIGIN'] = primary.origin;
  process.env['BV_FIXTURE_CROSS_ORIGIN'] = secondary.origin;
  process.env['BV_FIXTURE_PORT'] = String(primary.port);
  process.env['BV_FIXTURE_CROSS_PORT'] = String(secondary.port);

  return async () => {
    await primary?.close();
    await secondary?.close();
    primary = undefined;
    secondary = undefined;
  };
}

/** The fixture server origin for the current test run. */
export function fixtureOrigin(): string {
  const origin = process.env['BV_FIXTURE_ORIGIN'];
  if (!origin) throw new Error('fixture server is not running');
  return origin;
}

/** The cross-origin fixture server origin for the current test run. */
export function crossOrigin(): string {
  const origin = process.env['BV_FIXTURE_CROSS_ORIGIN'];
  if (!origin) throw new Error('cross-origin fixture server is not running');
  return origin;
}
