/**
 * The approver credential (Phase 0, gap 1).
 *
 * ## The problem this solves
 *
 * In v1 the daemon had one credential: the bearer token in `daemon.token`.
 * The agent holds it, because the agent has to call the daemon. And the
 * same token could call `approve.issue`, which minted the one-time token
 * that let a refused action proceed.
 *
 * That means the agent could approve its own actions. The approval gate
 * recorded that "a human approved this", but the thing doing the
 * approving was the agent.
 *
 * ## The split
 *
 * Two roles, two credentials:
 *
 *   - the **agent** holds the daemon token. It can propose actions, read
 *     snapshots, and anything else a client can do.
 *   - the **approver** holds a separate credential in `approver.token`,
 *     mode 0600, which the agent's process never reads.
 *
 * `approve.issue` checks the approver credential. Without it, the request
 * is refused — and the refusal says so plainly, because an agent that
 * cannot tell "you need a human" from "you are not allowed to ask" will
 * keep trying.
 *
 * ## The two channels
 *
 * A human has to be able to approve without giving the agent a
 * credential. Two are implemented:
 *
 *  1. **A controlling terminal.** The daemon records the TTY that started
 *     it. A prompt is written to that TTY, which the agent's process
 *     cannot write to: it is not the agent's stdin, not the agent's
 *     stdout, and the agent has no handle on it.
 *
 *  2. **A one-time approval code.** The daemon prints a short code and a
 *     URL for a local approval page. The human reads the code from the
 *     terminal the daemon was started in and enters it. The agent never
 *     sees it, because it is written to the controlling TTY rather than
 *     to the agent's output.
 *
 * The second channel is what makes the tool usable from an agent at all:
 * the agent can say "this needs approval, code ABCD is waiting", and the
 * human types the code into a second terminal. The code is bound to one
 * action and expires.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bvRoot } from '../core/paths.js';

/** The approver credential's file name, inside `.bv/`. */
export const APPROVER_TOKEN_FILE = 'approver.token';

/** The header the approver credential travels in. */
export const APPROVER_TOKEN_HEADER = 'x-bv-approver';

/** How long a pending approval code stays valid. */
export const APPROVAL_CODE_TTL_MS = 5 * 60 * 1000;

/** How many wrong codes are allowed before the channel locks. */
export const MAX_FAILED_CODE_ATTEMPTS = 10;

/** A pending approval, waiting for a human. */
export interface PendingApproval {
  /** The action id. */
  actionId: string;
  /** The action hash the token will be bound to. */
  actionHash: string;
  /** What the human is being asked to approve. */
  description: string;
  /** The short code the human types. */
  code: string;
  /** When it was created. */
  createdAt: number;
}

/**
 * The approver credential.
 *
 * The secret is only ever written to a 0600 file. The hash is what goes
 * into the daemon descriptor, so the descriptor can be read by the agent
 * without the agent being able to forge an approval.
 */
export class ApproverCredential {
  private constructor(
    private readonly secret: string,
    private readonly hash: string,
  ) {}

  /**
   * Load the credential, creating it if it does not exist.
   *
   * The file is created with mode 0600 and chmod-ed afterwards, because
   * the file mode on creation is affected by the process umask.
   *
   * The chmod is injectable so the failure path can be tested: on
   * Windows chmod never fails, so that path would otherwise only ever
   * run on Linux, in CI, where nobody would notice it was uncovered.
   */
  static async load(
    cwd: string,
    options: { chmod?: (path: string, mode: number) => Promise<void> } = {},
  ): Promise<ApproverCredential> {
    const path = approverTokenPath(cwd);
    const setMode = options.chmod ?? chmod;

    let secret: string;
    try {
      secret = (await readFile(path, 'utf8')).trim();
      if (secret.length === 0) throw new Error('the approver token file is empty');
    } catch {
      secret = randomBytes(32).toString('hex');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await setMode(path, 0o600);
      } catch {
        // A filesystem that does not support chmod is not a reason to
        // refuse to start. The file is inside the operator's own
        // workspace.
      }
    }

