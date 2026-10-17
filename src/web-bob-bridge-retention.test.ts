import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  listMessageActionsForGroup,
} from './db.js';
import { createOrRefreshMessageActionFromDraft } from './message-actions.js';
import type {
  OwnerChallengeDelivery,
  OwnerChallengeSummary,
} from './owner-challenge-delivery.js';
import { WebBobBridge, type WebBobDeliveryEvidence } from './web-bob-bridge.js';
import type { WebBobDraftRetentionLimits } from './web-bob-draft-retention.js';

/** Small caps exercise the same prune/reconcile paths without 10k-row fixtures. */
const TEST_RETENTION_LIMITS: WebBobDraftRetentionLimits = {
  terminalDraftLimit: 24,
  revisionLineageLimit: 48,
  inFlightLimit: 8,
};
const {
  terminalDraftLimit: TERMINAL_DRAFT_LIMIT,
  revisionLineageLimit: REVISION_LINEAGE_LIMIT,
  inFlightLimit: IN_FLIGHT_LIMIT,
} = TEST_RETENTION_LIMITS;
/** Enough delivered-revision churn to hit periodic bound checks without 128 slow prepares. */
const REVISION_CHURN_ITERATIONS = 32;

const config = {
  token: 'synthetic-retention-service-token-123456',
  denyAddresses: ['+12025550199'],
  denyChatGuids: ['iMessage;-;+12025550199'],
};
const draft = () => ({
  issuer: 'web-bob',
  audience: 'andrea',
  conversationId: 'retention-conversation',
  epoch: 'retention-epoch',
  draftId: 'retention-draft',
  revision: 1,
  chatGuid: 'iMessage;-;+12025550102',
  addresses: ['+12025550102'],
  text: 'Synthetic exact owner draft for storage regression.',
});

