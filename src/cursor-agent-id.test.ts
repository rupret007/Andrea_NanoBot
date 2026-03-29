import { describe, expect, it } from 'vitest';

import { normalizeCursorAgentId } from './cursor-agent-id.js';

describe('cursor-agent-id', () => {
  it('returns plain agent ids unchanged', () => {
    expect(normalizeCursorAgentId('bc_abc123')).toBe('bc_abc123');
  });

  it('extracts the id from Cursor URL query params', () => {
    expect(
      normalizeCursorAgentId('https://cursor.com/agents?id=bc_xyz999'),
    ).toBe('bc_xyz999');
  });

  it('extracts the id from Cursor URL path segment', () => {
    expect(
      normalizeCursorAgentId('https://cursor.com/agents/bc_urlpath123'),
    ).toBe('bc_urlpath123');
  });

  it('throws on invalid inputs', () => {
    expect(() => normalizeCursorAgentId('')).toThrow(
      'Cursor agent id is required',
    );
    expect(() => normalizeCursorAgentId('https://cursor.com/agents')).toThrow(
      'Invalid Cursor agent id',
    );
  });
});
