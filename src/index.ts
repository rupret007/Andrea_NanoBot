import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
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
  CONTAINER_RUNTIME_NAME,
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  getContainerRuntimeStatus,
} from './container-runtime.js';
import {
  createTask,
  getAllAgentThreads,
  getAllChats,
  getAgentThread,
  listAllCursorAgents,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  listCursorAgentArtifacts,
  listRuntimeOrchestrationJobs,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  listAllEnabledCommunitySkills,
  setRegisteredGroup,
  setAgentThread,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
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
import { formatBackendOperationFailure } from './backend-lane-errors.js';
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
  Channel,
  NewMessage,
  RegisteredGroup,
  SendMessageOptions,
} from './types.js';
import { logger } from './logger.js';
import {
  formatDebugStatus,
  loadLogControlFromPersistence,
  readDebugLogs,
  refreshLogControlFromPersistence,
  resetDebugLevel,
  setDebugLevel,
  startLogControlAutoRefresh,
} from './debug-control.js';
import {
  disableOpenClawSkill,
  enableOpenClawSkill,
  installOpenClawSkill,
} from './openclaw-market.js';
import { classifyAssistantRequest } from './assistant-routing.js';
import {
  analyzeAgentError,
  buildRepeatedAgentErrorMessage,
} from './agent-error.js';
import { listCursorModels, type CursorAgentView } from './cursor-jobs.js';
import {
  formatAgentRuntimeStatusMessage,
  getAgentRuntimeStatusSnapshot,
} from './andrea-runtime/agent-runtime.js';
import {
  buildRuntimeJobInlineActions,
  dispatchRuntimeCommand,
  formatRuntimeJobCard,
  formatRuntimeNextStep,
} from './andrea-runtime/commands.js';
import { createRuntimeOrchestrationService } from './andrea-runtime/orchestration.js';
import { createBackendLaneRegistry } from './backend-lanes/registry.js';
import {
  createAndreaRuntimeBackendLane,
  type AndreaRuntimeBackendLane,
} from './backend-lanes/andrea-runtime-lane.js';
import { createCursorBackendLane } from './backend-lanes/cursor-lane.js';
import type {
  BackendJobDetails,
  BackendJobHandle,
  BackendJobSummary,
} from './backend-lanes/types.js';
import {
  parseCursorCreateCommand,
  tokenizeCommandArguments,
} from './cursor-command-parser.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';
import { resolveEffectiveIdleTimeout } from './runtime-timeout.js';
import {
  maybeBuildDirectQuickReply,
  maybeBuildDirectRescueReply,
} from './direct-quick-reply.js';
import {
  decideMainChatRouting,
  shouldAvoidCombinedContextForMainChat,
  type MainChatSessionState,
} from './main-chat-routing.js';
import { buildSilentSuccessFallback } from './user-facing-fallback.js';
import {
  buildCursorJobCardActions,
  flattenCursorJobInventory,
  formatCursorJobCard,
  type FlattenedCursorJobEntry,
  getActiveCursorOperatorContext,
  getActiveCursorMessageContext,
  getBackendContextGuidance,
  getCursorContextGuidance,
  getSelectedLaneJobId,
  looksLikeCursorTargetToken,
  rememberCursorDashboardMessage,
  rememberCursorJobList,
  rememberCursorMessageContext,
  rememberCursorOperatorSelection,
  resolveBackendTarget,
  resolveCursorTarget,
} from './cursor-operator-context.js';
import {
  buildCursorDashboardCurrentJob,
  buildCursorDashboardCurrentJobEmpty,
  buildCursorDashboardDesktop,
  buildCursorDashboardHelp,
  buildCursorDashboardHome,
  buildCursorDashboardJobs,
  buildCursorDashboardRuntime,
  buildCursorDashboardRuntimeCurrent,
  buildCursorDashboardRuntimeCurrentEmpty,
  buildCursorDashboardRuntimeJobs,
  buildCursorDashboardStatus,
  buildCursorDashboardWizardConfirm,
  buildCursorDashboardWizardPrompt,
  buildCursorDashboardWizardRepo,
  CURSOR_DASHBOARD_EXPIRED_MESSAGE,
  CURSOR_DASHBOARD_PAGE_SIZE,
  formatCursorDashboardState,
  parseCursorDashboardState,
  type CursorDashboardState,
} from './cursor-dashboard.js';
import {
  formatHumanTaskStatus,
  formatOpaqueTaskId,
  formatTaskNextStepMessage,
  formatTaskReplyPrompt,
} from './task-presentation.js';
import {
  buildTaskOutputSuggestion,
  getTaskContextType,
  interpretTaskContinuation,
  maybeBuildHarmlessTaskReply,
  mergeTaskMessageContextPayload,
  summarizeVisibleTaskText,
  type TaskContextType,
} from './task-continuation.js';
import {
  ALEXA_STATUS_COMMANDS,
  AMAZON_SEARCH_COMMANDS,
  AMAZON_STATUS_COMMANDS,
  CURSOR_ARTIFACTS_COMMANDS,
  CURSOR_ARTIFACT_LINK_COMMANDS,
  CURSOR_CONVERSATION_COMMANDS,
  CURSOR_CREATE_COMMANDS,
  CURSOR_DASHBOARD_COMMANDS,
  CURSOR_FOLLOWUP_COMMANDS,
  CURSOR_JOBS_COMMANDS,
  CURSOR_MODELS_COMMANDS,
  CURSOR_SELECT_COMMANDS,
  CURSOR_STOP_COMMANDS,
  CURSOR_SYNC_COMMANDS,
  CURSOR_TERMINAL_COMMANDS,
  CURSOR_TERMINAL_HELP_COMMANDS,
  CURSOR_TERMINAL_LOG_COMMANDS,
  CURSOR_TERMINAL_STATUS_COMMANDS,
  CURSOR_TERMINAL_STOP_COMMANDS,
  CURSOR_TEST_COMMANDS,
  CURSOR_UI_COMMANDS,
  DEBUG_LEVEL_COMMANDS,
  DEBUG_LOGS_COMMANDS,
  DEBUG_RESET_COMMANDS,
  DEBUG_STATUS_COMMANDS,
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
  getCommandAccessDecision,
  normalizeCommandToken,
  PURCHASE_APPROVE_COMMANDS,
  PURCHASE_CANCEL_COMMANDS,
  PURCHASE_REQUEST_COMMANDS,
  PURCHASE_REQUESTS_COMMANDS,
  REMOTE_CONTROL_START_COMMANDS,
  REMOTE_CONTROL_STOP_COMMANDS,
} from './operator-command-gate.js';

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
const backendLaneRegistry = createBackendLaneRegistry();
const cursorBackendLane = createCursorBackendLane();
const andreaRuntimeExecutionEnabled =
  (process.env.ANDREA_RUNTIME_EXECUTION_ENABLED || '').toLowerCase() === 'true';
const andreaRuntimeService = createRuntimeOrchestrationService({
  assistantName: ASSISTANT_NAME,
  enqueueJob(groupJid, jobId, fn) {
    queue.enqueueTask(groupJid, jobId, fn);
  },
  getAvailableGroups() {
    return getAvailableGroups();
  },
  getRegisteredGroupJids() {
    return new Set(Object.keys(registeredGroups));
  },
  getRuntimeJobs() {
    return queue.getRuntimeJobs();
  },
  getSession(groupFolder) {
    return sessions[groupFolder];
  },
  getStoredThread(groupFolder) {
    return getAgentThread(groupFolder);
  },
  notifyIdle(groupJid) {
    queue.notifyIdle(groupJid);
  },
  persistAgentThread(groupFolder, threadId, runtime) {
    sessions[groupFolder] = threadId;
    setAgentThread({
      group_folder: groupFolder,
      runtime,
      thread_id: threadId,
      last_response_id: threadId,
      updated_at: new Date().toISOString(),
    });
  },
  refreshTaskSnapshots() {
    refreshTaskSnapshots(registeredGroups);
  },
  registerProcess(groupJid, proc, containerName, groupFolder) {
    queue.registerProcess(groupJid, proc, containerName, groupFolder);
  },
  requestStop(groupJid) {
    return queue.requestStop(groupJid);
  },
  resolveGroupByFolder(folder) {
    const entry = Object.entries(registeredGroups).find(
      ([, group]) => group.folder === folder,
    );
    if (!entry) return null;
    const [jid, group] = entry;
    return { jid, group };
  },
  runContainerAgent,
  writeGroupsSnapshot,
});
const andreaRuntimeBackendLane =
  createAndreaRuntimeBackendLane(andreaRuntimeService);

backendLaneRegistry.register(cursorBackendLane);
backendLaneRegistry.register(andreaRuntimeBackendLane);

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

function buildAndreaRuntimeDisabledMessage(): string {
  return [
    "Andrea's Codex/OpenAI runtime lane is integrated, but execution is still turned off on this host.",
    'Keep using /cursor as the main operator shell today. You can still review existing runtime work where it is available.',
    'Enable ANDREA_RUNTIME_EXECUTION_ENABLED=true only after validating the Codex/OpenAI runtime container and credentials on this machine.',
  ].join('\n');
}

