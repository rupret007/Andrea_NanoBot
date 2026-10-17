import { describe, expect, it } from 'vitest';

import type { MessageActionRecord } from './types.js';
import {
  isWebBobDispatchApproval,
  mintWebBobDispatchApproval,
} from './web-bob-approval.js';

function action(
  overrides: Partial<MessageActionRecord> = {},
): MessageActionRecord {
  const now = new Date().toISOString();
  return {
    messageActionId: 'action-1',
    groupFolder: 'webbob',
    sourceType: 'manual_prompt',
    sourceKey: 'webbob:inbound:abc',
    targetKind: 'external_thread',
    targetChannel: 'bluebubbles',
    targetConversationJson: JSON.stringify({
      kind: 'external_thread',
      chatJid: 'bb:iMessage;-;+12025550102',
      isGroup: false,
    }),
    draftText: 'Exact owner text.',
    trustLevel: 'approve_before_send',
    sendStatus: 'approved',
    requiresApproval: true,
    dedupeKey: 'dedupe-1',
    presentationChatJid: 'webbob:conversation-123',
    createdAt: now,
    lastUpdatedAt: now,
    ...overrides,
  };
}

describe('Web Bob host-only dispatch approval', () => {
  it.each([
    { messageActionId: 'another-action' },
    {
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;-;+12025550103',
        isGroup: false,
      }),
    },
    { presentationChatJid: 'webbob:another-conversation' },
    { targetChannel: 'telegram' as const },
  ])('rejects a changed action binding: %j', (overrides) => {
    const now = Date.now();
    const original = action();
    const approval = mintWebBobDispatchApproval(original, now);
    const altered = action(overrides);
    expect(
      isWebBobDispatchApproval(
        approval,
        altered,
        altered.presentationChatJid!,
        now,
      ),
    ).toBe(false);
  });

  it('rejects an approval presented from a different conversation', () => {
    const now = Date.now();
    const original = action();
    const approval = mintWebBobDispatchApproval(original, now);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        'webbob:another-conversation',
        now,
      ),
    ).toBe(false);
  });

  it.each([undefined, null, '', 'bb:iMessage;-;+12025550102'])(
    'does not mint approval for a non-Web Bob presentation surface: %s',
    (presentationChatJid) => {
      expect(() =>
        mintWebBobDispatchApproval(action({ presentationChatJid })),
      ).toThrow('Web Bob approval requires its own presentation surface.');
    },
  );

  it('binds the minted capability to the exact content hash', () => {
    const now = Date.now();
    const original = action();
    const approval = mintWebBobDispatchApproval(original, now);
    expect(
      isWebBobDispatchApproval(
        approval,
        action({ draftText: 'Different bytes.' }),
        original.presentationChatJid!,
        now,
      ),
    ).toBe(false);
    expect(
      isWebBobDispatchApproval(
        { surface: 'web-bob' },
        original,
        original.presentationChatJid!,
        now,
      ),
    ).toBe(false);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        original.presentationChatJid!,
        now,
      ),
    ).toBe(true);
  });

  it('consumes the approval on the first successful check', () => {
    const now = Date.now();
    const original = action();
    const approval = mintWebBobDispatchApproval(original, now);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        original.presentationChatJid!,
        now,
      ),
    ).toBe(true);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        original.presentationChatJid!,
        now,
      ),
    ).toBe(false);
  });

  it('expires on the real injected clock without fake timers', () => {
    const now = Date.now();
    const original = action();
    const approval = mintWebBobDispatchApproval(original, now);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        original.presentationChatJid!,
        now + 30_000,
      ),
    ).toBe(false);
    expect(
      isWebBobDispatchApproval(
        approval,
        original,
        original.presentationChatJid!,
        now + 29_999,
      ),
    ).toBe(true);
  });
});
