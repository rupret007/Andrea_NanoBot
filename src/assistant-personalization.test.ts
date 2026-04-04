import { beforeEach, describe, expect, it } from 'vitest';

import {
  acceptProposedProfileFact,
  buildAssistantPromptWithPersonalization,
  handlePersonalizationCommand,
  maybeCreateProactiveProfileCandidate,
  rejectProposedProfileFact,
} from './assistant-personalization.js';
import {
  _initTestDatabase,
  getProfileFact,
  listProfileFactsForGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata('tg:1', '2026-04-03T08:00:00.000Z', 'Telegram', 'telegram', false);
});

describe('assistant personalization', () => {
  it('applies directness controls and includes accepted facts in prompt context', () => {
    const result = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'be more direct',
    });

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('shorter and more direct');

    const prompt = buildAssistantPromptWithPersonalization(
      '<messages><message>hello</message></messages>',
      {
        channel: 'telegram',
        groupFolder: 'main',
      },
    );

    expect(prompt).toContain('Prefer short, direct answers');
    expect(prompt).toContain('Channel: Telegram.');
  });

  it('remembers explicit relationship facts and can summarize them', () => {
    const remember = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'remember that Candace is my spouse',
    });
    expect(remember.handled).toBe(true);

    const summary = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'what do you remember about Candace',
    });
    expect(summary.handled).toBe(true);
    expect(summary.responseText).toContain("Candace is your spouse");
  });

  it('uses conversation context for remember this and disables a referenced fact', () => {
    const remember = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'alexa',
      text: 'remember this',
      conversationSummary: 'Call the school before pickup.',
    });
    expect(remember.handled).toBe(true);
    expect(remember.referencedFactId).toBeTruthy();

    const forget = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'alexa',
      text: 'forget that',
      factIdHint: remember.referencedFactId,
    });
    expect(forget.handled).toBe(true);
    expect(getProfileFact(remember.referencedFactId!)?.state).toBe('disabled');
  });

  it('creates and accepts a conservative proactive directness candidate', () => {
    storeMessage({
      id: 'm1',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'User',
      content: 'make that shorter',
      timestamp: '2026-04-03T08:00:00.000Z',
    });
    storeMessage({
      id: 'm2',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'User',
      content: 'be more direct',
      timestamp: '2026-04-03T08:01:00.000Z',
    });

    const candidate = maybeCreateProactiveProfileCandidate({
      groupFolder: 'main',
      chatJid: 'tg:1',
      channel: 'telegram',
      text: 'make that shorter',
      now: new Date('2026-04-03T08:02:00.000Z'),
    });

    expect(candidate?.askText).toContain('short direct answers');
    expect(getProfileFact(candidate!.factId)?.state).toBe('proposed');
    expect(acceptProposedProfileFact(candidate!.factId, new Date('2026-04-03T08:03:00.000Z'))).toBe(true);
    expect(getProfileFact(candidate!.factId)?.state).toBe('accepted');
  });

  it('can reject a proposed candidate', () => {
    storeMessage({
      id: 'm3',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'User',
      content: 'what about Candace',
      timestamp: '2026-04-03T09:00:00.000Z',
    });
    storeMessage({
      id: 'm4',
      chat_jid: 'tg:1',
      sender: 'u1',
      sender_name: 'User',
      content: 'what do Candace and I have going on',
      timestamp: '2026-04-03T09:01:00.000Z',
    });

    const candidate = maybeCreateProactiveProfileCandidate({
      groupFolder: 'main',
      chatJid: 'tg:1',
      channel: 'telegram',
      text: 'what about Candace',
      now: new Date('2026-04-03T09:02:00.000Z'),
    });

    expect(candidate).toBeTruthy();
    expect(rejectProposedProfileFact(candidate!.factId, new Date('2026-04-03T09:03:00.000Z'))).toBe(true);
    expect(getProfileFact(candidate!.factId)?.state).toBe('rejected');
  });

  it('resets saved self preferences without deleting relationship facts', () => {
    handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'be more direct',
    });
    handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'remember that Candace is my spouse',
    });

    const reset = handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'reset my preferences',
    });
    expect(reset.handled).toBe(true);

    const accepted = listProfileFactsForGroup('main', ['accepted']);
    expect(accepted.map((fact) => fact.factKey)).toContain('relation_to_user');
    expect(accepted.map((fact) => fact.factKey)).not.toContain('response_style');
  });
});
