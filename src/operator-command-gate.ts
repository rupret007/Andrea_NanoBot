import type { RegisteredGroup } from './types.js';

export const REMOTE_CONTROL_START_COMMANDS = new Set([
  '/remote-control',
  '/remote_control',
]);

export const REMOTE_CONTROL_STOP_COMMANDS = new Set([
  '/remote-control-end',
  '/remote_control_end',
]);

export const RUNTIME_STATUS_COMMANDS = new Set([
  '/runtime-status',
  '/runtime_status',
  '/codex-status',
  '/codex_status',
]);

export const RUNTIME_JOBS_COMMANDS = new Set([
  '/runtime-jobs',
  '/runtime_jobs',
  '/codex-jobs',
  '/codex_jobs',
]);

export const RUNTIME_FOLLOWUP_COMMANDS = new Set([
  '/runtime-followup',
  '/runtime_followup',
  '/codex-followup',
  '/codex_followup',
]);

export const RUNTIME_STOP_COMMANDS = new Set([
  '/runtime-stop',
  '/runtime_stop',
  '/codex-stop',
  '/codex_stop',
]);

export const RUNTIME_LOGS_COMMANDS = new Set([
  '/runtime-logs',
  '/runtime_logs',
  '/codex-logs',
  '/codex_logs',
]);

const DISABLED_COMMANDS = new Set([
  ...REMOTE_CONTROL_START_COMMANDS,
  ...REMOTE_CONTROL_STOP_COMMANDS,
]);

const MAIN_CONTROL_ONLY_COMMANDS = new Set([
  ...RUNTIME_STATUS_COMMANDS,
  ...RUNTIME_JOBS_COMMANDS,
  ...RUNTIME_FOLLOWUP_COMMANDS,
  ...RUNTIME_STOP_COMMANDS,
  ...RUNTIME_LOGS_COMMANDS,
]);

export interface CommandAccessDecision {
  allowed: boolean;
  reason: 'public' | 'main_control_only' | 'disabled';
  message: string | null;
}

export function normalizeCommandToken(commandToken: string): string {
  return commandToken
    .trim()
    .toLowerCase()
    .replace(/@[^@\s]+$/, '')
    .replace(/[?!.,:;]+$/, '');
}

export function isMainControlChat(group: RegisteredGroup | undefined): boolean {
  return group?.isMain === true;
}

export function getCommandAccessDecision(
  commandToken: string,
  group: RegisteredGroup | undefined,
): CommandAccessDecision {
  const normalized = normalizeCommandToken(commandToken);

  if (DISABLED_COMMANDS.has(normalized)) {
    return {
      allowed: false,
      reason: 'disabled',
      message:
        'Andrea does not expose the old Claude remote-control bridge in this runtime.',
    };
  }

  if (!MAIN_CONTROL_ONLY_COMMANDS.has(normalized)) {
    return {
      allowed: true,
      reason: 'public',
      message: null,
    };
  }

  if (isMainControlChat(group)) {
    return {
      allowed: true,
      reason: 'public',
      message: null,
    };
  }

  return {
    allowed: false,
    reason: 'main_control_only',
    message:
      "That command is restricted to Andrea's main control chat.",
  };
}
