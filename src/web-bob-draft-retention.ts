import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export const WEB_BOB_TERMINAL_DRAFT_LIMIT = 10000;
export const WEB_BOB_REVISION_LINEAGE_LIMIT = 20000;

interface RevisionScope {
  actor: string;
  conversationId: string;
  epoch: string;
  draftId: string;
  revision: number;
}

type Fail = (status: number, message: string) => never;

const lineageIdentity = (scope: RevisionScope): string =>
  JSON.stringify([
    scope.actor,
    scope.conversationId,
    scope.epoch,
    scope.draftId,
  ]);
const lineageKey = (identity: string): string =>
  createHash('sha256').update(identity).digest('hex');

/** Detailed receipts may expire; revision high-water marks never do. Once the
 * bounded registry fills, new lineages fail closed while known ones may advance.
 * This avoids replacing an unbounded draft store with unbounded tombstones. */
export class WebBobDraftRetention {
  constructor(
    private readonly db: Database.Database,
    private readonly fail: Fail,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS webbob_revision_watermarks (
      lineageKey TEXT PRIMARY KEY,
      identity TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webbob_retention_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      admissionSealed INTEGER NOT NULL CHECK (admissionSealed IN (0, 1))
    );
    INSERT OR IGNORE INTO webbob_retention_state VALUES (1, 0);`);
  }

  private requireLineageCapacity(): void {
    const state = this.db
      .prepare(
        `SELECT admissionSealed,
          (SELECT count(*) FROM webbob_revision_watermarks) AS count
         FROM webbob_retention_state WHERE id = 1`,
      )
      .get() as { admissionSealed: number; count: number };
    if (state.admissionSealed || state.count >= WEB_BOB_REVISION_LINEAGE_LIMIT)
      this.fail(503, 'Web Bob bridge retained revision limit reached.');
  }

  /** Call under the admission write lock, before staging or creating an action. */
  assertRevision(scope: RevisionScope): void {
    const watermark = this.db
      .prepare(
        'SELECT revision FROM webbob_revision_watermarks WHERE lineageKey = ?',
      )
      .get(lineageKey(lineageIdentity(scope))) as
      | { revision: number }
      | undefined;
    // Also cover rows restored or inserted after startup, before backfill runs.
    const retained = this.db
      .prepare(
        `SELECT id FROM webbob_drafts
         WHERE json_extract(scope, '$.actor') = ?
           AND json_extract(scope, '$.conversationId') = ?
           AND json_extract(scope, '$.epoch') = ?
           AND json_extract(scope, '$.draftId') = ?
           AND json_extract(scope, '$.revision') >= ? LIMIT 1`,
      )
      .get(
        scope.actor,
        scope.conversationId,
        scope.epoch,
        scope.draftId,
        scope.revision,
      );
    if ((watermark && watermark.revision >= scope.revision) || retained)
      this.fail(
        409,
        'This draft revision already exists or is stale; review a fresh draft.',
      );
    if (!watermark) this.requireLineageCapacity();
  }

  /** Commit this in the same transaction as the successfully delivered draft. */
  recordRevision(scope: RevisionScope): void {
    this.assertRevision(scope);
    const identity = lineageIdentity(scope);
    this.db
      .prepare(
        `INSERT INTO webbob_revision_watermarks (lineageKey, identity, revision)
         VALUES (?, ?, ?)
         ON CONFLICT(lineageKey) DO UPDATE SET revision = excluded.revision`,
      )
      .run(lineageKey(identity), identity, scope.revision);
  }

  private backfill(): void {
    // Process known lineages first so even an oversized legacy store preserves
    // all tracked maxima. At most the fixed registry capacity plus one unknown
    // lineage is needed to detect overflow; never load unbounded history into JS.
    const revisions = this.db
      .prepare(
        `WITH retained AS (
          SELECT json_array(
            json_extract(scope, '$.actor'),
            json_extract(scope, '$.conversationId'),
            json_extract(scope, '$.epoch'),
            json_extract(scope, '$.draftId')
          ) AS identity, max(json_extract(scope, '$.revision')) AS revision
          FROM webbob_drafts GROUP BY identity
        )
        SELECT retained.identity, retained.revision,
          watermark.lineageKey AS existingKey
        FROM retained
        LEFT JOIN webbob_revision_watermarks watermark
          ON watermark.identity = retained.identity
        WHERE watermark.lineageKey IS NULL
          OR watermark.revision < retained.revision
        ORDER BY watermark.lineageKey IS NULL, retained.identity
        LIMIT ?`,
      )
      .all(WEB_BOB_REVISION_LINEAGE_LIMIT + 1) as {
      identity: string;
      revision: number;
      existingKey: string | null;
    }[];
    let count = (
      this.db
        .prepare('SELECT count(*) AS count FROM webbob_revision_watermarks')
        .get() as { count: number }
    ).count;
    const save = this.db.prepare(
      `INSERT INTO webbob_revision_watermarks (lineageKey, identity, revision)
       VALUES (?, ?, ?)
       ON CONFLICT(lineageKey) DO UPDATE SET revision = excluded.revision`,
    );
    for (const row of revisions) {
      const identity: unknown = JSON.parse(row.identity);
      if (
        !Array.isArray(identity) ||
        identity.length !== 4 ||
        !identity.every((part) => typeof part === 'string') ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        this.fail(503, 'Web Bob bridge retained revision data is invalid.');
      if (!row.existingKey && count >= WEB_BOB_REVISION_LINEAGE_LIMIT) {
        // Some legacy identities could not be represented. Permanently close
        // admission for ALL untracked identities before any rows are pruned.
        this.db
          .prepare(
            'UPDATE webbob_retention_state SET admissionSealed = 1 WHERE id = 1',
          )
          .run();
        break;
      }
      save.run(
        row.existingKey ?? lineageKey(row.identity),
        row.identity,
        row.revision,
      );
      if (!row.existingKey) count += 1;
    }
  }

  /** Safe both at startup and inside the caller's admission transaction. */
  prune(now: number): void {
    const prune = () => {
      this.db
        .prepare(
          `UPDATE webbob_drafts SET state = 'expired', challengeHash = ''
           WHERE state IN ('pending', 'awaiting_delivery') AND expires <= ?`,
        )
        .run(now);
      this.backfill();
      this.db
        .prepare(
          `DELETE FROM webbob_drafts
           WHERE state NOT IN ('pending', 'awaiting_delivery')
             AND rowid NOT IN (
               SELECT rowid FROM webbob_drafts
               WHERE state NOT IN ('pending', 'awaiting_delivery')
               ORDER BY expires DESC, rowid DESC LIMIT ?
             )`,
        )
        .run(WEB_BOB_TERMINAL_DRAFT_LIMIT);
      this.db
        .prepare(
          `DELETE FROM webbob_delivery
           WHERE NOT EXISTS (
             SELECT 1 FROM webbob_drafts WHERE id = webbob_delivery.draftId
           )`,
        )
        .run();
    };
    if (this.db.inTransaction) prune();
    else this.db.transaction(prune).immediate();
  }
}
