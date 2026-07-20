import { readFileSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _getActionableIngressSnapshotForTests,
  _initTestDatabase,
  claimPendingActionableMessagesForChat,
  getActionableMessagesSince,
  listPendingActionableMessagesForChats,
  listRecentMessagesForChat,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { prepareActionableIngressForStartupRecovery } from './startup-ingress-recovery.js';

const NOW = new Date('2026-07-16T18:20:00.000Z');
const BLUEBUBBLES_CHAT = 'bb:iMessage;-;+15550002222';
const TELEGRAM_CHAT = 'tg:owner';

function storeInboundMessage(input: {
  id: string;
  chatJid: string;
  timestamp: string;
  content: string;
}): void {
  storeMessage({
    id: input.id,
    chat_jid: input.chatJid,
    sender: 'owner',
    sender_name: 'Owner',
    content: input.content,
    timestamp: input.timestamp,
    is_from_me: input.chatJid.startsWith('bb:'),
  });
}

describe('startup actionable-ingress recovery', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
    _closeDatabase();
  });

  it('quarantines stale BlueBubbles rows before releasing prior-process claims', () => {
    vi.useFakeTimers();
    storeChatMetadata(
      BLUEBUBBLES_CHAT,
      '2026-07-16T18:00:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      TELEGRAM_CHAT,
      '2026-07-16T17:00:00.000Z',
      'Owner Telegram',
      'telegram',
      false,
    );
    vi.setSystemTime('2026-07-16T18:00:00.000Z');
    storeInboundMessage({
      id: 'bb-stale-command',
      chatJid: BLUEBUBBLES_CHAT,
      // A fresh-looking provider clock cannot extend authorization.
      timestamp: '2026-07-16T18:19:00.000Z',
      content: '@Andrea send the old instruction',
    });
    vi.setSystemTime('2026-07-16T18:10:00.000Z');
    storeInboundMessage({
      id: 'bb-fresh-command',
      chatJid: BLUEBUBBLES_CHAT,
      // A stale-looking provider clock cannot revoke a fresh local receipt.
      timestamp: '2026-07-16T17:30:00.000Z',
      content: '@Andrea summarize what is new',
    });
    vi.setSystemTime('2026-07-16T17:00:00.000Z');
    storeInboundMessage({
      id: 'tg-prior-process-command',
      chatJid: TELEGRAM_CHAT,
      timestamp: '2026-07-16T17:00:00.000Z',
      content: 'Keep this Telegram request',
    });

    expect(
      claimPendingActionableMessagesForChat({
        chatJid: BLUEBUBBLES_CHAT,
        now: new Date('2026-07-16T18:12:00.000Z'),
      }).messages.map((message) => message.id),
    ).toEqual(['bb-stale-command', 'bb-fresh-command']);
    expect(
      claimPendingActionableMessagesForChat({
        chatJid: TELEGRAM_CHAT,
        now: new Date('2026-07-16T18:12:00.000Z'),
      }).messages.map((message) => message.id),
    ).toEqual(['tg-prior-process-command']);

    const result = prepareActionableIngressForStartupRecovery(NOW);

    expect(result).toEqual({
      blueBubblesRecoveryCutoff: '2026-07-16T18:05:00.000Z',
      quarantinedBlueBubblesMessageCount: 1,
      recoveredIngressClaimCount: 2,
    });
    expect(
      _getActionableIngressSnapshotForTests(
        BLUEBUBBLES_CHAT,
        'bb-stale-command',
      ),
    ).toEqual({
      state: 'ignored',
      received_at: '2026-07-16T18:00:00.000Z',
      claim_token: null,
      disposition: 'stale_bluebubbles_startup_quarantine',
    });
    expect(
      _getActionableIngressSnapshotForTests(
        BLUEBUBBLES_CHAT,
        'bb-fresh-command',
      ),
    ).toMatchObject({
      state: 'pending',
      received_at: '2026-07-16T18:10:00.000Z',
      disposition: 'startup_claim_recovered',
    });
    expect(
      listPendingActionableMessagesForChats(
        [BLUEBUBBLES_CHAT, TELEGRAM_CHAT],
        200,
        NOW,
      ).map((message) => message.id),
    ).toEqual(['bb-fresh-command', 'tg-prior-process-command']);
    expect(
      getActionableMessagesSince(BLUEBUBBLES_CHAT, '', 'Andrea').map(
        (message) => message.id,
      ),
    ).toEqual(['bb-fresh-command']);
    expect(
      listRecentMessagesForChat(BLUEBUBBLES_CHAT, 10).map(
        (message) => message.id,
      ),
    ).toEqual(expect.arrayContaining(['bb-stale-command', 'bb-fresh-command']));

    // A duplicate provider callback cannot revive the quarantined ledger row.
    vi.setSystemTime('2026-07-16T18:21:00.000Z');
    storeInboundMessage({
      id: 'bb-stale-command',
      chatJid: BLUEBUBBLES_CHAT,
      timestamp: '2026-07-16T18:19:00.000Z',
      content: '@Andrea send the old instruction',
    });
    expect(
      listPendingActionableMessagesForChats([BLUEBUBBLES_CHAT], 200, NOW).map(
        (message) => message.id,
      ),
    ).toEqual(['bb-fresh-command']);
  });

  it('executes quarantine before claim recovery', () => {
    const calls: string[] = [];

    const result = prepareActionableIngressForStartupRecovery(NOW, {
      getBlueBubblesRecoveryCutoff(now) {
        calls.push(`cutoff:${now.toISOString()}`);
        return '2026-07-16T18:05:00.000Z';
      },
      quarantineStaleBlueBubblesMessages(beforeTimestamp, quarantinedAt) {
        calls.push(`quarantine:${beforeTimestamp}`);
        calls.push(`quarantined-at:${quarantinedAt.toISOString()}`);
        return 4;
      },
      recoverAllClaims(now) {
        calls.push(`recover:${now.toISOString()}`);
        return 2;
      },
    });

    expect(calls).toEqual([
      'cutoff:2026-07-16T18:20:00.000Z',
      'quarantine:2026-07-16T18:05:00.000Z',
      'quarantined-at:2026-07-16T18:20:00.000Z',
      'recover:2026-07-16T18:20:00.000Z',
    ]);
    expect(result).toEqual({
      blueBubblesRecoveryCutoff: '2026-07-16T18:05:00.000Z',
      quarantinedBlueBubblesMessageCount: 4,
      recoveredIngressClaimCount: 2,
    });
  });

  it('keeps a stale prior-process row out of the first post-barrier queue claim', () => {
    vi.useFakeTimers();
    storeChatMetadata(
      BLUEBUBBLES_CHAT,
      '2026-07-16T18:00:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    vi.setSystemTime('2026-07-16T18:00:00.000Z');
    storeInboundMessage({
      id: 'bb-stale-before-startup-barrier',
      chatJid: BLUEBUBBLES_CHAT,
      timestamp: '2026-07-16T18:19:59.000Z',
      content: '@Andrea run an old queued instruction',
    });

    prepareActionableIngressForStartupRecovery(NOW);

    // This models the earliest live callback after channels are allowed to
    // connect. A queue claim may include it, but never the quarantined row.
    vi.setSystemTime('2026-07-16T18:20:00.001Z');
    storeInboundMessage({
      id: 'bb-fresh-after-startup-barrier',
      chatJid: BLUEBUBBLES_CHAT,
      timestamp: '2026-07-16T17:00:00.000Z',
      content: '@Andrea summarize the newest texts',
    });

    expect(
      claimPendingActionableMessagesForChat({
        chatJid: BLUEBUBBLES_CHAT,
        now: new Date('2026-07-16T18:20:01.000Z'),
      }).messages.map((message) => message.id),
    ).toEqual(['bb-fresh-after-startup-barrier']);
    expect(
      _getActionableIngressSnapshotForTests(
        BLUEBUBBLES_CHAT,
        'bb-stale-before-startup-barrier',
      ),
    ).toMatchObject({
      state: 'ignored',
      disposition: 'stale_bluebubbles_startup_quarantine',
    });
  });

  it('wires the production startup fence before channels, queue processing, and pending-message drain', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const recoveryCall = source.lastIndexOf(
      'prepareActionableIngressForStartupRecovery()',
    );
    const channelConnect = source.lastIndexOf('await channel.connect();');
    const queueProcessor = source.lastIndexOf('queue.setProcessMessagesFn(');
    const pendingDrain = source.lastIndexOf('recoverPendingMessages();');

    expect(recoveryCall).toBeGreaterThan(-1);
    expect(channelConnect).toBeGreaterThan(recoveryCall);
    expect(queueProcessor).toBeGreaterThan(recoveryCall);
    expect(pendingDrain).toBeGreaterThan(recoveryCall);
  });
});
