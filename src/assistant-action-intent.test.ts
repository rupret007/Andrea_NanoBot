import { describe, expect, it } from 'vitest';

import {
  composeAssistantMessageContent,
  parseAssistantMessageActionIntent,
} from './assistant-action-intent.js';

describe('assistant action intent', () => {
  it('parses a synthetic BlueBubbles request as execution with a funny content directive', () => {
    const intent = parseAssistantMessageActionIntent(
      'Have BlueBubbles send Avery Example a message saying The package arrived, and make it funny.',
    );

    expect(intent).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Avery Example',
      content: 'The package arrived',
      compositionDirectives: ['funny'],
      explicitlyAuthorizesExecution: true,
    });
    expect(composeAssistantMessageContent(intent!)).toBe('The package arrived');
  });

  it('distinguishes execute, draft, prepare, recommend, and inform modes', () => {
    expect(
      parseAssistantMessageActionIntent('Text Avery Example: Dinner is ready.')
        ?.mode,
    ).toBe('execute');
    expect(
      parseAssistantMessageActionIntent(
        'Draft a funny message to Avery Example saying dinner is ready.',
      )?.mode,
    ).toBe('draft');
    expect(
      parseAssistantMessageActionIntent(
        'Draft a text to Avery Example: Hello.',
      ),
    ).toMatchObject({
      mode: 'draft',
      targetLabel: 'Avery Example',
      content: 'Hello.',
      explicitlyAuthorizesExecution: false,
    });
    expect(
      parseAssistantMessageActionIntent(
        'Prepare a message for Avery Example saying dinner is ready.',
      )?.mode,
    ).toBe('prepare');
    expect(
      parseAssistantMessageActionIntent('What should I text Avery Example?')
        ?.mode,
    ).toBe('recommend');
    expect(
      parseAssistantMessageActionIntent('Can BlueBubbles send texts for me?')
        ?.mode,
    ).toBe('inform');
  });

  it('parses a synthetic composite recent-text request as an exact Casey send', () => {
    expect(
      parseAssistantMessageActionIntent(
        'Hi can you use blue bubbles to send a message back to Casey please. Check my recent text from her and reply from you that yes, please bring the blue folder before the courier arrives.',
      ),
    ).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Casey',
      content: 'yes, please bring the blue folder before the courier arrives.',
      compositionDirectives: [],
      explicitlyAuthorizesExecution: true,
      contextBinding: {
        kind: 'recent_recipient_thread',
      },
    });
  });

  it.each([
    [
      'Use BlueBubbles to check my recent text from Casey and reply yes, please pick them up.',
      'yes, please pick them up.',
    ],
    [
      'Hi, could you use Messages to check Casey’s recent message and reply that Sure, please pick them up.',
      'Sure, please pick them up.',
    ],
  ])(
    'parses a natural recent-text reply variant: %s',
    (request, expectedContent) => {
      expect(parseAssistantMessageActionIntent(request)).toMatchObject({
        mode: 'execute',
        targetLabel: 'Casey',
        content: expectedContent,
        explicitlyAuthorizesExecution: true,
      });
    },
  );

  it('keeps a numbered review reply bound to its item and named recipient', () => {
    expect(
      parseAssistantMessageActionIntent(
        'Yes reply to 1 Casey saying yes I need her to pick up please.',
      ),
    ).toEqual({
      kind: 'message_send',
      mode: 'execute',
      capabilityId: 'messages.send.bluebubbles',
      providerId: 'bluebubbles',
      targetLabel: 'Casey',
      content: 'yes I need her to pick up please.',
      compositionDirectives: [],
      explicitlyAuthorizesExecution: true,
      contextBinding: {
        kind: 'recent_text_review_item',
        itemNumber: 1,
      },
    });
  });

  it.each([
    ['Reply to #1 saying I can pick them up at six.', null],
    ['Reply to #1: I can pick them up at six.', null],
    ['Reply to 1 Casey: I can pick them up at six.', 'Casey'],
  ])('preserves the supplied numbered-review body: %s', (request, target) => {
    expect(parseAssistantMessageActionIntent(request)).toMatchObject({
      mode: 'execute',
      targetLabel: target,
      content: 'I can pick them up at six.',
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

  it('preserves indirect wording literally unless the owner requests composition', () => {
    const composite = parseAssistantMessageActionIntent(
      'Hi can you use blue bubbles to send a message back to Casey please. Check my recent text from her and reply from you that yes, please bring the blue folder before the courier arrives.',
    );
    const numbered = parseAssistantMessageActionIntent(
      'Yes reply to 1 Casey saying yes I need her to pick up please.',
    );

    expect(composite && composeAssistantMessageContent(composite)).toBe(
      'yes, please bring the blue folder before the courier arrives.',
    );
    expect(numbered && composeAssistantMessageContent(numbered)).toBe(
      'yes I need her to pick up please.',
    );
  });

  it.each([
    [
      'Reply to #1 saying Line one.\nLine two with “quotes” and 🫶🏽.',
      'Line one.\nLine two with “quotes” and 🫶🏽.',
    ],
    [
      'Text Avery Example: First line.\nSecond line with emoji 🫶🏽.',
      'First line.\nSecond line with emoji 🫶🏽.',
    ],
  ])('preserves multiline and Unicode message bodies: %s', (request, body) => {
    const intent = parseAssistantMessageActionIntent(request);
    expect(intent?.content).toBe(body);
    expect(intent && composeAssistantMessageContent(intent)).toBe(body);
  });

  it.each([
    'Can you text Avery Example: Dinner is ready.',
    'Please can you text Avery Example: Dinner is ready.',
    'Hi, could you please text Avery Example: Dinner is ready.',
    'Hey! Would you send a message to Avery Example saying Dinner is ready.',
    'Hello can you use BlueBubbles to send Avery Example a message saying Dinner is ready.',
  ])('accepts a polite conversational preamble: %s', (request) => {
    expect(parseAssistantMessageActionIntent(request)).toMatchObject({
      mode: 'execute',
      targetLabel: 'Avery Example',
      content: 'Dinner is ready.',
      explicitlyAuthorizesExecution: true,
    });
  });

  it('does not turn a quoted literal phrase into a style directive', () => {
    const intent = parseAssistantMessageActionIntent(
      'Text Avery Example: "Please make it funny"',
    );
    expect(intent?.content).toBe('Please make it funny');
    expect(intent?.compositionDirectives).toEqual([]);
  });
});
