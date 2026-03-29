import { describe, expect, it } from 'vitest';

import { maybeBuildDirectQuickReply } from './direct-quick-reply.js';

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
