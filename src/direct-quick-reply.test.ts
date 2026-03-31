import { describe, expect, it } from 'vitest';

import {
  maybeBuildDirectQuickReply,
  maybeBuildDirectRescueReply,
} from './direct-quick-reply.js';

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

    expect(reply).toContain("I'm Andrea");
  });

  it('returns a casual morning check-in response for the exact live failure phrasing', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'hey hows it going this morning' },
    ]);

    expect(reply).toContain('Doing well');
  });

  it('returns a casual response for good-morning check-ins', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'good morning, how are you' },
    ]);

    expect(reply).toContain('Doing well');
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

  it('returns a presence response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'you there?' }]);

    expect(reply).toContain("I'm here");
  });

  it('returns a brief capability response', () => {
    const reply = maybeBuildDirectQuickReply([{ content: 'what can you do?' }]);

    expect(reply).toContain("I'm Andrea");
    expect(reply).toContain('tasks');
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

    expect(reply).toContain('tasks');
    expect(reply).toContain('operator status checks');
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

  it('returns a stable online response for plain ping', () => {
    expect(maybeBuildDirectQuickReply([{ content: 'Ping' }])).toBe(
      'Andrea is online.',
    );
  });

  it('does not hijack mixed thank-you requests', () => {
    const reply = maybeBuildDirectQuickReply([
      { content: 'Thanks, can you also remind me Friday at 2pm?' },
    ]);

    expect(reply).toBeNull();
  });

  it('returns a stable acknowledgment for short confirmations', () => {
    expect(maybeBuildDirectQuickReply([{ content: 'ok' }])).toBe(
      'Sounds good.',
    );
    expect(maybeBuildDirectQuickReply([{ content: 'yes!' }])).toBe(
      'Sounds good.',
    );
    expect(maybeBuildDirectQuickReply([{ content: 'go ahead' }])).toBe(
      'Sounds good.',
    );
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
    expect(reply).toContain('one short sentence');
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