function buildAndreaRuntimeStatusMessage(): string {
  const snapshot = getAgentRuntimeStatusSnapshot({
    activeThreads: getAllAgentThreads(),
    activeJobs: listRuntimeOrchestrationJobs({ limit: 100 }).jobs.filter(
      (job) => job.status === 'queued' || job.status === 'running',
    ).length,
    containerRuntimeName: CONTAINER_RUNTIME_NAME,
    containerRuntimeStatus: getContainerRuntimeStatus(CONTAINER_RUNTIME_NAME),
  });

  return [
    formatAgentRuntimeStatusMessage(snapshot),
    '',
    `- Runtime execution enabled on this host: ${andreaRuntimeExecutionEnabled ? 'yes' : 'no'}`,
    "- This is Andrea's integrated Codex/OpenAI runtime lane inside the same shell.",
    '- /cursor is still the cleaner operator surface today. Use /runtime-* only when you want explicit runtime controls.',
  ].join('\n');
}

function getAndreaRuntimeLane(): AndreaRuntimeBackendLane {
  return backendLaneRegistry.get('andrea_runtime') as AndreaRuntimeBackendLane;
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

function getMainChatSessionState(chatJid: string): MainChatSessionState {
  const snapshot = queue
    .getRuntimeJobs()
    .find((job) => job.groupJid === chatJid && job.active);
  if (!snapshot) return 'inactive';
  if (snapshot.isTaskContainer) return 'task_container';
  return snapshot.idleWaiting ? 'idle_assistant' : 'busy_assistant';
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
  const requestPolicy = classifyAssistantRequest(missedMessages, {
    allowCombinedContext:
      !isMainGroup || !shouldAvoidCombinedContextForMainChat(missedMessages),
  });

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      component: 'assistant',
      chatJid,
      groupFolder: group.folder,
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
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            requestRoute: requestPolicy.route,
          },
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
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            taskId: plannedReminder.task.id,
          },
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
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
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
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
        },
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
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            outputChars: raw.length,
            requestRoute: requestPolicy.route,
          },
          'Agent output chunk received',
        );
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
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
        },
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
      } else if (!shouldNotify) {
        await channel.sendMessage(
          chatJid,
          buildRepeatedAgentErrorMessage(output.code),
        );
      }

      lastNonRetriableErrorNotice[chatJid] = {
        code: output.code,
        at: now,
      };

      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          code: output.code,
          notified: shouldNotify,
        },
        'Non-retriable agent error detected, skipping retry loop',
      );

      return true;
    }

    if (
      output.status === 'error' &&
      requestPolicy.route === 'direct_assistant' &&
      output.userMessage
    ) {
      await channel.sendMessage(chatJid, output.userMessage);
      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          code: output.code,
          recoveryAttempted: output.recoveryAttempted,
        },
        'Surfaced direct assistant runtime failure to user without queue retry',
      );
      return true;
    }

    if (requestPolicy.route === 'direct_assistant') {
      const rescueReply = maybeBuildDirectRescueReply(missedMessages);
      if (rescueReply) {
        await channel.sendMessage(chatJid, rescueReply);
        logger.warn(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
          },
          'Recovered direct assistant error with local rescue reply',
        );
        return true;
      }
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
      },
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
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        route: requestPolicy.route,
      },
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
    | 'initial_output_timeout'
    | 'runtime_bootstrap_failed'
    | 'container_runtime_unavailable'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  nonRetriable: boolean;
  userMessage: string | null;
  recoveryAttempted: boolean;
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
        idleTimeoutMs,
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
      const analysis = analyzeAgentError(output);
      logger.error(
        {
          group: group.name,
          error: output.error,
          failureKind: output.failureKind,
          failureStage: output.failureStage,
          diagnosticHint: output.diagnosticHint,
          logFile: output.logFile,
          recoveryAttempted: output.recoveryAttempted,
          sawLifecycleOnlyOutput: output.sawLifecycleOnlyOutput,
          firstResultSubtype: output.firstResultSubtype,
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
        recoveryAttempted: output.recoveryAttempted === true,
      };
    }

    return {
      status: 'success',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
      recoveryAttempted: output.recoveryAttempted === true,
    };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
      recoveryAttempted: false,
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
          const sessionState = getMainChatSessionState(chatJid);
          const localQuickReply =
            groupMessages.length === 1
              ? maybeBuildDirectQuickReply(groupMessages)
              : null;
          const mainChatRoutingDecision = decideMainChatRouting({
            isMainGroup,
            messages: groupMessages,
            sessionState,
            localQuickReply,
          });

          if (mainChatRoutingDecision.kind === 'reply_locally') {
            try {
              await channel.sendMessage(
                chatJid,
                mainChatRoutingDecision.replyText,
              );
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              logger.info(
                { chatJid, sessionState },
                'Handled standalone main-chat message locally while work session stayed intact',
              );
            } catch (err) {
              logger.warn(
                { chatJid, err },
                'Local main-chat reply failed, deferring to standard processing',
              );
              queue.enqueueMessageCheck(chatJid);
              if (sessionState === 'idle_assistant') {
                queue.closeStdin(chatJid);
              }
            }
            continue;
          }

          if (mainChatRoutingDecision.kind === 'process_fresh_turn_now') {
            queue.enqueueMessageCheck(chatJid);
            if (sessionState === 'idle_assistant') {
              queue.closeStdin(chatJid);
            }
            logger.debug(
              { chatJid, sessionState },
              'Queued standalone main-chat turn for fresh processing',
            );
            continue;
          }

          if (mainChatRoutingDecision.kind === 'queue_fresh_turn_after_work') {
            queue.enqueueMessageCheck(chatJid);
            logger.debug(
              { chatJid, sessionState },
              'Queued standalone main-chat turn behind active work',
            );
            continue;
          }

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
  loadLogControlFromPersistence();
  startLogControlAutoRefresh();
  logger.info({ component: 'assistant' }, 'Database initialized');
  loadState();

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

  const CURSOR_STATUS_COMMANDS = new Set(['/cursor-status', '/cursor_status']);
  const CURSOR_CREATE_USAGE =
    'Usage: /cursor-create [--model MODEL_ID] [--repo REPO_URL] [--ref GIT_REF] [--pr PR_URL] [--branch BRANCH_NAME] [--auto-pr] [--cursor-github-app] [--skip-reviewer] PROMPT';
  const CURSOR_DOWNLOAD_USAGE =
    'Usage: /cursor-download [AGENT_ID|LIST_NUMBER|current] ABSOLUTE_PATH';
  const CURSOR_TERMINAL_USAGE =
    'Usage: /cursor-terminal [AGENT_ID|LIST_NUMBER|current] COMMAND';
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
    if (provider === 'cloud') return 'Cursor Cloud task';
    return 'Cursor task';
  }

  function isDesktopCursorRecord(
    record:
      | {
          provider?: 'cloud' | 'desktop';
          id: string;
        }
      | string,
  ): boolean {
    if (typeof record !== 'string' && record.provider) {
      return record.provider === 'desktop';
    }
    const id = typeof record === 'string' ? record : record.id;
    return /^desk_/i.test(id);
  }

  function buildCursorNextStepMessage(
    record:
      | {
          provider?: 'cloud' | 'desktop';
          id: string;
        }
      | string,
  ): string {
    if (isDesktopCursorRecord(record)) {
      return formatTaskNextStepMessage({
        primaryActions: 'Use this card to refresh the session or view output.',
        explicitFallback:
          '`/cursor-terminal` and `/cursor-terminal-log` still work as explicit fallbacks when you need machine-side control.',
      });
    }

    return formatTaskNextStepMessage({
      primaryActions:
        'Use this card to refresh the task, view output, or check results.',
      canReplyContinue: true,
      explicitFallback:
        'Slash commands still work if you want an explicit fallback.',
    });
  }

  function buildCursorTaskContextPayload(params: {
    agentId: string;
    provider: 'cloud' | 'desktop';
    contextType: TaskContextType;
    summary?: string | null;
    outputPreview?: string | null;
    outputSource?: string | null;
  }): Record<string, unknown> | null {
    return mergeTaskMessageContextPayload(
      { provider: params.provider },
      {
        taskContextType: params.contextType,
        taskTitle: `${labelCursorRecord({
          provider: params.provider,
          id: params.agentId,
        })} ${formatOpaqueTaskId(params.agentId)}`,
        taskSummary: summarizeVisibleTaskText(params.summary),
        outputPreview: summarizeVisibleTaskText(params.outputPreview),
        outputSource: params.outputSource || null,
      },
    );
  }

  function toCursorHandle(jobId: string): BackendJobHandle {
    return { laneId: 'cursor', jobId };
  }

  function getOperatorReplyToMessageId(
    message: NewMessage | undefined,
  ): string | undefined {
    if (!message) return undefined;
    if (message.reply_to_id) return message.reply_to_id;
    return /^\d+$/.test(message.id) ? message.id : undefined;
  }

  function buildOperatorSendOptions(
    message?: NewMessage,
    extra: Partial<SendMessageOptions> = {},
  ): SendMessageOptions {
    const replyToMessageId =
      extra.replyToMessageId || getOperatorReplyToMessageId(message);

    return {
      ...(message?.thread_id ? { threadId: message.thread_id } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...extra,
    };
  }

  async function sendCursorMessage(
    chatJid: string,
    text: string,
    message?: NewMessage,
    extra: Partial<SendMessageOptions> = {},
  ): Promise<string | undefined> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return undefined;
    const sent = await channel.sendMessage(
      chatJid,
      text,
      buildOperatorSendOptions(message, extra),
    );
    return sent.platformMessageId;
  }

  function buildDebugUpdatedBy(chatJid: string, message?: NewMessage): string {
    if (message?.sender) {
      return `telegram:${message.sender}`;
    }
    return `telegram:${chatJid}`;
  }

  function getActiveRuntimeSnapshot(chatJid: string) {
    return queue
      .getRuntimeJobs()
      .find((job) => job.groupJid === chatJid && job.active);
  }

  async function handleDebugStatus(
    chatJid: string,
    message?: NewMessage,
  ): Promise<void> {
    refreshLogControlFromPersistence();
    await sendCursorMessage(chatJid, formatDebugStatus(), message);
  }

  async function handleDebugLevel(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    const args = rawTrimmed.split(/\s+/).slice(1);
    const levelToken = args[0];
    if (!levelToken) {
      await sendCursorMessage(
        chatJid,
        'Usage: /debug-level <normal|debug|verbose> [scope] [duration]',
        message,
      );
      return;
    }

    try {
      const result = setDebugLevel({
        level: levelToken,
        scopeToken: args[1],
        durationToken: args[2],
        updatedBy: buildDebugUpdatedBy(chatJid, message),
        chatJid,
      });

      const aliasLabel =
        result.level === 'trace'
          ? 'verbose'
          : result.level === 'debug'
            ? 'debug'
            : 'normal';
      await sendCursorMessage(
        chatJid,
        [
          '*Debug Level Updated*',
          `- Scope: ${result.resolvedScope.label}`,
          `- Level: ${aliasLabel}`,
          `- Expires: ${result.expiresAt || 'persistent'}`,
        ].join('\n'),
        message,
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function handleDebugReset(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    try {
      const scopeToken = rawTrimmed.split(/\s+/).slice(1).join(' ').trim();
      const result = resetDebugLevel({
        scopeToken: scopeToken || 'chat',
        updatedBy: buildDebugUpdatedBy(chatJid, message),
        chatJid,
      });

      await sendCursorMessage(
        chatJid,
        `Debug logging reset for ${result.resetScope}.`,
        message,
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function handleDebugLogs(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    try {
      refreshLogControlFromPersistence();
      const args = rawTrimmed.split(/\s+/).slice(1);
      const target = args[0] || 'service';
      const parsedLines = Number.parseInt(args[1] || '', 10);
      const runtimeSnapshot = getActiveRuntimeSnapshot(chatJid);
      const logPayload = readDebugLogs({
        target,
        lines: Number.isFinite(parsedLines) ? parsedLines : 80,
        chatJid,
        groupFolder: registeredGroups[chatJid]?.folder,
        containerName: runtimeSnapshot?.containerName || null,
      });

      await sendCursorMessage(
        chatJid,
        `Debug Logs: ${logPayload.title}\n${logPayload.body}`,
        message,
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function sendBackendJobMessage(params: {
    chatJid: string;
    text: string;
    laneId: 'cursor' | 'andrea_runtime';
    jobId: string;
    sourceMessage?: NewMessage;
    contextKind: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    const platformMessageId = await sendCursorMessage(
      params.chatJid,
      params.text,
      params.sourceMessage,
      {
        replyToMessageId: params.replyToMessageId,
        inlineActions: params.inlineActions,
      },
    );
    if (platformMessageId) {
      rememberCursorMessageContext({
        chatJid: params.chatJid,
        platformMessageId,
        threadId: params.sourceMessage?.thread_id,
        contextKind: params.contextKind,
        laneId: params.laneId,
        agentId: params.jobId,
        payload: params.payload || null,
      });
    }
    rememberCursorOperatorSelection({
      chatJid: params.chatJid,
      threadId: params.sourceMessage?.thread_id,
      laneId: params.laneId,
      agentId: params.jobId,
    });
    return platformMessageId;
  }

  async function sendCursorAgentMessage(params: {
    chatJid: string;
    text: string;
    agentId: string;
    provider?: 'cloud' | 'desktop';
    sourceMessage?: NewMessage;
    contextKind: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    const mergedPayload = mergeTaskMessageContextPayload(
      params.provider ? { provider: params.provider } : null,
      (params.payload || {}) as Record<string, unknown>,
    );
    return sendBackendJobMessage({
      chatJid: params.chatJid,
      text: params.text,
      laneId: 'cursor',
      jobId: params.agentId,
      sourceMessage: params.sourceMessage,
      contextKind: params.contextKind,
      payload: mergedPayload,
      inlineActions: params.inlineActions,
      replyToMessageId: params.replyToMessageId,
    });
  }

  function getCursorDashboardMessageContext(
    chatJid: string,
    platformMessageId: string | undefined,
  ): {
    platformMessageId: string;
    agentId: string | null;
    state: CursorDashboardState;
  } | null {
    const context = getActiveCursorMessageContext(chatJid, platformMessageId);
    if (!context || context.contextKind !== 'cursor_dashboard') {
      return null;
    }
    const state = parseCursorDashboardState(context.payload);
    if (!state) return null;
    return {
      platformMessageId: context.platformMessageId,
      agentId: context.agentId,
      state,
    };
  }

  function summarizeCursorDashboardLines(params: {
    cloudStatus: ReturnType<typeof getCursorCloudStatus>;
    desktopStatus: Awaited<ReturnType<typeof getCursorDesktopStatus>>;
    gatewayStatus: Awaited<ReturnType<typeof getCursorGatewayStatus>>;
  }): {
    cloudLine: string;
    desktopLine: string;
    runtimeRouteLine: string;
    codexRuntimeLine: string;
  } {
    const cloudLine =
      params.cloudStatus.enabled && params.cloudStatus.hasApiKey
        ? 'ready'
        : 'unavailable (add CURSOR_API_KEY)';
    const desktopLine = params.desktopStatus.terminalAvailable
      ? 'ready'
      : params.desktopStatus.enabled
        ? params.desktopStatus.probeDetail
          ? `conditional (${params.desktopStatus.probeDetail})`
          : 'conditional'
        : 'optional and unavailable';
    const runtimeRouteLine =
      params.gatewayStatus.mode === 'configured'
        ? params.gatewayStatus.probeStatus === 'ok'
          ? 'configured'
          : params.gatewayStatus.probeStatus === 'failed'
            ? `configured (${params.gatewayStatus.probeDetail || 'probe failed'})`
            : 'configured'
        : params.gatewayStatus.mode === 'partial'
          ? 'partial'
          : 'optional and off';
    const codexRuntimeLine = andreaRuntimeExecutionEnabled
      ? 'enabled on this host'
      : 'integrated but off on this host';
    return { cloudLine, desktopLine, runtimeRouteLine, codexRuntimeLine };
  }

  async function getCursorSelectedAgentRecord(
    chatJid: string,
    threadId?: string,
  ): Promise<{
    inventory: Awaited<ReturnType<typeof cursorBackendLane.getInventory>>;
    selected: FlattenedCursorJobEntry | null;
  } | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;
    const selectedAgentId = getSelectedLaneJobId(chatJid, threadId, 'cursor');
    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const flattened = flattenCursorJobInventory(inventory);
    return {
      inventory,
      selected: selectedAgentId
        ? flattened.find((entry) => entry.id === selectedAgentId) || null
        : null,
    };
  }

  async function getRuntimeSelectedJobRecord(
    chatJid: string,
    threadId?: string,
  ): Promise<{
    jobs: BackendJobSummary[];
    selected: BackendJobDetails | null;
  } | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;

    const runtimeLane = getAndreaRuntimeLane();
    const selectedJobId = getSelectedLaneJobId(
      chatJid,
      threadId,
      'andrea_runtime',
    );
    const jobs = await runtimeLane.listJobs({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const selected = selectedJobId
      ? await runtimeLane.getJob({
          handle: { laneId: 'andrea_runtime', jobId: selectedJobId },
          groupFolder: group.folder,
          chatJid,
        })
      : null;

    return { jobs, selected };
  }

  async function upsertCursorDashboardMessage(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    text: string;
    inlineActionRows: SendMessageOptions['inlineActionRows'];
    selectedAgentId?: string | null;
    selectedLaneId?: 'cursor' | 'andrea_runtime';
    forceNew?: boolean;
  }): Promise<string | undefined> {
    const channel = findChannel(channels, params.chatJid);
    if (!channel) return undefined;

    const activeContext = getActiveCursorOperatorContext(
      params.chatJid,
      params.sourceMessage?.thread_id,
    );
    const existingDashboardMessageId = params.forceNew
      ? null
      : activeContext?.dashboardMessageId || null;

    let platformMessageId: string | undefined;
    if (existingDashboardMessageId && channel.editMessage) {
      const edited = await channel.editMessage(
        params.chatJid,
        existingDashboardMessageId,
        params.text,
        {
          inlineActionRows: params.inlineActionRows,
        },
      );
      platformMessageId = edited.platformMessageId;
    }

    if (!platformMessageId) {
      const sent = await channel.sendMessage(
        params.chatJid,
        params.text,
        buildOperatorSendOptions(params.sourceMessage, {
          inlineActionRows: params.inlineActionRows,
        }),
      );
      platformMessageId = sent.platformMessageId;
    }

    if (!platformMessageId) return undefined;

    rememberCursorDashboardMessage({
      chatJid: params.chatJid,
      threadId: params.sourceMessage?.thread_id,
      dashboardMessageId: platformMessageId,
      selectedAgentId: params.selectedAgentId,
      selectedLaneId: params.selectedLaneId,
    });
    rememberCursorMessageContext({
      chatJid: params.chatJid,
      platformMessageId,
      threadId: params.sourceMessage?.thread_id,
      contextKind: 'cursor_dashboard',
      laneId: params.selectedLaneId || 'cursor',
      agentId: params.selectedAgentId || null,
      payload: formatCursorDashboardState(params.state),
    });
    return platformMessageId;
  }

  async function openCursorDashboard(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    forceNew?: boolean;
  }): Promise<string | undefined> {
    const group = registeredGroups[params.chatJid];
    if (!group) {
      return sendCursorMessage(
        params.chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        params.sourceMessage,
      );
    }

    if (params.state.kind === 'home') {
      const [desktopStatus, gatewayStatus] = await Promise.all([
        getCursorDesktopStatus({ probe: false }),
        getCursorGatewayStatus({ probe: false }),
      ]);
      const cloudStatus = getCursorCloudStatus();
      const [selection, runtimeSelection] = await Promise.all([
        getCursorSelectedAgentRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
      ]);
      const activeContext = getActiveCursorOperatorContext(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const selectedLaneId = activeContext?.selectedLaneId || 'cursor';
      const selectedAgentId =
        selectedLaneId === 'andrea_runtime'
          ? runtimeSelection?.selected?.handle.jobId || null
          : selection?.selected?.id || null;
      const render = buildCursorDashboardHome({
        ...summarizeCursorDashboardLines({
          cloudStatus,
          desktopStatus,
          gatewayStatus,
        }),
        currentJob: selection?.selected || undefined,
        currentRuntimeTask: runtimeSelection?.selected || undefined,
        currentFocusLaneId: activeContext?.selectedLaneId || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId,
        selectedLaneId,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'status') {
      const desktopStatus = await getCursorDesktopStatus({ probe: true });
      const gatewayStatus = await getCursorGatewayStatus({ probe: true });
      const cloudStatus = getCursorCloudStatus();
      const capabilitySummary = summarizeCursorCapabilities({
        desktopStatus,
        cloudStatus,
        gatewayStatus,
      });
      const render = buildCursorDashboardStatus(
        formatCursorCapabilitySummaryMessage(capabilitySummary),
      );
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'jobs') {
      const inventory = await cursorBackendLane.getInventory({
        groupFolder: group.folder,
        chatJid: params.chatJid,
        limit: 50,
      });
      const flattened = flattenCursorJobInventory(inventory);
      const render = buildCursorDashboardJobs({
        entries: flattened,
        page: params.state.page || 0,
        pageSize: CURSOR_DASHBOARD_PAGE_SIZE,
        selectedAgentId: getSelectedLaneJobId(
          params.chatJid,
          params.sourceMessage?.thread_id,
          'cursor',
        ),
      });
      const platformMessageId = await upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: {
          kind: 'jobs',
          page: params.state.page || 0,
        },
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        forceNew: params.forceNew,
      });
      rememberCursorJobList({
        chatJid: params.chatJid,
        threadId: params.sourceMessage?.thread_id,
        listMessageId: platformMessageId,
        items: flattened.map((entry) => ({
          laneId: 'cursor',
          id: entry.id,
          provider: entry.provider,
        })),
        selectedAgentId: render.selectedAgentId || null,
        selectedLaneId: 'cursor',
      });
      return platformMessageId;
    }

    if (params.state.kind === 'current') {
      const selection = await getCursorSelectedAgentRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const selected = selection?.selected || null;
      const render = selected
        ? buildCursorDashboardCurrentJob(
            selected,
            selected.provider === 'cloud'
              ? cursorBackendLane.getTrackedArtifactCount(selected.id)
              : 0,
          )
        : buildCursorDashboardCurrentJobEmpty();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        selectedLaneId: 'cursor',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime') {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const render = buildCursorDashboardRuntime({
        executionEnabled: andreaRuntimeExecutionEnabled,
        readinessLine: andreaRuntimeExecutionEnabled
          ? 'ready on this host'
          : 'historical review is available, but new runtime work is still off on this host',
        currentTask: runtimeSelection?.selected || undefined,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: runtimeSelection?.selected?.handle.jobId || null,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime_jobs') {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const jobs = runtimeSelection?.jobs || [];
      const render = buildCursorDashboardRuntimeJobs({
        jobs,
        page: params.state.page || 0,
        pageSize: CURSOR_DASHBOARD_PAGE_SIZE,
        selectedJobId: runtimeSelection?.selected?.handle.jobId || null,
      });
      const platformMessageId = await upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: {
          kind: 'runtime_jobs',
          page: params.state.page || 0,
        },
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
      rememberCursorJobList({
        chatJid: params.chatJid,
        threadId: params.sourceMessage?.thread_id,
        listMessageId: platformMessageId,
        items: jobs.map((job) => ({
          laneId: 'andrea_runtime',
          id: job.handle.jobId,
          provider: null,
        })),
        selectedAgentId: render.selectedAgentId || null,
        selectedLaneId: 'andrea_runtime',
      });
      return platformMessageId;
    }

    if (params.state.kind === 'runtime_current') {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const render = runtimeSelection?.selected
        ? buildCursorDashboardRuntimeCurrent(
            runtimeSelection.selected,
            andreaRuntimeExecutionEnabled,
          )
        : buildCursorDashboardRuntimeCurrentEmpty();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          runtimeSelection?.selected?.handle.jobId || render.selectedAgentId,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'desktop') {
      const desktopStatus = await getCursorDesktopStatus({ probe: true });
      const render = buildCursorDashboardDesktop(
        formatCursorDesktopStatusMessage(desktopStatus),
      );
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'help') {
      const render = buildCursorDashboardHelp();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'wizard_repo') {
      const selection = await getCursorSelectedAgentRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const render = buildCursorDashboardWizardRepo({
        selectedRepo:
          params.state.wizard?.sourceRepository !== undefined
            ? params.state.wizard.sourceRepository
            : selection?.selected?.sourceRepository || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: selection?.selected?.id || null,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'wizard_prompt') {
      const render = buildCursorDashboardWizardPrompt({
        sourceRepository: params.state.wizard?.sourceRepository || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    const render = buildCursorDashboardWizardConfirm({
      sourceRepository: params.state.wizard?.sourceRepository || null,
      promptText: params.state.wizard?.promptText || '',
    });
    return upsertCursorDashboardMessage({
      chatJid: params.chatJid,
      sourceMessage: params.sourceMessage,
      state: params.state,
      text: render.text,
      inlineActionRows: render.inlineActionRows,
      forceNew: params.forceNew,
    });
  }
  async function resolveCursorTargetOrReply(params: {
    chatJid: string;
    message?: NewMessage;
    requestedTarget?: string | null;
  }): Promise<string | null> {
    const channel = findChannel(channels, params.chatJid);
    if (!channel) return null;

    try {
      const resolved = resolveCursorTarget({
        chatJid: params.chatJid,
        threadId: params.message?.thread_id,
        replyToMessageId: params.message?.reply_to_id,
        requestedTarget: params.requestedTarget,
      });
      if (resolved.target) {
        return resolved.target.agentId;
      }

      await channel.sendMessage(
        params.chatJid,
        resolved.failureMessage || getCursorContextGuidance(),
        buildOperatorSendOptions(params.message),
      );
      return null;
    } catch (err) {
      await channel.sendMessage(
        params.chatJid,
        formatCursorOperationFailure('Cursor target resolution failed', err),
        buildOperatorSendOptions(params.message),
      );
      return null;
    }
  }

  function parseCursorTargetToken(rawToken: string | undefined): string | null {
    return looksLikeCursorTargetToken(rawToken) ? rawToken!.trim() : null;
  }

  function parseCursorCommandTarget(rawMessage: string): {
    targetToken: string | null;
    args: string[];
  } {
    const parts = tokenizeCommandArguments(rawMessage);
    return {
      targetToken: parseCursorTargetToken(parts[1]),
      args: parts,
    };
  }

  function parseCursorCommandTargetAndLimit(
    rawMessage: string,
    fallbackLimit: number,
    maxLimit: number,
  ): {
    targetToken: string | null;
    limit: number;
  } {
    const { args, targetToken } = parseCursorCommandTarget(rawMessage);
    const limitIndex = targetToken ? 2 : 1;
    const parsedLimit = Number.parseInt(args[limitIndex] || '', 10);
    return {
      targetToken,
      limit:
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(maxLimit, parsedLimit)
          : fallbackLimit,
    };
  }

  async function sendCursorSelectionCard(
    chatJid: string,
    agentId: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;

    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const selected = flattenCursorJobInventory(inventory).find(
      (entry) => entry.id === agentId,
    );

    if (!selected) {
      await sendCursorMessage(
        chatJid,
        `That Cursor job is no longer visible in the latest /cursor-jobs list.\n\n${getCursorContextGuidance()}`,
        sourceMessage,
      );
      return;
    }

    const resultCount =
      selected.provider === 'cloud'
        ? cursorBackendLane.getTrackedArtifactCount(selected.id)
        : 0;
    const text = `${formatCursorJobCard(selected, resultCount)}\n\n${buildCursorNextStepMessage(selected.id)}`;
    const replyToMessageId =
      sourceMessage?.reply_to_id || getOperatorReplyToMessageId(sourceMessage);
    await sendCursorAgentMessage({
      chatJid,
      text,
      agentId: selected.id,
      provider: selected.provider,
      sourceMessage,
      contextKind: 'cursor_job_card',
      payload: buildCursorTaskContextPayload({
        agentId: selected.id,
        provider: selected.provider,
        contextType: 'job_card',
        summary:
          selected.summary ||
          selected.sourceRepository ||
          selected.promptText ||
          null,
      }),
      inlineActions: buildCursorJobCardActions(selected),
      replyToMessageId,
    });
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

  async function handleCursorStatus(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const desktopStatus = await getCursorDesktopStatus({ probe: true });
    const gatewayStatus = await getCursorGatewayStatus({ probe: true });
    const cloudStatus = getCursorCloudStatus();
    const capabilitySummary = summarizeCursorCapabilities({
      desktopStatus,
      cloudStatus,
      gatewayStatus,
    });
    await sendCursorMessage(
      chatJid,
      [
        formatCursorCapabilitySummaryMessage(capabilitySummary),
        formatCursorDesktopStatusMessage(desktopStatus),
        formatCursorGatewayStatusMessage(gatewayStatus),
        formatCursorCloudStatusMessage(cloudStatus),
      ].join('\n\n'),
      sourceMessage,
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

  async function handleCursorDashboard(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    await openCursorDashboard({
      chatJid,
      sourceMessage,
      state: { kind: 'home' },
      forceNew: true,
    });
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
          ? 'Try `/amazon-search <keywords>` to look for a product, then Andrea can prepare a guarded purchase approval.'
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

  async function handleCursorJobs(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    await openCursorDashboard({
      chatJid,
      sourceMessage,
      state: { kind: 'jobs', page: 0 },
      forceNew: true,
    });
  }

  async function sendRuntimeDashboardPrompt(
    chatJid: string,
    job: BackendJobDetails,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    await sendBackendJobMessage({
      chatJid,
      laneId: 'andrea_runtime',
      jobId: job.handle.jobId,
      sourceMessage,
      contextKind: 'runtime_job_message',
      payload: mergeTaskMessageContextPayload(job.metadata, {
        taskContextType: 'job_card',
        taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(job.handle.jobId)}`,
        taskSummary: summarizeVisibleTaskText(job.summary),
      }),
      text: formatTaskReplyPrompt({
        lane: 'codex_runtime',
        taskId: job.handle.jobId,
      }),
    });
  }

  async function handleCursorUi(
    chatJid: string,
    rawMessage: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const args = tokenizeCommandArguments(rawMessage);
    const action = (args[1] || 'home').trim().toLowerCase();
    const dashboardContext = getCursorDashboardMessageContext(
      chatJid,
      sourceMessage?.reply_to_id,
    );

    if (sourceMessage?.reply_to_id && !dashboardContext) {
      await sendCursorMessage(
        chatJid,
        CURSOR_DASHBOARD_EXPIRED_MESSAGE,
        sourceMessage,
      );
      return;
    }

    const activeSelection = await getCursorSelectedAgentRecord(
      chatJid,
      sourceMessage?.thread_id,
    );
    const selectedAgent = activeSelection?.selected || null;

    if (action === 'home') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'home' },
      });
      return;
    }

    if (action === 'status') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'status' },
      });
      return;
    }

    if (action === 'jobs') {
      const rawPage = Number.parseInt(args[2] || '', 10);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: {
          kind: 'jobs',
          page:
            Number.isFinite(rawPage) && rawPage > 0
              ? Math.max(0, rawPage - 1)
              : dashboardContext?.state.kind === 'jobs'
                ? dashboardContext.state.page || 0
                : 0,
        },
      });
      return;
    }

    if (action === 'current') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'desktop') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'desktop' },
      });
      return;
    }

    if (action === 'runtime') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime' },
      });
      return;
    }

    if (action === 'runtime-jobs') {
      const rawPage = Number.parseInt(args[2] || '', 10);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: {
          kind: 'runtime_jobs',
          page:
            Number.isFinite(rawPage) && rawPage > 0
              ? Math.max(0, rawPage - 1)
              : dashboardContext?.state.kind === 'runtime_jobs'
                ? dashboardContext.state.page || 0
                : 0,
        },
      });
      return;
    }

    if (action === 'runtime-current') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime_current' },
      });
      return;
    }

    if (action === 'help') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'help' },
      });
      return;
    }

    if (action === 'new') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'wizard_repo' },
      });
      return;
    }

    if (action === 'select') {
      if (dashboardContext?.state.kind !== 'jobs') {
        await sendCursorMessage(
          chatJid,
          CURSOR_DASHBOARD_EXPIRED_MESSAGE,
          sourceMessage,
        );
        return;
      }
      const visibleIndex = Number.parseInt(args[2] || '', 10);
      if (!Number.isFinite(visibleIndex) || visibleIndex <= 0) {
        await sendCursorMessage(
          chatJid,
          'That task tile is invalid. Open `/cursor` and browse Jobs again.',
          sourceMessage,
        );
        return;
      }
      const inventory = await cursorBackendLane.getInventory({
        groupFolder: registeredGroups[chatJid].folder,
        chatJid,
        limit: 50,
      });
      const flattened = flattenCursorJobInventory(inventory);
      const page = dashboardContext.state.page || 0;
      const selected =
        flattened[page * CURSOR_DASHBOARD_PAGE_SIZE + visibleIndex - 1];
      if (!selected) {
        await sendCursorMessage(
          chatJid,
          'That task is no longer visible in this Cursor jobs page. Open `Jobs` again to refresh the list.',
          sourceMessage,
        );
        return;
      }
      rememberCursorOperatorSelection({
        chatJid,
        threadId: sourceMessage?.thread_id,
        agentId: selected.id,
      });
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'runtime-select') {
      if (dashboardContext?.state.kind !== 'runtime_jobs') {
        await sendCursorMessage(
          chatJid,
          CURSOR_DASHBOARD_EXPIRED_MESSAGE,
          sourceMessage,
        );
        return;
      }
      const visibleIndex = Number.parseInt(args[2] || '', 10);
      if (!Number.isFinite(visibleIndex) || visibleIndex <= 0) {
        await sendCursorMessage(
          chatJid,
          'That task tile is invalid. Open `Codex/OpenAI` and browse Recent Work again.',
          sourceMessage,
        );
        return;
      }
      const runtimeLane = getAndreaRuntimeLane();
      const jobs = await runtimeLane.listJobs({
        groupFolder: registeredGroups[chatJid].folder,
        chatJid,
        limit: 50,
      });
      const page = dashboardContext.state.page || 0;
      const selected =
        jobs[page * CURSOR_DASHBOARD_PAGE_SIZE + visibleIndex - 1];
      if (!selected) {
        await sendCursorMessage(
          chatJid,
          'That task is no longer visible in this Codex/OpenAI work page. Open `Recent Work` again to refresh the list.',
          sourceMessage,
        );
        return;
      }
      rememberCursorOperatorSelection({
        chatJid,
        threadId: sourceMessage?.thread_id,
        laneId: 'andrea_runtime',
        agentId: selected.handle.jobId,
      });
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime_current' },
      });
      return;
    }

    if (action === 'sync') {
      await handleCursorSync(chatJid, null, sourceMessage);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'text') {
      await handleCursorConversation(chatJid, null, 20, sourceMessage);
      return;
    }

    if (action === 'files') {
      await handleCursorArtifacts(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'stop') {
      await handleCursorStop(chatJid, null, sourceMessage);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'followup') {
      if (!selectedAgent || selectedAgent.provider !== 'cloud') {
        await sendCursorMessage(
          chatJid,
          'Continue is only available for the current Cursor Cloud task. Open `Current Job`, then reply with plain text to that dashboard.',
          sourceMessage,
        );
        return;
      }
      await sendCursorAgentMessage({
        chatJid,
        agentId: selectedAgent.id,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: formatTaskReplyPrompt({
          lane: 'cursor_cloud',
          taskId: selectedAgent.id,
        }),
      });
      return;
    }

    if (
      action === 'runtime-refresh' ||
      action === 'runtime-output' ||
      action === 'runtime-followup' ||
      action === 'runtime-stop'
    ) {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        chatJid,
        sourceMessage?.thread_id,
      );
      const selectedRuntimeJob = runtimeSelection?.selected || null;
      if (!selectedRuntimeJob) {
        await sendCursorMessage(
          chatJid,
          'No Codex/OpenAI task is selected yet. Open `Codex/OpenAI`, then tap `Recent Work` to choose one.',
          sourceMessage,
        );
        return;
      }

      if (action === 'runtime-refresh') {
        const runtimeLane = getAndreaRuntimeLane();
        const refreshed = await runtimeLane.refreshJob({
          handle: selectedRuntimeJob.handle,
          groupFolder: registeredGroups[chatJid].folder,
          chatJid,
        });
        if (!refreshed) {
          await sendCursorMessage(
            chatJid,
            `Codex/OpenAI task ${formatOpaqueTaskId(selectedRuntimeJob.handle.jobId)} is no longer available in this workspace.`,
            sourceMessage,
          );
          return;
        }
        await sendBackendJobMessage({
          chatJid,
          laneId: 'andrea_runtime',
          jobId: refreshed.handle.jobId,
          sourceMessage,
          contextKind: 'runtime_job_card',
          payload: mergeTaskMessageContextPayload(refreshed.metadata, {
            taskContextType: 'job_card',
            taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(refreshed.handle.jobId)}`,
            taskSummary: summarizeVisibleTaskText(refreshed.summary),
          }),
          inlineActions: buildRuntimeJobInlineActions({
            job: refreshed,
            contextKind: 'runtime_job_card',
            canExecute: andreaRuntimeExecutionEnabled,
          }),
          text: [
            `Refreshed Codex/OpenAI task ${formatOpaqueTaskId(refreshed.handle.jobId)}.`,
            formatRuntimeJobCard(refreshed),
            formatRuntimeNextStep(refreshed.handle.jobId),
          ].join('\n\n'),
        });
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: { kind: 'runtime_current' },
        });
        return;
      }

      if (action === 'runtime-output') {
        await handleAndreaRuntimeCommand(
          chatJid,
          '/runtime-logs current',
          '/runtime-logs',
          sourceMessage,
        );
        return;
      }

      if (!andreaRuntimeExecutionEnabled) {
        await sendCursorMessage(
          chatJid,
          buildAndreaRuntimeDisabledMessage(),
          sourceMessage,
        );
        return;
      }

      if (action === 'runtime-followup') {
        await sendRuntimeDashboardPrompt(
          chatJid,
          selectedRuntimeJob,
          sourceMessage,
        );
        return;
      }

      await handleAndreaRuntimeCommand(
        chatJid,
        '/runtime-stop current',
        '/runtime-stop',
        sourceMessage,
      );
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime_current' },
      });
      return;
    }

    if (action === 'terminal-status') {
      await handleCursorTerminalStatus(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'terminal-log') {
      await handleCursorTerminalLog(chatJid, null, 40, sourceMessage);
      return;
    }

    if (action === 'terminal-help') {
      await handleCursorTerminalHelp(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'wizard') {
      const step = (args[2] || '').trim().toLowerCase();
      const priorWizard = dashboardContext?.state.wizard || {};

      if (step === 'repo-selected') {
        const selectedRepo = selectedAgent?.sourceRepository || null;
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_prompt',
            wizard: {
              ...priorWizard,
              sourceRepository: selectedRepo,
            },
          },
        });
        return;
      }

      if (step === 'repo-none') {
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_prompt',
            wizard: {
              ...priorWizard,
              sourceRepository: null,
            },
          },
        });
        return;
      }

      if (step === 'edit-repo') {
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_repo',
            wizard: {
              ...priorWizard,
            },
          },
        });
        return;
      }

      if (step === 'create') {
        const promptText = priorWizard.promptText?.trim();
        if (!promptText) {
          await sendCursorMessage(
            chatJid,
            'Reply to the dashboard with the Cloud job prompt before you tap Create.',
            sourceMessage,
          );
          return;
        }
        const created = await handleCursorCreate(
          chatJid,
          promptText,
          sourceMessage?.sender,
          {
            sourceRepository: priorWizard.sourceRepository || undefined,
          },
          sourceMessage,
        );
        if (created) {
          await openCursorDashboard({
            chatJid,
            sourceMessage,
            state: { kind: 'current' },
          });
        }
        return;
      }
    }

    await sendCursorMessage(
      chatJid,
      CURSOR_DASHBOARD_EXPIRED_MESSAGE,
      sourceMessage,
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
            : 'Cursor Cloud returned no models for this account right now. Job control can still work without `/cursor-models` if you omit `--model` and let Cursor use its default.',
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
    sourceMessage?: NewMessage,
  ): Promise<CursorAgentView | null> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return null;
    }

    try {
      const created = await cursorBackendLane.createCursorJob({
        groupFolder: group.folder,
        chatJid,
        promptText,
        requestedBy,
        options: {
          model: options.model,
          sourceRepository: options.sourceRepository,
          sourceRef: options.sourceRef,
          sourcePrUrl: options.sourcePrUrl,
          branchName: options.branchName,
          autoCreatePr: options.autoCreatePr,
          openAsCursorGithubApp: options.openAsCursorGithubApp,
          skipReviewerRequest: options.skipReviewerRequest,
        },
      });
      refreshCursorSnapshotsForAllGroups();
      const targetBits = [
        created.targetUrl ? `URL: ${created.targetUrl}` : null,
        created.targetPrUrl ? `PR: ${created.targetPrUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      await sendCursorAgentMessage({
        chatJid,
        agentId: created.id,
        provider: created.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: created.id,
          provider: created.provider,
          contextType: 'job_card',
          summary:
            created.summary ||
            created.sourceRepository ||
            created.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(created),
        text: [
          `Andrea started ${labelCursorRecord(created)} ${formatOpaqueTaskId(created.id)}.`,
          `Status: ${formatHumanTaskStatus(created.status)}`,
          targetBits || null,
          buildCursorNextStepMessage(created),
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return created;
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure('Cursor create failed', err),
        sourceMessage,
      );
      return null;
    }
  }

  async function handleCursorConversation(
    chatJid: string,
    requestedTarget: string | null,
    limit: number,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const messages = await cursorBackendLane.getConversation({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        limit,
      });
      if (messages.length === 0) {
        const provider = isDesktopCursorRecord(normalizedAgentId)
          ? 'desktop'
          : 'cloud';
        await sendCursorAgentMessage({
          chatJid,
          agentId: normalizedAgentId,
          provider,
          sourceMessage,
          contextKind: 'cursor_job_message',
          payload: buildCursorTaskContextPayload({
            agentId: normalizedAgentId,
            provider,
            contextType: 'output',
            outputSource: 'none',
          }),
          text: `No output is available yet for this task.\nTask: ${labelCursorRecord(normalizedAgentId)} ${formatOpaqueTaskId(normalizedAgentId)}.\n\n${buildCursorNextStepMessage(normalizedAgentId)}`,
        });
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
      const provider = isDesktopCursorRecord(normalizedAgentId)
        ? 'desktop'
        : 'cloud';
      const outputSuggestion = buildTaskOutputSuggestion({
        laneId: 'cursor',
        contextKind: 'output',
        hasStructuredOutput: true,
        canReplyContinue: provider !== 'desktop',
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider,
        sourceMessage,
        contextKind: 'cursor_job_message',
        payload: buildCursorTaskContextPayload({
          agentId: normalizedAgentId,
          provider,
          contextType: 'output',
          outputPreview: messages.at(-1)?.content || formatted,
          outputSource: 'conversation',
        }),
        text: `Current output for this task\nTask: ${labelCursorRecord(normalizedAgentId)} ${formatOpaqueTaskId(normalizedAgentId)} (latest ${messages.length} messages)\n\n${formatted}${outputSuggestion ? `\n\n${outputSuggestion}` : ''}\n\n${buildCursorNextStepMessage(normalizedAgentId)}`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor conversation fetch failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorArtifacts(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const artifacts = await cursorBackendLane.getCursorFiles({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });

      if (artifacts.length === 0) {
        await sendCursorAgentMessage({
          chatJid,
          agentId: normalizedAgentId,
          provider: 'cloud',
          sourceMessage,
          contextKind: 'cursor_job_message',
          text: `This task does not have results yet.\nTask: Cursor Cloud ${formatOpaqueTaskId(normalizedAgentId)}.\n\nView output first, then check Results again if you expect files from this task.`,
        });
        return;
      }

      const lines = artifacts.map(
        (artifact, index) =>
          `${index + 1}. ${artifact.absolutePath} (${artifact.sizeBytes ?? 'unknown'} bytes)${artifact.updatedAt ? ` updated=${artifact.updatedAt}` : ''}`,
      );

      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        payload: buildCursorTaskContextPayload({
          agentId: normalizedAgentId,
          provider: 'cloud',
          contextType: 'results',
          summary: lines.slice(0, 3).join('\n'),
        }),
        text: `Results for this task\nTask: Cursor Cloud ${formatOpaqueTaskId(normalizedAgentId)}\n\n${lines.join('\n')}\n\nReply to this result card with \`/cursor-download ABSOLUTE_PATH\` when you want one file. \`/cursor-download ${normalizedAgentId} ABSOLUTE_PATH\` still works anywhere as an explicit fallback.`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor results lookup failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorArtifactLink(
    chatJid: string,
    requestedTarget: string | null,
    absolutePath: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const link = await cursorBackendLane.getDownloadLink({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        absolutePath,
      });
      const expiry = link.expiresAt ? `\nExpires: ${link.expiresAt}` : '';
      await sendCursorAgentMessage({
        chatJid,
        agentId: link.agentId,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: `Download link for ${link.agentId}\nPath: ${link.absolutePath}\nURL: ${link.url}${expiry}`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor download failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminal(
    chatJid: string,
    requestedTarget: string | null,
    commandText: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const started = await cursorBackendLane.runTerminalCommand({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        commandText,
      });
      const lines = [
        `Andrea started desktop bridge terminal command ${started.commandId}.`,
        formatCursorTerminalStatusMessage(normalizedAgentId, started.terminal),
        'Recent output:',
        formatCursorTerminalOutputSection(started.output),
        'Reply to this card with `/cursor-terminal-status` or `/cursor-terminal-log` when you want the latest machine-side state.',
      ];
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: lines.join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal command failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalStatus(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const terminal = await cursorBackendLane.getTerminalStatus({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: formatCursorTerminalStatusMessage(normalizedAgentId, terminal),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal status failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalLog(
    chatJid: string,
    requestedTarget: string | null,
    limit: number,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const [terminal, output] = await Promise.all([
        cursorBackendLane.getTerminalStatus({
          handle: toCursorHandle(normalizedAgentId),
          groupFolder: group.folder,
          chatJid,
        }),
        cursorBackendLane.getTerminalOutput({
          handle: toCursorHandle(normalizedAgentId),
          groupFolder: group.folder,
          chatJid,
          limit,
        }),
      ]);
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: [
          formatCursorTerminalStatusMessage(normalizedAgentId, terminal),
          'Recent output:',
          formatCursorTerminalOutputSection(output),
        ].join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal log failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalStop(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const terminal = await cursorBackendLane.stopTerminal({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: `Stopped desktop bridge terminal command for ${normalizedAgentId}.\n\n${formatCursorTerminalStatusMessage(normalizedAgentId, terminal)}`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal stop failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorSelect(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    await sendCursorSelectionCard(chatJid, normalizedAgentId, sourceMessage);
  }

  async function handleCursorTerminalHelp(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    await sendCursorAgentMessage({
      chatJid,
      agentId: normalizedAgentId,
      provider: 'desktop',
      sourceMessage,
      contextKind: 'cursor_job_message',
      text: `Desktop bridge terminal control is available for ${formatOpaqueTaskId(normalizedAgentId)}.\n\nUse \`/cursor-terminal ${normalizedAgentId} <command>\` when you want Andrea to run a new machine-side command. Reply to this card with \`/cursor-terminal-status\` or \`/cursor-terminal-log\` when you want the latest state or output without retyping the id.`,
    });
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
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const synced = await cursorBackendLane.syncJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: synced.cursorJob.id,
        provider: synced.cursorJob.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: synced.cursorJob.id,
          provider: synced.cursorJob.provider,
          contextType: 'job_card',
          summary:
            synced.cursorJob.summary ||
            synced.cursorJob.sourceRepository ||
            synced.cursorJob.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(synced.cursorJob),
        text: [
          `Refreshed ${labelCursorRecord(synced.cursorJob)} ${formatOpaqueTaskId(synced.cursorJob.id)}.`,
          `Status: ${formatHumanTaskStatus(synced.cursorJob.status)}`,
          synced.cursorJob.provider === 'cloud'
            ? `Results: ${synced.artifacts.length === 0 ? 'none yet' : `${synced.artifacts.length} file${synced.artifacts.length === 1 ? '' : 's'}`}`
            : null,
          buildCursorNextStepMessage(synced.cursorJob),
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor sync failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorStop(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const stopped = await cursorBackendLane.stopCursorJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: stopped.id,
        provider: stopped.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        inlineActions: buildCursorJobCardActions(stopped),
        text: `Andrea asked Cursor to stop ${labelCursorRecord(stopped)} ${formatOpaqueTaskId(stopped.id)}.\n\nStatus: ${formatHumanTaskStatus(stopped.status)}\n\nTap \`Refresh\` when you want the latest final state.`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor stop failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorFollowup(
    chatJid: string,
    requestedTarget: string | null,
    promptText: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const normalizedAgentId = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!normalizedAgentId) {
      return;
    }

    try {
      const replyMessageContext = getActiveCursorMessageContext(
        chatJid,
        sourceMessage?.reply_to_id,
      );
      const canUseReplyContext =
        replyMessageContext?.agentId === normalizedAgentId &&
        !isDesktopCursorRecord(normalizedAgentId);
      if (canUseReplyContext) {
        const harmlessReply = maybeBuildHarmlessTaskReply(promptText);
        if (harmlessReply) {
          await sendCursorMessage(chatJid, harmlessReply, sourceMessage);
          return;
        }
      }
      const normalizedPromptText = canUseReplyContext
        ? interpretTaskContinuation({
            laneId: 'cursor',
            rawPrompt: promptText,
            contextKind: getTaskContextType(replyMessageContext?.payload),
            messageContextPayload: replyMessageContext?.payload,
            taskId: normalizedAgentId,
            taskLabel: labelCursorRecord(normalizedAgentId),
          }).normalizedPromptText
        : promptText;
      const followed = await cursorBackendLane.followUpCursorJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        promptText: normalizedPromptText,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: followed.id,
        provider: followed.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: followed.id,
          provider: followed.provider,
          contextType: 'job_card',
          summary:
            followed.summary ||
            followed.sourceRepository ||
            followed.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(followed),
        text: [
          `Andrea sent your next instruction to ${labelCursorRecord(followed)} ${formatOpaqueTaskId(followed.id)}.`,
          buildCursorNextStepMessage(followed),
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor follow-up failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleAndreaRuntimeCommand(
    chatJid: string,
    rawTrimmed: string,
    commandToken: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        buildOperatorSendOptions(sourceMessage),
      );
      return;
    }
    const runtimeLane = getAndreaRuntimeLane();
    const replyMessageContext = getActiveCursorMessageContext(
      chatJid,
      sourceMessage?.reply_to_id,
    );

    await dispatchRuntimeCommand(
      {
        async sendToChat(targetChatJid, text) {
          const sent = await channel.sendMessage(
            targetChatJid,
            text,
            buildOperatorSendOptions(sourceMessage),
          );
          return sent.platformMessageId;
        },
        async sendRuntimeJobMessage({
          operatorChatJid,
          text,
          jobId,
          contextKind,
          payload,
          inlineActions,
        }) {
          return sendBackendJobMessage({
            chatJid: operatorChatJid,
            text,
            laneId: 'andrea_runtime',
            jobId,
            sourceMessage,
            contextKind,
            payload,
            inlineActions,
          });
        },
        rememberRuntimeJobList({
          chatJid: targetChatJid,
          threadId,
          listMessageId,
          jobs,
        }) {
          rememberCursorJobList({
            chatJid: targetChatJid,
            threadId,
            listMessageId,
            items: jobs.map((job) => ({
              laneId: 'andrea_runtime',
              id: job.handle.jobId,
              provider: null,
            })),
            selectedLaneId: 'andrea_runtime',
          });
        },
        getStatusMessage() {
          return buildAndreaRuntimeStatusMessage();
        },
        canExecute: andreaRuntimeExecutionEnabled,
        getExecutionDisabledMessage() {
          return buildAndreaRuntimeDisabledMessage();
        },
        getRuntimeJobs() {
          return queue.getRuntimeJobs();
        },
        async listJobs({ chatJid: targetChatJid, groupFolder, limit }) {
          return runtimeLane.listJobs({
            chatJid: targetChatJid,
            groupFolder,
            limit,
          });
        },
        resolveTarget({
          chatJid: targetChatJid,
          threadId,
          replyToMessageId,
          requestedTarget,
        }) {
          const resolved = resolveBackendTarget({
            chatJid: targetChatJid,
            threadId,
            replyToMessageId,
            requestedTarget,
            laneId: 'andrea_runtime',
            parseExplicitTarget(raw) {
              return /^runtime-job-/i.test(raw.trim()) ? raw.trim() : null;
            },
          });
          return resolved.target
            ? {
                target: {
                  handle: resolved.target.handle,
                  jobId: resolved.target.agentId,
                  via: resolved.target.via,
                },
                failureMessage: null,
              }
            : {
                target: null,
                failureMessage:
                  resolved.failureMessage ||
                  getBackendContextGuidance('andrea_runtime'),
              };
        },
        async refreshJob(args) {
          return runtimeLane.refreshJob(args);
        },
        async getPrimaryOutput(args) {
          return runtimeLane.getPrimaryOutput(args);
        },
        async getJobLogs(args) {
          return runtimeLane.getJobLogs(args);
        },
        async stopJob(args) {
          return runtimeLane.stopJob(args);
        },
        async followUpJob(args) {
          return runtimeLane.followUp(args);
        },
        async followUpLegacyGroup({
          groupFolder,
          chatJid: targetChatJid,
          promptText,
        }) {
          const created = await runtimeLane.getService().followUp({
            groupFolder,
            prompt: promptText,
            source: {
              system: 'operator_command',
              actorRef: targetChatJid,
            },
          });
          const details = await runtimeLane.getJob({
            handle: { laneId: 'andrea_runtime', jobId: created.jobId },
            groupFolder,
            chatJid: targetChatJid,
          });
          if (!details) {
            throw new Error(
              `No runtime job found for "${created.jobId}" after follow-up queued.`,
            );
          }
          return details;
        },
        findGroupByFolder(folder) {
          const entry = Object.entries(registeredGroups).find(
            ([, group]) => group.folder === folder,
          );
          if (!entry) return null;
          const [jid, group] = entry;
          return { jid, folder: group.folder };
        },
        requestStop(groupJid) {
          return queue.requestStop(groupJid);
        },
        formatFailure({ operation, err, targetDisplay, guidance }) {
          return formatBackendOperationFailure({
            laneId: 'andrea_runtime',
            operation,
            err,
            targetDisplay,
            guidance,
          });
        },
      },
      {
        operatorChatJid: chatJid,
        groupFolder: group.folder,
        rawTrimmed,
        commandToken,
        threadId: sourceMessage?.thread_id,
        replyToMessageId: sourceMessage?.reply_to_id,
        replyMessageContext: replyMessageContext
          ? {
              agentId: replyMessageContext.agentId,
              contextKind: replyMessageContext.contextKind,
              payload: replyMessageContext.payload,
            }
          : null,
      },
    );
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const rawTrimmed = msg.content.trim();
      const trimmed = rawTrimmed.toLowerCase();
      const isSlashCommand = rawTrimmed.startsWith('/');
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
        handleCursorStatus(chatJid, msg).catch((err) =>
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
            .sendMessage(
              chatJid,
              commandAccess.message,
              buildOperatorSendOptions(msg),
            )
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

      if (
        RUNTIME_STATUS_COMMANDS.has(commandToken) ||
        RUNTIME_JOBS_COMMANDS.has(commandToken) ||
        RUNTIME_FOLLOWUP_COMMANDS.has(commandToken) ||
        RUNTIME_STOP_COMMANDS.has(commandToken) ||
        RUNTIME_LOGS_COMMANDS.has(commandToken)
      ) {
        handleAndreaRuntimeCommand(
          chatJid,
          rawTrimmed,
          commandToken,
          msg,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Andrea runtime command error'),
        );
        return;
      }

      if (DEBUG_STATUS_COMMANDS.has(commandToken)) {
        handleDebugStatus(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug status command error'),
        );
        return;
      }

      if (DEBUG_LEVEL_COMMANDS.has(commandToken)) {
        handleDebugLevel(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug level command error'),
        );
        return;
      }

      if (DEBUG_RESET_COMMANDS.has(commandToken)) {
        handleDebugReset(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug reset command error'),
        );
        return;
      }

      if (DEBUG_LOGS_COMMANDS.has(commandToken)) {
        handleDebugLogs(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug logs command error'),
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

      if (CURSOR_DASHBOARD_COMMANDS.has(commandToken)) {
        handleCursorDashboard(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor dashboard command error'),
        );
        return;
      }

      if (CURSOR_UI_COMMANDS.has(commandToken)) {
        handleCursorUi(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor dashboard UI command error'),
        );
        return;
      }

      if (CURSOR_SELECT_COMMANDS.has(commandToken)) {
        const { targetToken, args } = parseCursorCommandTarget(rawTrimmed);
        handleCursorSelect(chatJid, targetToken || args[1] || null, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor select command error'),
        );
        return;
      }

      if (CURSOR_JOBS_COMMANDS.has(commandToken)) {
        handleCursorJobs(chatJid, msg).catch((err) =>
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
            ?.sendMessage(
              chatJid,
              `${CURSOR_CREATE_USAGE}\n\n${detail}`,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor create usage send failed'),
            );
          return;
        }

        handleCursorCreate(
          chatJid,
          parsed.promptText,
          msg.sender,
          {
            model: parsed.model,
            sourceRepository: parsed.sourceRepository,
            sourceRef: parsed.sourceRef,
            sourcePrUrl: parsed.sourcePrUrl,
            branchName: parsed.branchName,
            autoCreatePr: parsed.autoCreatePr,
            openAsCursorGithubApp: parsed.openAsCursorGithubApp,
            skipReviewerRequest: parsed.skipReviewerRequest,
          },
          msg,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor create command error'),
        );
        return;
      }

      if (CURSOR_SYNC_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorSync(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor sync command error'),
        );
        return;
      }

      if (CURSOR_STOP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorStop(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor stop command error'),
        );
        return;
      }

      if (CURSOR_CONVERSATION_COMMANDS.has(commandToken)) {
        const { targetToken, limit } = parseCursorCommandTargetAndLimit(
          rawTrimmed,
          20,
          100,
        );
        handleCursorConversation(chatJid, targetToken, limit, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor conversation command error'),
        );
        return;
      }

      if (CURSOR_ARTIFACTS_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorArtifacts(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor artifacts command error'),
        );
        return;
      }

      if (CURSOR_ARTIFACT_LINK_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const absolutePath = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!absolutePath) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              CURSOR_DOWNLOAD_USAGE,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor artifact link usage send failed',
              ),
            );
          return;
        }

        handleCursorArtifactLink(chatJid, targetToken, absolutePath, msg).catch(
          (err) =>
            logger.error(
              { err, chatJid },
              'Cursor artifact link command error',
            ),
        );
        return;
      }

      if (CURSOR_TERMINAL_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const commandText = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!commandText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              CURSOR_TERMINAL_USAGE,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal usage send failed',
              ),
            );
          return;
        }

        handleCursorTerminal(chatJid, targetToken, commandText, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor terminal command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_HELP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalHelp(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal help command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STATUS_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalStatus(chatJid, targetToken, msg).catch((err) =>
          logger.error(
            { err, chatJid },
            'Cursor terminal status command error',
          ),
        );
        return;
      }

      if (CURSOR_TERMINAL_LOG_COMMANDS.has(commandToken)) {
        const { targetToken, limit } = parseCursorCommandTargetAndLimit(
          rawTrimmed,
          40,
          200,
        );
        handleCursorTerminalLog(chatJid, targetToken, limit, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal log command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STOP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalStop(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal stop command error'),
        );
        return;
      }

      if (CURSOR_FOLLOWUP_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const promptText = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /cursor-followup [AGENT_ID|LIST_NUMBER|current] TEXT',
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor followup usage send failed',
              ),
            );
          return;
        }

        handleCursorFollowup(chatJid, targetToken, promptText, msg).catch(
          (err) =>
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
            ?.sendMessage(chatJid, 'Usage: /amazon-search <keywords>')
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
              'Usage: /purchase-request <asin> <offer_id> [quantity]',
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
              'Usage: /purchase-approve <request_id> <approval_code>',
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
            ?.sendMessage(chatJid, 'Usage: /purchase-cancel <request_id>')
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

      const repliedCursorDashboard =
        registeredGroups[chatJid]?.isMain === true &&
        !isSlashCommand &&
        rawTrimmed
          ? getCursorDashboardMessageContext(chatJid, msg.reply_to_id)
          : null;
      if (repliedCursorDashboard) {
        if (repliedCursorDashboard.state.kind === 'wizard_repo') {
          const normalizedRepo =
            rawTrimmed.trim().toLowerCase() === 'none'
              ? null
              : rawTrimmed.trim();
          openCursorDashboard({
            chatJid,
            sourceMessage: msg,
            state: {
              kind: 'wizard_prompt',
              wizard: {
                ...repliedCursorDashboard.state.wizard,
                sourceRepository: normalizedRepo,
              },
            },
          }).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor wizard repo reply error'),
          );
          return;
        }

        if (
          repliedCursorDashboard.state.kind === 'wizard_prompt' ||
          repliedCursorDashboard.state.kind === 'wizard_confirm'
        ) {
          openCursorDashboard({
            chatJid,
            sourceMessage: msg,
            state: {
              kind: 'wizard_confirm',
              wizard: {
                ...repliedCursorDashboard.state.wizard,
                promptText: rawTrimmed,
              },
            },
          }).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor wizard prompt reply error'),
          );
          return;
        }

        if (repliedCursorDashboard.state.kind === 'current') {
          if (!repliedCursorDashboard.agentId) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                'No current task is selected in the Cursor lane. Open `Jobs`, then tap a task before replying here. Slash commands and raw ids still work if you want an explicit fallback.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Current dashboard empty guidance send failed',
                ),
              );
            return;
          }

          if (isDesktopCursorRecord(repliedCursorDashboard.agentId)) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                'Desktop sessions use `Refresh`, `View Output`, and `Terminal*` controls rather than plain-text continuation prompts.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Desktop dashboard followup guidance send failed',
                ),
              );
            return;
          }

          handleCursorFollowup(
            chatJid,
            repliedCursorDashboard.agentId,
            rawTrimmed,
            msg,
          ).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor dashboard followup error'),
          );
          return;
        }

        if (repliedCursorDashboard.state.kind === 'runtime_current') {
          if (!repliedCursorDashboard.agentId) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                'No current task is selected in the Codex/OpenAI lane. Open `Codex/OpenAI` -> `Recent Work`, then tap a task before replying here. Slash commands still work if you want an explicit fallback.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Runtime current dashboard guidance send failed',
                ),
              );
            return;
          }

          if (!andreaRuntimeExecutionEnabled) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                buildAndreaRuntimeDisabledMessage(),
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Runtime current dashboard disabled guidance send failed',
                ),
              );
            return;
          }

          handleAndreaRuntimeCommand(
            chatJid,
            `/runtime-followup ${repliedCursorDashboard.agentId} ${rawTrimmed}`,
            '/runtime-followup',
            msg,
          ).catch((err) =>
            logger.error({ err, chatJid }, 'Runtime dashboard followup error'),
          );
          return;
        }
      }

      const repliedMessageContext =
        registeredGroups[chatJid]?.isMain === true &&
        !isSlashCommand &&
        rawTrimmed
          ? getActiveCursorMessageContext(chatJid, msg.reply_to_id)
          : null;
      if (
        repliedMessageContext?.agentId &&
        repliedMessageContext.contextKind !== 'cursor_dashboard'
      ) {
        if (repliedMessageContext.laneId === 'andrea_runtime') {
          handleAndreaRuntimeCommand(
            chatJid,
            `/runtime-followup ${rawTrimmed}`,
            '/runtime-followup',
            msg,
          ).catch((err) =>
            logger.error(
              { err, chatJid },
              'Andrea runtime reply followup error',
            ),
          );
          return;
        }

        const provider =
          repliedMessageContext.payload?.provider === 'desktop' ||
          repliedMessageContext.payload?.provider === 'cloud'
            ? repliedMessageContext.payload.provider
            : isDesktopCursorRecord(repliedMessageContext.agentId)
              ? 'desktop'
              : 'cloud';

        if (provider === 'desktop') {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Desktop sessions use /cursor-sync, /cursor-conversation, and /cursor-terminal* rather than plain-text continuation prompts.',
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Desktop reply-followup guidance send failed',
              ),
            );
          return;
        }

        handleCursorFollowup(chatJid, null, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor reply followup error'),
        );
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
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  try {
    alexaRuntime = await startAlexaServer();
  } catch (err) {
    logger.error({ err }, 'Alexa voice ingress failed to start');
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
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
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