describe('Web Bob bounded draft retention and replay protection', () => {
  let folder: string;
  let databasePath: string;
  let coreDatabasePath: string;
  let seededDrafts: number;
  let bridge: WebBobBridge;
  const send = vi.fn();
  const readDelivery = vi.fn();
  const deliver =
    vi.fn<
      (challenge: string, summary: OwnerChallengeSummary) => Promise<void>
    >();
  const delivered = new Map<string, string>();

  const open = (
    ownerChallengeDelivery: OwnerChallengeDelivery | null = {
      deliver,
    },
  ) =>
    new WebBobBridge(config, databasePath, {
      connected: () => true,
      resolveRecipient: async () => ['+12025550102'],
      readDelivery,
      sendToTarget: send,
      retentionLimits: TEST_RETENTION_LIMITS,
      ...(ownerChallengeDelivery ? { ownerChallengeDelivery } : {}),
    });

  function inspect<T>(read: (db: Database.Database) => T): T {
    const db = new Database(databasePath);
    try {
      return read(db);
    } finally {
      db.close();
    }
  }

  function counts() {
    return inspect((db) => ({
      drafts: (
        db.prepare('SELECT count(*) AS n FROM webbob_drafts').get() as {
          n: number;
        }
      ).n,
      terminal: (
        db
          .prepare(
            "SELECT count(*) AS n FROM webbob_drafts WHERE state NOT IN ('pending', 'awaiting_delivery')",
          )
          .get() as { n: number }
      ).n,
      evidence: (
        db.prepare('SELECT count(*) AS n FROM webbob_delivery').get() as {
          n: number;
        }
      ).n,
      orphanEvidence: (
        db
          .prepare(
            'SELECT count(*) AS n FROM webbob_delivery WHERE draftId NOT IN (SELECT id FROM webbob_drafts)',
          )
          .get() as { n: number }
      ).n,
    }));
  }

  function inspectCore<T>(read: (db: Database.Database) => T): T {
    const db = new Database(coreDatabasePath);
    try {
      db.prepare('ATTACH DATABASE ? AS bridge').run(databasePath);
      return read(db);
    } finally {
      db.close();
    }
  }

  function coreCounts() {
    return inspectCore(
      (db) =>
        db
          .prepare(
            `SELECT
              (SELECT count(*) FROM message_actions) AS actions,
              (SELECT count(*) FROM outcomes) AS outcomes,
              (SELECT count(*) FROM message_actions action
               WHERE action.message_action_id NOT IN (
                 SELECT actionId FROM bridge.webbob_drafts)) AS orphanActions,
              (SELECT count(*) FROM outcomes outcome
               WHERE outcome.source_type = 'message_action' AND NOT EXISTS (
                 SELECT 1 FROM message_actions action
                 WHERE action.message_action_id = outcome.source_key
                   AND action.group_folder = outcome.group_folder)) AS orphanOutcomes`,
          )
          .get() as {
          actions: number;
          outcomes: number;
          orphanActions: number;
          orphanOutcomes: number;
        },
    );
  }

  function expectCoreMatchesBridge() {
    const retained = counts();
    expect(coreCounts()).toEqual({
      actions: retained.drafts,
      outcomes: retained.drafts,
      orphanActions: 0,
      orphanOutcomes: 0,
    });
  }

  function restart() {
    bridge.close();
    _closeDatabase();
    _initTestDatabaseAtPath(coreDatabasePath);
    bridge = open();
  }

  function seedHistory(
    state: string,
    count = TERMINAL_DRAFT_LIMIT + 3,
    expires = Date.now() + 10 * 60_000,
    sameLineage = false,
  ) {
    inspect((db) => {
      db.prepare('ATTACH DATABASE ? AS core').run(coreDatabasePath);
      db.function('retentionActionId', (id: string) => {
        const hash = createHash('sha256')
          .update(`webbob\u0000manual_prompt\u0000webbob:inbound:${id}`)
          .digest('hex');
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      });
      db.transaction(() => {
        db.prepare(
          `WITH RECURSIVE entries(n) AS (
            VALUES(?) UNION ALL SELECT n + 1 FROM entries WHERE n < ?
          )
          INSERT INTO webbob_drafts
            (id, scope, digest, challengeHash, serverEpoch, expires, pauseGeneration, state, actionId)
          SELECT printf('%064x', n),
            json_set(?,
              '$.conversationId', CASE WHEN ? THEN 'retention-conversation'
                ELSE 'retention-history-' || n END,
              '$.revision', CASE WHEN ? THEN n ELSE 1 END),
            '', '', '', ?, 0, ?, retentionActionId(printf('%064x', n)) FROM entries`,
        ).run(
          seededDrafts + 1,
          seededDrafts + count,
          JSON.stringify({
            ...draft(),
            actor: createHash('sha256')
              .update('web-bob:owner:jeff')
              .digest('hex'),
          }),
          Number(sameLineage),
          Number(sameLineage),
          expires,
          state,
        );
        const firstId = (seededDrafts + 1).toString(16).padStart(64, '0');
        const lastId = (seededDrafts + count).toString(16).padStart(64, '0');
        db.prepare(
          `INSERT INTO core.message_actions (
            message_action_id, group_folder, source_type, source_key,
            source_summary, target_kind, target_channel, target_conversation_json,
            draft_text, trust_level, send_status, dedupe_key,
            presentation_chat_jid, created_at, last_updated_at)
           SELECT actionId, 'webbob', 'manual_prompt', 'webbob:inbound:' || id,
             'Exact Web Bob owner draft', 'external_thread', 'bluebubbles',
             json_object('chatJid', 'bb:' || json_extract(scope, '$.chatGuid')),
             json_extract(scope, '$.text'), 'approve_before_send', 'drafted', actionId,
             'webbob:' || json_extract(scope, '$.conversationId'),
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
           FROM webbob_drafts WHERE id BETWEEN ? AND ?`,
        ).run(firstId, lastId);
        db.prepare(
          `INSERT INTO core.outcomes (
            outcome_id, group_folder, source_type, source_key, linked_refs_json,
            status, review_horizon, last_checked_at, created_at, updated_at)
           SELECT 'webbob:message_action:' || actionId, 'webbob',
             'message_action', actionId, json_object('messageActionId', actionId),
             'partial', 'today', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
           FROM webbob_drafts WHERE id BETWEEN ? AND ?`,
        ).run(firstId, lastId);
        db.prepare(
          `INSERT INTO webbob_delivery (draftId, evidence)
           SELECT id, '{}' FROM webbob_drafts WHERE id BETWEEN ? AND ?`,
        ).run(firstId, lastId);
      })();
      seededDrafts += count;
    });
  }

  async function approval(input = draft()) {
    const card = await bridge.prepare(input);
    const bridgeDraftId = card.draftId as string;
    const approvalToken = delivered.get(bridgeDraftId)!;
    expect(approvalToken).toMatch(/^wbtxt-[a-f0-9]{64}$/);
    return { bridgeDraftId, approvalToken };
  }

  async function withHttp(
    run: (post: (body: unknown) => Promise<Response>) => Promise<void>,
  ) {
    const server = http.createServer((req, res) => {
      void bridge.handleRequest(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      await run((body) =>
        fetch(`http://127.0.0.1:${port}/web-bob/v1/draft`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + config.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'webbob-retention-'));
    databasePath = path.join(folder, 'bridge.db');
    coreDatabasePath = path.join(folder, 'core.db');
    seededDrafts = 0;
    _initTestDatabaseAtPath(coreDatabasePath);
    send.mockReset();
    send.mockResolvedValue({
      platformMessageId: 'synthetic-retention-receipt',
      threadId: 'bb:iMessage;-;+12025550102',
    });
    readDelivery.mockReset();
    readDelivery.mockResolvedValue({
      state: 'sent',
      error: 0,
      deliveredAt: null,
    });
    delivered.clear();
    deliver.mockReset();
    deliver.mockImplementation(async (challenge, summary) => {
      delivered.set(summary.bridgeDraftId, challenge);
    });
    bridge = open();
  });

  afterEach(() => {
    bridge.close();
    _closeDatabase();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it.each(['disabled', 'unavailable'])(
    'persists neither drafts nor core actions for many distinct HTTP drafts when owner delivery is %s',
    async (availability) => {
      bridge.close();
      if (availability === 'unavailable') {
        deliver.mockImplementation(async () => {
          expect(counts().drafts).toBe(0);
          expect(
            listMessageActionsForGroup({ groupFolder: 'webbob' }),
          ).toHaveLength(0);
          throw new Error('Synthetic unavailable owner delivery.');
        });
      }
      bridge = open(availability === 'disabled' ? null : { deliver });
      const initialBytes = fs.statSync(databasePath).size;
      await withHttp(async (post) => {
        for (let index = 0; index < 128; index += 1) {
          const response = await post({
            ...draft(),
            conversationId: `failed-conversation-${index}`,
            draftId: `failed-draft-${index}`,
          });
          expect(response.status).toBe(503);
          expect(await response.text()).not.toContain('wbtxt-');
          expect(counts()).toEqual({
            drafts: 0,
            terminal: 0,
            evidence: 0,
            orphanEvidence: 0,
          });
          expectCoreMatchesBridge();
        }
      });
      expect(
        listMessageActionsForGroup({ groupFolder: 'webbob' }),
      ).toHaveLength(0);
      expect(fs.statSync(databasePath).size).toBe(initialBytes);
      expect(send).not.toHaveBeenCalled();
      if (availability === 'disabled') expect(deliver).not.toHaveBeenCalled();
      else expect(deliver).toHaveBeenCalledTimes(128);
    },
  );

  it.each([
    'failed',
    'approval_unavailable',
    'expired',
    'cancelled',
    'consumed',
    'superseded',
  ])(
    'bounds retained %s drafts and removes their receipt evidence',
    async (state) => {
      seedHistory(state);
      expect(counts().terminal).toBe(TERMINAL_DRAFT_LIMIT + 3);
      await bridge.prepare(draft());
      const retained = counts();
      expect(retained.terminal).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT);
      expect(retained.drafts).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT + 1);
      expect(retained.evidence).toBe(retained.terminal);
      expect(retained.orphanEvidence).toBe(0);
      expectCoreMatchesBridge();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('bounds startup retention after invalidating old pending owner decisions', () => {
    seedHistory('pending');
    restart();
    const retained = counts();
    expect(retained.drafts).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT);
    expect(retained.terminal).toBe(retained.drafts);
    expect(retained.evidence).toBe(retained.drafts);
    expect(retained.orphanEvidence).toBe(0);
    expectCoreMatchesBridge();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'superseded'])(
    'rejects a %s token and stale revisions after pruning and restart',
    async (terminalState) => {
      const original = await approval();
      const originalActionId = inspect(
        (db) =>
          (
            db
              .prepare('SELECT actionId FROM webbob_drafts WHERE id = ?')
              .get(original.bridgeDraftId) as { actionId: string }
          ).actionId,
      );
      let latestRevision = 1;
      if (terminalState === 'consumed') {
        expect((await bridge.confirm(original)).state).toBe('sent');
      } else {
        latestRevision = 2;
        await approval({ ...draft(), revision: latestRevision });
      }
      inspect((db) => {
        expect(
          db
            .prepare('SELECT state FROM webbob_drafts WHERE id = ?')
            .get(original.bridgeDraftId),
        ).toEqual({ state: terminalState });
        db.prepare('UPDATE webbob_drafts SET expires = 1 WHERE id = ?').run(
          original.bridgeDraftId,
        );
      });
      seedHistory('cancelled');
      await bridge.prepare({
        ...draft(),
        conversationId: 'pruning-trigger-conversation',
      });
      expect(
        inspect((db) =>
          db
            .prepare('SELECT id FROM webbob_drafts WHERE id = ?')
            .get(original.bridgeDraftId),
        ),
      ).toBeUndefined();
      expect(counts().orphanEvidence).toBe(0);
      expectCoreMatchesBridge();
      expect(
        inspectCore((db) =>
          db
            .prepare(
              'SELECT message_action_id FROM message_actions WHERE message_action_id = ?',
            )
            .get(originalActionId),
        ),
      ).toBeUndefined();
      expect(
        inspectCore((db) =>
          db
            .prepare(
              "SELECT outcome_id FROM outcomes WHERE source_type = 'message_action' AND source_key = ?",
            )
            .get(originalActionId),
        ),
      ).toBeUndefined();

      for (const restart of [false, true]) {
        if (restart) {
          bridge.close();
          _closeDatabase();
          _initTestDatabaseAtPath(coreDatabasePath);
          bridge = open();
        }
        expectCoreMatchesBridge();
        await expect(bridge.confirm(original)).rejects.toMatchObject({
          status: 404,
        });
        await expect(bridge.prepare(draft())).rejects.toMatchObject({
          status: 409,
        });
        await expect(
          bridge.prepare({ ...draft(), revision: latestRevision }),
        ).rejects.toMatchObject({ status: 409 });
        const replacement = await approval({
          ...draft(),
          revision: ++latestRevision,
        });
        expect(replacement.bridgeDraftId).not.toBe(original.bridgeDraftId);
        await expect(
          bridge.confirm({
            bridgeDraftId: replacement.bridgeDraftId,
            approvalToken: original.approvalToken,
          }),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(send).toHaveBeenCalledTimes(terminalState === 'consumed' ? 1 : 0);
    },
  );

  it('does not recreate pruned receipt evidence when an earlier inspection finishes', async () => {
    const original = await approval();
    await bridge.confirm(original);
    let finishInspection!: (evidence: WebBobDeliveryEvidence) => void;
    readDelivery.mockImplementationOnce(
      () =>
        new Promise<WebBobDeliveryEvidence>((resolve) => {
          finishInspection = resolve;
        }),
    );
    const inspection = bridge.status({
      bridgeDraftId: original.bridgeDraftId,
    });
    inspect((db) => {
      db.prepare('UPDATE webbob_drafts SET expires = 1 WHERE id = ?').run(
        original.bridgeDraftId,
      );
    });
    seedHistory('cancelled');
    await bridge.prepare({
      ...draft(),
      conversationId: 'inspection-pruning-conversation',
    });
    finishInspection({ state: 'delivered', error: 0, deliveredAt: Date.now() });
    await inspection;
    expect(counts().orphanEvidence).toBe(0);
    expect(
      inspect((db) =>
        db
          .prepare('SELECT draftId FROM webbob_delivery WHERE draftId = ?')
          .get(original.bridgeDraftId),
      ),
    ).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('bounds both databases through delivered revision churn, cancellation, supersession and restart', async () => {
    const original = await approval();
    bridge.cancel({ bridgeDraftId: original.bridgeDraftId });
    inspect((db) => {
      db.prepare('UPDATE webbob_drafts SET expires = 1 WHERE id = ?').run(
        original.bridgeDraftId,
      );
    });
    // Seed the near-cap history in one transaction, then exercise real delivered
    // revisions past the cap on the same lineage without owner confirmation.
    seedHistory('cancelled', TERMINAL_DRAFT_LIMIT - 1, Date.now(), true);
    for (let index = 0; index < REVISION_CHURN_ITERATIONS; index += 1) {
      const current = await approval({
        ...draft(),
        revision: TERMINAL_DRAFT_LIMIT + index,
      });
      if (index % 2 === 1)
        bridge.cancel({ bridgeDraftId: current.bridgeDraftId });
      if (index % 32 === 31) {
        expect(counts().terminal).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT);
        expect(counts().drafts).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT + 1);
        expectCoreMatchesBridge();
      }
    }
    expect(deliver).toHaveBeenCalledTimes(REVISION_CHURN_ITERATIONS + 1);
    expect(send).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index += 1) {
      restart();
      expect(counts().drafts).toBe(TERMINAL_DRAFT_LIMIT);
      expectCoreMatchesBridge();
      await expect(bridge.confirm(original)).rejects.toMatchObject({
        status: 404,
      });
      await expect(bridge.prepare(draft())).rejects.toMatchObject({
        status: 409,
      });
    }
  }, 30_000);

  it('reconciles the committed core action and outcome when the bridge insert fails', async () => {
    inspect((db) => {
      db.exec(`CREATE TRIGGER reject_draft_insert BEFORE INSERT ON webbob_drafts
        BEGIN SELECT RAISE(ABORT, 'Synthetic bridge insert failure'); END`);
    });
    await expect(bridge.prepare(draft())).rejects.toMatchObject({
      status: 503,
    });
    expect(deliver).toHaveBeenCalledOnce();
    const [bridgeDraftId, approvalToken] = [...delivered.entries()][0];
    expect(counts().drafts).toBe(0);
    expectCoreMatchesBridge();
    restart();
    expect(counts().drafts).toBe(0);
    expectCoreMatchesBridge();
    await expect(
      bridge.confirm({ bridgeDraftId, approvalToken }),
    ).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
  });

  it('reconciles crash-orphaned core records on restart while preserving non-bridge actions and outcomes', async () => {
    const original = await approval();
    const nonBridge = [
      {
        groupFolder: 'webbob',
        sourceType: 'manual_prompt' as const,
        sourceKey: 'ordinary:inbound:retention',
      },
      {
        groupFolder: 'webbob',
        sourceType: 'manual_prompt' as const,
        sourceKey: 'webbob:inbound:malformed',
      },
      {
        groupFolder: 'other-owner',
        sourceType: 'manual_prompt' as const,
        sourceKey: `webbob:inbound:${'a'.repeat(64)}`,
      },
      {
        groupFolder: 'webbob',
        sourceType: 'communication_thread' as const,
        sourceKey: `webbob:inbound:${'b'.repeat(64)}`,
      },
      {
        groupFolder: 'webbob',
        sourceType: 'manual_prompt' as const,
        sourceKey: 'ordinary:inbound:lookalike',
      },
    ].map((source) =>
      createOrRefreshMessageActionFromDraft({
        ...source,
        presentationChannel: 'bluebubbles',
        presentationChatJid: 'webbob:non-bridge-fixture',
        draftText: draft().text,
        forceApproval: true,
        targetChannelOverride: 'bluebubbles',
        targetOverride: {
          kind: 'external_thread',
          chatJid: 'bb:' + draft().chatGuid,
          isGroup: false,
        },
      }),
    );
    // Namespace-shaped metadata cannot make an unrelated action bridge-owned.
    inspectCore((db) =>
      db
        .prepare(
          'UPDATE message_actions SET source_key = ? WHERE message_action_id = ?',
        )
        .run(
          `webbob:inbound:${'c'.repeat(64)}`,
          nonBridge.at(-1)!.messageActionId,
        ),
    );
    inspect((db) =>
      db
        .prepare('DELETE FROM webbob_drafts WHERE id = ?')
        .run(original.bridgeDraftId),
    );
    expect(coreCounts().actions).toBe(nonBridge.length + 1);
    restart();
    expect(coreCounts().actions).toBe(nonBridge.length);
    expect(coreCounts().outcomes).toBe(nonBridge.length);
    expect(coreCounts().orphanOutcomes).toBe(0);
    for (const action of nonBridge) {
      expect(
        inspectCore((db) =>
          db
            .prepare(
              'SELECT message_action_id FROM message_actions WHERE message_action_id = ?',
            )
            .get(action.messageActionId),
        ),
      ).toEqual({ message_action_id: action.messageActionId });
      expect(
        inspectCore((db) =>
          db
            .prepare(
              "SELECT source_key FROM outcomes WHERE group_folder = ? AND source_type = 'message_action' AND source_key = ?",
            )
            .get(action.groupFolder, action.messageActionId),
        ),
      ).toEqual({ source_key: action.messageActionId });
    }
    await expect(bridge.confirm(original)).rejects.toMatchObject({
      status: 404,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('retains consumed consent through provider dispatch and receipt persistence despite more than 10,000 newer terminal records', async () => {
    const original = await approval();
    let finishSend!: (receipt: {
      platformMessageId: string;
      threadId: string;
    }) => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    send.mockImplementationOnce(() => {
      markSendStarted();
      return new Promise((resolve) => {
        finishSend = resolve;
      });
    });
    let finishInspection!: (evidence: WebBobDeliveryEvidence) => void;
    let markInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    readDelivery.mockImplementationOnce(() => {
      markInspectionStarted();
      return new Promise<WebBobDeliveryEvidence>((resolve) => {
        finishInspection = resolve;
      });
    });
    seedHistory(
      'cancelled',
      TERMINAL_DRAFT_LIMIT + 3,
      Date.now() + 60 * 60_000,
    );
    const confirmation = bridge.confirm(original);
    await sendStarted;
    const expectPinned = () => {
      expect(
        inspect((db) =>
          db
            .prepare(
              'SELECT state, dispatchInFlight, challengeHash FROM webbob_drafts WHERE id = ?',
            )
            .get(original.bridgeDraftId),
        ),
      ).toEqual({ state: 'consumed', dispatchInFlight: 1, challengeHash: '' });
      expectCoreMatchesBridge();
    };
    expectPinned();
    await expect(bridge.confirm(original)).rejects.toMatchObject({
      status: 409,
    });
    // A replacement instance can prune during startup while the original
    // instance's provider call and subsequent receipt persistence are pending.
    const successor = open();
    try {
      expectPinned();
      await successor.prepare({
        ...draft(),
        conversationId: 'dispatch-pruning-trigger',
      });
      expectPinned();
      finishSend({
        platformMessageId: 'synthetic-pinned-receipt',
        threadId: 'bb:' + draft().chatGuid,
      });
      await inspectionStarted;
      await successor.prepare({
        ...draft(),
        conversationId: 'receipt-pruning-trigger',
      });
      expectPinned();
      expect(
        inspect((db) =>
          db
            .prepare('SELECT draftId FROM webbob_delivery WHERE draftId = ?')
            .get(original.bridgeDraftId),
        ),
      ).toEqual({ draftId: original.bridgeDraftId });
      finishInspection({
        state: 'delivered',
        error: 0,
        deliveredAt: Date.now(),
      });
      expect((await confirmation).state).toBe('delivered');
      expect(
        inspect((db) =>
          db
            .prepare('SELECT id FROM webbob_drafts WHERE id = ?')
            .get(original.bridgeDraftId),
        ),
      ).toBeUndefined();
      expect(counts().orphanEvidence).toBe(0);
      expectCoreMatchesBridge();
    } finally {
      successor.close();
    }
    restart();
    expectCoreMatchesBridge();
    await expect(bridge.confirm(original)).rejects.toMatchObject({
      status: 404,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('retains a bounded set of unresolved dispatch pins across restart and rejects new consumption without using its token', async () => {
    const original = await approval();
    seedHistory('consumed', IN_FLIGHT_LIMIT - 1);
    // Model a process exit after durable consumption but before receipt settlement.
    inspect((db) =>
      db
        .prepare(
          "UPDATE webbob_drafts SET state = 'consumed', dispatchInFlight = 1, challengeHash = ''",
        )
        .run(),
    );
    seedHistory(
      'cancelled',
      TERMINAL_DRAFT_LIMIT + 3,
      Date.now() + 60 * 60_000,
    );
    restart();
    expect(
      inspect((db) =>
        db
          .prepare(
            'SELECT count(*) AS count FROM webbob_drafts WHERE dispatchInFlight = 1',
          )
          .get(),
      ),
    ).toEqual({ count: IN_FLIGHT_LIMIT });
    expect(counts().drafts).toBe(TERMINAL_DRAFT_LIMIT + IN_FLIGHT_LIMIT);
    expectCoreMatchesBridge();
    await expect(bridge.confirm(original)).rejects.toMatchObject({
      status: 409,
    });
    const next = await approval({
      ...draft(),
      conversationId: 'capacity-blocked-consent',
    });
    await expect(bridge.confirm(next)).rejects.toMatchObject({ status: 503 });
    expect(
      inspect((db) =>
        db
          .prepare(
            'SELECT state, dispatchInFlight, challengeHash FROM webbob_drafts WHERE id = ?',
          )
          .get(next.bridgeDraftId),
      ),
    ).toEqual({
      state: 'pending',
      dispatchInFlight: 0,
      challengeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expectCoreMatchesBridge();
    expect(send).not.toHaveBeenCalled();
  });

  it('bounds revision history and seals unknown lineages across restart when legacy history overflows', async () => {
    const original = await approval();
    bridge.cancel({ bridgeDraftId: original.bridgeDraftId });
    seedHistory('cancelled', REVISION_LINEAGE_LIMIT + 1);
    restart();

    for (const revision of [2, 3]) {
      expect(
        inspect((db) =>
          db
            .prepare(
              `SELECT admissionSealed,
                (SELECT count(*) FROM webbob_revision_watermarks) AS count
               FROM webbob_retention_state WHERE id = 1`,
            )
            .get(),
        ),
      ).toEqual({
        admissionSealed: 1,
        count: REVISION_LINEAGE_LIMIT,
      });
      expect(counts().terminal).toBeLessThanOrEqual(TERMINAL_DRAFT_LIMIT);
      const beforeActions = listMessageActionsForGroup({
        groupFolder: 'webbob',
      }).length;
      const beforeCore = coreCounts();
      const beforeDeliveries = deliver.mock.calls.length;
      await expect(
        bridge.prepare({
          ...draft(),
          conversationId: 'unknown-after-overflow',
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        listMessageActionsForGroup({ groupFolder: 'webbob' }),
      ).toHaveLength(beforeActions);
      expect(coreCounts()).toEqual(beforeCore);
      expectCoreMatchesBridge();
      expect(deliver).toHaveBeenCalledTimes(beforeDeliveries);
      await expect(bridge.prepare(draft())).rejects.toMatchObject({
        status: 409,
      });
      const replacement = await approval({ ...draft(), revision });
      await expect(
        bridge.confirm({
          bridgeDraftId: replacement.bridgeDraftId,
          approvalToken: original.approvalToken,
        }),
      ).rejects.toMatchObject({ status: 403 });
      restart();
    }
    expect(send).not.toHaveBeenCalled();
  });
});
