import { describe, expect, it } from 'vitest';

import {
  primaryPresentationActions,
  renderAssistantPresentation,
  type AssistantPresentation,
} from './assistant-presentation.js';

const presentation: AssistantPresentation = {
  kind: 'daily',
  title: 'Today',
  lead: 'Your first meeting is at 10.',
  facts: [
    'Calendar checked just now.',
    'You have one open loop.',
    'Focus time: 45 minutes.',
    'Hidden fourth fact.',
  ],
  nextAction: 'Prepare the agenda.',
  actions: [
    { label: 'Prepare', actionId: 'prepare', kind: 'primary' },
    { label: 'Remind me', actionId: 'remind', kind: 'primary' },
    { label: 'Extra', actionId: 'extra', kind: 'primary' },
    { label: 'Why?', actionId: 'why', kind: 'details' },
  ],
};

describe('assistant presentation', () => {
  it('keeps Telegram answers layered and bounded', () => {
    const text = renderAssistantPresentation(presentation, 'telegram');
    expect(text).toContain('*Today*');
    expect(text).toContain('*Next:* Prepare the agenda.');
    expect(text).not.toContain('Hidden fourth fact');
  });

  it('uses plain compact output for BlueBubbles and voice', () => {
    expect(
      renderAssistantPresentation(presentation, 'bluebubbles'),
    ).not.toContain('*');
    expect(renderAssistantPresentation(presentation, 'alexa')).not.toContain(
      '\n',
    );
  });

  it('limits primary controls while retaining details', () => {
    expect(
      primaryPresentationActions(presentation).map((item) => item.actionId),
    ).toEqual(['prepare', 'remind', 'why']);
  });
});
