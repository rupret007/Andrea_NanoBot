import type { RegisteredGroup } from './types.js';

export const REMOTE_CONTROL_START_COMMANDS = new Set([
  '/remote-control',
  '/remote_control',
  '/cursor-remote',
  '/cursor_remote',
]);

export const REMOTE_CONTROL_STOP_COMMANDS = new Set([
  '/remote-control-end',
  '/remote_control_end',
  '/cursor-remote-end',
  '/cursor_remote_end',
]);

export const CURSOR_MODELS_COMMANDS = new Set([
  '/cursor-models',
  '/cursor_models',
  '/cursor-model',
  '/cursor_model',
]);

export const CURSOR_TEST_COMMANDS = new Set([
  '/cursor-test',
  '/cursor_test',
  '/cursor-smoke',
  '/cursor_smoke',
]);

export const CURSOR_JOBS_COMMANDS = new Set(['/cursor-jobs', '/cursor_jobs']);

export const CURSOR_CREATE_COMMANDS = new Set([
  '/cursor-create',
  '/cursor_create',
]);

export const CURSOR_SYNC_COMMANDS = new Set(['/cursor-sync', '/cursor_sync']);

export const CURSOR_STOP_COMMANDS = new Set(['/cursor-stop', '/cursor_stop']);

export const CURSOR_FOLLOWUP_COMMANDS = new Set([
  '/cursor-followup',
  '/cursor_followup',
]);

export const CURSOR_CONVERSATION_COMMANDS = new Set([
  '/cursor-conversation',
  '/cursor_conversation',
  '/cursor-log',
  '/cursor_log',
]);

export const CURSOR_ARTIFACTS_COMMANDS = new Set([
  '/cursor-artifacts',
  '/cursor_artifacts',
]);

export const CURSOR_ARTIFACT_LINK_COMMANDS = new Set([
  '/cursor-artifact-link',
  '/cursor_artifact_link',
  '/cursor-download',
  '/cursor_download',
]);

export const ALEXA_STATUS_COMMANDS = new Set([
  '/alexa',
  '/alexa-status',
  '/alexa_status',
]);

export const AMAZON_STATUS_COMMANDS = new Set([
  '/amazon-status',
  '/amazon_status',
]);

export const AMAZON_SEARCH_COMMANDS = new Set([
  '/amazon-search',
  '/amazon_search',
]);

export const PURCHASE_REQUEST_COMMANDS = new Set([
  '/purchase-request',
  '/purchase_request',
]);

export const PURCHASE_REQUESTS_COMMANDS = new Set([
  '/purchase-requests',
  '/purchase_requests',
]);

export const PURCHASE_APPROVE_COMMANDS = new Set([
  '/purchase-approve',
  '/purchase_approve',
]);

export const PURCHASE_CANCEL_COMMANDS = new Set([
  '/purchase-cancel',
  '/purchase_cancel',
]);

const DISABLED_COMMANDS = new Set([
  ...REMOTE_CONTROL_START_COMMANDS,
  ...REMOTE_CONTROL_STOP_COMMANDS,
]);

const MAIN_CONTROL_ONLY_COMMANDS = new Set([
  ...CURSOR_MODELS_COMMANDS,
  ...CURSOR_TEST_COMMANDS,
  ...CURSOR_JOBS_COMMANDS,
  ...CURSOR_CREATE_COMMANDS,
  ...CURSOR_SYNC_COMMANDS,
  ...CURSOR_STOP_COMMANDS,
  ...CURSOR_FOLLOWUP_COMMANDS,
  ...CURSOR_CONVERSATION_COMMANDS,
  ...CURSOR_ARTIFACTS_COMMANDS,
  ...CURSOR_ARTIFACT_LINK_COMMANDS,
  ...ALEXA_STATUS_COMMANDS,
  ...AMAZON_STATUS_COMMANDS,
  ...AMAZON_SEARCH_COMMANDS,
  ...PURCHASE_REQUEST_COMMANDS,
  ...PURCHASE_REQUESTS_COMMANDS,
  ...PURCHASE_APPROVE_COMMANDS,
  ...PURCHASE_CANCEL_COMMANDS,
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
        'This experimental remote-control bridge is disabled in this runtime.',
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

  if (group) {
    return {
      allowed: false,
      reason: 'main_control_only',
      message:
        "That command is restricted to Andrea's main control chat. Use the registered main chat for admin and integration work.",
    };
  }

  return {
    allowed: false,
    reason: 'main_control_only',
    message:
      "That command is restricted to Andrea's main control chat. Open a DM with Andrea and run /registermain first.",
  };
}
