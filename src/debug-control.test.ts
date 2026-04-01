import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDebugLogsInlineActions,
  buildDebugMutationInlineActions,
  buildDebugStatusInlineActions,
  formatDebugStatus,
  getAssistantExecutionProbeState,
  parseDebugDurationMs,
  readDebugLogs,
  resolveDebugScope,
  resetDebugLevel,
  setAssistantExecutionProbeState,
  setDebugLevel,
} from './debug-control.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import { getLogControlConfig, setLogControlConfig } from './logger.js';

describe('debug control', () => {
  beforeEach(() => {
    _initTestDatabase();
    setLogControlConfig({
      globalLevel: 'info',
      scopedOverrides: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('defaults Telegram-style durations to 60 minutes', () => {
    expect(parseDebugDurationMs(undefined)).toBe(60 * 60 * 1000);
  });

  it('resolves current scope to the active chat', () => {
    expect(resolveDebugScope('current', 'tg:main')).toEqual({
      scopeKey: 'chat:tg:main',
      label: 'chat:tg:main',
    });
  });

  it('persists a scoped verbose override immediately', () => {
    const result = setDebugLevel({
      level: 'verbose',
      scopeToken: 'lane:andrea_runtime',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    expect(result.level).toBe('trace');
    expect(result.resolvedScope.scopeKey).toBe('lane:andrea_runtime');
    expect(
      getLogControlConfig().scopedOverrides['lane:andrea_runtime'],
    ).toBeDefined();
  });

  it('resets all overrides back to normal', () => {
    setDebugLevel({
      level: 'debug',
      scopeToken: 'component:container',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    const result = resetDebugLevel({
      scopeToken: 'all',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    expect(result.resetScope).toBe('all');
    expect(getLogControlConfig().globalLevel).toBe('info');
    expect(Object.keys(getLogControlConfig().scopedOverrides)).toEqual([]);
  });

  it('formats debug status with assistant execution probe state', () => {
    setAssistantExecutionProbeState({
      status: 'failed',
      reason: 'initial_output_timeout',
      detail: 'container did not emit first structured result before timeout',
      checkedAt: '2026-03-31T14:00:00.000Z',
    });

    const status = formatDebugStatus();
    expect(status).toContain('Assistant execution probe: failed');
    expect(getAssistantExecutionProbeState().reason).toBe(
      'initial_output_timeout',
    );
  });

  it('builds actionable debug panel buttons', () => {
    expect(
      buildDebugStatusInlineActions().map((action) => action.label),
    ).toEqual(['Refresh', 'Current Logs', 'Debug Chat 10m', 'Reset All']);
    expect(
      buildDebugMutationInlineActions().map((action) => action.label),
    ).toEqual(['Debug Status', 'Current Logs', 'Reset All']);
    expect(buildDebugLogsInlineActions('runtime', 40)[0]).toEqual({
      label: 'Refresh Logs',
      actionId: '/debug-logs runtime 40',
    });
  });
});

describe('debug log tails', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-debug-'));
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    process.chdir(tempDir);
    _initTestDatabase();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    _closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads stderr tails with sanitization', () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'nanoclaw.stderr.log'),
      'line1\nOPENAI_API_KEY=sk-secret-token\nline3\n',
    );

    const payload = readDebugLogs({ target: 'stderr', lines: 5 });
    expect(payload.title).toBe('stderr');
    expect(payload.body).toContain('OPENAI_API_KEY=***');
  });

  it('prefers current chat service lines over stale group container logs', () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'nanoclaw.log'),
      [
        '[10:00:00.000] INFO (1): current chat line',
        '  chatJid: "tg:main"',
        '  component: "assistant"',
      ].join('\n'),
    );

    const groupLogsDir = path.join(tempDir, 'groups', 'main', 'logs');
    fs.mkdirSync(groupLogsDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupLogsDir, 'container-2026-03-31T15-00-00-000Z.log'),
      'stale container timeout log',
    );

    const payload = readDebugLogs({
      target: 'current',
      lines: 20,
      chatJid: 'tg:main',
      groupFolder: 'main',
    });

    expect(payload.title).toBe('current');
    expect(payload.body).toContain('current chat line');
    expect(payload.body).not.toContain('stale container timeout log');
  });
});
