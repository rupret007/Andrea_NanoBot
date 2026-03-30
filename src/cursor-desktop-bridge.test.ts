import { EventEmitter } from 'events';
import path from 'path';
import { PassThrough } from 'stream';

import { describe, expect, it } from 'vitest';

import { CursorDesktopBridge } from './cursor-desktop-bridge.js';

function createFakeRun() {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;

  return {
    pid: 4242,
    stdout,
    stderr,
    kill: () => {
      killed = true;
      emitter.emit('close', null, 'SIGTERM');
    },
    onClose: (
      handler: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => emitter.on('close', handler),
    onError: (handler: (err: Error) => void) => emitter.on('error', handler),
    emitStdoutLine: (line: string) => stdout.write(`${line}\n`),
    emitStderr: (line: string) => stderr.write(line),
    finish: (code = 0) => emitter.emit('close', code, null),
    get killed() {
      return killed;
    },
  };
}

describe('CursorDesktopBridge', () => {
  it('creates a session, captures Cursor session id, and records conversation', () => {
    const run = createFakeRun();
    const writes: string[] = [];

    const bridge = new CursorDesktopBridge(
      {
        host: '127.0.0.1',
        port: 4124,
        token: 'bridge-token',
        cliPath: 'cursor-agent',
        defaultCwd: '/workspace',
        force: true,
        stateFile: '/tmp/cursor-desktop-bridge-test.json',
      },
      {
        createRun: () => run,
        now: () => new Date('2026-03-29T20:10:00.000Z'),
        hostname: () => 'Jeff-Mac',
        existsSync: () => false,
        mkdirSync: () => undefined as never,
        readFileSync: (() => '') as unknown as typeof import('fs').readFileSync,
        writeFileSync: (_path, body) => {
          writes.push(String(body));
        },
      },
    );

    const created = bridge.createSession({
      promptText: 'Fix the auth tests',
      requestedBy: 'tg:jeff',
      groupFolder: 'main',
      chatJid: 'tg:42',
    });

    run.emitStdoutLine(
      JSON.stringify({ type: 'init', session_id: 'cursor-session-1' }),
    );
    run.emitStdoutLine(
      JSON.stringify({ type: 'final', result: 'Auth tests are fixed.' }),
    );
    run.finish(0);

    const synced = bridge.getSession(created.id);
    expect(synced.status).toBe('COMPLETED');
    expect(synced.cursorSessionId).toBe('cursor-session-1');
    expect(synced.summary).toContain('Auth tests are fixed');
    expect(synced.groupFolder).toBe('main');
    expect(synced.chatJid).toBe('tg:42');

    const conversation = bridge.getConversation(created.id, 10);
    expect(conversation).toHaveLength(2);
    expect(conversation[0].role).toBe('user');
    expect(conversation[1].role).toBe('assistant');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('supports follow-up and stop flows', () => {
    const firstRun = createFakeRun();
    const secondRun = createFakeRun();
    let runIndex = 0;

    const bridge = new CursorDesktopBridge(
      {
        host: '127.0.0.1',
        port: 4124,
        token: 'bridge-token',
        cliPath: 'cursor-agent',
        defaultCwd: '/workspace',
        force: true,
        stateFile: '/tmp/cursor-desktop-bridge-test.json',
      },
      {
        createRun: () => {
          runIndex += 1;
          return runIndex === 1 ? firstRun : secondRun;
        },
        now: () => new Date('2026-03-29T20:11:00.000Z'),
        hostname: () => 'Jeff-Mac',
        existsSync: () => false,
        mkdirSync: () => undefined as never,
        readFileSync: (() => '') as unknown as typeof import('fs').readFileSync,
        writeFileSync: () => undefined as never,
      },
    );

    const created = bridge.createSession({
      promptText: 'Build the feature',
    });
    firstRun.emitStdoutLine(
      JSON.stringify({ type: 'init', session_id: 'cursor-session-2' }),
    );
    firstRun.emitStdoutLine(
      JSON.stringify({ type: 'final', result: 'Initial build done.' }),
    );
    firstRun.finish(0);

    const followed = bridge.followupSession(
      created.id,
      'Now add regression coverage',
    );
    expect(followed.status).toBe('RUNNING');
    expect(secondRun.killed).toBe(false);

    const stopped = bridge.stopSession(created.id);
    expect(stopped.status).toBe('STOPPED');
    expect(secondRun.killed).toBe(true);
  });

  it('supports terminal commands, status, output, and stop', () => {
    const run = createFakeRun();

    const bridge = new CursorDesktopBridge(
      {
        host: '127.0.0.1',
        port: 4124,
        token: 'bridge-token',
        cliPath: 'cursor-agent',
        defaultCwd: '/workspace',
        force: true,
        stateFile: '/tmp/cursor-desktop-bridge-test.json',
      },
      {
        createRun: () => createFakeRun(),
        createTerminalRun: () => run,
        now: () => new Date('2026-03-29T20:12:00.000Z'),
        hostname: () => 'Jeff-Mac',
        existsSync: () => false,
        mkdirSync: () => undefined as never,
        readFileSync: (() => '') as unknown as typeof import('fs').readFileSync,
        writeFileSync: () => undefined as never,
      },
    );

    const created = bridge.createSession({
      promptText: 'Inspect the repo',
      cwd: '/workspace/repo',
    });

    const started = bridge.startTerminalCommand(created.id, 'pwd');
    expect(started.commandId).toContain('term_');
    expect(started.terminal.status).toBe('RUNNING');

    run.emitStdoutLine('/workspace/repo');
    const metadataLine = `__ANDREA_TERM_META_${started.commandId}__`;
    run.emitStdoutLine(`${metadataLine}/workspace/repo::0`);
    run.finish(0);

    const status = bridge.getTerminalStatus(created.id);
    expect(status.status).toBe('IDLE');
    expect(status.cwd).toBe(path.resolve('/workspace/repo'));
    expect(status.lastExitCode).toBe(0);

    const output = bridge.getTerminalOutput(created.id, { limit: 10 });
    expect(output.some((line) => line.text.includes('pwd'))).toBe(true);
    expect(output.some((line) => line.text.includes('/workspace/repo'))).toBe(
      true,
    );

    const secondRun = createFakeRun();
    const bridgeWithStop = new CursorDesktopBridge(
      {
        host: '127.0.0.1',
        port: 4124,
        token: 'bridge-token',
        cliPath: 'cursor-agent',
        defaultCwd: '/workspace',
        force: true,
        stateFile: '/tmp/cursor-desktop-bridge-test.json',
      },
      {
        createRun: () => createFakeRun(),
        createTerminalRun: () => secondRun,
        now: () => new Date('2026-03-29T20:12:00.000Z'),
        hostname: () => 'Jeff-Mac',
        existsSync: () => false,
        mkdirSync: () => undefined as never,
        readFileSync: (() => '') as unknown as typeof import('fs').readFileSync,
        writeFileSync: () => undefined as never,
      },
    );

    const stopSession = bridgeWithStop.createSession({
      promptText: 'Long-running repo work',
    });
    bridgeWithStop.startTerminalCommand(stopSession.id, 'npm test');
    const stopped = bridgeWithStop.stopTerminalCommand(stopSession.id);
    expect(stopped.status).toBe('STOPPED');
    expect(secondRun.killed).toBe(true);
  });
});