    return new ApproverCredential(secret, hashApproverToken(secret));
  }

  /** The hash of the secret. Safe to write into a descriptor. */
  get tokenHash(): string {
    return this.hash;
  }

  /**
   * The secret itself.
   *
   * Only the operator's client calls this. The agent's process never
   * loads an `ApproverCredential`, so it never gets here. If you are
   * holding one of these, you are running code the operator chose to run.
   */
  revealSecret(): string {
    return this.secret;
  }

  /**
   * Whether a presented secret matches this credential.
   *
   * The comparison is constant-time, so a caller cannot learn the secret
   * by timing how long the comparison took.
   */
  matches(presented: string): boolean {
    return compareHashes(hashApproverToken(presented), this.hash);
  }
}

/** Hash an approver token for storage and comparison. */
export function hashApproverToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two hex hashes in constant time.
 *
 * `timingSafeEqual` throws when the two buffers have different lengths,
 * so the length is checked first. A mismatch is a refusal, not a crash.
 */
export function compareHashes(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** The path of the approver credential. */
export function approverTokenPath(cwd: string = process.cwd()): string {
  return join(bvRoot(cwd), APPROVER_TOKEN_FILE);
}

/**
 * The pending approvals, waiting for a human.
 *
 * The codes are short enough to read aloud and type, and long enough
 * that guessing one within its lifetime is not practical.
 */
export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly byCode = new Map<string, string>();
  /** How many wrong codes have been tried, in total. */
  private failedAttempts = 0;

  /** Add a pending approval and return its code. */
  add(actionId: string, actionHash: string, description: string): PendingApproval {
    // Expire anything old before adding, so the map does not grow.
    this.prune();

    const code = makeCode();
    const entry: PendingApproval = {
      actionId,
      actionHash,
      description,
      code,
      createdAt: Date.now(),
    };

    this.pending.set(actionId, entry);
    this.byCode.set(code, actionId);
    return entry;
  }

  /** The pending approval for an action id. */
  get(actionId: string): PendingApproval | undefined {
    const found = this.pending.get(actionId);
    if (found === undefined) return undefined;
    if (Date.now() - found.createdAt > APPROVAL_CODE_TTL_MS) {
      this.remove(actionId);
      return undefined;
    }
    return found;
  }

  /**
   * The pending approval for a code.
   *
   * A wrong code counts as an attempt. After too many, the channel
   * locks: a six-character code is long enough that guessing it is not
   * practical, but a lock makes guessing it pointless too.
   */
  getByCode(code: string): PendingApproval | undefined {
    if (this.locked) return undefined;

    const actionId = this.byCode.get(code.toUpperCase());
    if (actionId === undefined) {
      this.failedAttempts += 1;
      return undefined;
    }
    return this.get(actionId);
  }

  /** Whether the channel has locked after too many wrong codes. */
  get locked(): boolean {
    return this.failedAttempts >= MAX_FAILED_CODE_ATTEMPTS;
  }

  /** How many wrong codes have been tried. */
  get attempts(): number {
    return this.failedAttempts;
  }

  /** Every pending approval. */
  list(): PendingApproval[] {
    this.prune();
    return [...this.pending.values()];
  }

  /** Remove a pending approval. */
  remove(actionId: string): boolean {
    const entry = this.pending.get(actionId);
    if (entry === undefined) return false;
    this.byCode.delete(entry.code);
    return this.pending.delete(actionId);
  }

  /** Remove the expired ones. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [actionId, entry] of [...this.pending]) {
      if (now - entry.createdAt > APPROVAL_CODE_TTL_MS) {
        this.byCode.delete(entry.code);
        this.pending.delete(actionId);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Make a short approval code.
 *
 * Six characters from an alphabet with no ambiguous characters, so a code
 * read off a screen can be typed back without a question.
 */
export function makeCode(): string {
  // No 0/O, 1/I, 5/S, 8/B, 2/Z: the characters people misread when
  // they are copying a code off a screen.
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679';
  const bytes = randomBytes(6);
  let code = '';
  for (const byte of bytes) {
    code += alphabet[byte % alphabet.length];
  }
  return code;
}
