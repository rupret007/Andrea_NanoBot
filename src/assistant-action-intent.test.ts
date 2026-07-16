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

  it('does not turn a quoted literal phrase into a style directive', () => {
    const intent = parseAssistantMessageActionIntent(
      'Text Travis Story: "Please make it funny"',
    );
    expect(intent?.content).toBe('Please make it funny');
    expect(intent?.compositionDirectives).toEqual([]);
  });
});
