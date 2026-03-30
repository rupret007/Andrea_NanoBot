import { EventEmitter } from 'events';
import path from 'path';
import { PassThrough } from 'stream';

import { describe, expect, it } from 'vitest';

import {
  buildCursorDesktopCliArgs,
  CursorDesktopBridge,
  resolveCursorDesktopCliMode,
  shouldUseShellForCursorDesktopCli,
} from './cursor-desktop-bridge.js';

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
  it('detects the installed Cursor CLI as a subcommand-based bridge runner', () => {
    expect(resolveCursorDesktopCliMode('cursor-agent')).toBe('cursor-agent');
    expect(resolveCursorDesktopCliMode('cursor.cmd')).toBe('cursor-subcommand');
    expect(
      resolveCursorDesktopCliMode(
        'C:\\Users\\jeff\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
      ),
    ).toBe('cursor-subcommand');
  });

  it('uses the Windows shell only for .cmd/.bat Cursor entrypoints', () => {
    expect(shouldUseShellForCursorDesktopCli('cursor-agent')).toBe(false);
    expect(shouldUseShellForCursorDesktopCli('cursor.cmd')).toBe(
      process.platform === 'win32',
    );
    expect(shouldUseShellForCursorDesktopCli('cursor.bat')).toBe(
      process.platform === 'win32',
    );
  });

  it('builds Cursor CLI args for both standalone and subcommand modes', () => {
    expect(
      buildCursorDesktopCliArgs({
        cliPath: 'cursor-agent',
        promptText: 'Fix the flaky test',
        model: 'cu/default',
        resumeSessionId: 'cursor-session-1',
        force: true,
      }),
    ).toEqual([
      '-p',
      'Fix the flaky test',
      '--output-format',
      'stream-json',
      '--force',
      '--model',
      'cu/default',
      '--resume=cursor-session-1',
    ]);

    expect(
      buildCursorDesktopCliArgs({
        cliPath:
          'C:\\Users\\jeff\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
        promptText: 'Fix the flaky test',
        model: null,
        resumeSessionId: null,
        force: true,
      }),
    ).toEqual([
      'agent',
      '-p',
      'Fix the flaky test',
      '--output-format',
      'stream-json',
      '--force',
    ]);
  });

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
    expect(bridge.getHealth()).toMatchObject({
      terminalAvailable: true,
      agentJobCompatibility: 'validated',
      agentJobDetail: null,
    });
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

  it('fails a run that exits cleanly without any usable agent output', () => {
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
        createRun: () => run,
        now: () => new Date('2026-03-29T20:11:30.000Z'),
        hostname: () => 'Jeff-Mac',
        existsSync: () => false,
        mkdirSync: () => undefined as never,
        readFileSync: (() => '') as unknown as typeof import('fs').readFileSync,
        writeFileSync: () => undefined as never,
      },
    );

    const created = bridge.createSession({
      promptText: 'Reply with exactly: smoke ok.',
    });
    run.emitStderr(
      "Warning: 'p' is not in the list of known options, but still passed to Electron/Chromium.",
    );
    run.finish(0);

    const synced = bridge.getSession(created.id);
    expect(synced.status).toBe('FAILED');
    expect(synced.summary).toContain('known options');
    expect(bridge.getConversation(created.id, 10)).toHaveLength(1);
    expect(bridge.getHealth()).toMatchObject({
      terminalAvailable: true,
      agentJobCompatibility: 'failed',
    });
    expect(bridge.getHealth().agentJobDetail).toContain('known options');
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
