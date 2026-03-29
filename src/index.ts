import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AvailableCursorAgent,
  AvailableOpenClawSkill,
  ContainerOutput,
  runContainerAgent,
  writeCursorAgentsSnapshot,
  writeGroupsSnapshot,
  writeOpenClawSkillsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getCursorAgentById,
  listAllCursorAgents,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  listCursorAgentsForGroup,
  listCursorAgentArtifacts,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  listAllEnabledCommunitySkills,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  formatCursorGatewaySmokeTestMessage,
  formatCursorGatewayStatusMessage,
  getCursorGatewayStatus,
  runCursorGatewaySmokeTest,
} from './cursor-gateway.js';
import {
  CursorCloudClient,
  formatCursorCloudStatusMessage,
  getCursorCloudStatus,
  resolveCursorCloudConfig,
} from './cursor-cloud.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  disableOpenClawSkill,
  enableOpenClawSkill,
  installOpenClawSkill,
} from './openclaw-market.js';
import { classifyAssistantRequest } from './assistant-routing.js';
import { analyzeAgentError } from './agent-error.js';
import {
  createCursorAgent,
  followupCursorAgent,
  getCursorAgentConversation,
  stopCursorAgent,
  syncCursorAgent,
} from './cursor-jobs.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const NON_RETRIABLE_ERROR_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
const lastNonRetriableErrorNotice: Record<
  string,
  { code: string; at: number }
> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

