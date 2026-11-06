/**
 * Time-travel snapshots (M14).
 *
 * Each step stores the state that was needed to reproduce it: the URL, the
 * ARIA snapshot, a screenshot, the storage state, the cookies and a slice of
 * the network traffic.
 *
 * `bv rewind --to N` creates a **branch run**: it restores the storage
 * state, navigates to the step's URL, and carries on from there.
 *
 * What this cannot do is stated plainly in `docs/KNOWN_LIMITATIONS.md`:
 * in-page JavaScript state and server-side state cannot be restored. The
 * rewind gets the browser back to the same *place*, not to the same
 * *moment*.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runDir, stepDir } from '../core/paths.js';

/** The state stored for one step. */
export interface StepSnapshot {
  /** The step number. */
  step: number;
  /** The URL the page was at. */
  url: string;
  /** The path of the ARIA snapshot. */
  ariaPath: string;
  /** The path of the screenshot, when there is one. */
  screenshotPath?: string;
  /** The path of the storage-state file, when there is one. */
  statePath?: string;
  /** The path of the network slice, when there is one. */
  netPath?: string;
  /** The hash of the storage state, so a change can be detected. */
  storageHash?: string;
  /** The cookies, with the values redacted. */
  cookies?: { name: string; value: string; domain: string }[];
  /** When the step was captured. */
  capturedAt: string;
}

/** The result of a rewind. */
export interface RewindResult {
  /** The run that was created. */
  branchRunId: string;
  /** The step that was rewound to. */
  toStep: number;
  /** The URL the browser was taken to. */
  url: string;
  /** Whether the storage state was restored. */
  storageRestored: boolean;
  /** What could not be restored. */
  notRestored: string[];
}

/**
 * Read the snapshots of a run, oldest first.
 *
 * A step that has no snapshot file is skipped: a run that was interrupted
 * mid-step has fewer snapshots than steps.
 */
export async function readSnapshots(
  runId: string,
  cwd: string = process.cwd(),
): Promise<StepSnapshot[]> {
  const stepsDir = join(runDir(runId, cwd), 'steps');

  let entries: string[];
  try {
    entries = await readdir(stepsDir);
  } catch {
    return [];
  }

  const snapshots: StepSnapshot[] = [];
  for (const entry of entries.sort()) {
    const statePath = join(stepsDir, entry, 'state.json');
    try {
      const raw = await readFile(statePath, 'utf8');
      const state = JSON.parse(raw) as Record<string, unknown>;
      snapshots.push({
        step: Number.parseInt(entry, 10),
        url: typeof state['url'] === 'string' ? state['url'] : '',
        ariaPath: join(stepsDir, entry, 'aria.txt'),
        ...(typeof state['screenshotPath'] === 'string'
          ? { screenshotPath: state['screenshotPath'] }
          : {}),
        statePath,
        ...(typeof state['storageHash'] === 'string' ? { storageHash: state['storageHash'] } : {}),
        ...(Array.isArray(state['cookies'])
          ? { cookies: state['cookies'] as { name: string; value: string; domain: string }[] }
          : {}),
        capturedAt: typeof state['capturedAt'] === 'string' ? state['capturedAt'] : '',
      });
    } catch {
      // A step without a state file has no snapshot.
    }
  }

  return snapshots;
}

/**
 * Find the snapshot for a step.
 *
 * Returns undefined when the step has no snapshot.
 */
export async function findSnapshot(
  runId: string,
  step: number,
  cwd: string = process.cwd(),
): Promise<StepSnapshot | undefined> {
  const snapshots = await readSnapshots(runId, cwd);
  return snapshots.find((snapshot) => snapshot.step === step);
}

/**
 * The things a rewind cannot restore.
 *
 * This list is returned with every rewind so the caller can tell the user
 * exactly what they are not getting.
 */
export const NOT_RESTORED: readonly string[] = [
  'in-page JavaScript state (variables, closures, the DOM the script built)',
  'server-side state (the database, the session, anything the server computed)',
  'open network connections and service workers',
  'the browser history and the back/forward stack',
];

/**
 * Plan a rewind.
 *
 * The plan says what to restore and what cannot be restored. It is a pure
 * function so the behaviour can be tested without a browser.
 */
export function planRewind(
  snapshot: StepSnapshot | undefined,
  step: number,
): { url: string; storageRestored: boolean; notRestored: string[] } {
  if (snapshot === undefined) {
    return {
      url: '',
      storageRestored: false,
      notRestored: [
        ...NOT_RESTORED,
        `the state of step ${step}, because that step has no snapshot`,
      ],
    };
  }

  return {
    url: snapshot.url,
    // The storage state is restored only when there is one to restore.
    storageRestored: snapshot.statePath !== undefined,
    notRestored: [...NOT_RESTORED],
  };
}

/**
 * Redact a cookie's value.
 *
 * The name and domain are useful for understanding the state; the value is
 * a secret.
 */
export function redactCookie(cookie: { name: string; value: string; domain: string }): {
  name: string;
  value: string;
  domain: string;
} {
  return { ...cookie, value: '[REDACTED]' };
}

/**
 * The path of a step's directory.
 */
export function snapshotDir(runId: string, step: number, cwd: string = process.cwd()): string {
  return stepDir(runId, step, cwd);
}
