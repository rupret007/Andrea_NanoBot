import { describe, expect, it } from 'vitest';
import {
  resolveAssistantConversationFollowup,
  type AssistantConversationState,
} from './assistant-conversation.js';
describe('shared conversation follow-ups', () => {
  it('asks for a clearer anchor when a follow-up arrives with no Assistant context', () => {
    expect(
      resolveAssistantConversationFollowup('anything else', undefined).speech,
    ).toContain('a person, a plan, or something you want me to remember');
  });

  it('resolves strong follow-ups and rejects weak ones', () => {
    const state: AssistantConversationState = {
      flowKey: 'before_next_meeting',
      subjectKind: 'meeting',
      subjectData: {},
      summaryText: 'your next meeting and what to handle before it',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'before_that',
        'after_that',
        'remind_before_that',
        'save_that',
        'save_for_later',
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
        'draft_follow_up',
        'approve_bundle',
        'show_bundle',
        'action_guidance',
        'risk_check',
        'memory_control',
      ],
      styleHints: {},
    };

    expect(
      resolveAssistantConversationFollowup('anything else', state),
    ).toMatchObject({ ok: true, action: 'anything_else' });
    expect(
      resolveAssistantConversationFollowup('make that shorter', state),
    ).toMatchObject({ ok: true, action: 'shorter' });
    expect(
      resolveAssistantConversationFollowup('say more', state),
    ).toMatchObject({
      ok: true,
      action: 'say_more',
    });
    expect(
      resolveAssistantConversationFollowup('remember that', state),
    ).toMatchObject({ ok: true, action: 'save_that' });
    expect(
      resolveAssistantConversationFollowup('save that for later', state),
    ).toMatchObject({ ok: true, action: 'save_for_later' });
    expect(
      resolveAssistantConversationFollowup('send me the details', state),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAssistantConversationFollowup(
        'give me the deeper comparison in Telegram',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAssistantConversationFollowup('send that to my messages', state),
    ).toMatchObject({ ok: true, action: 'send_details' });
    expect(
      resolveAssistantConversationFollowup('save that in my library', state),
    ).toMatchObject({ ok: true, action: 'save_to_library' });
    expect(
      resolveAssistantConversationFollowup(
        'track that under Candace thread',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'track_thread' });
    expect(
      resolveAssistantConversationFollowup(
        'turn that into a reminder tonight',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'create_reminder' });
    expect(
      resolveAssistantConversationFollowup('just the reminder', state),
    ).toMatchObject({ ok: true, action: 'create_reminder' });
    expect(
      resolveAssistantConversationFollowup(
        'keep track of that for tonight',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'save_for_later' });
    expect(
      resolveAssistantConversationFollowup('draft that for me', state),
    ).toMatchObject({ ok: true, action: 'draft_follow_up' });
    expect(
      resolveAssistantConversationFollowup('draft a message about that', state),
    ).toMatchObject({ ok: true, action: 'draft_follow_up' });
    expect(
      resolveAssistantConversationFollowup('do that', state),
    ).toMatchObject({
      ok: true,
      action: 'approve_bundle',
    });
    expect(
      resolveAssistantConversationFollowup('show me the actions again', state),
    ).toMatchObject({ ok: true, action: 'show_bundle' });
    expect(
      resolveAssistantConversationFollowup('remind me before that', state),
    ).toMatchObject({ ok: true, action: 'remind_before_that' });
    expect(
      resolveAssistantConversationFollowup(
        'what should I do about that',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'action_guidance' });
    expect(
      resolveAssistantConversationFollowup(
        'should I be worried about anything',
        state,
      ),
    ).toMatchObject({ ok: true, action: 'risk_check' });
    expect(
      resolveAssistantConversationFollowup('be a little more direct', state),
    ).toMatchObject({ ok: true, action: 'memory_control' });
    expect(
      resolveAssistantConversationFollowup('what is the weather', state),
    ).toMatchObject({ ok: false });
  });

  it('resolves generic person follow-ups and explainability prompts', () => {
    const state: AssistantConversationState = {
      flowKey: 'family_upcoming',
      subjectKind: 'household',
      subjectData: {
        personName: 'Candace',
        activePeople: ['Candace', 'Travis'],
        householdFocus: true,
      },
      summaryText: 'family plans and household logistics',
      supportedFollowups: ['anything_else', 'switch_person', 'memory_control'],
      styleHints: {},
    };

    expect(
      resolveAssistantConversationFollowup('what about Travis', state),
    ).toMatchObject({ ok: true, action: 'switch_person' });
    expect(
      resolveAssistantConversationFollowup('why did you say that', state),
    ).toMatchObject({ ok: true, action: 'memory_control' });
    expect(
      resolveAssistantConversationFollowup('what is the weather', state).speech,
    ).toContain('still about Candace');
  });

  it('uses the active Assistant anchor when a follow-up binding is too weak to complete safely', () => {
    const state: AssistantConversationState = {
      flowKey: 'candace_followthrough',
      subjectKind: 'person',
      subjectData: {
        personName: 'Candace',
        activeVoiceAnchor: 'Candace dinner plans',
      },
      summaryText: 'Candace still needs a dinner answer tonight.',
      supportedFollowups: ['anything_else'],
      styleHints: {},
    };

    expect(
      resolveAssistantConversationFollowup('save that', state),
    ).toMatchObject({
      ok: false,
      speech: expect.stringContaining('Candace dinner plans'),
    });
  });
});
