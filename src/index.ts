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
import {
  ASSISTANT_NAME,
  AGENT_RUNTIME_FALLBACK,
  ANDREA_OPENAI_BACKEND_URL,
  CONTAINER_TIMEOUT,
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
  CONTAINER_RUNTIME_NAME,
  getContainerRuntimeStatus,
} from './container-runtime.js';
import {
  createTask,
  deleteRuntimeBackendCardContext,
  deleteRuntimeBackendChatSelection,
  getAllAgentThreads,
  getAllChats,
  getAgentThread,
  listAllCursorAgents,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  listCursorAgentArtifacts,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getRuntimeBackendCardContext,
  getRuntimeBackendChatSelection,
  getRuntimeBackendJob,
  initDatabase,
  listAllEnabledCommunitySkills,
  pruneExpiredRuntimeBackendCardContexts,
  setRegisteredGroup,
  setAgentThread,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  upsertRuntimeBackendCardContext,
  upsertRuntimeBackendChatSelection,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { planSimpleReminder } from './local-reminder.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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
  formatCursorDesktopStatusMessage,
  getCursorDesktopStatus,
} from './cursor-desktop.js';
import {
  formatCursorCapabilitySummaryMessage,
  formatCursorOperationFailure,
  summarizeCursorCapabilities,
} from './cursor-capabilities.js';
import {
  formatAmazonBusinessStatusMessage,
  getAmazonBusinessStatus,
} from './amazon-business.js';
import {
  type AlexaRuntime,
  formatAlexaStatusMessage,
  getAlexaStatus,
  startAlexaServer,
} from './alexa.js';
import { seedConfiguredAlexaLinkedAccount } from './alexa-identity.js';
import {
  approveAmazonPurchaseRequest,
  cancelAmazonPurchaseRequest,
  createAmazonPurchaseRequest,
  formatAmazonPurchaseRequestsMessage,
  formatAmazonSearchResultsMessage,
  listAmazonPurchaseRequests,
  searchAmazonProducts,
} from './amazon-shopping.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropIncomingMessageBeforeCommands,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AgentThreadState,
  Channel,
  NewMessage,
  RegisteredGroup,
  RuntimeBackendJob,
} from './types.js';
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
  getCursorAgentArtifacts,
  getCursorArtifactDownloadLink,
  getCursorAgentConversation,
  getCursorTerminalOutput,
  getCursorTerminalStatus,
  listCursorJobInventory,
  listCursorModels,
  runCursorTerminalCommand,
  stopCursorTerminal,
  stopCursorAgent,
  syncCursorAgent,
} from './cursor-jobs.js';
import {
  parseCursorCreateCommand,
  tokenizeCommandArguments,
} from './cursor-command-parser.js';
import { normalizeCursorAgentId } from './cursor-agent-id.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';
import { resolveEffectiveIdleTimeout } from './runtime-timeout.js';
import {
  maybeBuildDirectQuickReply,
  maybeBuildDirectRescueReply,
} from './direct-quick-reply.js';
import { buildSilentSuccessFallback } from './user-facing-fallback.js';
import {
  ANDREA_OPENAI_BACKEND_ID,
} from './andrea-openai-backend.js';
import {
  AndreaOpenAiRuntimeError,
  createAndreaOpenAiRuntimeJob,
  followUpAndreaOpenAiRuntimeJob,
  getAndreaOpenAiBackendStatus,
  getAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJobLogs,
  listAndreaOpenAiRuntimeJobs,
  stopAndreaOpenAiRuntimeJob,
} from './andrea-openai-runtime.js';
import {
  formatRuntimeBackendCreateAcceptedMessage,
  extractRuntimeBackendJobIdFromText,
  formatRuntimeBackendFailure,
  formatRuntimeBackendFollowupAcceptedMessage,
  formatRuntimeBackendJobCard,
  formatRuntimeBackendJobsMessage,
  formatRuntimeBackendLogsMessage,
  formatRuntimeBackendStatusSummary,
  formatRuntimeBackendStopMessage,
} from './runtime-shell.js';
import {
  buildRuntimeReplyContextMissingMessage,
  buildRuntimeSelectionMissingMessage,
  computeRuntimeCardContextExpiry,
  resolveRuntimeJobTarget,
  resolveRuntimeLogsTarget,
  resolveRuntimeReplyContext,
} from './runtime-chat-context.js';
import {
  ALEXA_STATUS_COMMANDS,
  AMAZON_SEARCH_COMMANDS,
  AMAZON_STATUS_COMMANDS,
  CURSOR_ARTIFACTS_COMMANDS,
  CURSOR_ARTIFACT_LINK_COMMANDS,
  CURSOR_CONVERSATION_COMMANDS,
  CURSOR_CREATE_COMMANDS,
  CURSOR_FOLLOWUP_COMMANDS,
  CURSOR_JOBS_COMMANDS,
  CURSOR_MODELS_COMMANDS,
  CURSOR_STOP_COMMANDS,
  CURSOR_SYNC_COMMANDS,
  CURSOR_TERMINAL_COMMANDS,
  CURSOR_TERMINAL_LOG_COMMANDS,
  CURSOR_TERMINAL_STATUS_COMMANDS,
  CURSOR_TERMINAL_STOP_COMMANDS,
  CURSOR_TEST_COMMANDS,
  getCommandAccessDecision,
  normalizeCommandToken,
  PURCHASE_APPROVE_COMMANDS,
  PURCHASE_CANCEL_COMMANDS,
  PURCHASE_REQUEST_COMMANDS,
  PURCHASE_REQUESTS_COMMANDS,
  RUNTIME_CREATE_COMMANDS,
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOB_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
  REMOTE_CONTROL_START_COMMANDS,
  REMOTE_CONTROL_STOP_COMMANDS,
} from './operator-command-gate.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let agentThreads: Record<string, AgentThreadState> = {};
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

