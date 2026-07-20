import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { _initTestDatabaseAtPath, getAllChats, _closeDatabase } =
        await import('./db.js');

      _initTestDatabaseAtPath(dbPath);

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('finishes a partial ingress-origin migration and makes legacy BlueBubbles rows non-actionable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));
    try {
      const dbPath = path.join(tempDir, 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT,
          channel TEXT,
          is_group INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          is_bot_message INTEGER DEFAULT 0,
          thread_id TEXT,
          reply_to_id TEXT,
          provider_idempotency_key TEXT,
          message_ingress_origin TEXT NOT NULL DEFAULT 'live',
          PRIMARY KEY (id, chat_jid)
        );
        INSERT INTO chats VALUES
          ('bb:iMessage;-;+15550001111', 'Contact', '2026-07-16T18:00:00.000Z', 'bluebubbles', 0),
          ('tg:12345', 'Owner Telegram', '2026-07-16T18:00:00.000Z', 'telegram', 0);
        INSERT INTO messages VALUES
          ('bb:legacy-history', 'bb:iMessage;-;+15550001111', 'bb:contact', 'Contact', '@Andrea old provider row', '2026-07-16T18:00:00.000Z', 0, 0, NULL, NULL, NULL, 'live'),
          ('tg:legacy-live', 'tg:12345', 'owner', 'Owner', 'current Telegram command', '2026-07-16T18:00:01.000Z', 1, 0, NULL, NULL, NULL, 'live');
      `);
      legacyDb.close();

      vi.resetModules();
      const dbModule = await import('./db.js');
      dbModule._initTestDatabaseAtPath(dbPath);

      expect(
        dbModule
          .listRecentMessagesForChat('bb:iMessage;-;+15550001111', 10)
          .map((message) => message.id),
      ).toContain('bb:legacy-history');
      expect(
        dbModule.getActionableMessagesSince(
          'bb:iMessage;-;+15550001111',
          '',
          'Andrea',
        ),
      ).toEqual([]);
      expect(
        dbModule
          .getActionableMessagesSince('tg:12345', '', 'Andrea')
          .map((message) => message.id),
      ).toEqual(['tg:legacy-live']);
      expect(
        dbModule.listPendingActionableMessagesForChats(['tg:12345']),
      ).toEqual([]);
      dbModule.storeMessage({
        id: 'bb:post-migration-live',
        chat_jid: 'bb:iMessage;-;+15550001111',
        sender: 'bb:owner',
        sender_name: 'Owner',
        content: '@Andrea current self-thread turn',
        timestamp: '2026-07-16T18:01:00.000Z',
        is_from_me: true,
      });
      dbModule._closeDatabase();
      dbModule._initTestDatabaseAtPath(dbPath);
      expect(
        dbModule
          .getActionableMessagesSince(
            'bb:iMessage;-;+15550001111',
            '',
            'Andrea',
          )
          .map((message) => message.id),
      ).toEqual(['bb:post-migration-live']);
      expect(
        dbModule
          .listPendingActionableMessagesForChats(['bb:iMessage;-;+15550001111'])
          .map((message) => message.id),
      ).toEqual(['bb:post-migration-live']);
      dbModule._closeDatabase();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('backfills deterministic cognition runs as replay provenance', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE cognitive_runs (
          run_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          group_folder TEXT,
          channel TEXT,
          task_family TEXT NOT NULL,
          turn_id TEXT,
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
      `);
      const insert = legacyDb.prepare(`
        INSERT INTO cognitive_runs VALUES (
          ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
          'main', 'system', 'assistant', ?, 'sanitized goal',
          'assistant.daily_guidance', 'answered', 'none', 'reactive_plan',
          '{}', '{}', '{}', NULL, '{}', 0.88, 'done', '{}', NULL
        )
      `);
      insert.run('cog:live-turn', 'live-turn');
      insert.run(
        'cog:cog-bench-quick-guidance-legacy',
        'cog-bench-quick-guidance-legacy',
      );
      legacyDb.close();

      vi.resetModules();
      const { _initTestDatabaseAtPath, listCognitiveRuns, _closeDatabase } =
        await import('./db.js');
      _initTestDatabaseAtPath(dbPath);

      expect(
        listCognitiveRuns({ limit: 10 }).map((run) => ({
          runId: run.runId,
          runOrigin: run.runOrigin,
        })),
      ).toEqual(
        expect.arrayContaining([
          { runId: 'cog:live-turn', runOrigin: 'live' },
          {
            runId: 'cog:cog-bench-quick-guidance-legacy',
            runOrigin: 'replay',
          },
        ]),
      );
      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('backfills linked BlueBubbles proof-drill cognition as replay', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));
    try {
      const dbPath = path.join(tempDir, 'messages.db');
      vi.resetModules();
      const dbModule = await import('./db.js');
      const messageActions = await import('./message-actions.js');
      dbModule._initTestDatabaseAtPath(dbPath);
      const runId = 'cog:legacy-bluebubbles-proof-turn';
      dbModule.upsertCognitiveRun({
        runId,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        groupFolder: 'main',
        channel: 'bluebubbles',
        taskFamily: 'communication',
        turnId: 'legacy-bluebubbles-proof-turn',
        runOrigin: 'live',
        goalSummary: 'Sanitized deferred message-action decision.',
        selectedSkillId: 'bluebubbles.continuity',
        status: 'blocked',
        autonomyLevel: 'plan_draft_only',
        cognitiveMode: 'approval_staged',
        taskGraphJson: '{}',
        evidenceContractJson: '{}',
        providerUsabilityJson: '{}',
        councilRunId: null,
        verificationJson: '{}',
        outcomeScore: 0.2,
        nextAction: 'Keep the proof action unsent.',
        privacyJson: '{}',
        linkedSkillCardId: null,
      });
      const action = messageActions.createOrRefreshMessageActionFromDraft({
        groupFolder: 'main',
        presentationChannel: 'bluebubbles',
        presentationChatJid: 'bb:iMessage;-;+15555550100',
        sourceType: 'manual_prompt',
        sourceKey: 'bluebubbles-proof-drill:self-thread:legacy',
        sourceSummary: 'BlueBubbles same-thread proof drill.',
        draftText: 'Keep this proof draft unsent.',
        communicationContext: 'general',
        now: new Date('2026-07-01T00:00:00.000Z'),
      });
      expect(action.sourceKey).toContain(
        'bluebubbles-proof-drill:self-thread:',
      );
      dbModule.storeChatMetadata(
        'bb:iMessage;-;+15555550100',
        '2026-07-01T00:00:00.000Z',
        'Self thread',
        'bluebubbles',
        false,
      );
      dbModule.storeMessageDirect({
        id: 'legacy-bluebubbles-proof-turn',
        chat_jid: 'bb:iMessage;-;+15555550100',
        sender: 'owner',
        sender_name: 'Owner',
        content: 'send it later tonight',
        timestamp: '2026-07-01T00:00:00.000Z',
        is_from_me: false,
        is_bot_message: false,
      });
      dbModule._closeDatabase();

      dbModule._initTestDatabaseAtPath(dbPath);
      expect(dbModule.getCognitiveRun(runId)?.runOrigin).toBe('replay');
      dbModule._closeDatabase();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
