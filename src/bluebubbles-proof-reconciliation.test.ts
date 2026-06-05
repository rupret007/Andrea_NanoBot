import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
  updateMessageAction,
} from './db.js';
import { getBlueBubblesCanonicalSelfThreadJid } from './bluebubbles-self-thread.js';
import {
  buildBlueBubblesProofReconciliationReport,
  formatBlueBubblesProofReconciliationReport,
} from './bluebubbles-proof-reconciliation.js';
import { createOrRefreshMessageActionFromDraft } from './message-actions.js';

function seedSelfThreadMessages(): void {
  const canonical = getBlueBubblesCanonicalSelfThreadJid();
  storeChatMetadata(
    canonical,
    '2026-06-04T12:00:00.000Z',
    canonical,
    'bluebubbles',
    false,
  );
  storeMessageDirect({
    id: 'bb:user-proof-start',
    chat_jid: canonical,
    sender: '+14695405551',
    sender_name: 'Jeff',
    content: '@Andrea send it later tonight with secret words',
    timestamp: '2026-06-04T12:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
  });
}

function createSelfThreadAction(now: Date) {
  const canonical = getBlueBubblesCanonicalSelfThreadJid();
  return createOrRefreshMessageActionFromDraft({
    groupFolder: 'main',
    presentationChannel: 'bluebubbles',
    presentationChatJid: canonical,
    sourceType: 'manual_prompt',
    sourceKey: `proof-test:${now.toISOString()}`,
    sourceSummary: 'BlueBubbles same-thread proof drill.',
    draftText: 'BlueBubbles proof drill draft.',
    personName: 'Andrea self-thread',
    threadTitle: 'Andrea self-thread proof lane',
    communicationContext: 'general',
    targetOverride: {
      kind: 'external_thread',
      chatJid: canonical,
      threadId: null,
      replyToMessageId: null,
      isGroup: false,
      personName: 'Andrea self-thread',
    },
    targetChannelOverride: 'bluebubbles',
    now,
  });
}

describe('BlueBubbles proof reconciliation', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('promotes a fresh deferred canonical self-thread action with confirmation', () => {
    const canonical = getBlueBubblesCanonicalSelfThreadJid();
    seedSelfThreadMessages();
    const action = createSelfThreadAction(new Date('2026-06-04T12:01:00.000Z'));
    updateMessageAction(action.messageActionId, {
      sendStatus: 'deferred',
      lastActionKind: 'remind_instead',
      lastActionAt: '2026-06-04T12:02:00.000Z',
      lastUpdatedAt: '2026-06-04T12:02:00.000Z',
      requiresApproval: false,
    });
    storeMessageDirect({
      id: 'bb:proof-confirmation',
      chat_jid: canonical,
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: BlueBubbles proof drill deferred decision is recorded.',
      timestamp: '2026-06-04T12:02:05.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    const report = buildBlueBubblesProofReconciliationReport({
      groupFolder: 'main',
      now: new Date('2026-06-04T12:10:00.000Z'),
    });

    expect(report.messageActionProofState).toBe('fresh');
    expect(report.lastDecisionActionId).toBe(action.messageActionId);
    expect(report.confirmationAt).toBe('2026-06-04T12:02:05.000Z');
    expect(report.blockerCategory).toBe('none');
    expect(formatBlueBubblesProofReconciliationReport(report)).not.toContain(
      'secret words',
    );
  });

  it('keeps skipped actions from satisfying proof', () => {
    seedSelfThreadMessages();
    const action = createSelfThreadAction(new Date('2026-06-04T12:01:00.000Z'));
    updateMessageAction(action.messageActionId, {
      sendStatus: 'skipped',
      lastActionKind: 'skipped',
      lastActionAt: '2026-06-04T12:02:00.000Z',
      lastUpdatedAt: '2026-06-04T12:02:00.000Z',
    });

    const report = buildBlueBubblesProofReconciliationReport({
      groupFolder: 'main',
      now: new Date('2026-06-04T12:10:00.000Z'),
    });

    expect(report.messageActionProofState).toBe('none');
    expect(report.blockerCategory).toBe('skipped');
    expect(
      report.timeline.some((entry) => entry.detail === 'skipped_action'),
    ).toBe(true);
  });
});
