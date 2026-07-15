import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  isDatabaseInitialized,
  listCognitiveApprovalPackets,
} from './db.js';

const roots: string[] = [];

function databasePath(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'andrea-durable-migration-'),
  );
  roots.push(root);
  return path.join(root, 'fixture.sqlite');
}

afterEach(() => {
  if (isDatabaseInitialized()) _closeDatabase();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('durable continuity schema migration', () => {
  it('upgrades an old approval row idempotently without inventing historical evidence', () => {
    const dbPath = databasePath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE cognitive_runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        group_folder TEXT,
        channel TEXT,
        task_family TEXT NOT NULL,
        turn_id TEXT,
        run_origin TEXT NOT NULL DEFAULT 'live',
        goal_summary TEXT NOT NULL,
        selected_skill_id TEXT NOT NULL,
        status TEXT NOT NULL,
        autonomy_level TEXT NOT NULL,
        cognitive_mode TEXT NOT NULL,
        task_graph_json TEXT NOT NULL,
        evidence_contract_json TEXT NOT NULL,
        provider_usability_json TEXT NOT NULL,
        council_run_id TEXT,
        verification_json TEXT NOT NULL,
        outcome_score REAL NOT NULL,
        next_action TEXT NOT NULL,
        privacy_json TEXT NOT NULL,
        linked_skill_card_id TEXT
      );
      CREATE TABLE cognitive_approval_packets (
        approval_packet_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        action_class TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        approval_channel TEXT,
        approval_key TEXT,
        expires_at TEXT,
        decision_json TEXT NOT NULL,
        privacy_json TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO cognitive_runs VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        'cognitive:legacy:1',
        '2026-07-12T10:00:00.000Z',
        '2026-07-12T10:00:00.000Z',
        'main',
        'telegram',
        'code',
        'turn-legacy-1',
        'live',
        'Approve one historical bounded action.',
        'code.repair',
        'awaiting_approval',
        'plan_draft_only',
        'approval_staged',
        '{}',
        '{}',
        '{}',
        null,
        '{}',
        0,
        'Wait for exact approval.',
        '{"metadataOnly":true}',
        null,
      );
    const summary = 'Approve one historical bounded action.';
    legacy
      .prepare(
        `INSERT INTO cognitive_approval_packets VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        'approval:legacy:1',
        '2026-07-12T10:00:00.000Z',
        '2026-07-12T10:00:00.000Z',
        'cognitive:legacy:1',
        'repository.executor',
        'repository_write',
        'staged',
        summary,
        null,
        'repository:legacy-fixture',
        '2026-07-14T10:00:00.000Z',
        '{}',
        '{"metadataOnly":true}',
      );
    legacy.close();

    _initTestDatabaseAtPath(dbPath);
    const migrated = listCognitiveApprovalPackets({ groupFolder: 'main' })[0];
    expect(migrated).toMatchObject({
      approvalPacketId: 'approval:legacy:1',
      status: 'staged',
      approvalVersion: 1,
      scopeDigest: null,
      summaryDigest: null,
    });
    expect(
      approveCognitiveApprovalPacketCAS({
        approvalPacketId: migrated!.approvalPacketId,
        groupFolder: 'main',
        expectedSummary: summary,
        expectedApprovalVersion: migrated!.approvalVersion || 1,
        expectedScopeDigest: migrated!.scopeDigest || null,
        now: '2026-07-13T10:00:00.000Z',
        approvalChannel: 'owner_cockpit',
      }),
    ).toEqual({ status: 'approved', approvalVersion: 2 });
    _closeDatabase();

    _initTestDatabaseAtPath(dbPath);
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main' })[0],
    ).toMatchObject({
      status: 'approved',
      approvalVersion: 2,
      scopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const inspection = new Database(dbPath, { readonly: true });
    const tables = inspection
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'durable_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexes = inspection
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_durable_work_origin_scope%'`,
      )
      .all() as Array<{ name: string }>;
    inspection.close();
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'durable_effect_receipts',
        'durable_resume_grants',
        'durable_work_checkpoints',
        'durable_work_events',
        'durable_work_leases',
        'durable_work_links',
        'durable_work_units',
      ]),
    );
    expect(indexes).toEqual([{ name: 'idx_durable_work_origin_scope_v1' }]);
  });

  it('fails closed without rewriting duplicate legacy approval grants', () => {
    const dbPath = databasePath();
    _initTestDatabaseAtPath(dbPath);
    _closeDatabase();

    const legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP INDEX idx_durable_resume_approval_once;
      DROP TRIGGER trg_durable_grant_checkpoint_scope_insert;
    `);
    const insert = legacy.prepare(`
      INSERT INTO durable_resume_grants (
        grant_id, token_hash, work_id, checkpoint_id, work_version,
        plan_version, owner_scope_hash, chat_scope_hash, group_scope_hash,
        channel, target_scope_hash, action_class, approval_packet_id,
        approval_version, approval_scope_hash, inbound_message_hash, status,
        created_at, updated_at, expires_at, consumed_at, revoked_at,
        consumed_lease_id, privacy_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `);
    for (const suffix of ['one', 'two']) {
      insert.run(
        `grant:legacy-duplicate:${suffix}`,
        suffix.repeat(64).slice(0, 64),
        'work:legacy-duplicate',
        'checkpoint:legacy-duplicate',
        1,
        1,
        'owner-hash',
        'chat-hash',
        'group-hash',
        'owner_cockpit',
        'target-hash',
        'repository_write',
        'approval:legacy-duplicate',
        2,
        'approval-scope-hash',
        'active',
        '2026-07-13T10:00:00.000Z',
        '2026-07-13T10:00:00.000Z',
        '2026-07-13T10:10:00.000Z',
        '{"metadataOnly":true}',
      );
    }
    legacy.close();

    expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
      /unique constraint failed/i,
    );
    if (isDatabaseInitialized()) _closeDatabase();

    const inspection = new Database(dbPath, { readonly: true });
    const preserved = inspection
      .prepare(
        `SELECT COUNT(*) AS count FROM durable_resume_grants
         WHERE approval_packet_id = ? AND approval_version = ?`,
      )
      .get('approval:legacy-duplicate', 2) as { count: number };
    inspection.close();
    expect(preserved.count).toBe(2);
  });

  it.each([
    {
      label: 'packet without version',
      approvalPacketId: 'approval:legacy-partial',
      approvalVersion: null,
      approvalScopeHash: 'approval-scope-hash',
    },
    {
      label: 'version without packet',
      approvalPacketId: null,
      approvalVersion: 2,
      approvalScopeHash: null,
    },
  ])(
    'fails closed without rewriting a legacy $label',
    ({ approvalPacketId, approvalVersion, approvalScopeHash }) => {
      const dbPath = databasePath();
      _initTestDatabaseAtPath(dbPath);
      _closeDatabase();

      const legacy = new Database(dbPath);
      legacy.pragma('foreign_keys = OFF');
      legacy.exec(`
        DROP TRIGGER trg_durable_grant_checkpoint_scope_insert;
        DROP TRIGGER trg_durable_grant_approval_pair_insert;
      `);
      legacy
        .prepare(
          `INSERT INTO durable_resume_grants (
            grant_id, token_hash, work_id, checkpoint_id, work_version,
            plan_version, owner_scope_hash, chat_scope_hash, group_scope_hash,
            channel, target_scope_hash, action_class, approval_packet_id,
            approval_version, approval_scope_hash, inbound_message_hash, status,
            created_at, updated_at, expires_at, consumed_at, revoked_at,
            consumed_lease_id, privacy_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(
          'grant:legacy-partial',
          'partial'.repeat(10).slice(0, 64),
          'work:legacy-partial',
          'checkpoint:legacy-partial',
          1,
          1,
          'owner-hash',
          'chat-hash',
          'group-hash',
          'owner_cockpit',
          'target-hash',
          'repository_write',
          approvalPacketId,
          approvalVersion,
          approvalScopeHash,
          'active',
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:00:00.000Z',
          '2026-07-13T10:10:00.000Z',
          '{"metadataOnly":true}',
        );
      legacy.close();

      expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
        /approval identity is incomplete/i,
      );
      if (isDatabaseInitialized()) _closeDatabase();

      const inspection = new Database(dbPath, { readonly: true });
      const preserved = inspection
        .prepare(
          `SELECT approval_packet_id AS approvalPacketId,
                  approval_version AS approvalVersion
           FROM durable_resume_grants WHERE grant_id = ?`,
        )
        .get('grant:legacy-partial') as {
        approvalPacketId: string | null;
        approvalVersion: number | null;
      };
      inspection.close();
      expect(preserved).toEqual({ approvalPacketId, approvalVersion });
    },
  );

  it('fails closed when a same-name grant uniqueness index has the wrong identity', () => {
    const dbPath = databasePath();
    _initTestDatabaseAtPath(dbPath);
    _closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP INDEX idx_durable_resume_approval_once;
      CREATE INDEX idx_durable_resume_approval_once
        ON durable_resume_grants(grant_id);
    `);
    legacy.close();

    expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
      /grant uniqueness schema is missing or mismatched/i,
    );
    if (isDatabaseInitialized()) _closeDatabase();

    const inspection = new Database(dbPath, { readonly: true });
    const definition = inspection
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_durable_resume_approval_once'`,
      )
      .get() as { sql: string };
    inspection.close();
    expect(definition.sql).toContain('(grant_id)');
  });

  it('fails closed when a same-name grant uniqueness index has an inert predicate suffix', () => {
    const dbPath = databasePath();
    _initTestDatabaseAtPath(dbPath);
    _closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP INDEX idx_durable_resume_approval_once;
      CREATE UNIQUE INDEX idx_durable_resume_approval_once
        ON durable_resume_grants(approval_packet_id, approval_version)
        WHERE approval_packet_id IS NOT NULL
          AND approval_version IS NOT NULL
          AND 0;
    `);
    legacy.close();

    expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
      /grant uniqueness schema is missing or mismatched/i,
    );
    if (isDatabaseInitialized()) _closeDatabase();
  });

  it('fails closed when a same-name approval pairing trigger has the wrong identity', () => {
    const dbPath = databasePath();
    _initTestDatabaseAtPath(dbPath);
    _closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TRIGGER trg_durable_grant_approval_pair_insert;
      CREATE TRIGGER trg_durable_grant_approval_pair_insert
        BEFORE INSERT ON durable_resume_grants
        FOR EACH ROW
        BEGIN
          SELECT 1;
        END;
    `);
    legacy.close();

    expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
      /grant pairing schema is missing or mismatched/i,
    );
    if (isDatabaseInitialized()) _closeDatabase();

    const inspection = new Database(dbPath, { readonly: true });
    const definition = inspection
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger'
           AND name = 'trg_durable_grant_approval_pair_insert'`,
      )
      .get() as { sql: string };
    inspection.close();
    expect(definition.sql).toContain('SELECT 1');
  });

  it('fails closed when a same-name approval pairing trigger has an inert condition suffix', () => {
    const dbPath = databasePath();
    _initTestDatabaseAtPath(dbPath);
    _closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TRIGGER trg_durable_grant_approval_pair_insert;
      CREATE TRIGGER trg_durable_grant_approval_pair_insert
        BEFORE INSERT ON durable_resume_grants
        FOR EACH ROW
        WHEN (NEW.approval_packet_id IS NULL) <> (NEW.approval_version IS NULL)
          AND 0
        BEGIN
          SELECT RAISE(ABORT, 'durable grant approval identity must be complete');
        END;
    `);
    legacy.close();

    expect(() => _initTestDatabaseAtPath(dbPath)).toThrow(
      /grant pairing schema is missing or mismatched/i,
    );
    if (isDatabaseInitialized()) _closeDatabase();
  });
});
