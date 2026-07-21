import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const LEARNING_COLUMNS = [
  'adaptive_status',
  'adaptive_kind',
  'adaptive_metadata_json',
  'expires_at',
  'review_after',
  'owner_review_required',
  'production_eligible',
  'applied_count',
  'last_applied_at',
] as const;

const EPISODE_COLUMNS = [
  'updated_at',
  'schema_version',
  'unified_frame_id',
  'turn_id',
  'conversation_id',
  'group_folder',
  'scope_key',
  'run_origin',
  'intent_refs_json',
  'response_contract_id',
  'response_evaluation_id',
  'action_evidence_refs_json',
  'provider_receipt_ids_json',
  'goal_ids_json',
  'commitment_ids_json',
  'observations_json',
  'reconciled_outcome_json',
  'owner_feedback_json',
  'learning_candidate_ids_json',
  'applied_lesson_ids_json',
  'lifecycle_event_ids_json',
  'rollback_event_ids_json',
  'expires_at',
  'bounds_json',
] as const;

describe('adaptive grounded intelligence migration', () => {
  it('upgrades legacy episode and learning rows additively and fail-closed', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-adaptive-grounded-migration-'),
    );
    const dbPath = path.join(tempDir, 'messages.db');
    try {
      vi.resetModules();
      const dbModule = await import('./db.js');
      dbModule._initTestDatabaseAtPath(dbPath);
      dbModule._closeDatabase();

      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        DROP INDEX idx_grounded_learning_records_adaptive;
        DROP INDEX idx_cognitive_episodes_turn;
        DROP INDEX idx_cognitive_episodes_frame;
        DROP TABLE grounded_learning_lifecycle_events;
      `);
      for (const column of LEARNING_COLUMNS) {
        legacyDb.exec(
          `ALTER TABLE grounded_learning_records DROP COLUMN ${column}`,
        );
      }
      for (const column of EPISODE_COLUMNS) {
        legacyDb.exec(`ALTER TABLE cognitive_episodes DROP COLUMN ${column}`);
      }
      legacyDb
        .prepare(
          `
            INSERT INTO grounded_learning_records (
              record_id, created_at, updated_at, kind, status, subject,
              context_key, lesson, evidence_refs_json,
              counter_evidence_refs_json, applies_to_authority, review_note,
              source_turn_id, privacy_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
          `,
        )
        .run(
          'legacy-learning',
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          'outcome',
          'accepted',
          'legacy subject',
          'legacy scope',
          'legacy response lesson',
          '[]',
          '[]',
          'pre-adaptive accepted record',
          'legacy-turn',
          '{}',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO cognitive_episodes (
              episode_id, created_at, ask_summary, channel, goal_id,
              reasoning_mode, selected_context_summary, action_id, result,
              user_correction, confidence, lesson, follow_up_needed,
              sensitivity, retention_policy, privacy_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-episode',
          '2026-07-01T00:00:00.000Z',
          'legacy ask',
          'telegram',
          null,
          'direct',
          'legacy context',
          null,
          'unknown',
          null,
          0.5,
          'legacy lesson',
          null,
          'private',
          'bounded',
          '{}',
        );
      legacyDb.close();

      dbModule._initTestDatabaseAtPath(dbPath);
      expect(
        dbModule.listGroundedLearningRecords({ limit: 10 })[0],
      ).toMatchObject({
        recordId: 'legacy-learning',
        status: 'accepted',
        adaptiveStatus: null,
        ownerReviewRequired: true,
        productionEligible: false,
        appliedCount: 0,
      });
      expect(dbModule.listCognitiveEpisodes({ limit: 10 })[0]).toMatchObject({
        episodeId: 'legacy-episode',
        schemaVersion: null,
        turnId: null,
        runOrigin: null,
      });
      expect(
        dbModule.listAdaptiveLearningLifecycleEvents({ limit: 10 }),
      ).toEqual([]);
      dbModule._closeDatabase();

      const migratedDb = new Database(dbPath, { readonly: true });
      const learningColumns = migratedDb
        .prepare(`PRAGMA table_info(grounded_learning_records)`)
        .all() as Array<{ name: string }>;
      const episodeColumns = migratedDb
        .prepare(`PRAGMA table_info(cognitive_episodes)`)
        .all() as Array<{ name: string }>;
      const lifecycleTable = migratedDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get('grounded_learning_lifecycle_events');
      migratedDb.close();

      expect(learningColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining([...LEARNING_COLUMNS]),
      );
      expect(episodeColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining([...EPISODE_COLUMNS]),
      );
      expect(lifecycleTable).toBeTruthy();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
