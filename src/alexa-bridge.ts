import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { analyzeAgentError } from './agent-error.js';
import { classifyAssistantRequest } from './assistant-routing.js';
import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import {
  type AvailableCursorAgent,
  type AvailableGroup,
  type AvailableOpenClawSkill,
  runContainerAgent,
  writeCursorAgentsSnapshot,
  writeGroupsSnapshot,
  writeOpenClawSkillsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getSession,
  listAllCursorAgents,
  listAllEnabledCommunitySkills,
  listCursorAgentArtifacts,
  setRegisteredGroup,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  assertValidGroupFolder,
  resolveGroupFolderPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { formatMessages, formatOutbound } from './router.js';
import { type NewMessage, type RegisteredGroup } from './types.js';
import { getUserFacingErrorDetail } from './user-facing-error.js';

export interface AlexaPrincipal {
  userId: string;
  personId?: string;
  accessToken?: string;
}

export interface AlexaBridgeConfig {
  assistantName?: string;
  targetGroupFolder?: string;
}

export interface AlexaTurnRequest {
  utterance: string;
  principal: AlexaPrincipal;
}

export interface AlexaTurnResult {
  text: string;
  route: ReturnType<typeof classifyAssistantRequest>['route'];
  chatJid: string;
  groupFolder: string;
}

export interface AlexaBridgeTarget {
  chatJid: string;
  group: RegisteredGroup;
  shouldPersistGroup: boolean;
}

type RuntimeDeps = {
  getAllRegisteredGroups: typeof getAllRegisteredGroups;
  getAllChats: typeof getAllChats;
  getAllTasks: typeof getAllTasks;
  listAllEnabledCommunitySkills: typeof listAllEnabledCommunitySkills;
  listAllCursorAgents: typeof listAllCursorAgents;
  listCursorAgentArtifacts: typeof listCursorAgentArtifacts;
  setRegisteredGroup: typeof setRegisteredGroup;
  getSession: typeof getSession;
  setSession: typeof setSession;
  storeChatMetadata: typeof storeChatMetadata;
  storeMessage: typeof storeMessage;
  runContainerAgent: typeof runContainerAgent;
};

export type AlexaBridgeDeps = RuntimeDeps;

const runtimeDeps: RuntimeDeps = {
  getAllRegisteredGroups,
  getAllChats,
  getAllTasks,
  listAllEnabledCommunitySkills,
  listAllCursorAgents,
  listCursorAgentArtifacts,
  setRegisteredGroup,
  getSession,
  setSession,
  storeChatMetadata,
  storeMessage,
  runContainerAgent,
};

function stableAlexaId(principal: AlexaPrincipal): string {
  return principal.personId?.trim() || principal.userId.trim();
}

function hashPrincipal(principal: AlexaPrincipal): string {
  return crypto
    .createHash('sha256')
    .update(stableAlexaId(principal))
    .digest('hex')
    .slice(0, 12);
}

function buildAlexaChatJid(
  groupFolder: string,
  principal: AlexaPrincipal,
): string {
  return `alexa:${groupFolder}:${hashPrincipal(principal)}`;
}

function ensureGroupWorkspace(
  group: RegisteredGroup,
  assistantName: string,
): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(groupMdFile)) return;

  const templateFile = path.join(
    GROUPS_DIR,
    group.isMain ? 'main' : 'global',
    'CLAUDE.md',
  );
  if (!fs.existsSync(templateFile)) return;

  let content = fs.readFileSync(templateFile, 'utf-8');
  if (assistantName !== 'Andy') {
    content = content.replace(/^# Andy$/m, `# ${assistantName}`);
    content = content.replace(/You are Andy/g, `You are ${assistantName}`);
  }
  fs.writeFileSync(groupMdFile, content);
}

function buildAvailableGroups(
  deps: RuntimeDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const chats = deps.getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
    .map((chat) => ({
      jid: chat.jid,
      name: chat.name,
      lastActivity: chat.last_message_time,
      isRegistered: registeredJids.has(chat.jid),
    }));
}

