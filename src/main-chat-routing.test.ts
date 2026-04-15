import { describe, expect, it } from 'vitest';

import {
  decideMainChatRouting,
  shouldAvoidCombinedContextForMainChat,
} from './main-chat-routing.js';

describe('main chat routing', () => {
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
});