async function bootstrapMainChatRegistration(
  chatJid: string,
  chatName: string,
  channel: string,
): Promise<{ ok: boolean; message: string }> {
  const existing = registeredGroups[chatJid];
  if (existing) {
    if (existing.isMain) {
      return {
        ok: true,
        message: 'This chat is already registered as the main control chat.',
      };
    }
    return {
      ok: false,
      message:
        'This chat is already registered as a non-main chat. Use your existing main chat for administration.',
    };
  }

  const existingMain = Object.entries(registeredGroups).find(
    ([, group]) => group.isMain,
  );
  if (existingMain) {
    return {
      ok: false,
      message: `Main chat is already registered as ${existingMain[0]}.`,
    };
  }

  const mainFolderConflict = Object.entries(registeredGroups).find(
    ([jid, group]) => group.folder === 'main' && jid !== chatJid,
  );
  if (mainFolderConflict) {
    return {
      ok: false,
      message:
        'Cannot bootstrap main chat because folder "main" is already used by another registration.',
    };
  }

  registerGroup(chatJid, {
    name: chatName || 'Main',
    folder: 'main',
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
  });

  logger.info(
    { chatJid, chatName, channel },
    'Bootstrapped main chat registration via channel command',
  );

  return {
    ok: true,
    message: `Main chat registered successfully (${chatJid}). You can now send commands to ${ASSISTANT_NAME} here.`,
  };
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function getEnabledOpenClawSkillsSnapshot(): AvailableOpenClawSkill[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return listAllEnabledCommunitySkills()
    .map((skill) => {
      const targetGroup = foldersToChats.get(skill.group_folder);
      if (!targetGroup) return null;

      return {
        chatJid: targetGroup.jid,
        groupFolder: skill.group_folder,
        groupName: targetGroup.name,
        skillId: skill.skill_id,
        displayName: skill.display_name,
        sourceUrl: skill.source_url,
        canonicalClawHubUrl: skill.canonical_clawhub_url,
        githubTreeUrl: skill.github_tree_url,
        installDirName: skill.cache_dir_name,
        enabledAt: skill.enabled_at,
        security: {
          virusTotalStatus: skill.virus_total_status,
          openClawStatus: skill.openclaw_status,
          openClawSummary: skill.openclaw_summary,
        },
      };
    })
    .filter((skill): skill is AvailableOpenClawSkill => skill !== null);
}

function getCursorAgentsSnapshot(): AvailableCursorAgent[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return listAllCursorAgents()
    .map((agent) => {
      const targetGroup = foldersToChats.get(agent.group_folder);
      if (!targetGroup) return null;

      return {
        id: agent.id,
        chatJid: targetGroup.jid,
        groupFolder: agent.group_folder,
        groupName: targetGroup.name,
        status: agent.status,
        model: agent.model,
        promptText: agent.prompt_text,
        sourceRepository: agent.source_repository,
        sourceRef: agent.source_ref,
        sourcePrUrl: agent.source_pr_url,
        targetUrl: agent.target_url,
        targetPrUrl: agent.target_pr_url,
        targetBranchName: agent.target_branch_name,
        summary: agent.summary,
        createdAt: agent.created_at,
        updatedAt: agent.updated_at,
        lastSyncedAt: agent.last_synced_at,
        artifacts: listCursorAgentArtifacts(agent.id).map((artifact) => ({
          absolutePath: artifact.absolute_path,
          sizeBytes: artifact.size_bytes,
          updatedAt: artifact.updated_at,
          downloadUrl: artifact.download_url,
          downloadUrlExpiresAt: artifact.download_url_expires_at,
          syncedAt: artifact.synced_at,
        })),
      };
    })
    .filter((agent): agent is AvailableCursorAgent => agent !== null);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const requestPolicy = classifyAssistantRequest(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      requestRoute: requestPolicy.route,
      requestReason: requestPolicy.reason,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    requestPolicy,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = formatOutbound(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

    if (output.status === 'error' && output.nonRetriable) {
      const now = Date.now();
      const previousNotice = lastNonRetriableErrorNotice[chatJid];
      const shouldNotify =
        !previousNotice ||
        previousNotice.code !== output.code ||
        now - previousNotice.at >= NON_RETRIABLE_ERROR_NOTIFY_COOLDOWN_MS;

      if (shouldNotify && output.userMessage) {
        await channel.sendMessage(chatJid, output.userMessage);
      }

      lastNonRetriableErrorNotice[chatJid] = {
        code: output.code,
        at: now,
      };

      logger.warn(
        {
          group: group.name,
          code: output.code,
          notified: shouldNotify,
        },
        'Non-retriable agent error detected, skipping retry loop',
      );

      return true;
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  requestPolicy: ReturnType<typeof classifyAssistantRequest>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{
  status: 'success' | 'error';
  code:
    | 'insufficient_quota'
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  nonRetriable: boolean;
  userMessage: string | null;
}> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );
  writeOpenClawSkillsSnapshot(
    group.folder,
    isMain,
    getEnabledOpenClawSkillsSnapshot(),
  );
  writeCursorAgentsSnapshot(group.folder, isMain, getCursorAgentsSnapshot());

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        requestPolicy,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      const analysis = analyzeAgentError(output.error);
      logger.error(
        {
          group: group.name,
          error: output.error,
          code: analysis.code,
          nonRetriable: analysis.nonRetriable,
        },
        'Container agent error',
      );
      return {
        status: 'error',
        code: analysis.code,
        nonRetriable: analysis.nonRetriable,
        userMessage: analysis.userMessage,
      };
    }

    return {
      status: 'success',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
    };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const REMOTE_CONTROL_START_COMMANDS = new Set([
    '/remote-control',
    '/remote_control',
    '/cursor-remote',
    '/cursor_remote',
  ]);
  const REMOTE_CONTROL_STOP_COMMANDS = new Set([
    '/remote-control-end',
    '/remote_control_end',
    '/cursor-remote-end',
    '/cursor_remote_end',
  ]);
  const CURSOR_STATUS_COMMANDS = new Set([
    '/cursor',
    '/cursor-status',
    '/cursor_status',
  ]);
  const CURSOR_TEST_COMMANDS = new Set([
    '/cursor-test',
    '/cursor_test',
    '/cursor-smoke',
    '/cursor_smoke',
  ]);
  const CURSOR_JOBS_COMMANDS = new Set(['/cursor-jobs', '/cursor_jobs']);
  const CURSOR_CREATE_COMMANDS = new Set(['/cursor-create', '/cursor_create']);
  const CURSOR_SYNC_COMMANDS = new Set(['/cursor-sync', '/cursor_sync']);
  const CURSOR_STOP_COMMANDS = new Set(['/cursor-stop', '/cursor_stop']);
  const CURSOR_FOLLOWUP_COMMANDS = new Set([
    '/cursor-followup',
    '/cursor_followup',
  ]);
  const CURSOR_CONVERSATION_COMMANDS = new Set([
    '/cursor-conversation',
    '/cursor_conversation',
    '/cursor-log',
    '/cursor_log',
  ]);
  const CURSOR_ARTIFACTS_COMMANDS = new Set([
    '/cursor-artifacts',
    '/cursor_artifacts',
  ]);

  // Handle remote-control (and cursor-remote alias) commands
  async function handleRemoteControl(
    action: 'start' | 'stop',
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (action === 'start') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  async function handleCursorStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const gatewayStatus = await getCursorGatewayStatus({ probe: true });
    const cloudStatus = getCursorCloudStatus();
    await channel.sendMessage(
      chatJid,
      [
        formatCursorGatewayStatusMessage(gatewayStatus),
        formatCursorCloudStatusMessage(cloudStatus),
      ].join('\n\n'),
    );
  }

  async function runCursorCloudProbeMessage(): Promise<string> {
    const status = getCursorCloudStatus();
    if (!status.enabled) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: skipped',
        '- Detail: set `CURSOR_API_KEY` to enable Cursor Cloud Agent probes.',
      ].join('\n');
    }

    const config = resolveCursorCloudConfig();
    if (!config) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: failed',
        '- Detail: Cursor Cloud config could not be resolved from environment.',
      ].join('\n');
    }

    try {
      const client = new CursorCloudClient(config);
      const models = await client.listModels();
      const modelPreview = models.models
        .slice(0, 5)
        .map((model) => model.id)
        .join(', ');
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: ok',
        `- Base URL: ${status.baseUrl}`,
        `- Models visible: ${models.models.length}`,
        modelPreview ? `- Sample models: ${modelPreview}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    } catch (err) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: failed',
        `- Detail: ${getUserFacingErrorDetail(err)}`,
      ].join('\n');
    }
  }

  async function handleCursorSmokeTest(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = await getCursorGatewayStatus({ probe: true });
    const smoke = await runCursorGatewaySmokeTest({ status });
    const cloudProbe = await runCursorCloudProbeMessage();
    await channel.sendMessage(
      chatJid,
      [formatCursorGatewaySmokeTestMessage(status, smoke), cloudProbe].join(
        '\n\n',
      ),
    );
  }

  async function handleCursorJobs(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    const agents = listCursorAgentsForGroup(group.folder, 20);
    if (agents.length === 0) {
      await channel.sendMessage(
        chatJid,
        'No Cursor agent jobs are tracked for this chat yet.',
      );
      return;
    }

    const lines = agents.map(
      (agent, index) =>
        `${index + 1}. ${agent.id} [${agent.status}] model=${agent.model || 'default'} updated=${agent.updated_at}${agent.target_url ? `\nURL: ${agent.target_url}` : ''}${agent.target_pr_url ? `\nPR: ${agent.target_pr_url}` : ''}`,
    );

    await channel.sendMessage(chatJid, `Cursor jobs:\n\n${lines.join('\n\n')}`);
  }

  async function handleCursorCreate(
    chatJid: string,
    promptText: string,
    requestedBy?: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const created = await createCursorAgent({
        groupFolder: group.folder,
        chatJid,
        promptText,
        requestedBy,
      });
      refreshCursorSnapshotsForAllGroups();
      const targetBits = [
        created.targetUrl ? `URL: ${created.targetUrl}` : null,
        created.targetPrUrl ? `PR: ${created.targetPrUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      await channel.sendMessage(
        chatJid,
        [
          `Created Cursor agent ${created.id} (status: ${created.status}).`,
          targetBits || null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure('Cursor create failed', err),
      );
    }
  }

  async function handleCursorConversation(
    chatJid: string,
    agentId: string,
    limit: number,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const messages = await getCursorAgentConversation({
        groupFolder: group.folder,
        chatJid,
        agentId,
        limit,
      });
      if (messages.length === 0) {
        await channel.sendMessage(
          chatJid,
          `No conversation messages are available yet for ${agentId}.`,
        );
        return;
      }

      const formatted = messages
        .map((message, index) => {
          const compact = message.content.replace(/\s+/g, ' ').trim();
          const preview =
            compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
          const createdAt = message.createdAt ? ` @ ${message.createdAt}` : '';
          return `${index + 1}. [${message.role}]${createdAt}\n${preview}`;
        })
        .join('\n\n');
      await channel.sendMessage(
        chatJid,
        `Cursor conversation for ${agentId} (latest ${messages.length}):\n\n${formatted}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          `Cursor conversation fetch failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorArtifacts(
    chatJid: string,
    agentId: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    const stored = getCursorAgentById(agentId);
    if (
      !stored ||
      stored.group_folder !== group.folder ||
      stored.chat_jid !== chatJid
    ) {
      await channel.sendMessage(
        chatJid,
        `No tracked Cursor agent with id "${agentId}" exists for this chat.`,
      );
      return;
    }

    const artifacts = listCursorAgentArtifacts(agentId);
    if (artifacts.length === 0) {
      await channel.sendMessage(
        chatJid,
        `Cursor agent ${agentId} has no tracked artifacts yet. Run /cursor_sync ${agentId} first.`,
      );
      return;
    }

    const lines = artifacts.map(
      (artifact, index) =>
        `${index + 1}. ${artifact.absolute_path} (${artifact.size_bytes ?? 'unknown'} bytes)${artifact.updated_at ? ` updated=${artifact.updated_at}` : ''}`,
    );

    await channel.sendMessage(
      chatJid,
      `Cursor artifacts for ${agentId}:\n\n${lines.join('\n')}`,
    );
  }

  function refreshCursorSnapshotsForAllGroups(): void {
    const cursorRows = getCursorAgentsSnapshot();
    for (const group of Object.values(registeredGroups)) {
      writeCursorAgentsSnapshot(
        group.folder,
        group.isMain === true,
        cursorRows,
      );
    }
  }

  async function handleCursorSync(
    chatJid: string,
    agentId: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const synced = await syncCursorAgent({
        groupFolder: group.folder,
        chatJid,
        agentId,
      });
      refreshCursorSnapshotsForAllGroups();
      await channel.sendMessage(
        chatJid,
        `Synced ${synced.agent.id}. Status: ${synced.agent.status}. Artifacts: ${synced.artifacts.length}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          `Cursor sync failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorStop(
    chatJid: string,
    agentId: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const stopped = await stopCursorAgent({
        groupFolder: group.folder,
        chatJid,
        agentId,
      });
      refreshCursorSnapshotsForAllGroups();
      await channel.sendMessage(
        chatJid,
        `Stop requested for ${stopped.id}. Current status: ${stopped.status}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          `Cursor stop failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorFollowup(
    chatJid: string,
    agentId: string,
    promptText: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const followed = await followupCursorAgent({
        groupFolder: group.folder,
        chatJid,
        agentId,
        promptText,
      });
      refreshCursorSnapshotsForAllGroups();
      await channel.sendMessage(
        chatJid,
        `Follow-up sent to ${followed.id}. Status: ${followed.status}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          `Cursor follow-up failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const rawTrimmed = msg.content.trim();
      const trimmed = rawTrimmed.toLowerCase();
      const rawCommandToken = trimmed.split(/\s+/)[0] || '';
      const commandToken = rawCommandToken.split('@')[0] || '';
      if (CURSOR_STATUS_COMMANDS.has(commandToken)) {
        handleCursorStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor status command error'),
        );
        return;
      }

      if (CURSOR_TEST_COMMANDS.has(commandToken)) {
        handleCursorSmokeTest(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor smoke command error'),
        );
        return;
      }

      if (CURSOR_JOBS_COMMANDS.has(commandToken)) {
        handleCursorJobs(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor jobs command error'),
        );
        return;
      }

      if (CURSOR_CREATE_COMMANDS.has(commandToken)) {
        const promptText = rawTrimmed.split(/\s+/).slice(1).join(' ').trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_create <prompt>')
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor create usage send failed'),
            );
          return;
        }

        handleCursorCreate(chatJid, promptText, msg.sender).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor create command error'),
        );
        return;
      }

      if (CURSOR_SYNC_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_sync <agent_id>')
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor sync usage send failed'),
            );
          return;
        }

        handleCursorSync(chatJid, agentId).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor sync command error'),
        );
        return;
      }

      if (CURSOR_STOP_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_stop <agent_id>')
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor stop usage send failed'),
            );
          return;
        }

        handleCursorStop(chatJid, agentId).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor stop command error'),
        );
        return;
      }

      if (CURSOR_CONVERSATION_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /cursor_conversation <agent_id> [limit]',
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor conversation usage send failed',
              ),
            );
          return;
        }

        const parsedLimit = Number.parseInt(parts[2] || '', 10);
        const limit =
          Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(100, parsedLimit)
            : 20;
        handleCursorConversation(chatJid, agentId, limit).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor conversation command error'),
        );
        return;
      }

      if (CURSOR_ARTIFACTS_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_artifacts <agent_id>')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor artifacts usage send failed',
              ),
            );
          return;
        }

        handleCursorArtifacts(chatJid, agentId).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor artifacts command error'),
        );
        return;
      }

      if (CURSOR_FOLLOWUP_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_followup <agent_id> <text>')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor followup usage send failed',
              ),
            );
          return;
        }

        const promptText = rawTrimmed.split(/\s+/).slice(2).join(' ').trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor_followup <agent_id> <text>')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor followup usage send failed',
              ),
            );
          return;
        }

        handleCursorFollowup(chatJid, agentId, promptText).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor followup command error'),
        );
        return;
      }

      if (REMOTE_CONTROL_START_COMMANDS.has(commandToken)) {
        handleRemoteControl('start', chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      if (REMOTE_CONTROL_STOP_COMMANDS.has(commandToken)) {
        handleRemoteControl('stop', chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onRegisterMainChat: bootstrapMainChatRegistration,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    onMarketplaceChanged: () => {
      const skillRows = getEnabledOpenClawSkillsSnapshot();
      for (const group of Object.values(registeredGroups)) {
        writeOpenClawSkillsSnapshot(
          group.folder,
          group.isMain === true,
          skillRows,
        );
      }
    },
    onCursorChanged: () => {
      const cursorRows = getCursorAgentsSnapshot();
      for (const group of Object.values(registeredGroups)) {
        writeCursorAgentsSnapshot(
          group.folder,
          group.isMain === true,
          cursorRows,
        );
      }
    },
    enableOpenClawSkill,
    disableOpenClawSkill,
    installOpenClawSkill,
  });
  const cursorRows = getCursorAgentsSnapshot();
  for (const group of Object.values(registeredGroups)) {
    writeCursorAgentsSnapshot(group.folder, group.isMain === true, cursorRows);
  }
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
