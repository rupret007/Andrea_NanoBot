import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import os from 'os';
import path from 'path';

import { logger, sanitizeLogString } from './logger.js';

import type {
  CursorDesktopAgentJobCompatibility,
  CursorDesktopConversationMessage,
  CursorDesktopHealth,
  CursorDesktopSession,
  CursorDesktopStartTerminalCommandResponse,
  CursorDesktopTerminalOutputLine,
  CursorDesktopTerminalStatus,
} from './cursor-desktop.js';

type SessionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED';
type TerminalStatus = 'IDLE' | 'RUNNING' | 'FAILED' | 'STOPPED';

const MAX_TERMINAL_OUTPUT_LINES = 400;
const MAX_TERMINAL_LINE_LENGTH = 4_000;

interface CursorDesktopBridgeRuntimeConfig {
  host: string;
  port: number;
  token: string;
  cliPath: string;
  defaultCwd: string | null;
  force: boolean;
  stateFile: string;
}

interface CursorDesktopBridgeStoredState {
  sessions: CursorDesktopSessionRecord[];
  agentJobCompatibility?: CursorDesktopAgentJobCompatibility;
  agentJobDetail?: string | null;
}

interface CursorDesktopSessionRecord extends CursorDesktopSession {
  status: SessionStatus;
  activePid: number | null;
  lastError: string | null;
  conversation: CursorDesktopConversationMessage[];
  terminal: CursorDesktopTerminalRecord;
}

interface CursorDesktopTerminalRecord extends CursorDesktopTerminalStatus {
  output: CursorDesktopTerminalOutputLine[];
}

interface SpawnedRun {
  pid: number | null;
  kill: (signal?: NodeJS.Signals | number) => void;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onClose: (
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void;
  onError: (handler: (err: Error) => void) => void;
}

interface CursorDesktopBridgeDeps {
  createRun?: (options: {
    cliPath: string;
    cwd: string;
    promptText: string;
    model?: string | null;
    resumeSessionId?: string | null;
    force: boolean;
  }) => SpawnedRun;
  createTerminalRun?: (options: {
    cwd: string;
    commandText: string;
    metadataToken: string;
  }) => SpawnedRun;
  now?: () => Date;
  hostname?: () => string;
  readFileSync?: typeof fs.readFileSync;
  writeFileSync?: typeof fs.writeFileSync;
  existsSync?: typeof fs.existsSync;
  mkdirSync?: typeof fs.mkdirSync;
}

interface CreateSessionInput {
  promptText: string;
  requestedBy?: string;
  model?: string;
  groupFolder?: string;
  chatJid?: string;
  cwd?: string;
  sourceRepository?: string;
  sourceRef?: string;
  sourcePrUrl?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
}

type CursorDesktopCliMode = 'cursor-agent' | 'cursor-subcommand';

function defaultNow(): Date {
  return new Date();
}

function normalizePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 4124;
  return Math.min(65535, parsed);
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function truncateSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > 1_500 ? `${compact.slice(0, 1_500)}...` : compact;
}

function truncateTerminalLine(value: string): string {
  const normalized = value.replace(/\0/g, '').replace(/\r/g, '');
  if (!normalized) return '';
  return normalized.length > MAX_TERMINAL_LINE_LENGTH
    ? `${normalized.slice(0, MAX_TERMINAL_LINE_LENGTH)}...`
    : normalized;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCursorSessionId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return toNullableString(parsed.session_id);
  } catch {
    return null;
  }
}

function extractTextFromJsonLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    const directKeys = ['result', 'text', 'summary', 'message'];
    for (const key of directKeys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return truncateSummary(value);
      }
    }

    const message = parsed.message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string' && content.trim()) {
        return truncateSummary(content);
      }
    }

    const result = parsed.result;
    if (result && typeof result === 'object') {
      const output = (result as Record<string, unknown>).output;
      if (typeof output === 'string' && output.trim()) {
        return truncateSummary(output);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveTerminalShellPath(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

function resolveCursorDesktopCliMode(cliPath: string): CursorDesktopCliMode {
  const normalized = path.basename(cliPath).trim().toLowerCase();
  if (
    normalized === 'cursor' ||
    normalized === 'cursor.cmd' ||
    normalized === 'cursor.exe'
  ) {
    return 'cursor-subcommand';
  }
  return 'cursor-agent';
}

function shouldUseShellForCursorDesktopCli(cliPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const normalized = path.basename(cliPath).trim().toLowerCase();
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat');
}

function buildCursorDesktopCliArgs(options: {
  cliPath: string;
  promptText: string;
  model?: string | null;
  resumeSessionId?: string | null;
  force: boolean;
}): string[] {
  const args = ['-p', options.promptText, '--output-format', 'stream-json'];
  if (options.force) args.push('--force');
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.resumeSessionId) {
    args.push(`--resume=${options.resumeSessionId}`);
  }

  if (resolveCursorDesktopCliMode(options.cliPath) === 'cursor-subcommand') {
    return ['agent', ...args];
  }

  return args;
}

function createChildRun(options: {
  cliPath: string;
  cwd: string;
  promptText: string;
  model?: string | null;
  resumeSessionId?: string | null;
  force: boolean;
}): SpawnedRun {
  const args = buildCursorDesktopCliArgs(options);

  const child = spawn(options.cliPath, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: shouldUseShellForCursorDesktopCli(options.cliPath),
  });

  return {
    pid: child.pid ?? null,
    kill: (signal) => child.kill(signal),
    stdout: child.stdout,
    stderr: child.stderr,
    onClose: (handler) => child.on('close', handler),
    onError: (handler) => child.on('error', handler),
  };
}

function createTerminalChildRun(options: {
  cwd: string;
  commandText: string;
  metadataToken: string;
}): SpawnedRun {
  const shellPath = resolveTerminalShellPath();
  let args: string[];

  if (process.platform === 'win32') {
    const script = `${options.commandText} & for %I in (.) do @echo ${options.metadataToken}%~fI::!errorlevel! & exit /b 0`;
    args = ['/v:on', '/d', '/s', '/c', script];
  } else {
    const script = [
      options.commandText,
      '__andrea_exit=$?',
      `printf '\\n${options.metadataToken}%s::%s\\n' "$PWD" "$__andrea_exit"`,
      'exit 0',
    ].join('\n');
    args = ['-lc', script];
  }

  const child = spawn(shellPath, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    pid: child.pid ?? null,
    kill: (signal) => child.kill(signal),
    stdout: child.stdout,
    stderr: child.stderr,
    onClose: (handler) => child.on('close', handler),
    onError: (handler) => child.on('error', handler),
  };
}

function resolveRuntimeConfigFromEnv(): CursorDesktopBridgeRuntimeConfig {
  const stateFile =
    process.env.CURSOR_DESKTOP_BRIDGE_STATE_FILE ||
    path.join(os.homedir(), '.cursor-desktop-bridge', 'state.json');
  return {
    host: process.env.CURSOR_DESKTOP_BRIDGE_HOST || '127.0.0.1',
    port: normalizePort(process.env.CURSOR_DESKTOP_BRIDGE_PORT),
    token: process.env.CURSOR_DESKTOP_BRIDGE_TOKEN || '',
    cliPath: process.env.CURSOR_DESKTOP_CLI_PATH || 'cursor-agent',
    defaultCwd: toNullableString(process.env.CURSOR_DESKTOP_DEFAULT_CWD),
    force: parseBoolean(process.env.CURSOR_DESKTOP_FORCE, true),
    stateFile,
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function splitPathname(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function cloneConversation(
  messages: CursorDesktopConversationMessage[],
  limit?: number,
): CursorDesktopConversationMessage[] {
  const safeLimit =
    limit && Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.floor(limit)))
      : messages.length;
  return messages.slice(-safeLimit).map((message) => ({ ...message }));
}

function cloneTerminalOutput(
  lines: CursorDesktopTerminalOutputLine[],
  limit?: number,
): CursorDesktopTerminalOutputLine[] {
  const safeLimit =
    limit && Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.floor(limit)))
      : lines.length;
  return lines.slice(-safeLimit).map((line) => ({ ...line }));
}

