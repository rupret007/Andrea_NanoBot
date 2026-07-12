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
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

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
      const { initDatabase, listCognitiveRuns, _closeDatabase } =
        await import('./db.js');
      initDatabase();

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
