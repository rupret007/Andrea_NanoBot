import { describe, expect, it } from 'vitest';

import {
  assistantCapabilityKey,
  classifyAssistantRequest,
} from './assistant-routing.js';
import {
  decideMainChatRouting,
  shouldAvoidCombinedContextForMainChat,
  shouldPipeToActiveAssistant,
} from './main-chat-routing.js';

describe('main chat routing', () => {
  it('replies locally for quick discovery asks even when no work session is active yet', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [{ content: 'what are you useful for right now' }],
      sessionState: 'inactive',
      localQuickReply:
        "I'm Andrea. I help most with schedule moves, reminders and save-for-later.",
    });

    expect(decision).toEqual({
      kind: 'reply_locally',
      replyText:
        "I'm Andrea. I help most with schedule moves, reminders and save-for-later.",
    });
  });

  it('replies locally for the exact silence regression when work is active', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [{ content: 'hey hows it going this morning' }],
      sessionState: 'busy_assistant',
      localQuickReply:
        'Doing well and fully caffeinated in spirit. What do you want to tackle?',
    });

    expect(decision).toEqual({
      kind: 'reply_locally',
      replyText:
        'Doing well and fully caffeinated in spirit. What do you want to tackle?',
    });
  });

  it('queues terse standalone work-like plain text behind active work instead of piping it into the session', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [{ content: 'continue' }],
      sessionState: 'busy_assistant',
      localQuickReply: null,
    });

    expect(decision).toEqual({ kind: 'queue_fresh_turn_after_work' });
  });

  it('processes standalone non-casual plain text as a fresh turn when the assistant session is idle', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [{ content: 'Can you summarize what changed overnight?' }],
      sessionState: 'idle_assistant',
      localQuickReply: null,
    });

    expect(decision).toEqual({ kind: 'process_fresh_turn_now' });
  });

  it('processes substantive new companion asks immediately even while work is active', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [
        {
          content:
            'Can you summerize my text messages in the Pops of Punk text thread please. Last 2 days.',
        },
      ],
      sessionState: 'busy_assistant',
      localQuickReply: null,
    });

    expect(decision).toEqual({ kind: 'process_fresh_turn_now' });
  });

  it('keeps explicit reply-context messages out of standalone conversation routing', () => {
    const decision = decideMainChatRouting({
      isMainGroup: true,
      messages: [{ content: 'continue', reply_to_id: '1234' }],
      sessionState: 'busy_assistant',
      localQuickReply: null,
    });

    expect(decision).toEqual({ kind: 'pipe_active_session' });
  });

  it('marks standalone main-chat plain text as unsafe for combined-context routing', () => {
    expect(
      shouldAvoidCombinedContextForMainChat([
        { content: 'continue', reply_to_id: undefined },
      ]),
    ).toBe(true);
  });

  it('does not pipe a search request into a tool-free active assistant', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'How are you today?' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'Search the web for the latest Node release' },
    ]);

    expect(activePolicy.route).toBe('direct_assistant');
    expect(incomingPolicy.route).toBe('protected_assistant');
    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'Search the web for the latest Node release' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(false);
  });

  it('does not pipe a new ordinary ask into an execution-capable active assistant', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'Edit src/index.ts and run its tests' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'How are you today?' },
    ]);

    expect(activePolicy.route).toBe('code_plane');
    expect(incomingPolicy.route).toBe('direct_assistant');
    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'How are you today?' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(false);
  });

  it('allows an explicit continuation to finish in its active capability boundary', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'Edit src/index.ts and run its tests' },
    ]);
    const incomingPolicy = classifyAssistantRequest([{ content: 'continue' }]);

    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'continue' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(true);
  });

  it('does not treat an acknowledgement prefix as permission to reuse execution tools', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'Edit src/index.ts and run its tests' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'okay, how are you today?' },
    ]);

    expect(incomingPolicy.route).toBe('direct_assistant');
    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'okay, how are you today?' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(false);
  });

  it('keeps a bounded skill-selection follow-up in its active tool boundary', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'Search the skill catalog for a calendar skill' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'install it' },
    ]);

    expect(activePolicy.route).toBe('advanced_helper');
    expect(incomingPolicy.route).toBe('direct_assistant');
    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'install it' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(true);
  });

  it('allows another request only when the capability profile matches exactly', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'Search the web for Node releases' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'Read https://nodejs.org and summarize it' },
    ]);

    expect(assistantCapabilityKey(incomingPolicy)).toBe(
      assistantCapabilityKey(activePolicy),
    );
    expect(
      shouldPipeToActiveAssistant({
        messages: [{ content: 'Read https://nodejs.org and summarize it' }],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(true);
  });

  it('does not let reply context override a protected capability request', () => {
    const activePolicy = classifyAssistantRequest([
      { content: 'How are you today?' },
    ]);
    const incomingPolicy = classifyAssistantRequest([
      { content: 'Search the web for the latest Node release' },
    ]);

    expect(
      shouldPipeToActiveAssistant({
        messages: [
          {
            content: 'Search the web for the latest Node release',
            reply_to_id: '1234',
          },
        ],
        incomingPolicy,
        activeCapabilityKey: assistantCapabilityKey(activePolicy),
      }),
    ).toBe(false);
  });
});