function refreshTaskSnapshots(groups: Record<string, RegisteredGroup>): void {
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
  for (const group of Object.values(groups)) {
    writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
  }
}

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

  if (requestPolicy.route === 'direct_assistant') {
    const quickReply = maybeBuildDirectQuickReply(missedMessages);
    if (quickReply) {
      try {
        await channel.sendMessage(chatJid, quickReply);
        logger.info(
          { group: group.name },
          'Handled message via direct quick reply path',
        );
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Direct quick reply send failed, rolled back cursor for retry',
        );
        return false;
      }
    }
  }

  if (requestPolicy.route === 'protected_assistant') {
    const lastContent = missedMessages.at(-1)?.content ?? '';
    const plannedReminder = planSimpleReminder(
      lastContent,
      group.folder,
      chatJid,
    );
    if (plannedReminder) {
      try {
        createTask(plannedReminder.task);
        refreshTaskSnapshots(registeredGroups);
        await channel.sendMessage(chatJid, plannedReminder.confirmation);
        logger.info(
          { group: group.name, taskId: plannedReminder.task.id },
          'Handled reminder via local protected fast path',
        );
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local protected reminder path failed, rolled back cursor for retry',
        );
        return false;
      }
    }
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const configuredTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const effectiveIdleTimeout = resolveEffectiveIdleTimeout(
    IDLE_TIMEOUT,
    configuredTimeout,
  );

  if (effectiveIdleTimeout !== IDLE_TIMEOUT) {
    logger.debug(
      {
        group: group.name,
        configuredTimeout,
        requestedIdleTimeout: IDLE_TIMEOUT,
        effectiveIdleTimeout,
      },
      'Clamped idle timeout to preserve graceful container shutdown window',
    );
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, effectiveIdleTimeout);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    requestPolicy,
    effectiveIdleTimeout,
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

    if (requestPolicy.route === 'direct_assistant') {
      const rescueReply = maybeBuildDirectRescueReply(missedMessages);
      if (rescueReply) {
        await channel.sendMessage(chatJid, rescueReply);
        logger.warn(
          { group: group.name },
          'Recovered direct assistant error with local rescue reply',
        );
        return true;
      }
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

  if (!outputSentToUser) {
    const fallbackReply = buildSilentSuccessFallback(
      requestPolicy.route,
      missedMessages,
    );
    await channel.sendMessage(chatJid, fallbackReply);
    logger.warn(
      { group: group.name, route: requestPolicy.route },
      'Recovered blank agent success with user-facing fallback',
    );
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  requestPolicy: ReturnType<typeof classifyAssistantRequest>,
  idleTimeoutMs: number,
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
  const runtimeRoute = classifyRuntimeRoute(requestPolicy, prompt);
  const existingThread =
    agentThreads[group.folder] || getAgentThread(group.folder);
  if (existingThread) {
    agentThreads[group.folder] = existingThread;
  }
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const sessionId = shouldReuseExistingThread(existingThread, preferredRuntime)
    ? existingThread.thread_id
    : sessions[group.folder];

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
        fallbackRuntime: AGENT_RUNTIME_FALLBACK,
        runtimeRoute,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        requestPolicy,
        idleTimeoutMs,
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

  try {
    seedConfiguredAlexaLinkedAccount();
  } catch (err) {
    logger.error({ err }, 'Alexa linked-account seed failed');
  }

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  let alexaRuntime: AlexaRuntime | null = null;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    if (alexaRuntime) {
      await alexaRuntime
        .close()
        .catch((err) =>
          logger.warn({ err }, 'Alexa voice ingress shutdown failed'),
        );
    }
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const CURSOR_STATUS_COMMANDS = new Set([
    '/cursor',
    '/cursor-status',
    '/cursor_status',
  ]);
  const CURSOR_CREATE_USAGE =
    'Usage: /cursor-create [--model MODEL_ID] [--repo REPO_URL] [--ref GIT_REF] [--pr PR_URL] [--branch BRANCH_NAME] [--auto-pr] [--cursor-github-app] [--skip-reviewer] PROMPT';
  const CURSOR_ARTIFACT_LINK_USAGE =
    'Usage: /cursor-artifact-link AGENT_ID ABSOLUTE_PATH';
  const RUNTIME_CREATE_USAGE = 'Usage: /runtime-create TEXT';
  const RUNTIME_JOBS_USAGE = 'Usage: /runtime-jobs [LIMIT] [BEFORE_JOB_ID]';
  const RUNTIME_JOB_USAGE = 'Usage: /runtime-job [JOB_ID]';
  const RUNTIME_FOLLOWUP_USAGE = 'Usage: /runtime-followup JOB_ID TEXT';
  const RUNTIME_STOP_USAGE = 'Usage: /runtime-stop [JOB_ID]';
  const RUNTIME_LOGS_USAGE = 'Usage: /runtime-logs [JOB_ID] [LINES]';
  const CURSOR_TERMINAL_USAGE = 'Usage: /cursor-terminal AGENT_ID COMMAND';
  const CURSOR_TERMINAL_STATUS_USAGE =
    'Usage: /cursor-terminal-status AGENT_ID';
  const CURSOR_TERMINAL_LOG_USAGE =
    'Usage: /cursor-terminal-log AGENT_ID [LIMIT]';
  const CURSOR_TERMINAL_STOP_USAGE = 'Usage: /cursor-terminal-stop AGENT_ID';
  const MAX_CURSOR_TERMINAL_REPLY_CHARS = 3000;
  const MAX_CURSOR_TERMINAL_LINES = 40;

  function formatCursorTerminalStatusMessage(
    agentId: string,
    terminal: {
      status: string;
      cwd: string | null;
      shell: string | null;
      lastCommand: string | null;
      lastExitCode: number | null;
      activePid: number | null;
      outputLineCount: number;
      lastStartedAt: string | null;
      lastFinishedAt: string | null;
    },
  ): string {
    const lines = [
      `Desktop bridge terminal for ${agentId}:`,
      `- Status: ${terminal.status}`,
      `- CWD: ${terminal.cwd || 'unknown'}`,
      `- Shell: ${terminal.shell || 'unknown'}`,
      `- Last exit: ${terminal.lastExitCode ?? 'unknown'}`,
      `- Active PID: ${terminal.activePid ?? 'none'}`,
      `- Output lines cached: ${terminal.outputLineCount}`,
    ];

    if (terminal.lastCommand) {
      lines.push(`- Last command: ${terminal.lastCommand}`);
    }
    if (terminal.lastStartedAt) {
      lines.push(`- Last started: ${terminal.lastStartedAt}`);
    }
    if (terminal.lastFinishedAt) {
      lines.push(`- Last finished: ${terminal.lastFinishedAt}`);
    }

    return lines.join('\n');
  }

  function formatCursorTerminalOutputSection(
    output: Array<{
      stream: string;
      text: string;
    }>,
  ): string {
    if (output.length === 0) {
      return 'No terminal output captured yet.';
    }

    const clippedLines = output
      .slice(-MAX_CURSOR_TERMINAL_LINES)
      .map((line) => `[${line.stream}] ${line.text}`);
    let joined = clippedLines.join('\n');
    if (joined.length > MAX_CURSOR_TERMINAL_REPLY_CHARS) {
      joined = `...${joined.slice(-(MAX_CURSOR_TERMINAL_REPLY_CHARS - 3))}`;
    }
    return joined;
  }

  function labelCursorRecord(
    record:
      | {
          provider?: 'cloud' | 'desktop';
          id: string;
        }
      | string,
  ): string {
    const provider =
      typeof record === 'string'
        ? /^desk_/i.test(record)
          ? 'desktop'
          : /^bc[-_]/i.test(record)
            ? 'cloud'
            : null
        : record.provider ||
          (/^desk_/i.test(record.id)
            ? 'desktop'
            : /^bc[-_]/i.test(record.id)
              ? 'cloud'
              : null);

    if (provider === 'desktop') return 'desktop bridge session';
    if (provider === 'cloud') return 'Cursor Cloud job';
    return 'Cursor job';
  }

  async function handleRemoteControl(
    action: 'start' | 'stop',
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    logger.info(
      { action, chatJid, sender: msg.sender },
      'Remote control command blocked in demo mode',
    );
    await channel.sendMessage(
      chatJid,
      'This experimental remote-control bridge is disabled in the demo runtime.',
    );
  }

  function resolveRuntimeGroupTarget(
    token: string,
  ): { chatJid: string; group: RegisteredGroup } | null {
    const trimmed = token.trim();
    if (!trimmed) return null;

    const byJid = registeredGroups[trimmed];
    if (byJid) {
      return { chatJid: trimmed, group: byJid };
    }

    const byFolder = Object.entries(registeredGroups).find(
      ([, group]) => group.folder === trimmed,
    );
    if (byFolder) {
      return { chatJid: byFolder[0], group: byFolder[1] };
    }

    return null;
  }

  async function resolveRuntimeBackendContext(
    chatJid: string,
  ): Promise<{ channel: Channel; group: RegisteredGroup } | null> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return null;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return null;
    }

    return { channel, group };
  }

  function readCachedRuntimeJob(jobId: string): RuntimeBackendJob | null {
    const cached = getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, jobId);
    if (!cached?.raw_json) return null;
    try {
      return JSON.parse(cached.raw_json) as RuntimeBackendJob;
    } catch (err) {
      logger.warn(
        { err, jobId },
        'Failed to parse cached runtime backend job payload',
      );
      return null;
    }
  }

  function getCurrentRuntimeSelection(
    chatJid: string,
    groupFolder: string,
  ): string | null {
    const selection = getRuntimeBackendChatSelection(
      ANDREA_OPENAI_BACKEND_ID,
      chatJid,
    );
    if (!selection) return null;

    if (selection.group_folder !== groupFolder) {
      deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
      return null;
    }

    return selection.job_id;
  }

  function updateCurrentRuntimeSelection(
    chatJid: string,
    groupFolder: string,
    jobId: string,
    updatedAt = new Date().toISOString(),
  ): void {
    upsertRuntimeBackendChatSelection({
      backend_id: ANDREA_OPENAI_BACKEND_ID,
      chat_jid: chatJid,
      job_id: jobId,
      group_folder: groupFolder,
      updated_at: updatedAt,
    });
  }

  function clearCurrentRuntimeSelection(chatJid: string): void {
    deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
  }

  function shouldClearRuntimeSelectionForError(err: unknown): boolean {
    return (
      err instanceof AndreaOpenAiRuntimeError &&
      (err.kind === 'not_found' || err.kind === 'context_mismatch')
    );
  }

  async function sendRuntimeBackendCardMessage(params: {
    channel: Channel;
    chatJid: string;
    group: RegisteredGroup;
    text: string;
    job?: RuntimeBackendJob | null;
    threadId?: string;
    armReplyContext?: boolean;
    updateSelection?: boolean;
  }): Promise<void> {
    const {
      channel,
      chatJid,
      group,
      text,
      job,
      threadId,
      armReplyContext = false,
      updateSelection = false,
    } = params;

    let receipt = null;
    if (channel.sendMessageWithReceipt) {
      receipt = await channel.sendMessageWithReceipt(chatJid, text, threadId);
      if (!receipt) return;
    } else {
      await channel.sendMessage(chatJid, text, threadId);
    }

    if (!job) return;

    const nowIso = new Date().toISOString();
    if (updateSelection) {
      updateCurrentRuntimeSelection(chatJid, group.folder, job.jobId, nowIso);
    }

    if (!armReplyContext || !receipt?.platformMessageIds.length) return;

    const expiresAt = computeRuntimeCardContextExpiry(nowIso);
    for (const messageId of receipt.platformMessageIds) {
      upsertRuntimeBackendCardContext({
        backend_id: ANDREA_OPENAI_BACKEND_ID,
        chat_jid: chatJid,
        message_id: messageId,
        job_id: job.jobId,
        group_folder: group.folder,
        thread_id: threadId || job.threadId || null,
        created_at: nowIso,
        expires_at: expiresAt,
      });
    }
  }

  async function maybeHandleRuntimeReplyContext(
    chatJid: string,
    msg: NewMessage,
  ): Promise<boolean> {
    const replyTo = msg.reply_to;
    const replyText = replyTo?.content?.trim() || '';
    const replyMessageId = replyTo?.message_id?.trim() || '';
    const promptText = msg.content.trim();

    if (!replyText || !replyMessageId || !promptText) return false;

    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return true;

    pruneExpiredRuntimeBackendCardContexts(new Date().toISOString());
    const runtimeCardContext = getRuntimeBackendCardContext(
      ANDREA_OPENAI_BACKEND_ID,
      chatJid,
      replyMessageId,
    );
    const resolution = resolveRuntimeReplyContext({
      replyMessageId,
      replyText,
      contextMessageId: runtimeCardContext?.message_id,
      contextJobId: runtimeCardContext?.job_id,
      contextGroupFolder: runtimeCardContext?.group_folder,
      currentGroupFolder: context.group.folder,
      expiresAt: runtimeCardContext?.expires_at,
      nowIso: new Date().toISOString(),
    });

    if (resolution.kind === 'not_runtime_reply') {
      return false;
    }

    if (resolution.kind === 'missing' || resolution.kind === 'expired') {
      if (runtimeCardContext && resolution.kind === 'expired') {
        deleteRuntimeBackendCardContext(
          ANDREA_OPENAI_BACKEND_ID,
          chatJid,
          replyMessageId,
        );
      }
      await context.channel.sendMessage(
        chatJid,
        buildRuntimeReplyContextMissingMessage(resolution.jobIdHint),
        msg.thread_id,
      );
      return true;
    }

    try {
      const job = await followUpAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId: resolution.jobId!,
        prompt: promptText,
        actorId: msg.sender,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendFollowupAcceptedMessage(job),
        job,
        threadId: msg.thread_id || runtimeCardContext?.thread_id || undefined,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
        msg.thread_id,
      );
    }

    return true;
  }

  async function runOperatorRuntimeFollowup(
    operatorChatJid: string,
    targetChatJid: string,
    targetGroup: RegisteredGroup,
    promptText: string,
  ): Promise<void> {
    const channel = findChannel(channels, operatorChatJid);
    if (!channel) return;

    const requestPolicy = classifyAssistantRequest([{ content: promptText }]);
    let hadVisibleOutput = false;

    const result = await runAgent(
      targetGroup,
      promptText,
      targetChatJid,
      requestPolicy,
      IDLE_TIMEOUT,
      async (partial) => {
        const text =
          typeof partial.result === 'string'
            ? formatOutbound(partial.result)
            : '';
        if (!text) return;
        hadVisibleOutput = true;
        await channel.sendMessage(
          operatorChatJid,
          `Runtime follow-up (${targetGroup.folder}):\n\n${text}`,
        );
      },
    );

    if (result.status === 'error') {
      await channel.sendMessage(
        operatorChatJid,
        result.userMessage ||
          `Runtime follow-up failed for ${targetGroup.folder}.`,
      );
      return;
    }

    if (!hadVisibleOutput) {
      await channel.sendMessage(
        operatorChatJid,
        `Runtime follow-up for ${targetGroup.folder} completed without a user-visible reply.`,
      );
    }
  }

  async function handleRuntimeStatus(chatJid: string): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    const status = await getAndreaOpenAiBackendStatus();
    await context.channel.sendMessage(
      chatJid,
      formatRuntimeBackendStatusSummary(
        status,
        context.group,
        ANDREA_OPENAI_BACKEND_URL,
      ),
    );
  }

  async function handleRuntimeCreate(
    chatJid: string,
    promptText: string,
    actorId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await createAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        prompt: promptText,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendCreateAcceptedMessage(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeJobs(
    chatJid: string,
    limit: number,
    beforeJobId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await listAndreaOpenAiRuntimeJobs({
        chatJid,
        group: context.group,
        limit,
        beforeJobId,
      });
      if (result.jobs.length === 0) {
        await context.channel.sendMessage(
          chatJid,
          `No Andrea OpenAI jobs are recorded yet for backend group "${context.group.folder}".`,
        );
        return;
      }
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendJobsMessage({
          group: context.group,
          jobs: result.jobs,
          nextBeforeJobId: result.nextBeforeJobId,
          limit,
        }),
      );
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeJob(
    chatJid: string,
    jobId: string,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await getAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendJobCard(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleRuntimeFollowup(
    chatJid: string,
    jobId: string,
    promptText: string,
    actorId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await followUpAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
        prompt: promptText,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendFollowupAcceptedMessage(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeStop(
    chatJid: string,
    jobId: string,
    actorId?: string,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await stopAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendStopMessage(result),
        job: result.job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleRuntimeLogs(
    chatJid: string,
    jobId: string,
    limit: number,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await getAndreaOpenAiRuntimeJobLogs({
        chatJid,
        group: context.group,
        jobId,
        lines: limit,
      });
      let currentJob = readCachedRuntimeJob(jobId);
      if (!currentJob && !result.logText?.trim()) {
        try {
          currentJob = await getAndreaOpenAiRuntimeJob({
            chatJid,
            group: context.group,
            jobId,
          });
        } catch {
          currentJob = null;
        }
      }
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendLogsMessage(result, currentJob),
        job: currentJob,
        armReplyContext: Boolean(currentJob),
        updateSelection: Boolean(currentJob),
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleCursorStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const desktopStatus = await getCursorDesktopStatus({ probe: true });
    const gatewayStatus = await getCursorGatewayStatus({ probe: true });
    const cloudStatus = getCursorCloudStatus();
    const capabilitySummary = summarizeCursorCapabilities({
      desktopStatus,
      cloudStatus,
      gatewayStatus,
    });
    await channel.sendMessage(
      chatJid,
      [
        formatCursorCapabilitySummaryMessage(capabilitySummary),
        formatCursorDesktopStatusMessage(desktopStatus),
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

  async function runCursorDesktopProbeMessage(): Promise<string> {
    const status = await getCursorDesktopStatus({ probe: true });
    return formatCursorDesktopStatusMessage(status);
  }

  async function handleCursorSmokeTest(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = await getCursorGatewayStatus({ probe: true });
    const smoke = await runCursorGatewaySmokeTest({ status });
    const desktopProbe = await runCursorDesktopProbeMessage();
    const cloudProbe = await runCursorCloudProbeMessage();
    await channel.sendMessage(
      chatJid,
      [
        desktopProbe,
        formatCursorGatewaySmokeTestMessage(status, smoke),
        cloudProbe,
      ].join('\n\n'),
    );
  }

  async function handleAmazonStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = getAmazonBusinessStatus();
    await channel.sendMessage(
      chatJid,
      [
        formatAmazonBusinessStatusMessage(status),
        status.searchReady
          ? 'Try `/amazon_search <keywords>` to look for a product, then Andrea can prepare a guarded purchase approval.'
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n\n'),
    );
  }

  async function handleAlexaStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = alexaRuntime?.getStatus() || getAlexaStatus();
    await channel.sendMessage(chatJid, formatAlexaStatusMessage(status));
  }

  async function handleAmazonSearch(
    chatJid: string,
    query: string,
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
      const results = await searchAmazonProducts(query, 5);
      await channel.sendMessage(
        chatJid,
        formatAmazonSearchResultsMessage(query, results),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure('Amazon search failed', err),
      );
    }
  }

  async function handleAmazonPurchaseRequest(
    chatJid: string,
    asin: string,
    offerId: string,
    quantity: number,
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
      const created = await createAmazonPurchaseRequest({
        groupFolder: group.folder,
        chatJid,
        asin,
        offerId,
        quantity,
        requestedBy,
      });
      await channel.sendMessage(chatJid, created.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure('Amazon purchase request failed', err),
      );
    }
  }

  async function handleAmazonPurchaseRequests(chatJid: string): Promise<void> {
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
      await channel.sendMessage(
        chatJid,
        formatAmazonPurchaseRequestsMessage(
          listAmazonPurchaseRequests(group.folder, 20),
        ),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase request lookup failed',
          err,
        ),
      );
    }
  }

  async function handleAmazonPurchaseApprove(
    chatJid: string,
    requestId: string,
    approvalCode: string,
    approvedBy?: string,
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
      const approved = await approveAmazonPurchaseRequest({
        groupFolder: group.folder,
        requestId,
        approvalCode,
        approvedBy,
      });
      await channel.sendMessage(chatJid, approved.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase approval failed',
          err,
        ),
      );
    }
  }

  async function handleAmazonPurchaseCancel(
    chatJid: string,
    requestId: string,
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
      const cancelled = cancelAmazonPurchaseRequest({
        groupFolder: group.folder,
        requestId,
      });
      await channel.sendMessage(chatJid, cancelled.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase cancellation failed',
          err,
        ),
      );
    }
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

    const inventory = await listCursorJobInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 20,
    });

    const formatAgentLine = (
      agent: {
        id: string;
        status: string;
        model: string | null;
        updatedAt?: string;
        updated_at?: string;
        targetUrl?: string | null;
        target_url?: string | null;
        targetPrUrl?: string | null;
        target_pr_url?: string | null;
      },
      index: number,
    ) => {
      const updatedAt = agent.updatedAt || agent.updated_at || 'unknown';
      const targetUrl = agent.targetUrl || agent.target_url;
      const targetPrUrl = agent.targetPrUrl || agent.target_pr_url;
      return `${index + 1}. ${agent.id} [${agent.status}] model=${agent.model || 'default'} updated=${updatedAt}${targetUrl ? `\nURL: ${targetUrl}` : ''}${targetPrUrl ? `\nPR: ${targetPrUrl}` : ''}`;
    };

    const sections: string[] = [];
    if (inventory.cloudTracked.length > 0) {
      sections.push(
        `Tracked Cursor Cloud jobs:\n${inventory.cloudTracked
          .map((agent, index) => formatAgentLine(agent, index))
          .join('\n\n')}`,
      );
    }

    if (inventory.desktopTracked.length > 0) {
      sections.push(
        `Tracked desktop bridge sessions:\n${inventory.desktopTracked
          .map((agent, index) => formatAgentLine(agent, index))
          .join('\n\n')}`,
      );
    }

    if (inventory.cloudRecoverable.length > 0) {
      sections.push(
        `Recoverable Cursor Cloud jobs:\n${inventory.cloudRecoverable
          .map((agent, index) => formatAgentLine(agent, index))
          .join(
            '\n\n',
          )}\n\nRun /cursor-sync AGENT_ID to attach one of these jobs to this workspace.`,
      );
    }

    if (inventory.desktopRecoverable.length > 0) {
      sections.push(
        `Recoverable desktop bridge sessions:\n${inventory.desktopRecoverable
          .map((agent, index) => formatAgentLine(agent, index))
          .join(
            '\n\n',
          )}\n\nRun /cursor-sync AGENT_ID to attach one of these sessions to this workspace.`,
      );
    }

    if (sections.length === 0) {
      const backendHint =
        !inventory.hasCloud && !inventory.hasDesktop
          ? 'Neither Cursor Cloud nor the desktop bridge is configured right now. Add `CURSOR_API_KEY` for queued Cloud jobs, or add `CURSOR_DESKTOP_BRIDGE_URL` + `CURSOR_DESKTOP_BRIDGE_TOKEN` for operator-only desktop session and terminal control.'
          : 'No tracked or recoverable Cursor Cloud jobs or desktop bridge sessions were found for this workspace.';
      const warning = inventory.warning
        ? `\n\nLive backend lookup skipped: ${inventory.warning}`
        : '';
      await channel.sendMessage(chatJid, `${backendHint}${warning}`);
      return;
    }

    if (inventory.warning) {
      sections.push(`Live backend lookup skipped: ${inventory.warning}`);
    }

    await channel.sendMessage(
      chatJid,
      `Cursor jobs:\n\n${sections.join('\n\n')}`,
    );
  }

  async function handleCursorModels(
    chatJid: string,
    filterText: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    try {
      const models = await listCursorModels(200);
      const normalizedFilter = filterText.trim().toLowerCase();
      const matches = normalizedFilter
        ? models.filter((model) => {
            const haystack = `${model.id} ${model.name || ''}`.toLowerCase();
            return haystack.includes(normalizedFilter);
          })
        : models;

      if (matches.length === 0) {
        await channel.sendMessage(
          chatJid,
          normalizedFilter
            ? `No Cursor models matched "${filterText.trim()}".`
            : 'Cursor Cloud returned no models for this account right now. Job control can still work without `/cursor_models` if you omit `--model` and let Cursor use its default.',
        );
        return;
      }

      const capped = matches.slice(0, 30);
      const lines = capped.map((model, index) => {
        const label = model.name && model.name !== model.id ? model.name : null;
        return `${index + 1}. ${model.id}${label ? ` (${label})` : ''}`;
      });
      const truncated =
        matches.length > capped.length
          ? `\n\nShowing ${capped.length} of ${matches.length} models. Narrow with /cursor-models FILTER.`
          : '';

      await channel.sendMessage(
        chatJid,
        `Cursor models:\n\n${lines.join('\n')}${truncated}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure('Cursor model list failed', err),
      );
    }
  }

  async function handleCursorCreate(
    chatJid: string,
    promptText: string,
    requestedBy?: string,
    options: {
      model?: string;
      sourceRepository?: string;
      sourceRef?: string;
      sourcePrUrl?: string;
      branchName?: string;
      autoCreatePr?: boolean;
      openAsCursorGithubApp?: boolean;
      skipReviewerRequest?: boolean;
    } = {},
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
        model: options.model,
        sourceRepository: options.sourceRepository,
        sourceRef: options.sourceRef,
        sourcePrUrl: options.sourcePrUrl,
        branchName: options.branchName,
        autoCreatePr: options.autoCreatePr,
        openAsCursorGithubApp: options.openAsCursorGithubApp,
        skipReviewerRequest: options.skipReviewerRequest,
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
          `Created ${labelCursorRecord(created)} ${created.id} (status: ${created.status}).`,
          targetBits || null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure('Cursor create failed', err),
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

    let normalizedAgentId: string;
    try {
      normalizedAgentId = normalizeCursorAgentId(agentId);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure('Cursor conversation fetch failed', err),
      );
      return;
    }

    try {
      const messages = await getCursorAgentConversation({
        groupFolder: group.folder,
        chatJid,
        agentId: normalizedAgentId,
        limit,
      });
      if (messages.length === 0) {
        await channel.sendMessage(
          chatJid,
          `No conversation messages are available yet for ${normalizedAgentId}.`,
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
        `${labelCursorRecord(normalizedAgentId)} conversation for ${normalizedAgentId} (latest ${messages.length}):\n\n${formatted}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor conversation fetch failed for ${normalizedAgentId}`,
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

    let normalizedAgentId: string;
    try {
      normalizedAgentId = normalizeCursorAgentId(agentId);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure('Cursor artifacts lookup failed', err),
      );
      return;
    }
    try {
      const artifacts = await getCursorAgentArtifacts({
        groupFolder: group.folder,
        chatJid,
        agentId: normalizedAgentId,
      });

      if (artifacts.length === 0) {
        await channel.sendMessage(
          chatJid,
          `Cursor Cloud job ${normalizedAgentId} has no tracked artifacts yet.`,
        );
        return;
      }

      const lines = artifacts.map(
        (artifact, index) =>
          `${index + 1}. ${artifact.absolutePath} (${artifact.sizeBytes ?? 'unknown'} bytes)${artifact.updatedAt ? ` updated=${artifact.updatedAt}` : ''}`,
      );

      await channel.sendMessage(
        chatJid,
        `Cursor Cloud artifacts for ${normalizedAgentId}:\n\n${lines.join('\n')}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor artifacts lookup failed for ${normalizedAgentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorArtifactLink(
    chatJid: string,
    agentId: string,
    absolutePath: string,
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
      const link = await getCursorArtifactDownloadLink({
        groupFolder: group.folder,
        chatJid,
        agentId,
        absolutePath,
      });
      const expiry = link.expiresAt ? `\nExpires: ${link.expiresAt}` : '';
      await channel.sendMessage(
        chatJid,
        `Artifact link for ${link.agentId}\nPath: ${link.absolutePath}\nURL: ${link.url}${expiry}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor artifact link failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorTerminal(
    chatJid: string,
    agentId: string,
    commandText: string,
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
      const started = await runCursorTerminalCommand({
        groupFolder: group.folder,
        chatJid,
        agentId,
        commandText,
      });
      const lines = [
        `Started desktop bridge terminal command ${started.commandId}.`,
        formatCursorTerminalStatusMessage(agentId, started.terminal),
        'Recent output:',
        formatCursorTerminalOutputSection(started.output),
        'Use /cursor-terminal-status or /cursor-terminal-log for follow-up.',
      ];
      await channel.sendMessage(chatJid, lines.join('\n\n'));
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal command failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorTerminalStatus(
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
      const terminal = await getCursorTerminalStatus({
        groupFolder: group.folder,
        chatJid,
        agentId,
      });
      await channel.sendMessage(
        chatJid,
        formatCursorTerminalStatusMessage(agentId, terminal),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal status failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorTerminalLog(
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
      const [terminal, output] = await Promise.all([
        getCursorTerminalStatus({
          groupFolder: group.folder,
          chatJid,
          agentId,
        }),
        getCursorTerminalOutput({
          groupFolder: group.folder,
          chatJid,
          agentId,
          limit,
        }),
      ]);
      await channel.sendMessage(
        chatJid,
        [
          formatCursorTerminalStatusMessage(agentId, terminal),
          'Recent output:',
          formatCursorTerminalOutputSection(output),
        ].join('\n\n'),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal log failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  async function handleCursorTerminalStop(
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
      const terminal = await stopCursorTerminal({
        groupFolder: group.folder,
        chatJid,
        agentId,
      });
      await channel.sendMessage(
        chatJid,
        `Stopped desktop bridge terminal command for ${agentId}.\n\n${formatCursorTerminalStatusMessage(agentId, terminal)}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal stop failed for ${agentId}`,
          err,
        ),
      );
    }
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
        `Synced ${labelCursorRecord(synced.agent)} ${synced.agent.id}. Status: ${synced.agent.status}. Artifacts: ${synced.artifacts.length}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(`Cursor sync failed for ${agentId}`, err),
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
        `Stop requested for ${labelCursorRecord(stopped)} ${stopped.id}. Current status: ${stopped.status}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(`Cursor stop failed for ${agentId}`, err),
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
        `Follow-up sent to ${labelCursorRecord(followed)} ${followed.id}. Status: ${followed.status}.`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor follow-up failed for ${agentId}`,
          err,
        ),
      );
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const rawTrimmed = msg.content.trim();
      const trimmed = rawTrimmed.toLowerCase();
      const rawCommandToken = trimmed.split(/\s+/)[0] || '';
      const commandToken = normalizeCommandToken(rawCommandToken);

      const allowlistCfg = loadSenderAllowlist();
      if (
        shouldDropIncomingMessageBeforeCommands(
          chatJid,
          msg,
          allowlistCfg,
          Boolean(registeredGroups[chatJid]),
        )
      ) {
        if (allowlistCfg.logDenied) {
          logger.debug(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message before command handling',
          );
        }
        return;
      }

      // Remote control commands — intercept before storage
      if (CURSOR_STATUS_COMMANDS.has(commandToken)) {
        handleCursorStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor status command error'),
        );
        return;
      }

      const commandAccess = getCommandAccessDecision(
        commandToken,
        registeredGroups[chatJid],
      );
      if (!commandAccess.allowed) {
        const channel = findChannel(channels, chatJid);
        if (channel && commandAccess.message) {
          channel
            .sendMessage(chatJid, commandAccess.message)
            .catch((err) =>
              logger.error(
                { err, chatJid, commandToken },
                'Operator command gate reply failed',
              ),
            );
        }
        logger.info(
          {
            chatJid,
            commandToken,
            reason: commandAccess.reason,
            isMain: registeredGroups[chatJid]?.isMain === true,
          },
          'Blocked command outside allowed surface',
        );
        return;
      }

      if (RUNTIME_STATUS_COMMANDS.has(commandToken)) {
        handleRuntimeStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Runtime status command error'),
        );
        return;
      }

      if (RUNTIME_CREATE_COMMANDS.has(commandToken)) {
        const promptText = tokenizeCommandArguments(rawTrimmed)
          .slice(1)
          .join(' ')
          .trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, RUNTIME_CREATE_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Runtime create usage send failed',
              ),
            );
          return;
        }

        handleRuntimeCreate(chatJid, promptText, msg.sender).catch((err) =>
          logger.error({ err, chatJid }, 'Runtime create command error'),
        );
        return;
      }

      if (RUNTIME_JOBS_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const parsedLimit = Number.parseInt(parts[1] || '', 10);
        const limit =
          Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(100, parsedLimit)
            : 20;
        const beforeJobId =
          Number.isFinite(parsedLimit) && parsedLimit > 0 ? parts[2] : parts[1];
        handleRuntimeJobs(chatJid, limit, beforeJobId || undefined).catch(
          (err) => logger.error({ err, chatJid }, 'Runtime jobs command error'),
        );
        return;
      }

      if (RUNTIME_JOB_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const resolution = resolveRuntimeJobTarget(
          parts[1],
          getCurrentRuntimeSelection(
            chatJid,
            registeredGroups[chatJid]?.folder || '',
          ),
        );
        if (!resolution.jobId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              parts[1]
                ? RUNTIME_JOB_USAGE
                : buildRuntimeSelectionMissingMessage('view'),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Runtime job usage send failed'),
            );
          return;
        }

        handleRuntimeJob(chatJid, resolution.jobId, resolution.usedSelection).catch((err) =>
          logger.error({ err, chatJid }, 'Runtime job command error'),
        );
        return;
      }

      if (RUNTIME_FOLLOWUP_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const jobId = parts[1];
        const promptText = parts.slice(2).join(' ').trim();
        if (!jobId || !promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, RUNTIME_FOLLOWUP_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Runtime followup usage send failed',
              ),
            );
          return;
        }

        handleRuntimeFollowup(chatJid, jobId, promptText, msg.sender).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Runtime followup command error'),
        );
        return;
      }

      if (RUNTIME_STOP_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const resolution = resolveRuntimeJobTarget(
          parts[1],
          getCurrentRuntimeSelection(
            chatJid,
            registeredGroups[chatJid]?.folder || '',
          ),
        );
        if (!resolution.jobId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              parts[1]
                ? RUNTIME_STOP_USAGE
                : buildRuntimeSelectionMissingMessage('stop'),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Runtime stop usage send failed'),
            );
          return;
        }

        handleRuntimeStop(
          chatJid,
          resolution.jobId,
          msg.sender,
          resolution.usedSelection,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Runtime stop command error'),
        );
        return;
      }

      if (RUNTIME_LOGS_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const resolution = resolveRuntimeLogsTarget(
          parts[1],
          parts[2],
          getCurrentRuntimeSelection(
            chatJid,
            registeredGroups[chatJid]?.folder || '',
          ),
        );
        if (!resolution.jobId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              parts[1]
                ? RUNTIME_LOGS_USAGE
                : buildRuntimeSelectionMissingMessage('logs'),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Runtime logs usage send failed'),
            );
          return;
        }

        handleRuntimeLogs(
          chatJid,
          resolution.jobId,
          resolution.limit,
          resolution.usedSelection,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Runtime logs command error'),
        );
        return;
      }

      if (CURSOR_MODELS_COMMANDS.has(commandToken)) {
        const args = tokenizeCommandArguments(rawTrimmed);
        const filterText = args.slice(1).join(' ').trim();
        handleCursorModels(chatJid, filterText).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor models command error'),
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
        const parsed = parseCursorCreateCommand(rawTrimmed);
        if (parsed.errors.length > 0) {
          const channel = findChannel(channels, chatJid);
          const detail = parsed.errors.map((err) => `- ${err}`).join('\n');
          channel
            ?.sendMessage(chatJid, `${CURSOR_CREATE_USAGE}\n\n${detail}`)
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor create usage send failed'),
            );
          return;
        }

        handleCursorCreate(chatJid, parsed.promptText, msg.sender, {
          model: parsed.model,
          sourceRepository: parsed.sourceRepository,
          sourceRef: parsed.sourceRef,
          sourcePrUrl: parsed.sourcePrUrl,
          branchName: parsed.branchName,
          autoCreatePr: parsed.autoCreatePr,
          openAsCursorGithubApp: parsed.openAsCursorGithubApp,
          skipReviewerRequest: parsed.skipReviewerRequest,
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor create command error'),
        );
        return;
      }

      if (CURSOR_SYNC_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor-sync AGENT_ID')
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
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor-stop AGENT_ID')
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
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /cursor-conversation AGENT_ID [LIMIT]',
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
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor-artifacts AGENT_ID')
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

      if (CURSOR_ARTIFACT_LINK_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        const absolutePath = parts.slice(2).join(' ').trim();
        if (!agentId || !absolutePath) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, CURSOR_ARTIFACT_LINK_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor artifact link usage send failed',
              ),
            );
          return;
        }

        handleCursorArtifactLink(chatJid, agentId, absolutePath).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor artifact link command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_COMMANDS.has(commandToken)) {
        const terminalMatch = rawTrimmed.match(/^\/\S+\s+(\S+)\s+([\s\S]+)$/);
        const agentId = terminalMatch?.[1];
        const commandText = terminalMatch?.[2]?.trim() || '';
        if (!agentId || !commandText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, CURSOR_TERMINAL_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal usage send failed',
              ),
            );
          return;
        }

        handleCursorTerminal(chatJid, agentId, commandText).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STATUS_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, CURSOR_TERMINAL_STATUS_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal status usage send failed',
              ),
            );
          return;
        }

        handleCursorTerminalStatus(chatJid, agentId).catch((err) =>
          logger.error(
            { err, chatJid },
            'Cursor terminal status command error',
          ),
        );
        return;
      }

      if (CURSOR_TERMINAL_LOG_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, CURSOR_TERMINAL_LOG_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal log usage send failed',
              ),
            );
          return;
        }

        const parsedLimit = Number.parseInt(parts[2] || '', 10);
        const limit =
          Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(200, parsedLimit)
            : 40;

        handleCursorTerminalLog(chatJid, agentId, limit).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal log command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STOP_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, CURSOR_TERMINAL_STOP_USAGE)
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal stop usage send failed',
              ),
            );
          return;
        }

        handleCursorTerminalStop(chatJid, agentId).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal stop command error'),
        );
        return;
      }

      if (CURSOR_FOLLOWUP_COMMANDS.has(commandToken)) {
        const parts = tokenizeCommandArguments(rawTrimmed);
        const agentId = parts[1];
        if (!agentId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor-followup AGENT_ID TEXT')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor followup usage send failed',
              ),
            );
          return;
        }

        const promptText = parts.slice(2).join(' ').trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /cursor-followup AGENT_ID TEXT')
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

      if (AMAZON_STATUS_COMMANDS.has(commandToken)) {
        handleAmazonStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon status command error'),
        );
        return;
      }

      if (ALEXA_STATUS_COMMANDS.has(commandToken)) {
        handleAlexaStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Alexa status command error'),
        );
        return;
      }

      if (AMAZON_SEARCH_COMMANDS.has(commandToken)) {
        const query = rawTrimmed.split(/\s+/).slice(1).join(' ').trim();
        if (!query) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /amazon_search <keywords>')
            .catch((err) =>
              logger.error({ err, chatJid }, 'Amazon search usage send failed'),
            );
          return;
        }

        handleAmazonSearch(chatJid, query).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon search command error'),
        );
        return;
      }

      if (PURCHASE_REQUEST_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const asin = parts[1];
        const offerId = parts[2];
        const parsedQuantity = Number.parseInt(parts[3] || '', 10);
        const quantity =
          Number.isFinite(parsedQuantity) && parsedQuantity > 0
            ? Math.min(999, parsedQuantity)
            : 1;

        if (!asin || !offerId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /purchase_request <asin> <offer_id> [quantity]',
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase request usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseRequest(
          chatJid,
          asin,
          offerId,
          quantity,
          msg.sender,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase request error'),
        );
        return;
      }

      if (PURCHASE_REQUESTS_COMMANDS.has(commandToken)) {
        handleAmazonPurchaseRequests(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase list command error'),
        );
        return;
      }

      if (PURCHASE_APPROVE_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const requestId = parts[1];
        const approvalCode = parts[2];
        if (!requestId || !approvalCode) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /purchase_approve <request_id> <approval_code>',
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase approve usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseApprove(
          chatJid,
          requestId,
          approvalCode,
          msg.sender,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase approve error'),
        );
        return;
      }

      if (PURCHASE_CANCEL_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const requestId = parts[1];
        if (!requestId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /purchase_cancel <request_id>')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase cancel usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseCancel(chatJid, requestId).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase cancel error'),
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

      try {
        if (await maybeHandleRuntimeReplyContext(chatJid, msg)) {
          return;
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Runtime reply-context routing error');
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
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
  try {
    alexaRuntime = await startAlexaServer();
  } catch (err) {
    logger.error({ err }, 'Alexa voice ingress failed to start');
  }

  const hasAlexaIngress = alexaRuntime?.getStatus().running === true;
  if (channels.length === 0 && !hasAlexaIngress) {
    logger.fatal('No channels connected and Alexa voice ingress is not running');
    process.exit(1);
  }
  if (channels.length === 0 && hasAlexaIngress) {
    logger.info('No chat channels connected; Alexa voice ingress is serving locally');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getAgentThreads: () => agentThreads,
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
    onTasksChanged: () => refreshTaskSnapshots(registeredGroups),
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
    searchAmazonProducts,
    createAmazonPurchaseRequest,
    approveAmazonPurchaseRequest,
    cancelAmazonPurchaseRequest,
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
