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
});
