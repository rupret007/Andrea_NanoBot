import { describe, expect, it } from 'vitest';

import {
  formatLaneClarificationPrompt,
  pickLaneForPrompt,
} from './lane-picker.js';

describe('pickLaneForPrompt', () => {
  it('routes obvious code-edit prompts to cursor', () => {
    const result = pickLaneForPrompt(
      'refactor the auth.ts module to use async/await',
    );
    expect(result.lane).toBe('cursor');
    expect(result.matchedTokens).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^cursor_verb:/),
        expect.stringMatching(/^cursor_filetype:/),
      ]),
    );
  });

  it('routes filetype-only prompts (no verb) to cursor when nothing competes', () => {
    const result = pickLaneForPrompt(
      'something interesting in the auth.ts file',
    );
    // file noun + .ts filetype → cursor; no codex signal.
    expect(result.lane).toBe('cursor');
  });

  it('routes execution-shaped prompts to codex', () => {
    const result = pickLaneForPrompt('run npm test in the main repo');
    expect(result.lane).toBe('codex');
    expect(result.matchedTokens).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^codex_verb:/),
        expect.stringMatching(/^codex_tool:/),
      ]),
    );
  });

  it('routes shell-snippet prompts to codex', () => {
    const result = pickLaneForPrompt('try `git status` and tell me');
    expect(result.lane).toBe('codex');
    expect(result.matchedTokens).toContain('codex_shell_hint');
  });

  it('returns ambiguous for short prompts to avoid mis-routing', () => {
    const result = pickLaneForPrompt('go');
    expect(result.lane).toBe('ambiguous');
    expect(result.reason).toBe('prompt_too_short');
  });

  it('returns ambiguous when nothing matches', () => {
    const result = pickLaneForPrompt(
      'hey can you tell me what time it is in tokyo right now',
    );
    expect(result.lane).toBe('ambiguous');
    expect(result.reason).toBe('no_pattern_matched');
  });

  it('returns ambiguous when both lanes score equally', () => {
    // Verbs only on each side, no filetype/tool, no shell hint.
    const result = pickLaneForPrompt('please fix and run the suite');
    // "fix" is cursor verb (1), "run" is codex verb (1) — tie.
    expect(result.lane).toBe('ambiguous');
    expect(result.reason).toBe('tie_between_lanes');
  });

  it('breaks ties when one lane has a stronger token (filetype or tool)', () => {
    const cursorWins = pickLaneForPrompt('fix the bug in auth.ts and run it');
    // cursor: verb(1)+filetype(2)=3; codex: verb(1)=1 → cursor wins.
    expect(cursorWins.lane).toBe('cursor');

    const codexWins = pickLaneForPrompt('please fix something and run npm ci');
    // cursor: verb(1)=1; codex: verb(1)+tool(2)=3 → codex wins.
    expect(codexWins.lane).toBe('codex');
  });

  it('is deterministic — same input always returns the same lane and reason', () => {
    const a = pickLaneForPrompt('refactor handlers.ts');
    const b = pickLaneForPrompt('refactor handlers.ts');
    expect(a).toEqual(b);
  });
});

describe('formatLaneClarificationPrompt', () => {
  it('truncates long prompts with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = pickLaneForPrompt('hey there nothing matches please');
    const formatted = formatLaneClarificationPrompt(long, result);
    expect(formatted).toContain('...');
    expect(formatted).toMatch(/--lane=cursor/);
    expect(formatted).toMatch(/--lane=codex/);
  });

  it('includes the reason from the pick result', () => {
    const result = pickLaneForPrompt('zzz');
    const formatted = formatLaneClarificationPrompt('zzz', result);
    expect(formatted).toContain('prompt_too_short');
  });
});
