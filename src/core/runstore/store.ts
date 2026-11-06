/**
 * The run store.
 *
 * Every command writes a step record. The audit log is append-only: one JSON
 * object per line, timestamped, with secrets masked.
 *
 * Layout:
 *
 *   .bv/runs/<runId>/
 *     ├── audit.jsonl
 *     ├── result.json
 *     └── steps/NNN/{ aria.txt, screenshot.png, state.json, net.json }
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditPath, runDir, stepDir } from '../paths.js';
import type { RecordedRun } from '../../compile/ir.js';

/** The status of a run. */
export type RunStatus = 'running' | 'verified' | 'unverified' | 'failed' | 'stopped';

/** One recorded step. */
export interface StepRecord {
  /** 1-based step number. */
  step: number;
  /** What was done, e.g. `click`, `goto`, `snapshot`. */
  action: string;
  /** The target, as the user described it. */
  target?: string;
  /** The locator strategy that succeeded. */
  strategy?: string;
  /** How long the action took. */
  durationMs: number;
  /** The URL before the action. */
  urlBefore: string;
  /** The URL after the action. */
  urlAfter: string;
  /** The policy verdict for this step. */
  policyVerdict?: string;
  /** Taint information for the step. */
  taint?: { tainted: boolean; sources?: string[] };
  /** The path of the full snapshot for this step. */
  snapshotPath?: string;
  /** The path of the screenshot for this step. */
  screenshotPath?: string;
  /** Whether the step succeeded. */
  ok: boolean;
  /** A message describing the outcome. */
  message?: string;
  /** When the step happened, ISO-8601. */
  timestamp: string;
  /** Injection findings raised during this step. */
  injectionFindings?: number;
  /** Console errors seen since the previous step. */
  consoleErrors?: string[];
}

/** The final result of a run. */
export interface RunResult {
  /** The run id. */
  runId: string;
  /** The run's status. */
  status: RunStatus;
  /** The goal, when the run had one. */
  goal?: string;
  /** The number of steps taken. */
  steps: number;
  /** When the run started, ISO-8601. */
  startedAt: string;
  /** When the run ended, ISO-8601. */
  endedAt?: string;
  /** The final URL. */
  finalUrl?: string;
  /** The verification result. */
  verification?: {
    passed: boolean;
    conditions: { type: string; passed: boolean; detail?: string }[];
  };
  /** The error that ended the run, if any. */
  error?: string;
}

/**
 * Read a recorded run from the run store.
 *
 * Returns the IR as it was written. Throws when the run has no recording,
 * which is the case for a run that was made before the recorder existed or
 * that ended before any step succeeded.
 */
export async function readRun(
  runId: string,
  cwd: string = process.cwd(),
): Promise<RecordedRun> {
  const store = new RunStore(runId, cwd);
  const recorded = (await store.readRecorded()) as RecordedRun | undefined;

  if (recorded === undefined) {
    throw new Error(`the run ${runId} has no recording. Only runs made with the recorder can be compiled.`);
  }
  return recorded;
}

/** A run id: a timestamp plus a short random suffix, sortable and unique. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * The run store.
 *
 * Owns the on-disk layout of one run.
 */
export class RunStore {
  readonly runId: string;
  readonly cwd: string;
  private readonly startedAt: string;
  private stepCountValue = 0;

  constructor(runId: string, cwd: string, startedAt: string = new Date().toISOString()) {
    this.runId = runId;
    this.cwd = cwd;
    this.startedAt = startedAt;
  }

  /** The root directory of the run. */
  get dir(): string {
    return runDir(this.runId, this.cwd);
  }

  /** Create the run's directories. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, 'steps'), { recursive: true });
  }

  /** Append a line to the audit log. */
  async audit(record: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    await appendFile(auditPath(this.runId, this.cwd), line, 'utf8');
  }

  /** Read the audit log. */
  async readAudit(): Promise<Record<string, unknown>[]> {
    try {
      const raw = await readFile(auditPath(this.runId, this.cwd), 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /** Write the full snapshot text for a step. */
  async writeSnapshot(step: number, text: string): Promise<string> {
    const dir = stepDir(this.runId, step, this.cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'aria.txt');
    await writeFile(path, text, 'utf8');
    return path;
  }

  /** Write the screenshot for a step. */
  async writeScreenshot(step: number, data: Buffer): Promise<string> {
    const dir = stepDir(this.runId, step, this.cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'screenshot.png');
    await writeFile(path, data);
    return path;
  }

  /** Write the state snapshot for a step. */
  async writeState(step: number, state: Record<string, unknown>): Promise<string> {
    const dir = stepDir(this.runId, step, this.cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'state.json');
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return path;
  }

  /** Write the network slice for a step. */
  async writeNetwork(step: number, network: unknown): Promise<string> {
    const dir = stepDir(this.runId, step, this.cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'net.json');
    await writeFile(path, `${JSON.stringify(network, null, 2)}\n`, 'utf8');
    return path;
  }

  /** Write a step record to the audit log and return it. */
  async recordStep(record: StepRecord): Promise<void> {
    this.stepCountValue += 1;
    await this.audit({ type: 'step', ...record });
  }

  /** Write the final result. */
  async writeResult(result: RunResult): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  /**
   * Write the recorded IR of the run.
   *
   * The IR is what `bv compile` reads, so it is kept separate from the
   * audit log: the audit log is append-only and machine-oriented, the IR
   * is the human-facing record of what the agent did.
   */
  async writeRecorded(recorded: unknown): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, 'recorded.json');
    await writeFile(path, JSON.stringify(recorded, null, 2), 'utf8');
    return path;
  }

  /** Read the run's recorded IR. */
  async readRecorded(): Promise<unknown> {
    try {
      const raw = await readFile(join(this.dir, 'recorded.json'), 'utf8');
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Read the run's result. */
  async readResult(): Promise<RunResult | undefined> {
    try {
      const raw = await readFile(join(this.dir, 'result.json'), 'utf8');
      return JSON.parse(raw) as RunResult;
    } catch {
      return undefined;
    }
  }

  /** The run's start time. */
  get started(): string {
    return this.startedAt;
  }

  /** How many steps have been recorded. */
  get stepCount(): number {
    return this.stepCountValue;
  }
}