function createDefaultTerminalState(
  cwd: string | null,
): CursorDesktopTerminalRecord {
  return {
    available: true,
    status: 'IDLE',
    shell: resolveTerminalShellPath(),
    cwd,
    lastCommand: null,
    activeCommandId: null,
    lastCompletedCommandId: null,
    lastExitCode: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    activePid: null,
    outputLineCount: 0,
    output: [],
  };
}

function toNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function restoreTerminalState(
  value: unknown,
  fallbackCwd: string | null,
): CursorDesktopTerminalRecord {
  const row =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  const base = createDefaultTerminalState(fallbackCwd);
  const output = Array.isArray(row?.output)
    ? row.output
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const item = entry as Record<string, unknown>;
          const text = toNullableString(item.text);
          if (!text) return null;
          return {
            commandId: toNullableString(item.commandId),
            stream: toNullableString(item.stream) || 'stdout',
            text: truncateTerminalLine(text),
            createdAt: toNullableString(item.createdAt),
          } satisfies CursorDesktopTerminalOutputLine;
        })
        .filter(
          (entry): entry is CursorDesktopTerminalOutputLine => entry !== null,
        )
        .slice(-MAX_TERMINAL_OUTPUT_LINES)
    : [];

  return {
    ...base,
    status:
      row?.status === 'RUNNING'
        ? 'STOPPED'
        : (toNullableString(row?.status) as TerminalStatus | null) || 'IDLE',
    shell: toNullableString(row?.shell) || base.shell,
    cwd: toNullableString(row?.cwd) || fallbackCwd,
    lastCommand: toNullableString(row?.lastCommand),
    activeCommandId: null,
    lastCompletedCommandId: toNullableString(row?.lastCompletedCommandId),
    lastExitCode: toNonNegativeInt(row?.lastExitCode),
    lastStartedAt: toNullableString(row?.lastStartedAt),
    lastFinishedAt: toNullableString(row?.lastFinishedAt),
    activePid: null,
    outputLineCount: output.length,
    output,
  };
}

function parseTerminalMetadataLine(
  line: string,
  metadataToken: string,
): { cwd: string | null; exitCode: number | null } | null {
  if (!line.startsWith(metadataToken)) return null;
  const payload = line.slice(metadataToken.length);
  const delimiterIndex = payload.lastIndexOf('::');
  if (delimiterIndex < 0) return null;

  const cwd = toNullableString(payload.slice(0, delimiterIndex));
  const exitRaw = payload.slice(delimiterIndex + 2).trim();
  const parsedExit = Number.parseInt(exitRaw, 10);

  return {
    cwd,
    exitCode:
      Number.isFinite(parsedExit) && parsedExit >= 0 ? parsedExit : null,
  };
}

export class CursorDesktopBridge {
  private readonly deps: Required<CursorDesktopBridgeDeps>;
  private readonly sessions = new Map<string, CursorDesktopSessionRecord>();
  private readonly activeRuns = new Map<string, SpawnedRun>();
  private readonly activeTerminalRuns = new Map<string, SpawnedRun>();
  private agentJobCompatibility: CursorDesktopAgentJobCompatibility = 'unknown';
  private agentJobDetail: string | null = null;

  constructor(
    private readonly config: CursorDesktopBridgeRuntimeConfig,
    deps: CursorDesktopBridgeDeps = {},
  ) {
    this.deps = {
      createRun: deps.createRun ?? createChildRun,
      createTerminalRun: deps.createTerminalRun ?? createTerminalChildRun,
      now: deps.now ?? defaultNow,
      hostname: deps.hostname ?? os.hostname,
      readFileSync: deps.readFileSync ?? fs.readFileSync,
      writeFileSync: deps.writeFileSync ?? fs.writeFileSync,
      existsSync: deps.existsSync ?? fs.existsSync,
      mkdirSync: deps.mkdirSync ?? fs.mkdirSync,
    };
    this.loadState();
  }