function getEnabledOpenClawSkillsSnapshot(
  deps: RuntimeDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableOpenClawSkill[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return deps
    .listAllEnabledCommunitySkills()
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

function getCursorAgentsSnapshot(
  deps: RuntimeDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableCursorAgent[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return deps
    .listAllCursorAgents()
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
        artifacts: deps.listCursorAgentArtifacts(agent.id).map((artifact) => ({
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

function resolveExistingGroupByFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): [string, RegisteredGroup] | undefined {
  return Object.entries(groups).find(([, group]) => group.folder === folder);
}

export function resolveAlexaBridgeTarget(
  principal: AlexaPrincipal,
  config: AlexaBridgeConfig = {},
  registeredGroups = runtimeDeps.getAllRegisteredGroups(),
): AlexaBridgeTarget {
  const requestedFolder = config.targetGroupFolder?.trim();
  if (requestedFolder) {
    assertValidGroupFolder(requestedFolder);
    const existing = resolveExistingGroupByFolder(
      registeredGroups,
      requestedFolder,
    );
    return {
      chatJid: buildAlexaChatJid(requestedFolder, principal),
      group: existing?.[1] ?? {
        name: 'Alexa Voice',
        folder: requestedFolder,
        trigger: DEFAULT_TRIGGER,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: requestedFolder === 'main',
      },
      shouldPersistGroup: false,
    };
  }

  const existingMain = resolveExistingGroupByFolder(registeredGroups, 'main');
  if (existingMain?.[1]) {
    return {
      chatJid: buildAlexaChatJid('main', principal),
      group: existingMain[1],
      shouldPersistGroup: false,
    };
  }

  const suffix = hashPrincipal(principal);
  const folder = `alexa_${suffix}`;
  const existingIsolated = resolveExistingGroupByFolder(
    registeredGroups,
    folder,
  );
  return {
    chatJid: existingIsolated?.[0] || `alexa:${suffix}`,
    group: existingIsolated?.[1] ?? {
      name: 'Alexa Voice',
      folder,
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    },
    shouldPersistGroup: !existingIsolated,
  };
}

function buildUserMessage(
  chatJid: string,
  principal: AlexaPrincipal,
  utterance: string,
): NewMessage {
  return {
    id: `alexa-in-${crypto.randomUUID()}`,
    chat_jid: chatJid,
    sender: stableAlexaId(principal),
    sender_name: 'Alexa User',
    content: utterance,
    timestamp: new Date().toISOString(),
  };
}

function buildAssistantMessage(
  chatJid: string,
  assistantName: string,
  text: string,
): NewMessage {
  return {
    id: `alexa-out-${crypto.randomUUID()}`,
    chat_jid: chatJid,
    sender: assistantName,
    sender_name: assistantName,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
  };
}

function writeSnapshotsForGroup(
  deps: RuntimeDeps,
  group: RegisteredGroup,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  const isMain = group.isMain === true;
  const tasks = deps.getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      script: task.script || undefined,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );
  writeOpenClawSkillsSnapshot(
    group.folder,
    isMain,
    getEnabledOpenClawSkillsSnapshot(deps, registeredGroups),
  );
  writeCursorAgentsSnapshot(
    group.folder,
    isMain,
    getCursorAgentsSnapshot(deps, registeredGroups),
  );
  writeGroupsSnapshot(
    group.folder,
    isMain,
    buildAvailableGroups(deps, registeredGroups),
    new Set(Object.keys(registeredGroups)),
  );
}

export async function runAlexaAssistantTurn(
  request: AlexaTurnRequest,
  config: AlexaBridgeConfig = {},
  deps: RuntimeDeps = runtimeDeps,
): Promise<AlexaTurnResult> {
  const assistantName = config.assistantName || ASSISTANT_NAME;
  const registeredGroups = deps.getAllRegisteredGroups();
  const target = resolveAlexaBridgeTarget(
    request.principal,
    config,
    registeredGroups,
  );

  if (target.shouldPersistGroup) {
    deps.setRegisteredGroup(target.chatJid, target.group);
    registeredGroups[target.chatJid] = target.group;
  }

  ensureGroupWorkspace(target.group, assistantName);

  const userMessage = buildUserMessage(
    target.chatJid,
    request.principal,
    request.utterance,
  );
  deps.storeChatMetadata(
    target.chatJid,
    userMessage.timestamp,
    'Alexa Voice',
    'alexa',
    false,
  );
  deps.storeMessage(userMessage);

  const requestPolicy = classifyAssistantRequest([userMessage]);
  writeSnapshotsForGroup(deps, target.group, registeredGroups);

  const sessionId = deps.getSession(target.group.folder);
  const outputs: string[] = [];

  try {
    const output = await deps.runContainerAgent(
      target.group,
      {
        prompt: formatMessages([userMessage], TIMEZONE),
        sessionId,
        groupFolder: target.group.folder,
        chatJid: target.chatJid,
        isMain: target.group.isMain === true,
        assistantName,
        requestPolicy,
      },
      () => {},
      async (partial) => {
        if (partial.newSessionId) {
          deps.setSession(target.group.folder, partial.newSessionId);
        }
        const text =
          typeof partial.result === 'string'
            ? formatOutbound(partial.result)
            : '';
        if (text) outputs.push(text);
      },
    );

    if (output.newSessionId) {
      deps.setSession(target.group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      const analysis = analyzeAgentError(output);
      const failureText =
        analysis.userMessage ||
        `Sorry, ${assistantName} hit a snag and needs another try.`;
      deps.storeMessage(
        buildAssistantMessage(target.chatJid, assistantName, failureText),
      );
      return {
        text: failureText,
        route: requestPolicy.route,
        chatJid: target.chatJid,
        groupFolder: target.group.folder,
      };
    }

    let text = outputs.join('\n\n').trim();
    if (!text && typeof output.result === 'string') {
      text = formatOutbound(output.result);
    }
    if (!text) {
      text = `${assistantName} is here, but I did not get a finished answer back yet. Please ask again.`;
    }

    deps.storeMessage(
      buildAssistantMessage(target.chatJid, assistantName, text),
    );

    logger.info(
      {
        chatJid: target.chatJid,
        groupFolder: target.group.folder,
        route: requestPolicy.route,
      },
      'Alexa turn completed',
    );

    return {
      text,
      route: requestPolicy.route,
      chatJid: target.chatJid,
      groupFolder: target.group.folder,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.error(
      {
        err,
        chatJid: target.chatJid,
        groupFolder: target.group.folder,
      },
      'Alexa bridge failed',
    );
    const failureText = `Sorry, ${assistantName} ran into a runtime issue: ${getUserFacingErrorDetail(err)}`;
    deps.storeMessage(
      buildAssistantMessage(target.chatJid, assistantName, failureText),
    );
    return {
      text: failureText,
      route: requestPolicy.route,
      chatJid: target.chatJid,
      groupFolder: target.group.folder,
    };
  }
}
