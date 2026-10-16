import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listMessageActionsForGroup,
} from './db.js';
import type {
  OwnerChallengeDelivery,
  OwnerChallengeSummary,
} from './owner-challenge-delivery.js';
import { WebBobBridge, type WebBobDeliveryEvidence } from './web-bob-bridge.js';
import {
  WEB_BOB_REVISION_LINEAGE_LIMIT,
  WEB_BOB_TERMINAL_DRAFT_LIMIT,
} from './web-bob-draft-retention.js';

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

  function seedHistory(
    state: string,
    count = WEB_BOB_TERMINAL_DRAFT_LIMIT + 3,
    expires = Date.now() + 10 * 60_000,
  ) {
    inspect((db) => {
      db.transaction(() => {
        db.prepare(
          `WITH RECURSIVE entries(n) AS (
            VALUES(1) UNION ALL SELECT n + 1 FROM entries WHERE n < ?
          )
          INSERT INTO webbob_drafts
            (id, scope, digest, challengeHash, serverEpoch, expires, pauseGeneration, state, actionId)
          SELECT printf('%064x', n),
            json_set(?, '$.conversationId', 'retention-history-' || n),
            '', '', '', ?, 0, ?, '' FROM entries`,
        ).run(
          count,
          JSON.stringify({
            ...draft(),
            actor: createHash('sha256')
              .update('web-bob:owner:jeff')
              .digest('hex'),
          }),
          expires,
          state,
        );
        db.prepare(
          `INSERT INTO webbob_delivery (draftId, evidence)
           SELECT id, '{}' FROM webbob_drafts WHERE actionId = ''`,
        ).run();
      })();
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
    _initTestDatabase();
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'webbob-retention-'));
    databasePath = path.join(folder, 'bridge.db');
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
      expect(counts().terminal).toBe(WEB_BOB_TERMINAL_DRAFT_LIMIT + 3);
      await bridge.prepare(draft());
      const retained = counts();
      expect(retained.terminal).toBeLessThanOrEqual(
        WEB_BOB_TERMINAL_DRAFT_LIMIT,
      );
      expect(retained.drafts).toBeLessThanOrEqual(
        WEB_BOB_TERMINAL_DRAFT_LIMIT + 1,
      );
      expect(retained.evidence).toBe(retained.terminal);
      expect(retained.orphanEvidence).toBe(0);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('bounds startup retention after invalidating old pending owner decisions', () => {
    seedHistory('pending');
    bridge.close();
    bridge = open();
    const retained = counts();
    expect(retained.drafts).toBeLessThanOrEqual(WEB_BOB_TERMINAL_DRAFT_LIMIT);
    expect(retained.terminal).toBe(retained.drafts);
    expect(retained.evidence).toBe(retained.drafts);
    expect(retained.orphanEvidence).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'superseded'])(
    'rejects a %s token and stale revisions after pruning and restart',
    async (terminalState) => {
      const original = await approval();
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

      for (const restart of [false, true]) {
        if (restart) {
          bridge.close();
          bridge = open();
        }
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

  it('bounds revision history and seals unknown lineages across restart when legacy history overflows', async () => {
    const original = await approval();
    bridge.cancel({ bridgeDraftId: original.bridgeDraftId });
    seedHistory('cancelled', WEB_BOB_REVISION_LINEAGE_LIMIT + 1);
    bridge.close();
    bridge = open();

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
        count: WEB_BOB_REVISION_LINEAGE_LIMIT,
      });
      expect(counts().terminal).toBeLessThanOrEqual(
        WEB_BOB_TERMINAL_DRAFT_LIMIT,
      );
      const beforeActions = listMessageActionsForGroup({
        groupFolder: 'webbob',
      }).length;
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
      bridge.close();
      bridge = open();
    }
    expect(send).not.toHaveBeenCalled();
  });
});