  private loadState(): void {
    try {
      if (!this.deps.existsSync(this.config.stateFile)) return;
      const raw = this.deps.readFileSync(this.config.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as CursorDesktopBridgeStoredState;
      this.agentJobCompatibility =
        parsed.agentJobCompatibility === 'validated' ||
        parsed.agentJobCompatibility === 'failed'
          ? parsed.agentJobCompatibility
          : 'unknown';
      this.agentJobDetail = toNullableString(parsed.agentJobDetail);
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      for (const session of sessions) {
        if (!session?.id) continue;
        const restoredTerminal = restoreTerminalState(
          (session as unknown as Record<string, unknown>).terminal,
          session.cwd || null,
        );
        if (restoredTerminal.status === 'STOPPED') {
          restoredTerminal.output.push({
            commandId: restoredTerminal.activeCommandId,
            stream: 'system',
            text: 'Bridge restarted while a terminal command was active.',
            createdAt: this.deps.now().toISOString(),
          });
          restoredTerminal.output = restoredTerminal.output.slice(
            -MAX_TERMINAL_OUTPUT_LINES,
          );
          restoredTerminal.outputLineCount = restoredTerminal.output.length;
        }
        this.sessions.set(session.id, {
          ...session,
          provider: 'desktop',
          activePid: null,
          status:
            session.status === 'RUNNING'
              ? 'FAILED'
              : session.status || 'FAILED',
          lastError:
            session.status === 'RUNNING'
              ? 'Bridge restarted while a Cursor run was active.'
              : session.lastError || null,
          conversation: Array.isArray(session.conversation)
            ? session.conversation
            : [],
          terminal: restoredTerminal,
        });
      }
    } catch (err) {
      logger.warn(
        { err, stateFile: this.config.stateFile },
        'Cursor desktop bridge state restore failed',
      );
    }
  }

  private saveState(): void {
    const payload: CursorDesktopBridgeStoredState = {
      agentJobCompatibility: this.agentJobCompatibility,
      agentJobDetail: this.agentJobDetail,
      sessions: [...this.sessions.values()].map((session) => ({
        ...session,
        activePid: null,
        terminal: {
          ...session.terminal,
          activePid: null,
          activeCommandId: null,
        },
      })),
    };
    this.deps.mkdirSync(path.dirname(this.config.stateFile), {
      recursive: true,
    });
    this.deps.writeFileSync(
      this.config.stateFile,
      JSON.stringify(payload, null, 2),
    );
  }

  private getCwd(candidate: string | undefined): string {
    const resolved =
      toNullableString(candidate) || this.config.defaultCwd || process.cwd();
    return path.resolve(resolved);
  }

  private getSessionOrThrow(id: string): CursorDesktopSessionRecord {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Cursor desktop session ${id} was not found.`);
    }
    return session;
  }

  private updateSession(
    id: string,
    apply: (session: CursorDesktopSessionRecord) => void,
  ): CursorDesktopSessionRecord {
    const session = this.getSessionOrThrow(id);
    apply(session);
    session.updatedAt = this.deps.now().toISOString();
    session.lastSyncedAt = session.updatedAt;
    this.saveState();
    return session;
  }

  private serializeSession(
    session: CursorDesktopSessionRecord,
  ): CursorDesktopSession {
    const {
      conversation: _conversation,
      activePid: _activePid,
      lastError: _lastError,
      terminal: _terminal,
      ...rest
    } = session;
    return { ...rest };
  }

  private appendTerminalOutput(
    terminal: CursorDesktopTerminalRecord,
    line: Omit<CursorDesktopTerminalOutputLine, 'createdAt'> & {
      createdAt?: string | null;
    },
  ): void {
    const text = truncateTerminalLine(line.text);
    if (!text) return;
    terminal.output.push({
      commandId: line.commandId ?? null,
      stream: line.stream,
      text,
      createdAt: line.createdAt || this.deps.now().toISOString(),
    });
    terminal.output = terminal.output.slice(-MAX_TERMINAL_OUTPUT_LINES);
    terminal.outputLineCount = terminal.output.length;
  }

  private launchRun(
    session: CursorDesktopSessionRecord,
    promptText: string,
    resumeSessionId: string | null,
  ): void {
    if (this.activeRuns.has(session.id)) {
      throw new Error(
        `Cursor desktop session ${session.id} is already running.`,
      );
    }

    const run = this.deps.createRun({
      cliPath: this.config.cliPath,
      cwd: this.getCwd(session.cwd || undefined),
      promptText,
      model: session.model,
      resumeSessionId,
      force: this.config.force,
    });

    this.activeRuns.set(session.id, run);
    session.activePid = run.pid ?? null;
    session.status = 'RUNNING';
    session.lastError = null;
    session.lastSyncedAt = this.deps.now().toISOString();
    session.updatedAt = session.lastSyncedAt;
    this.saveState();

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let latestSummary = '';
    let latestPlainText = '';
    let stoppedByBridge = false;

    run.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const sessionId = parseCursorSessionId(trimmed);
        if (sessionId && !session.cursorSessionId) {
          session.cursorSessionId = sessionId;
        }

        const extracted = extractTextFromJsonLine(trimmed);
        if (extracted) {
          latestSummary = extracted;
          continue;
        }

        const plainText = truncateSummary(trimmed);
        if (plainText) {
          latestPlainText = plainText;
        }
      }
      session.updatedAt = this.deps.now().toISOString();
      this.saveState();
    });

    run.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf-8');
    });

    run.onError((err) => {
      this.activeRuns.delete(session.id);
      session.activePid = null;
      session.status = 'FAILED';
      session.lastError = sanitizeLogString(err.message || 'Cursor run failed');
      session.summary = session.lastError;
      session.updatedAt = this.deps.now().toISOString();
      session.lastSyncedAt = session.updatedAt;
      this.agentJobCompatibility = 'failed';
      this.agentJobDetail = session.lastError;
      this.saveState();
    });

    run.onClose((code) => {
      this.activeRuns.delete(session.id);
      session.activePid = null;
      session.updatedAt = this.deps.now().toISOString();
      session.lastSyncedAt = session.updatedAt;

      if (stoppedByBridge) {
        session.status = 'STOPPED';
        session.summary = latestSummary || 'Stopped.';
      } else if (code === 0) {
        const usableSummary = latestSummary || latestPlainText;
        if (usableSummary) {
          session.status = 'COMPLETED';
          session.summary = usableSummary;
          this.agentJobCompatibility = 'validated';
          this.agentJobDetail = null;
          session.conversation.push({
            role: 'assistant',
            content: session.summary,
            createdAt: session.updatedAt,
          });
        } else {
          session.status = 'FAILED';
          session.lastError =
            truncateSummary(stderrBuffer) ||
            'Cursor desktop CLI exited without a usable agent response.';
          session.summary = session.lastError;
          this.agentJobCompatibility = 'failed';
          this.agentJobDetail = session.lastError;
        }
      } else {
        session.status = 'FAILED';
        session.lastError =
          truncateSummary(stderrBuffer) ||
          `Cursor CLI exited with code ${code ?? 'unknown'}.`;
        session.summary = session.lastError;
        this.agentJobCompatibility = 'failed';
        this.agentJobDetail = session.lastError;
      }

      this.saveState();
    });

    const stop = run.kill;
    run.kill = (signal) => {
      stoppedByBridge = true;
      stop(signal);
    };
  }

  getHealth(): CursorDesktopHealth {
    return {
      ok: true,
      machineName: this.deps.hostname(),
      cliPath: this.config.cliPath,
      activeRuns: this.activeRuns.size,
      trackedSessions: this.sessions.size,
      defaultCwd: this.config.defaultCwd,
      terminalAvailable: true,
      agentJobCompatibility: this.agentJobCompatibility,
      agentJobDetail: this.agentJobDetail,
    };
  }

  listSessions(limit = 50): CursorDesktopSession[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, safeLimit)
      .map((session) => this.serializeSession(session));
  }

  createSession(input: CreateSessionInput): CursorDesktopSession {
    const promptText = toNullableString(input.promptText);
    if (!promptText) {
      throw new Error('Prompt text is required.');
    }

    const nowIso = this.deps.now().toISOString();
    const id = randomId('desk');
    const session: CursorDesktopSessionRecord = {
      id,
      status: 'RUNNING',
      model: toNullableString(input.model),
      promptText,
      groupFolder: toNullableString(input.groupFolder),
      chatJid: toNullableString(input.chatJid),
      sourceRepository: toNullableString(input.sourceRepository),
      sourceRef: toNullableString(input.sourceRef),
      sourcePrUrl: toNullableString(input.sourcePrUrl),
      targetUrl: null,
      targetPrUrl: null,
      targetBranchName: toNullableString(input.branchName),
      autoCreatePr: input.autoCreatePr === true,
      openAsCursorGithubApp: input.openAsCursorGithubApp === true,
      skipReviewerRequest: input.skipReviewerRequest === true,
      summary: 'Queued on Cursor desktop bridge.',
      createdBy: toNullableString(input.requestedBy),
      createdAt: nowIso,
      updatedAt: nowIso,
      lastSyncedAt: nowIso,
      provider: 'desktop',
      cursorSessionId: null,
      cwd: this.getCwd(input.cwd),
      activePid: null,
      lastError: null,
      conversation: [
        {
          role: 'user',
          content: promptText,
          createdAt: nowIso,
        },
      ],
      terminal: createDefaultTerminalState(this.getCwd(input.cwd)),
    };

    this.sessions.set(id, session);
    this.saveState();
    this.launchRun(session, promptText, null);
    return this.serializeSession(session);
  }

  getSession(id: string): CursorDesktopSession {
    return this.serializeSession(this.getSessionOrThrow(id));
  }

  followupSession(id: string, promptTextRaw: string): CursorDesktopSession {
    const promptText = toNullableString(promptTextRaw);
    if (!promptText) {
      throw new Error('Prompt text is required.');
    }

    const session = this.getSessionOrThrow(id);
    if (!session.cursorSessionId) {
      throw new Error(
        `Cursor desktop session ${id} does not have a resumable Cursor session id yet.`,
      );
    }
    if (this.activeRuns.has(id)) {
      throw new Error(`Cursor desktop session ${id} is already running.`);
    }

    session.conversation.push({
      role: 'user',
      content: promptText,
      createdAt: this.deps.now().toISOString(),
    });
    this.launchRun(session, promptText, session.cursorSessionId);
    return this.getSession(id);
  }

  stopSession(id: string): CursorDesktopSession {
    const session = this.getSessionOrThrow(id);
    const active = this.activeRuns.get(id);
    if (!active) {
      if (session.status === 'STOPPED') return this.getSession(id);
      throw new Error(`Cursor desktop session ${id} is not running.`);
    }

    active.kill('SIGTERM');
    return this.getSession(id);
  }

  getConversation(id: string, limit = 20): CursorDesktopConversationMessage[] {
    const session = this.getSessionOrThrow(id);
    return cloneConversation(session.conversation, limit);
  }

  getTerminalStatus(id: string): CursorDesktopTerminalStatus {
    const session = this.getSessionOrThrow(id);
    const { output: _output, ...rest } = session.terminal;
    return { ...rest };
  }

  getTerminalOutput(
    id: string,
    options: {
      limit?: number;
      commandId?: string | null;
    } = {},
  ): CursorDesktopTerminalOutputLine[] {
    const session = this.getSessionOrThrow(id);
    const filtered = options.commandId
      ? session.terminal.output.filter(
          (line) => line.commandId === options.commandId,
        )
      : session.terminal.output;
    return cloneTerminalOutput(filtered, options.limit);
  }

  startTerminalCommand(
    id: string,
    commandTextRaw: string,
  ): CursorDesktopStartTerminalCommandResponse {
    const commandText = toNullableString(commandTextRaw);
    if (!commandText) {
      throw new Error('Terminal command text is required.');
    }

    const session = this.getSessionOrThrow(id);
    if (this.activeTerminalRuns.has(id)) {
      throw new Error(
        `Cursor desktop terminal for ${id} is already running a command.`,
      );
    }

    const terminal = session.terminal;
    const commandId = randomId('term');
    const metadataToken = `__ANDREA_TERM_META_${commandId}__`;
    const run = this.deps.createTerminalRun({
      cwd: this.getCwd(terminal.cwd || session.cwd || undefined),
      commandText,
      metadataToken,
    });

    this.activeTerminalRuns.set(id, run);
    const startedAt = this.deps.now().toISOString();
    terminal.available = true;
    terminal.status = 'RUNNING';
    terminal.lastCommand = commandText;
    terminal.activeCommandId = commandId;
    terminal.lastStartedAt = startedAt;
    terminal.activePid = run.pid ?? null;
    this.appendTerminalOutput(terminal, {
      commandId,
      stream: 'system',
      text: `$ ${commandText}`,
      createdAt: startedAt,
    });
    session.updatedAt = startedAt;
    session.lastSyncedAt = startedAt;
    this.saveState();

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let terminalMeta: { cwd: string | null; exitCode: number | null } | null =
      null;
    let stoppedByBridge = false;

    const flushBuffered = (buffer: string, stream: 'stdout' | 'stderr') => {
      const lines = buffer.split(/\r?\n/);
      for (const line of lines) {
        const normalized = truncateTerminalLine(line);
        if (!normalized) continue;
        const meta = parseTerminalMetadataLine(normalized, metadataToken);
        if (meta) {
          terminalMeta = meta;
          if (meta.cwd) {
            const resolvedCwd = path.resolve(meta.cwd);
            terminal.cwd = resolvedCwd;
            session.cwd = resolvedCwd;
          }
          if (meta.exitCode !== null) {
            terminal.lastExitCode = meta.exitCode;
          }
          continue;
        }
        this.appendTerminalOutput(terminal, {
          commandId,
          stream,
          text: normalized,
        });
      }
    };

    run.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      flushBuffered(lines.join('\n'), 'stdout');
      session.updatedAt = this.deps.now().toISOString();
      session.lastSyncedAt = session.updatedAt;
      this.saveState();
    });

    run.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf-8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      flushBuffered(lines.join('\n'), 'stderr');
      session.updatedAt = this.deps.now().toISOString();
      session.lastSyncedAt = session.updatedAt;
      this.saveState();
    });

    run.onError((err) => {
      this.activeTerminalRuns.delete(id);
      terminal.status = 'FAILED';
      terminal.activePid = null;
      terminal.activeCommandId = null;
      terminal.lastCompletedCommandId = commandId;
      terminal.lastFinishedAt = this.deps.now().toISOString();
      this.appendTerminalOutput(terminal, {
        commandId,
        stream: 'system',
        text: `Terminal command failed to start: ${sanitizeLogString(err.message || 'unknown error')}`,
        createdAt: terminal.lastFinishedAt,
      });
      session.updatedAt = terminal.lastFinishedAt;
      session.lastSyncedAt = session.updatedAt;
      this.saveState();
    });

    run.onClose((code, signal) => {
      this.activeTerminalRuns.delete(id);
      if (stdoutBuffer) {
        flushBuffered(stdoutBuffer, 'stdout');
        stdoutBuffer = '';
      }
      if (stderrBuffer) {
        flushBuffered(stderrBuffer, 'stderr');
        stderrBuffer = '';
      }

      const finishedAt = this.deps.now().toISOString();
      terminal.activePid = null;
      terminal.activeCommandId = null;
      terminal.lastCompletedCommandId = commandId;
      terminal.lastFinishedAt = finishedAt;
      const exitCode = terminalMeta?.exitCode ?? code ?? null;
      terminal.lastExitCode = exitCode;

      if (stoppedByBridge || signal === 'SIGTERM') {
        terminal.status = 'STOPPED';
        this.appendTerminalOutput(terminal, {
          commandId,
          stream: 'system',
          text: 'Terminal command stopped.',
          createdAt: finishedAt,
        });
      } else if (exitCode === 0) {
        terminal.status = 'IDLE';
        this.appendTerminalOutput(terminal, {
          commandId,
          stream: 'system',
          text: 'Terminal command finished with exit 0.',
          createdAt: finishedAt,
        });
      } else {
        terminal.status = 'FAILED';
        this.appendTerminalOutput(terminal, {
          commandId,
          stream: 'system',
          text: `Terminal command finished with exit ${exitCode ?? 'unknown'}.`,
          createdAt: finishedAt,
        });
      }

      session.updatedAt = finishedAt;
      session.lastSyncedAt = finishedAt;
      this.saveState();
    });

    const stop = run.kill;
    run.kill = (signal) => {
      stoppedByBridge = true;
      stop(signal);
    };

    return {
      commandId,
      terminal: this.getTerminalStatus(id),
    };
  }

  stopTerminalCommand(id: string): CursorDesktopTerminalStatus {
    const active = this.activeTerminalRuns.get(id);
    if (!active) {
      throw new Error(`Cursor desktop terminal for ${id} is not running.`);
    }

    active.kill('SIGTERM');
    return this.getTerminalStatus(id);
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${this.config.token}`) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = splitPathname(url.pathname);

    try {
      if (method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, this.getHealth());
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/sessions') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
        writeJson(res, 200, { sessions: this.listSessions(limit) });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/sessions') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        writeJson(
          res,
          200,
          this.createSession({
            promptText: String(body.promptText || ''),
            requestedBy: toNullableString(body.requestedBy) || undefined,
            model: toNullableString(body.model) || undefined,
            groupFolder: toNullableString(body.groupFolder) || undefined,
            chatJid: toNullableString(body.chatJid) || undefined,
            cwd: toNullableString(body.cwd) || undefined,
            sourceRepository:
              toNullableString(body.sourceRepository) || undefined,
            sourceRef: toNullableString(body.sourceRef) || undefined,
            sourcePrUrl: toNullableString(body.sourcePrUrl) || undefined,
            branchName: toNullableString(body.branchName) || undefined,
            autoCreatePr: body.autoCreatePr === true,
            openAsCursorGithubApp: body.openAsCursorGithubApp === true,
            skipReviewerRequest: body.skipReviewerRequest === true,
          }),
        );
        return;
      }

