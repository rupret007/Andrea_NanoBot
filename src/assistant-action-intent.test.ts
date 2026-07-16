import { describe, expect, it } from 'vitest';

import {
  composeAssistantMessageContent,
  parseAssistantMessageActionIntent,
} from './assistant-action-intent.js';

describe('assistant action intent', () => {
  it('parses the exact BlueBubbles request as execution with a funny content directive', () => {
    const intent = parseAssistantMessageActionIntent(
      'Have BlueBubbles send Travis Story a message saying hi from Andrea and he smells, and make it funny.',
    );

    expect(intent).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Travis Story',
      content: 'hi from Andrea and he smells',
      compositionDirectives: ['funny'],
      explicitlyAuthorizesExecution: true,
    });
    expect(composeAssistantMessageContent(intent!)).toBe(
      'Hi from Andrea — she says you smell, but in a limited-edition, artisanal way. 😄',
    );
  });

  it('distinguishes execute, draft, prepare, recommend, and inform modes', () => {
    expect(
      parseAssistantMessageActionIntent('Text Travis Story: Dinner is ready.')
        ?.mode,
    ).toBe('execute');
    expect(
      parseAssistantMessageActionIntent(
        'Draft a funny message to Travis Story saying dinner is ready.',
      )?.mode,
    ).toBe('draft');
    expect(
      parseAssistantMessageActionIntent('Draft a text to Travis Story: Hello.'),
    ).toMatchObject({
      mode: 'draft',
      targetLabel: 'Travis Story',
      content: 'Hello.',
      explicitlyAuthorizesExecution: false,
    });
    expect(
      parseAssistantMessageActionIntent(
        'Prepare a message for Travis Story saying dinner is ready.',
      )?.mode,
    ).toBe('prepare');
    expect(
      parseAssistantMessageActionIntent('What should I text Travis Story?')
        ?.mode,
    ).toBe('recommend');
    expect(
      parseAssistantMessageActionIntent('Can BlueBubbles send texts for me?')
        ?.mode,
    ).toBe('inform');
  });

  it('parses the real composite recent-text request as an exact Candace send', () => {
    expect(
      parseAssistantMessageActionIntent(
        'Hi can you use blue bubbles to send a message back to Candace please. Check my recent text from her and reply from you that yes please if she could pick them up I haven’t had a chance.',
      ),
    ).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Candace',
      content: 'yes please if she could pick them up I haven’t had a chance.',
      compositionDirectives: [],
      explicitlyAuthorizesExecution: true,
      contextBinding: {
        kind: 'recent_recipient_thread',
      },
    });
  });

  it.each([
    [
      'Use BlueBubbles to check my recent text from Candace and reply yes, please pick them up.',
      'yes, please pick them up.',
    ],
    [
      'Hi, could you use Messages to check Candace’s recent message and reply that Sure, please pick them up.',
      'Sure, please pick them up.',
    ],
  ])(
    'parses a natural recent-text reply variant: %s',
    (request, expectedContent) => {
      expect(parseAssistantMessageActionIntent(request)).toMatchObject({
        mode: 'execute',
        targetLabel: 'Candace',
        content: expectedContent,
        explicitlyAuthorizesExecution: true,
      });
    },
  );

  it('keeps a numbered review reply bound to its item and named recipient', () => {
    expect(
      parseAssistantMessageActionIntent(
        'Yes reply to 1 Candace saying yes I need her to pick up please.',
      ),
    ).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Candace',
      content: 'yes I need her to pick up please.',
      compositionDirectives: [],
      explicitlyAuthorizesExecution: true,
      contextBinding: {
        kind: 'recent_text_review_item',
        itemNumber: 1,
      },
    });
  });

  it('treats the real BlueBubbles capability-truth question as inform-only', () => {
    expect(
      parseAssistantMessageActionIntent(
        'You can’t send message on blue bubbles on my behalf?',
      ),
    ).toMatchObject({
      mode: 'inform',
      targetLabel: null,
      content: null,
      explicitlyAuthorizesExecution: false,
    });
  });

  it('turns the real indirect Candace instructions into natural recipient-facing text', () => {
    const composite = parseAssistantMessageActionIntent(
      'Hi can you use blue bubbles to send a message back to Candace please. Check my recent text from her and reply from you that yes please if she could pick them up I haven’t had a chance.',
    );
    const numbered = parseAssistantMessageActionIntent(
      'Yes reply to 1 Candace saying yes I need her to pick up please.',
    );

    expect(composite && composeAssistantMessageContent(composite)).toBe(
      'Yes, please pick them up. I haven’t had a chance.',
    );
    expect(numbered && composeAssistantMessageContent(numbered)).toBe(
      'Yes, please pick them up.',
    );
  });

  it.each([
    'Can you text Travis Story: Dinner is ready.',
    'Please can you text Travis Story: Dinner is ready.',
    'Hi, could you please text Travis Story: Dinner is ready.',
    'Hey! Would you send a message to Travis Story saying Dinner is ready.',
    'Hello can you use BlueBubbles to send Travis Story a message saying Dinner is ready.',
  ])('accepts a polite conversational preamble: %s', (request) => {
    expect(parseAssistantMessageActionIntent(request)).toMatchObject({
      mode: 'execute',
      targetLabel: 'Travis Story',
      content: 'Dinner is ready.',
      explicitlyAuthorizesExecution: true,
    });
  });

  it('does not turn a quoted literal phrase into a style directive', () => {
    const intent = parseAssistantMessageActionIntent(
      'Text Travis Story: "Please make it funny"',
    );
    expect(intent?.content).toBe('Please make it funny');
    expect(intent?.compositionDirectives).toEqual([]);
  });
});
