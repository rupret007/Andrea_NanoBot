import { describe, expect, it } from 'vitest';

import { buildAssistantCapabilityExecutionInput } from './assistant-capability-input.js';

describe('buildAssistantCapabilityExecutionInput', () => {
  it('does not inherit the prior thread target for generic synced-thread summary asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'Summarize my text messages for today',
      capabilityMatch: {
        capabilityId: 'communication.summarize_thread',
        canonicalText: 'Summarize my text messages for today',
      },
      priorSubjectData: {
        threadTitle: 'Pops of Punk',
        personName: 'Pops of Punk',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
    expect(result.timeWindowKind).toBeNull();
  });

  it('keeps explicit thread targets on named synced-thread summary asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent:
        'Summarize the texts today from the Pops of Punk text thread please',
      capabilityMatch: {
        capabilityId: 'communication.summarize_thread',
        canonicalText: 'summarize my text messages in Pops of Punk from today',
        arguments: {
          targetChatName: 'Pops of Punk',
          threadTitle: 'Pops of Punk',
          timeWindowKind: 'today',
          timeWindowValue: null,
        },
      },
      priorSubjectData: {
        threadTitle: 'Older thread',
      },
    });

    expect(result.targetChatName).toBe('Pops of Punk');
    expect(result.threadTitle).toBe('Pops of Punk');
    expect(result.timeWindowKind).toBe('today');
  });

  it('does not inherit the prior thread target for recent text review asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'Review my recent texts',
      capabilityMatch: {
        capabilityId: 'communication.review_recent_texts',
        canonicalText: 'review recent text messages from the last 24 hours',
      },
      priorSubjectData: {
        threadTitle: 'Candace',
        personName: 'Candace',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
  });

  it('still reuses prior communication context for other communication follow-ups', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'What should I say back?',
      capabilityMatch: {
        capabilityId: 'communication.draft_reply',
        canonicalText: 'what should I say back',
      },
      priorSubjectData: {
        threadTitle: 'Candace',
        personName: 'Candace',
      },
    });

    expect(result.threadTitle).toBe('Candace');
    expect(result.personName).toBe('Candace');
  });

  it('does not inherit leftover person titles for generic what-do-I-owe asks', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: 'What do I owe people?',
      capabilityMatch: {
        capabilityId: 'communication.open_loops',
        canonicalText: 'what do I owe people',
      },
      priorSubjectData: {
        threadTitle: 'Bob',
        personName: 'Bob',
      },
    });

    expect(result.threadTitle).toBeNull();
    expect(result.personName).toBeUndefined();
    expect(result.targetChatName).toBeNull();
  });

  it('keeps an explicit named who-do-I-owe target', () => {
    const result = buildAssistantCapabilityExecutionInput({
      lastContent: "What's still open with Bob?",
      capabilityMatch: {
        capabilityId: 'communication.open_loops',
        canonicalText: "what's still open with Bob",
        arguments: {
          targetChatName: 'Bob',
          threadTitle: 'Bob',
          personName: 'Bob',
        },
      },
      priorSubjectData: {
        threadTitle: 'Older thread',
        personName: 'Older thread',
      },
    });

    expect(result.targetChatName).toBe('Bob');
    expect(result.threadTitle).toBe('Bob');
    expect(result.personName).toBe('Bob');
  });
});
