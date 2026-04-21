import { describe, expect, it } from 'vitest';

import {
  buildDirectAssistantRuntimeFailureReply,
  maybeBuildDirectQuickReply,
  maybeBuildDirectRescueReply,
} from './direct-quick-reply.js';
import { buildAndreaPingPresenceReply } from './ping-presence.js';

describe('direct quick reply', () => {
  it('returns 42 for meaning-of-life asks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: "what's the meaning of life?" },
    ]);

    expect(reply).toContain('42');
  });

  it('returns a personality response', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'do you have a personality?' },
    ]);

    expect(reply).toContain('Andrea');
  });

  it('returns a greeting response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'hello there' }]);

    expect(reply).toBeTruthy();
    expect(reply?.toLowerCase()).toContain('hi');
  });

  it('returns a casual morning check-in response for the exact live failure phrasing', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'hey hows it going this morning' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it('returns a casual response for bare-Andrea how-we-doing checks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Hey Andrea how we doing?' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it('returns a casual response for bare-Andrea how-are-we-doing checks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Hey Andrea, how are we doing?' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it('returns a casual response for direct how-we-doing checks', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'how we doing?' }]);

    expect(reply).toContain('Doing well');
  });

  it('keeps @Andrea how-we-doing checks local-first', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: '@Andrea hey how we doing?' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it('returns a casual response for good-morning check-ins', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'good morning, how are you' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it("returns a calm what's-up response", () => {
    const reply = maybeBuildDirectQuickReply([{ content: "what's up?" }]);

    expect(reply).toBeTruthy();
    expect(reply?.toLowerCase()).not.toContain('candace');
    expect(reply?.toLowerCase()).not.toContain('dinner');
  });

  it('keeps BlueBubbles @Andrea vibe checks local-first', () => {
    const reply = maybeBuildDirectQuickReply([{ content: "@Andrea what's up?" }]);

    expect(reply).toBeTruthy();
    expect(reply?.toLowerCase()).not.toContain('candace');
    expect(reply?.toLowerCase()).not.toContain('dinner');
  });

  it('returns a calm what-are-you-doing response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'what are you doing?' }]);

    expect(reply).toBeTruthy();
    expect(reply).not.toContain('/help');
  });

  it('returns a warm help-me response without dumping commands', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'can you help me?' }]);

    expect(reply).toBeTruthy();
    expect(reply).not.toContain('/help');
  });

  it('does not hijack mixed greeting requests', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Hi, can you remind me tomorrow at 3pm to call Sam?' },
    ]);

    expect(reply).toBeNull();
  });

  it('does not hijack mixed reminder asks that start with a greeting', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Hi, can you remind me tomorrow at 3pm to call Sam?' },
    ]);

    expect(reply).toBeNull();
  });

  it('does not hijack mixed reminder asks that start casually', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'hey can you remind me tomorrow at 3pm to call Sam?' },
    ]);

    expect(reply).toBeNull();
  });

  it('does not hijack mixed reminder asks that start with bare Andrea addressing', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Hey Andrea remind me tomorrow at 3pm to call Sam?' },
    ]);

    expect(reply).toBeNull();
  });

  it('does not hijack substantive thread-summary asks that start with bare Andrea addressing', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Andrea summarize my texts from yesterday' },
    ]);

    expect(reply).toBeNull();
  });

  it('does not hijack broader status asks that are not casual check-ins', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'how are we doing on that project' },
    ]);

    expect(reply).toBeNull();
  });

  it('returns a presence response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'you there?' }]);

    expect(reply).toContain('here');
  });

  it('returns a brief capability response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'what can you do?' }]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('meeting prep');
    expect(reply).toContain('save-for-later');
    expect(reply).toContain('life threads');
    expect(reply).toContain('idea capture');
    expect(reply).toContain('what should I say back');
    expect(reply).toContain('Telegram');
    expect(reply).toContain('Messages');
    expect(reply).toContain('Alexa');
    expect(reply).not.toContain('Candace');
  });

  it('keeps broader handle-again phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'hey andrea what all do you handle again' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('repo check-ins');
    expect(reply).toContain('quick reply help');
    expect(reply).not.toContain('coding');
    expect(reply).not.toContain('inspect your files');
  });

  it('keeps casual what-can-you-actually-do phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'yo what can you actually do for me' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('meeting prep');
    expect(reply).toContain('Messages');
    expect(reply).not.toContain('coding');
    expect(reply).not.toContain('inspect your files');
  });

  it('keeps useful-right-now discovery phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what are you useful for right now' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('life threads');
    expect(reply).toContain('Telegram');
    expect(reply).not.toContain('Writing, editing, and explaining code');
  });

  it('keeps help-me-with-today discovery phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what can you help me with today' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('quick reply help');
    expect(reply).toContain('meeting prep');
    expect(reply).toContain('Alexa');
    expect(reply).not.toContain('big or small');
  });

  it('keeps can-you-handle-again discovery phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what all can you handle again' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('repo check-ins');
    expect(reply).toContain('quick reply help');
  });

  it('keeps use-you-for-tonight discovery phrasing in the local capability lane', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what should i use you for tonight' },
    ]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('save-for-later');
    expect(reply).toContain('life threads');
    expect(reply).toContain('quick reply help');
  });

  it('returns a bounded coding-capability response for cursor and codex asks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Can you use cursor and codex?' },
    ]);

    expect(reply).toContain('coding and repo work');
    expect(reply).not.toContain('/cursor_status');
  });

  it('returns a stable command-help response', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'What commands do you have?' },
    ]);

    expect(reply).toContain('/commands');
    expect(reply).toContain('/help');
  });

  it('returns a strongest-capabilities response for best-at asks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what are you best at?' },
    ]);

    expect(reply).toContain('Schedule help');
    expect(reply).toContain('meeting prep');
    expect(reply).toContain('reply drafting');
    expect(reply).toContain('repo check-ins');
  });

  it('returns a stable response for funny-or-pretending asks', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Are you funny or just pretending?' },
    ]);

    expect(reply).toContain('Useful first');
  });

  it('returns a light acknowledgment for funny remarks', () => {
    const reply = maybeBuildDirectQuickReply([{ content: "ahh that's funny" }]);

    expect(reply).toContain("I'll take that as a win");
  });

  it('returns the shared witty online response for plain ping', () => {
    const now = new Date('2026-04-07T20:05:00.000Z');

    expect(maybeBuildDirectQuickReply([{ content: 'Ping' }], now)).toBe(
      buildAndreaPingPresenceReply(undefined, now),
    );
  });

  it('keeps the ping one-liner stable within the same local hour', () => {
    const first = maybeBuildDirectQuickReply(
      [{ content: 'Ping' }],
      new Date('2026-04-07T20:05:00.000Z'),
    );
    const second = maybeBuildDirectQuickReply(
      [{ content: 'Ping' }],
      new Date('2026-04-07T20:45:00.000Z'),
    );

    expect(first).toBe(second);
  });

  it('does not hijack mixed thank-you requests', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Thanks, can you also remind me Friday at 2pm?' },
    ]);

    expect(reply).toBeNull();
  });

  it('returns a stable acknowledgment for short confirmations', () => {
    expect(
      ['Sounds good.', 'Okay.', 'All right.'],
    ).toContain(maybeBuildDirectQuickReply([{ content: 'ok' }]));
    expect(
      ['Sounds good.', 'Okay.', 'All right.'],
    ).toContain(maybeBuildDirectQuickReply([{ content: 'yes!' }]));
    expect(
      ['Sounds good.', 'Okay.', 'All right.'],
    ).toContain(maybeBuildDirectQuickReply([{ content: 'go ahead' }]));
  });

  it('does not hijack mixed requests that start with thanks', () => {
    const reply = maybeBuildDirectQuickReply([
      {
        content:
          'Thanks, can you remind me Friday at 2pm to check on the demo?',
      },
    ]);

    expect(reply).toBeNull();
  });

  it('returns a stable project-help response', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Can you help me with project work?' },
    ]);

    expect(reply).toContain('repo, file, or task');
  });

  it('returns a stable link-check response', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Can you check https://example.com for me?' },
    ]);

    expect(reply).toContain('what you want checked on that link');
  });

  it("returns a witty what's-what response", () => {
    const reply = maybeBuildDirectQuickReply([
      { content: "do you know what's what" },
    ]);

    expect(reply).toContain("what's what");
  });

  it('returns a multi-timezone answer for Australia time asks', () => {
    const reply = maybeBuildDirectQuickReply(
      [{ content: 'What time is it in Australia?' }],
      new Date('2026-04-06T12:00:00.000Z'),
    );

    expect(reply).toContain('Australia spans a few time zones');
    expect(reply).toContain('Sydney');
    expect(reply).toContain('Perth');
  });

  it('returns a plain local time answer for simple time asks', () => {
    const now = new Date('2026-04-06T12:34:00');
    const reply = maybeBuildDirectQuickReply(
      [{ content: 'What time is it?' }],
      now,
    );

    expect(reply).toContain("Right now it's");
    expect(reply).toContain(
      now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    );
  });

  it('returns a plain local time answer for BlueBubbles @Andrea time asks', () => {
    const now = new Date('2026-04-06T12:34:00');
    const reply = maybeBuildDirectQuickReply(
      [{ content: '@Andrea what time is it?' }],
      now,
    );

    expect(reply).toContain("Right now it's");
    expect(reply).toContain(
      now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    );
  });

  it('returns a plain local date answer for simple date asks', () => {
    const reply = maybeBuildDirectQuickReply(
      [{ content: 'What day is it?' }],
      new Date('2026-04-09T12:34:00.000Z'),
    );

    expect(reply).toBe('Today is Thursday, April 9.');
  });

  it('solves simple math expressions', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'what is 56 + 778' }]);

    expect(reply).toContain('56 + 778 = 834');
  });

  it('supports division and rounds to a stable precision', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'what is 46 / 6' }]);

    expect(reply).toContain('46 / 6 = 7.666667');
  });

  it('supports textual math prompts with commas', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'What is 1,234 plus 99?' },
    ]);

    expect(reply).toContain('1234 + 99 = 1333');
  });

  it('ignores unsupported expressions', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what is os.system("rm -rf /")' },
    ]);

    expect(reply).toBeNull();
  });

  it('ignores extreme results', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'what is 999999999999 * 999999999999' },
    ]);

    expect(reply).toBeNull();
  });

  it('uses the latest message only', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: "what's the meaning of life?" },
      { content: 'what is 1 + 1' },
    ]);

    expect(reply).toContain('1 + 1 = 2');
  });
});

