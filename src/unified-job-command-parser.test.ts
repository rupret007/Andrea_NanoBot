import { describe, expect, it } from 'vitest';

import {
  parseUnifiedJobCommand,
  UNIFIED_JOB_USAGE_MESSAGE,
} from './unified-job-command-parser.js';

describe('parseUnifiedJobCommand', () => {
  it('parses a bare prompt with no lane flag', () => {
    const r = parseUnifiedJobCommand('/job refactor handlers.ts');
    expect(r.error).toBeNull();
    expect(r.laneOverride).toBeNull();
    expect(r.prompt).toBe('refactor handlers.ts');
  });

  it('accepts --lane=cursor', () => {
    const r = parseUnifiedJobCommand('/job --lane=cursor edit auth.ts');
    expect(r.laneOverride).toBe('cursor');
    expect(r.prompt).toBe('edit auth.ts');
  });

  it('accepts --lane=codex', () => {
    const r = parseUnifiedJobCommand('/job --lane=codex npm test');
    expect(r.laneOverride).toBe('codex');
    expect(r.prompt).toBe('npm test');
  });

  it('accepts --lane=auto and treats it as null override', () => {
    const r = parseUnifiedJobCommand('/job --lane=auto fix the bug');
    expect(r.laneOverride).toBeNull();
    expect(r.error).toBeNull();
    expect(r.prompt).toBe('fix the bug');
  });

  it('accepts colon syntax --lane:cursor', () => {
    const r = parseUnifiedJobCommand('/job --lane:cursor refactor');
    expect(r.laneOverride).toBe('cursor');
  });

  it('rejects unknown lane values with a structured error', () => {
    const r = parseUnifiedJobCommand('/job --lane=claude do thing');
    expect(r.error).toMatch(/Unknown lane "claude"/);
    expect(r.laneOverride).toBeNull();
  });

  it('returns the usage message when prompt is empty', () => {
    const r = parseUnifiedJobCommand('/job');
    expect(r.error).toBe(UNIFIED_JOB_USAGE_MESSAGE);
  });

  it('returns the usage message when only a lane flag is present', () => {
    const r = parseUnifiedJobCommand('/job --lane=cursor');
    expect(r.error).toBe(UNIFIED_JOB_USAGE_MESSAGE);
  });

  it('preserves quoted prompt segments', () => {
    const r = parseUnifiedJobCommand(
      '/job --lane=codex run "npm test --watch=false"',
    );
    expect(r.laneOverride).toBe('codex');
    expect(r.prompt).toBe('run npm test --watch=false');
  });

  it('treats a flag mid-prompt the same as a flag at the start', () => {
    const r = parseUnifiedJobCommand(
      '/job refactor the auth module --lane=cursor for clarity',
    );
    expect(r.laneOverride).toBe('cursor');
    expect(r.prompt).toBe('refactor the auth module for clarity');
  });

  it('handles the /work alias the same as /job (parser is command-agnostic)', () => {
    const r = parseUnifiedJobCommand('/work --lane=cursor refactor src/foo.ts');
    expect(r.laneOverride).toBe('cursor');
    expect(r.prompt).toBe('refactor src/foo.ts');
  });
});
