import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  classifyRuntimeRoute,
  formatAgentRuntimeStatusMessage,
  getAgentRuntimeStatusSnapshot,
  selectPreferredRuntime,
  shouldReuseExistingThread,
} from './agent-runtime.js';
import { classifyAssistantRequest } from './assistant-routing.js';
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
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  CONTAINER_RUNTIME_NAME,
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  getContainerRuntimeStatus,
} from './container-runtime.js';
import {
  getAllAgentThreads,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAgentThread,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setAgentThread,
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
  getCommandAccessDecision,
  normalizeCommandToken,
  REMOTE_CONTROL_START_COMMANDS,
  REMOTE_CONTROL_STOP_COMMANDS,
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
} from './operator-command-gate.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AgentThreadState,
  Channel,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let agentThreads: Record<string, AgentThreadState> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

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
  agentThreads = getAllAgentThreads();
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

function persistAgentThread(
  groupFolder: string,
  threadId: string,
  runtime: AgentThreadState['runtime'],
): void {
  sessions[groupFolder] = threadId;
  setSession(groupFolder, threadId);
  const thread: AgentThreadState = {
    group_folder: groupFolder,
    runtime,
    thread_id: threadId,
    last_response_id: threadId,
    updated_at: new Date().toISOString(),
  };
  agentThreads[groupFolder] = thread;
  setAgentThread(thread);
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

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function refreshTaskSnapshots(): void {
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
}

function getRegisteredGroupByFolder(
  folder: string,
): { jid: string; group: RegisteredGroup } | null {
  const match = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === folder,
  );
  if (!match) return null;
  return { jid: match[0], group: match[1] };
}

function formatRuntimeJobsMessage(): string {
  const jobs = queue.getRuntimeJobs();
  if (jobs.length === 0) {
    return 'Andrea has no active or queued runtime jobs right now.';
  }

  return [
    '*Andrea Runtime Jobs*',
    ...jobs.map((job) =>
      [
        `- ${job.groupFolder || job.groupJid}`,
        `active=${job.active ? 'yes' : 'no'}`,
        `idle=${job.idleWaiting ? 'yes' : 'no'}`,
        `pending_messages=${job.pendingMessages ? 'yes' : 'no'}`,
        `pending_tasks=${job.pendingTaskCount}`,
        `container=${job.containerName || 'none'}`,
      ].join(' | '),
    ),
  ].join('\n');
}

function readLatestRuntimeLog(groupFolder: string, lineLimit: number): string | null {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const logsDir = path.join(groupDir, 'logs');
  if (!fs.existsSync(logsDir)) return null;

  const entries = fs
    .readdirSync(logsDir)
    .filter((entry) => entry.endsWith('.log'))
    .sort();

  const latest = entries.at(-1);
  if (!latest) return null;

  const content = fs.readFileSync(path.join(logsDir, latest), 'utf-8');
  const lines = content.trim().split(/\r?\n/);
  const tail = lines.slice(-Math.max(1, lineLimit));
  return [`Latest log: ${latest}`, ...tail].join('\n');
}

