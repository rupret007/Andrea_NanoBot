import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase, setRouterState } from './db.js';
import {
  applyMessagingOutboundPauseCommand,
  captureMessagingOutboundAuthorizationFence,
  getMessagingOutboundPauseState,
  isMessagingOutboundPaused,
  parseMessagingOutboundPauseCommand,
  readMessagingOutboundPauseStateFromStore,
  resolveInboundMessagingOwnerAuthorizationAt,
  resolveQueuedMessagingOwnerAuthorizationAt,
  setMessagingOutboundPaused,
  validateMessagingOutboundAuthorizationFence,
} from './messaging-outbound-pause.js';

describe('messaging outbound pause', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it.each([
    'stop sending messages',
    'stop texting real people',
    'do not send any more texts to anyone',
    'turn off BlueBubbles',
  ])('recognizes an owner pause command: %s', (text) => {
    expect(parseMessagingOutboundPauseCommand(text)).toBe('pause');
  });

  it.each([
    'You’re texting people confusing things from my phone please stop',
    "You're sending people confusing messages from my phone stop",
    'You are sending messages from my phone, please stop.',
    'This keeps texting people from my phone please stop!',
  ])('recognizes a phone-origin safety complaint: %s', (text) => {
    expect(parseMessagingOutboundPauseCommand(text)).toBe('pause');
  });

  it.each([
    'stop',
    'Please stop by the store on your way home',
    "I can't stop texting from my phone",
    'I am sending this from my phone',
    'Please stop the video I am sending from my phone',
  ])(
    'does not treat ordinary or incomplete stop language as a pause: %s',
    (text) => {
      expect(parseMessagingOutboundPauseCommand(text)).toBeNull();
    },
  );

  it('requires an explicit resume command', () => {
    expect(parseMessagingOutboundPauseCommand('resume message sending')).toBe(
      'resume',
    );
    expect(parseMessagingOutboundPauseCommand('okay')).toBeNull();
    expect(parseMessagingOutboundPauseCommand('yes')).toBeNull();
  });

  it('keeps delayed Telegram and BlueBubbles authorization on immutable ingress clocks', () => {
    const delayedTelegram = {
      timestamp: '2026-07-16T19:45:00.000Z',
      ingress_received_at: '2026-07-16T20:00:00.000Z',
    };
    const blueBubblesIngress = {
      timestamp: '2026-07-17T01:00:00.000Z',
      ingress_received_at: '2026-07-16T19:45:00.000Z',
    };

    expect(resolveInboundMessagingOwnerAuthorizationAt(delayedTelegram)).toBe(
      '2026-07-16T20:00:00.000Z',
    );
    expect(
      resolveInboundMessagingOwnerAuthorizationAt({
        timestamp: '2026-07-16T19:45:00.000Z',
      }),
    ).toBe('2026-07-16T19:45:00.000Z');
    expect(
      resolveQueuedMessagingOwnerAuthorizationAt('telegram', delayedTelegram),
    ).toBe('2026-07-16T19:45:00.000Z');
    expect(
      resolveQueuedMessagingOwnerAuthorizationAt(
        'bluebubbles',
        blueBubblesIngress,
      ),
    ).toBe('2026-07-16T19:45:00.000Z');
    expect(
      resolveQueuedMessagingOwnerAuthorizationAt('bluebubbles', undefined),
    ).toBe('');
  });

  it('persists pause across state reads until explicitly resumed', () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
      now: new Date('2026-07-16T20:00:00.000Z'),
    });
    expect(isMessagingOutboundPaused()).toBe(true);
    expect(getMessagingOutboundPauseState()).toMatchObject({
      paused: true,
      changedByChatJid: 'tg:owner',
      lastPausedAt: '2026-07-16T20:00:00.000Z',
      pauseGeneration: 1,
    });

    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
      now: new Date('2026-07-16T20:01:00.000Z'),
    });
    expect(isMessagingOutboundPaused()).toBe(false);
    expect(getMessagingOutboundPauseState()).toMatchObject({
      paused: false,
      changedAt: '2026-07-16T20:01:00.000Z',
      lastPausedAt: '2026-07-16T20:00:00.000Z',
      pauseGeneration: 1,
    });
  });

  it('never lets a delayed or replayed resume clear a newer durable stop', () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'newer_owner_stop',
      now: new Date('2026-07-16T20:00:00.000Z'),
    });

    expect(
      applyMessagingOutboundPauseCommand({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'delayed_resume',
        authorizationAt: '2026-07-16T19:59:59.999Z',
        now: new Date('2026-07-16T21:00:00.000Z'),
      }),
    ).toMatchObject({ applied: false });
    expect(isMessagingOutboundPaused()).toBe(true);

    expect(
      applyMessagingOutboundPauseCommand({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'invalid_resume',
        authorizationAt: '',
      }),
    ).toMatchObject({ applied: false });
    expect(isMessagingOutboundPaused()).toBe(true);

    expect(
      applyMessagingOutboundPauseCommand({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'fresh_resume',
        authorizationAt: '2026-07-16T20:00:00.001Z',
      }),
    ).toMatchObject({ applied: true });
    expect(getMessagingOutboundPauseState()).toMatchObject({
      paused: false,
      changedAt: '2026-07-16T20:00:00.001Z',
    });

    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'second_newer_stop',
      now: new Date('2026-07-16T20:05:00.000Z'),
    });
    expect(
      applyMessagingOutboundPauseCommand({
        paused: false,
        changedByChatJid: 'tg:owner',
        reason: 'replayed_old_resume',
        authorizationAt: '2026-07-16T20:00:00.001Z',
      }),
    ).toMatchObject({ applied: false });
    expect(isMessagingOutboundPaused()).toBe(true);
  });

  it('reads the standalone durable store read-only and fails closed when unavailable', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-outbound-pause-'),
    );
    const databasePath = path.join(tempDir, 'messages.db');
    try {
      const database = new Database(databasePath);
      database.exec(
        'CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      database
        .prepare('INSERT INTO router_state (key, value) VALUES (?, ?)')
        .run(
          'messaging_outbound_pause_v1',
          JSON.stringify({
            paused: true,
            changedAt: '2026-07-16T20:00:00.000Z',
            changedByChatJid: 'tg:owner',
            reason: 'owner_natural_language_pause',
            lastPausedAt: '2026-07-16T20:00:00.000Z',
            pauseGeneration: 3,
          }),
        );
      database.close();

      expect(
        readMessagingOutboundPauseStateFromStore(databasePath),
      ).toMatchObject({
        paused: true,
        pauseGeneration: 3,
      });
      expect(
        readMessagingOutboundPauseStateFromStore(
          path.join(tempDir, 'missing.db'),
        ),
      ).toMatchObject({
        paused: true,
        reason: 'pause_state_unavailable_fail_closed',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retains the last stop boundary across later resumes and advances it only on a new pause', () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'first_pause',
      now: new Date('2026-07-16T20:00:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'first_resume',
      now: new Date('2026-07-16T20:05:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'duplicate_resume',
      now: new Date('2026-07-16T20:06:00.000Z'),
    });
    expect(getMessagingOutboundPauseState()?.lastPausedAt).toBe(
      '2026-07-16T20:00:00.000Z',
    );

    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'bb:owner-self-thread',
      reason: 'second_pause',
      now: new Date('2026-07-16T21:00:00.000Z'),
    });
    expect(getMessagingOutboundPauseState()?.lastPausedAt).toBe(
      '2026-07-16T21:00:00.000Z',
    );
    expect(getMessagingOutboundPauseState()?.pauseGeneration).toBe(2);
  });

  it('never moves the stop boundary backward and still advances its generation', () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'first_pause',
      now: new Date('2026-07-16T21:00:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'resume_after_clock_regression',
      now: new Date('2026-07-16T20:00:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'second_pause_after_clock_regression',
      now: new Date('2026-07-16T20:30:00.000Z'),
    });

    expect(getMessagingOutboundPauseState()).toMatchObject({
      paused: true,
      lastPausedAt: '2026-07-16T21:00:00.000Z',
      pauseGeneration: 2,
    });
  });

  it('invalidates an immutable fence across pause and resume, including the same millisecond', () => {
    const beforePause = captureMessagingOutboundAuthorizationFence(
      '2026-07-16T20:00:00.000Z',
    );
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_pause',
      now: new Date('2026-07-16T20:00:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume',
      now: new Date('2026-07-16T20:01:00.000Z'),
    });

    expect(validateMessagingOutboundAuthorizationFence(beforePause)).toEqual({
      ok: false,
      reason:
        'The owner changed the Messages pause generation after this dispatch was authorized.',
    });
    const mintedAfterResume = captureMessagingOutboundAuthorizationFence(
      '2026-07-16T20:00:00.000Z',
    );
    expect(
      validateMessagingOutboundAuthorizationFence(mintedAfterResume),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('before the latest owner stop boundary'),
    });
    expect(
      validateMessagingOutboundAuthorizationFence(
        captureMessagingOutboundAuthorizationFence('2026-07-16T20:01:00.001Z'),
      ),
    ).toEqual({ ok: true });
  });

  it('does not let a pre-stop Telegram card callback mint fresh authority after resume', () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_pause_after_card',
      now: new Date('2026-07-16T19:50:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume_after_card',
      now: new Date('2026-07-16T19:55:00.000Z'),
    });

    const oldCardAuthorization = resolveInboundMessagingOwnerAuthorizationAt({
      timestamp: '2026-07-16T19:45:00.000Z',
      ingress_received_at: '2026-07-16T19:45:00.000Z',
    });
    expect(
      validateMessagingOutboundAuthorizationFence(
        captureMessagingOutboundAuthorizationFence(oldCardAuthorization),
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('before the latest owner stop boundary'),
    });

    const freshCardAuthorization = resolveInboundMessagingOwnerAuthorizationAt({
      timestamp: '2026-07-16T19:55:00.001Z',
      ingress_received_at: '2026-07-16T19:55:00.001Z',
    });
    expect(
      validateMessagingOutboundAuthorizationFence(
        captureMessagingOutboundAuthorizationFence(freshCardAuthorization),
      ),
    ).toEqual({ ok: true });
  });

  it('fails closed when the durable pause database is unavailable', () => {
    _closeDatabase();
    try {
      expect(
        validateMessagingOutboundAuthorizationFence({
          authorizationAt: new Date().toISOString(),
          pauseGeneration: 0,
        }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining('state is unavailable'),
      });
    } finally {
      _initTestDatabase();
    }
  });

  it('normalizes a legacy active pause into a durable last-stop boundary', () => {
    setRouterState(
      'messaging_outbound_pause_v1',
      JSON.stringify({
        paused: true,
        changedAt: '2026-07-16T20:00:00.000Z',
        changedByChatJid: 'tg:owner',
        reason: 'legacy_owner_pause',
      }),
    );

    expect(getMessagingOutboundPauseState()).toMatchObject({
      paused: true,
      lastPausedAt: '2026-07-16T20:00:00.000Z',
      pauseGeneration: 1,
    });
  });

  it.each([
    '{not json',
    JSON.stringify({ paused: false }),
    JSON.stringify({
      paused: false,
      changedAt: 'not-a-date',
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
    }),
    JSON.stringify({
      paused: false,
      changedAt: '2026-07-16T20:00:00.000Z',
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
      lastPausedAt: 'not-a-date',
    }),
  ])(
    'fails closed when the durable pause record is corrupt: %s',
    (rawState) => {
      setRouterState('messaging_outbound_pause_v1', rawState);

      expect(isMessagingOutboundPaused()).toBe(true);
      expect(getMessagingOutboundPauseState()).toMatchObject({
        paused: true,
        reason: 'pause_state_corrupt_fail_closed',
      });
    },
  );
});
