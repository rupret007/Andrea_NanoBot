/**
 * Instinct Fence Tests
 *
 * These tests prove that the Instinct real-world partner number is NOT on
 * any allowlist and that NanoBot never auto-replies into Instinct threads.
 *
 * Architecture note: Instinct is a real-world partner agent that lives outside
 * NanoBot. NanoBot is the thin send/receive wire only. Instinct logic must
 * never be absorbed into this service.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropIncomingMessageBeforeCommands,
  shouldDropMessage,
  type SenderAllowlistConfig,
} from './sender-allowlist.js';
import {
  isNeverAuthorizeSendCaller,
  isNeverAuthorizeSendSurface,
  isTrustedOwnerReviewSurface,
} from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

const INSTINCT_PHONE_HANDLES = [
  '+15551234567',
  '+15559876543',
  '+1555INSTINCT',
];

const INSTINCT_CHAT_JIDS = [
  'bb:iMessage;-;+15551234567',
  'bb:iMessage;-;+15559876543',
  'bb:SMS;-;+15551234567',
];

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-fence-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Instinct number is NOT on sender allowlist', () => {
  it('Instinct phone handles are denied when default allows only specific senders', () => {
    const p = writeConfig({
      default: { allow: ['jeff@example.com', 'bob@example.com'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);

    for (const handle of INSTINCT_PHONE_HANDLES) {
      expect(isSenderAllowed('any-chat', handle, cfg)).toBe(false);
      expect(isTriggerAllowed('any-chat', handle, cfg)).toBe(false);
    }
  });

  it('Instinct phone handles can be explicitly excluded from a per-chat allowlist', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        'bb:iMessage;-;+15551234567': {
          allow: [],
          mode: 'drop',
        },
      },
    });
    const cfg = loadSenderAllowlist(p);

    expect(shouldDropMessage('bb:iMessage;-;+15551234567', cfg)).toBe(true);
    expect(
      isSenderAllowed('bb:iMessage;-;+15551234567', '+15551234567', cfg),
    ).toBe(false);
  });

  it('messages from Instinct numbers are dropped when configured', () => {
    const p = writeConfig({
      default: { allow: ['owner@example.com'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);

    for (const handle of INSTINCT_PHONE_HANDLES) {
      expect(
        shouldDropIncomingMessageBeforeCommands(
          'bb:group-chat',
          { is_from_me: false, is_bot_message: false, sender: handle },
          cfg,
          true,
        ),
      ).toBe(true);
    }
  });
});

describe('NanoBot never auto-replies into Instinct threads', () => {
  it('Instinct chat JIDs are never trusted owner review surfaces', () => {
    for (const chatJid of INSTINCT_CHAT_JIDS) {
      expect(
        isTrustedOwnerReviewSurface({
          channelName: 'bluebubbles',
          chatJid,
          group: mainGroup,
        }),
      ).toBe(false);
    }
  });

  it('Instinct chat JIDs cannot authorize sends', () => {
    for (const chatJid of INSTINCT_CHAT_JIDS) {
      expect(
        isNeverAuthorizeSendCaller({
          group: mainGroup,
          chatJid,
        }),
      ).toBe(true);
    }
  });

  it('Instinct-labeled surfaces cannot authorize sends even with isMain', () => {
    const instinctGroup: RegisteredGroup = {
      ...mainGroup,
      name: 'Instinct',
      folder: 'instinct',
    };

    expect(
      isNeverAuthorizeSendSurface(instinctGroup, {
        chatJid: 'bb:iMessage;-;+15551234567',
      }),
    ).toBe(false);

    expect(
      isNeverAuthorizeSendCaller({
        group: instinctGroup,
        chatJid: 'bb:iMessage;-;+15551234567',
      }),
    ).toBe(true);
  });

  it('messages from Instinct do not trigger assistant responses when drop mode is configured', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'drop' },
      chats: {},
      logDenied: false,
    };

    for (const handle of INSTINCT_PHONE_HANDLES) {
      expect(
        shouldDropIncomingMessageBeforeCommands(
          'bb:band-chat',
          { is_from_me: false, is_bot_message: false, sender: handle },
          cfg,
          true,
        ),
      ).toBe(true);

      expect(isTriggerAllowed('bb:band-chat', handle, cfg)).toBe(false);
    }
  });
});

describe('Instinct fence respects Jeff architecture', () => {
  it('Instinct numbers stay outside the send authorization boundary', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['jeff@example.com'], mode: 'drop' },
      chats: {},
      logDenied: false,
    };

    expect(isSenderAllowed('bb:any-chat', 'jeff@example.com', cfg)).toBe(true);

    for (const handle of INSTINCT_PHONE_HANDLES) {
      expect(isSenderAllowed('bb:any-chat', handle, cfg)).toBe(false);
    }
  });

  it('owner-only chats cannot be hijacked by Instinct handles', () => {
    const p = writeConfig({
      default: {
        allow: ['owner@example.com'],
        mode: 'trigger',
      },
      chats: {
        'bb:owner-self-thread': {
          allow: ['owner@example.com'],
          mode: 'trigger',
        },
      },
    });
    const cfg = loadSenderAllowlist(p);

    expect(
      isSenderAllowed('bb:owner-self-thread', 'owner@example.com', cfg),
    ).toBe(true);

    for (const handle of INSTINCT_PHONE_HANDLES) {
      expect(isSenderAllowed('bb:owner-self-thread', handle, cfg)).toBe(false);

      expect(
        shouldDropIncomingMessageBeforeCommands(
          'bb:owner-self-thread',
          { is_from_me: false, is_bot_message: false, sender: handle },
          cfg,
          true,
        ),
      ).toBe(false);

      expect(isTriggerAllowed('bb:owner-self-thread', handle, cfg)).toBe(false);
    }
  });
});