      if (segments[0] === 'v1' && segments[1] === 'sessions' && segments[2]) {
        const id = segments[2];

        if (method === 'GET' && segments.length === 3) {
          writeJson(res, 200, this.getSession(id));
          return;
        }

        if (method === 'GET' && segments[3] === 'conversation') {
          const limit = Number.parseInt(
            url.searchParams.get('limit') || '',
            10,
          );
          writeJson(res, 200, {
            messages: this.getConversation(id, limit),
          });
          return;
        }

        if (method === 'POST' && segments[3] === 'followup') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          writeJson(
            res,
            200,
            this.followupSession(id, String(body.promptText || '')),
          );
          return;
        }

        if (method === 'POST' && segments[3] === 'stop') {
          writeJson(res, 200, this.stopSession(id));
          return;
        }

        if (segments[3] === 'terminal') {
          if (method === 'GET' && segments.length === 4) {
            writeJson(res, 200, this.getTerminalStatus(id));
            return;
          }

          if (method === 'GET' && segments[4] === 'output') {
            const limit = Number.parseInt(
              url.searchParams.get('limit') || '',
              10,
            );
            writeJson(res, 200, {
              lines: this.getTerminalOutput(id, {
                limit,
                commandId: toNullableString(url.searchParams.get('commandId')),
              }),
            });
            return;
          }

          if (method === 'POST' && segments[4] === 'command') {
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            writeJson(
              res,
              200,
              this.startTerminalCommand(id, String(body.commandText || '')),
            );
            return;
          }

          if (method === 'POST' && segments[4] === 'stop') {
            writeJson(res, 200, this.stopTerminalCommand(id));
            return;
          }
        }
      }

      writeJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.warn(
        { err, method, pathname: url.pathname },
        'Cursor desktop bridge request failed',
      );
      writeJson(res, 400, {
        error:
          err instanceof Error ? sanitizeLogString(err.message) : String(err),
      });
    }
  }
}

export function startCursorDesktopBridge(
  deps: CursorDesktopBridgeDeps = {},
): http.Server {
  const config = resolveRuntimeConfigFromEnv();
  if (!config.token.trim()) {
    throw new Error(
      'CURSOR_DESKTOP_BRIDGE_TOKEN is required to start the Cursor desktop bridge.',
    );
  }

  const bridge = new CursorDesktopBridge(config, deps);
  const server = http.createServer((req, res) => {
    bridge.handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'Cursor desktop bridge request crashed');
      writeJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        cliPath: config.cliPath,
        defaultCwd: config.defaultCwd,
        stateFile: config.stateFile,
      },
      'Cursor desktop bridge started',
    );
  });

  return server;
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startCursorDesktopBridge();
}

export {
  buildCursorDesktopCliArgs,
  resolveCursorDesktopCliMode,
  shouldUseShellForCursorDesktopCli,
};
