/**
 * Site memory (M16).
 *
 * The playbooks database remembers what worked: the selectors that found an
 * element, the quirks of a site, the steps of a login.
 *
 * Two rules keep it honest:
 *
 *  1. **Entries expire.** The default lifetime is 30 days. A site that
 *     changed its markup last month should not be trusted today.
 *  2. **Confidence decays on failure.** A selector that stops working is
 *     less trusted, not more, and a selector that keeps working is more
 *     trusted.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { playbooksPath } from '../core/paths.js';

/** One remembered fact about a site. */
export interface PlaybookEntry {
  /** The origin the entry is about. */
  origin: string;
  /** The key, e.g. `selector:login-button`. */
  key: string;
  /** The value, e.g. `role=button name="Sign in"`. */
  value: string;
  /** How confident the entry is, from 0 to 1. */
  confidence: number;
  /** When the entry was last confirmed to work. */
  lastVerifiedAt: string;
  /** When the entry expires. */
  expiresAt: string;
}

/** The options for the playbook store. */
export interface PlaybookOptions {
  /** How long an entry lives, in days. */
  ttlDays?: number;
}

/** The default entry lifetime, in days. */
export const DEFAULT_TTL_DAYS = 30;

/**
 * The playbook store.
 *
 * A thin wrapper over SQLite. The database is opened lazily so that a
 * command that does not need it does not create the file.
 */
export class Playbooks {
  private db: Database.Database | undefined;

  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly options: PlaybookOptions = {},
  ) {}

  /** Open the database and make sure the schema exists. */
  private open(): Database.Database {
    if (this.db !== undefined) return this.db;

    const path = playbooksPath(this.cwd);
    // The directory is created synchronously so the constructor can stay
    // synchronous: better-sqlite3 needs the directory to exist before the
    // database file is opened.
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS playbooks (
        origin          TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        confidence      REAL NOT NULL DEFAULT 1.0,
        last_verified_at TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        PRIMARY KEY (origin, key)
      );
      CREATE INDEX IF NOT EXISTS playbooks_expiry ON playbooks (expires_at);
    `);
    this.db = db;
    return db;
  }

  /** Close the database. */
  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  /**
   * Remember something.
   *
   * Storing an existing key refreshes it and raises its confidence.
   */
  remember(origin: string, key: string, value: string): PlaybookEntry {
    const db = this.open();
    const now = new Date();
    const ttlDays = this.options.ttlDays ?? DEFAULT_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const existing = db
      .prepare('SELECT confidence FROM playbooks WHERE origin = ? AND key = ?')
      .get(origin, key) as { confidence: number } | undefined;

    // A repeated success raises the confidence, up to 1.
    const confidence = Math.min(1, (existing?.confidence ?? 0.5) + 0.1);

    db.prepare(
      `INSERT INTO playbooks (origin, key, value, confidence, last_verified_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(origin, key) DO UPDATE SET
         value = excluded.value,
         confidence = excluded.confidence,
         last_verified_at = excluded.last_verified_at,
         expires_at = excluded.expires_at`,
    ).run(origin, key, value, confidence, now.toISOString(), expiresAt.toISOString());

    return {
      origin,
      key,
      value,
      confidence,
      lastVerifiedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Look something up.
   *
   * An expired entry is not returned, and is deleted as it is found.
   */
  recall(origin: string, key: string): PlaybookEntry | undefined {
    const db = this.open();
    const row = db
      .prepare('SELECT * FROM playbooks WHERE origin = ? AND key = ?')
      .get(origin, key) as
      | {
          origin: string;
          key: string;
          value: string;
          confidence: number;
          last_verified_at: string;
          expires_at: string;
        }
      | undefined;

    if (row === undefined) return undefined;

    if (Date.parse(row.expires_at) <= Date.now()) {
      this.forget(origin, key);
      return undefined;
    }

    return {
      origin: row.origin,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      lastVerifiedAt: row.last_verified_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Record that something stopped working.
   *
   * The confidence drops. An entry that has lost all confidence is
   * forgotten, so a broken selector is not carried forward.
   */
  recordFailure(origin: string, key: string): PlaybookEntry | undefined {
    const db = this.open();
    const entry = this.recall(origin, key);
    if (entry === undefined) return undefined;

    const confidence = entry.confidence - 0.25;
    if (confidence <= 0) {
      this.forget(origin, key);
      return undefined;
    }

    db.prepare('UPDATE playbooks SET confidence = ? WHERE origin = ? AND key = ?').run(
      confidence,
      origin,
      key,
    );

    return { ...entry, confidence };
  }

  /** Forget one entry. */
  forget(origin: string, key: string): boolean {
    const db = this.open();
    const result = db
      .prepare('DELETE FROM playbooks WHERE origin = ? AND key = ?')
      .run(origin, key);
    return result.changes > 0;
  }

  /** Every entry for an origin. */
  list(origin?: string): PlaybookEntry[] {
    const db = this.open();
    const rows = (
      origin === undefined
        ? db.prepare('SELECT * FROM playbooks ORDER BY origin, key').all()
        : db.prepare('SELECT * FROM playbooks WHERE origin = ? ORDER BY key').all(origin)
    ) as {
      origin: string;
      key: string;
      value: string;
      confidence: number;
      last_verified_at: string;
      expires_at: string;
    }[];

    return rows.map((row) => ({
      origin: row.origin,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      lastVerifiedAt: row.last_verified_at,
      expiresAt: row.expires_at,
    }));
  }

  /** Remove every expired entry. */
  prune(): number {
    const db = this.open();
    const result = db
      .prepare('DELETE FROM playbooks WHERE expires_at <= ?')
      .run(new Date().toISOString());
    return result.changes;
  }

  /** How many entries are stored. */
  count(): number {
    const db = this.open();
    const row = db.prepare('SELECT COUNT(*) AS n FROM playbooks').get() as { n: number };
    return row.n;
  }

  /** Remove every entry. */
  clear(): void {
    this.open().exec('DELETE FROM playbooks');
  }
}

/**
 * The origin of a URL, for keying the playbooks.
 *
 * The path is not part of the key: a site is a site.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Render a list of entries for a human.
 */
export function renderPlaybooks(entries: readonly PlaybookEntry[]): string {
  if (entries.length === 0) return '(the playbook is empty)';
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(
      `${entry.origin}  ${entry.key} = ${entry.value}  (confidence ${entry.confidence.toFixed(2)}, expires ${entry.expiresAt.slice(0, 10)})`,
    );
  }
  return lines.join('\n');
}