async function sendToChat(chatJid: string, text: string): Promise<void> {
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, cannot send operator message');
    return;
  }
  await channel.sendMessage(chatJid, text);
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
      if (result.result) {
        const text = formatOutbound(result.result);
        logger.info(
          { group: group.name },
          `Agent output: ${result.result.length} chars`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
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

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

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
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const existingThread = getAgentThread(group.folder) || agentThreads[group.folder];
  const runtimeRoute = classifyRuntimeRoute(requestPolicy, prompt);
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const sessionId = shouldReuseExistingThread(existingThread, preferredRuntime)
    ? existingThread.thread_id
    : sessions[group.folder];

  refreshTaskSnapshots();

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          persistAgentThread(
            group.folder,
            output.newSessionId,
            output.runtime || preferredRuntime,
          );
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
        preferredRuntime,
        runtimeRoute,
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
      persistAgentThread(
        group.folder,
        output.newSessionId,
        output.runtime || preferredRuntime,
      );
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error, runtime: output.runtime },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function handleRuntimeStatus(chatJid: string): Promise<void> {
  const snapshot = getAgentRuntimeStatusSnapshot({
    activeThreads: agentThreads,
    activeJobs: queue.getRuntimeJobs().length,
    containerRuntimeName: CONTAINER_RUNTIME_NAME,
    containerRuntimeStatus: getContainerRuntimeStatus(CONTAINER_RUNTIME_NAME),
  });
  await sendToChat(chatJid, formatAgentRuntimeStatusMessage(snapshot));
}

async function handleRuntimeJobs(chatJid: string): Promise<void> {
  await sendToChat(chatJid, formatRuntimeJobsMessage());
}

async function handleRuntimeStop(
  operatorChatJid: string,
  targetFolder: string,
): Promise<void> {
  const target = getRegisteredGroupByFolder(targetFolder);
  if (!target) {
    await sendToChat(
      operatorChatJid,
      `No registered group found for folder "${targetFolder}".`,
    );
    return;
  }

  const stopped = queue.requestStop(target.jid);
  await sendToChat(
    operatorChatJid,
    stopped
      ? `Requested runtime stop for ${targetFolder}.`
      : `No active runtime job found for ${targetFolder}.`,
  );
}

async function handleRuntimeLogs(
  operatorChatJid: string,
  targetFolder: string,
  lineLimit: number,
): Promise<void> {
  const target = getRegisteredGroupByFolder(targetFolder);
  if (!target) {
    await sendToChat(
      operatorChatJid,
      `No registered group found for folder "${targetFolder}".`,
    );
    return;
  }

  const logText = readLatestRuntimeLog(target.group.folder, lineLimit);
  await sendToChat(
    operatorChatJid,
    logText || `No runtime logs found yet for ${targetFolder}.`,
  );
}

async function handleRuntimeFollowup(
  operatorChatJid: string,
  targetFolder: string,
  prompt: string,
): Promise<void> {
  const target = getRegisteredGroupByFolder(targetFolder);
  if (!target) {
    await sendToChat(
      operatorChatJid,
      `No registered group found for folder "${targetFolder}".`,
    );
    return;
  }

  const taskId = `runtime-followup-${Date.now()}-${target.group.folder}`;
  const requestPolicy = classifyAssistantRequest([{ content: prompt }]);

  queue.enqueueTask(target.jid, taskId, async () => {
    const existingThread =
      getAgentThread(target.group.folder) || agentThreads[target.group.folder];
    const runtimeRoute = classifyRuntimeRoute(requestPolicy, prompt);
    const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
    const sessionId = shouldReuseExistingThread(existingThread, preferredRuntime)
      ? existingThread.thread_id
      : sessions[target.group.folder];
    let emittedOutput = false;

    const output = await runContainerAgent(
      target.group,
      {
        prompt,
        sessionId,
        preferredRuntime,
        runtimeRoute,
        groupFolder: target.group.folder,
        chatJid: target.jid,
        isMain: target.group.isMain === true,
        assistantName: ASSISTANT_NAME,
        requestPolicy,
      },
      (proc, containerName) =>
        queue.registerProcess(target.jid, proc, containerName, target.group.folder),
      async (result) => {
        if (result.newSessionId) {
          persistAgentThread(
            target.group.folder,
            result.newSessionId,
            result.runtime || preferredRuntime,
          );
        }
        if (result.result) {
          const text = formatOutbound(result.result);
          if (text) {
            emittedOutput = true;
            await sendToChat(operatorChatJid, text);
          }
        }
        if (result.status === 'success') {
          queue.notifyIdle(target.jid);
        }
      },
    );

    if (output.newSessionId) {
      persistAgentThread(
        target.group.folder,
        output.newSessionId,
        output.runtime || preferredRuntime,
      );
    }

    if (output.status === 'error') {
      await sendToChat(
        operatorChatJid,
        `Runtime follow-up failed for ${targetFolder}: ${output.error || 'unknown error'}`,
      );
      return;
    }

    if (!emittedOutput) {
      await sendToChat(
        operatorChatJid,
        `Runtime follow-up for ${targetFolder} completed with no user-facing output.`,
      );
    }
  });

  await sendToChat(
    operatorChatJid,
    `Queued runtime follow-up for ${targetFolder}.`,
  );
}

async function handleOperatorCommand(
  chatJid: string,
  msg: NewMessage,
): Promise<boolean> {
  const rawTrimmed = msg.content.trim();
  if (!rawTrimmed.startsWith('/')) return false;

  const commandToken = normalizeCommandToken(
    rawTrimmed.split(/\s+/)[0] || rawTrimmed,
  );
  const decision = getCommandAccessDecision(commandToken, registeredGroups[chatJid]);

  if (!decision.allowed) {
    if (decision.message) {
      await sendToChat(chatJid, decision.message);
    }
    return (
      REMOTE_CONTROL_START_COMMANDS.has(commandToken) ||
      REMOTE_CONTROL_STOP_COMMANDS.has(commandToken) ||
      RUNTIME_STATUS_COMMANDS.has(commandToken) ||
      RUNTIME_JOBS_COMMANDS.has(commandToken) ||
      RUNTIME_FOLLOWUP_COMMANDS.has(commandToken) ||
      RUNTIME_STOP_COMMANDS.has(commandToken) ||
      RUNTIME_LOGS_COMMANDS.has(commandToken)
    );
  }

  if (RUNTIME_STATUS_COMMANDS.has(commandToken)) {
    await handleRuntimeStatus(chatJid);
    return true;
  }

  if (RUNTIME_JOBS_COMMANDS.has(commandToken)) {
    await handleRuntimeJobs(chatJid);
    return true;
  }

  if (RUNTIME_FOLLOWUP_COMMANDS.has(commandToken)) {
    const parts = rawTrimmed.split(/\s+/);
    const targetFolder = parts[1];
    const followupText = parts.slice(2).join(' ').trim();
    if (!targetFolder || !followupText) {
      await sendToChat(chatJid, 'Usage: /runtime-followup GROUP_FOLDER TEXT');
      return true;
    }
    await handleRuntimeFollowup(chatJid, targetFolder, followupText);
    return true;
  }

  if (RUNTIME_STOP_COMMANDS.has(commandToken)) {
    const parts = rawTrimmed.split(/\s+/);
    const targetFolder = parts[1];
    if (!targetFolder) {
      await sendToChat(chatJid, 'Usage: /runtime-stop GROUP_FOLDER');
      return true;
    }
    await handleRuntimeStop(chatJid, targetFolder);
    return true;
  }

  if (RUNTIME_LOGS_COMMANDS.has(commandToken)) {
    const parts = rawTrimmed.split(/\s+/);
    const targetFolder = parts[1];
    const parsedLimit = Number.parseInt(parts[2] || '', 10);
    const lineLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(120, parsedLimit)
        : 40;
    if (!targetFolder) {
      await sendToChat(chatJid, 'Usage: /runtime-logs GROUP_FOLDER [LINES]');
      return true;
    }
    await handleRuntimeLogs(chatJid, targetFolder, lineLimit);
    return true;
  }

  return false;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`Andrea runtime bot running (default trigger: ${DEFAULT_TRIGGER})`);

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
  // Channel callbacks (shared by all channels)
  const channelOpts = {
        onMessage: (chatJid: string, msg: NewMessage) => {
      const processStoredMessage = () => {
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
      };

      const trimmed = msg.content.trim();
      if (!trimmed.startsWith('/')) {
        processStoredMessage();
        return;
      }

      handleOperatorCommand(chatJid, msg)
        .then((handled) => {
          if (!handled) {
            processStoredMessage();
          }
        })
        .catch((err) => {
          logger.error({ err, chatJid }, 'Operator command handling error');
          processStoredMessage();
        });
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
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
    getAgentThreads: () => agentThreads,
    persistAgentThread,
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
      refreshTaskSnapshots();
    },
  });
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
    logger.error({ err }, 'Failed to start Andrea_OpenAI_Bot');
    process.exit(1);
  });
}