describe('direct rescue reply', () => {
  it('offers a calm fallback for short direct turns', () => {
    const reply = maybeBuildDirectRescueReply([{ content: 'can you help?' }]);

    expect(reply).toContain("I'm here");
    expect(reply).not.toContain('operator');
  });

  it('does not rescue long complex asks', () => {
    const reply = maybeBuildDirectRescueReply([
      {
        content:
          'Please compare three backup vendors, summarize tradeoffs, and draft a rollout plan for the team.',
      },
    ]);

    expect(reply).toBeNull();
  });

  it('does not rescue slash commands', () => {
    const reply = maybeBuildDirectRescueReply([{ content: '/cursor_status' }]);

    expect(reply).toBeNull();
  });

  it('does not rescue URL-heavy messages', () => {
    const reply = maybeBuildDirectRescueReply([
      {
        content:
          'can you compare https://example.com and https://example.org for me?',
      },
    ]);

    expect(reply).toBeNull();
  });
});

describe('direct runtime failure reply', () => {
  it('prefers the local capability answer over a technical runtime banner', () => {
    const reply = buildDirectAssistantRuntimeFailureReply(
      [{ content: 'Can you use cursor and codex?' }],
      'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution.',
    );

    expect(reply).toContain('coding and repo work');
    expect(reply).not.toContain('runtime failed during startup or execution');
  });

  it('keeps a generic direct fallback non-technical when no quick answer exists', () => {
    const reply = buildDirectAssistantRuntimeFailureReply(
      [{ content: 'Can you help me compare three backup vendors for next month?' }],
      'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution.',
    );

    expect(reply).toContain("can't check that live right now");
    expect(reply).not.toContain('operator');
    expect(reply).not.toContain('runtime failed during startup or execution');
  });

  it('shapes runtime failure replies more concisely for BlueBubbles', () => {
    const reply = buildDirectAssistantRuntimeFailureReply(
      [{ content: "What's up?" }],
      'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution.',
      new Date('2026-04-06T22:18:10.000Z'),
      'bluebubbles',
    );

    expect(reply).toBeTruthy();
    expect(reply).not.toContain('setup verify');
  });

  it('prefers the local time answer over a degraded runtime reply for @Andrea time asks', () => {
    const reply = buildDirectAssistantRuntimeFailureReply(
      [{ content: '@Andrea what time is it?' }],
      'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution.',
      new Date('2026-04-06T22:18:10.000Z'),
      'bluebubbles',
    );

    expect(reply).toContain("Right now it's");
    expect(reply).not.toContain("can't check that live right now");
    expect(reply).not.toContain('setup verify');
  });
});
