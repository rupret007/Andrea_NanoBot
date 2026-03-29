import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  disableOpenClawSkill,
  DisableOpenClawSkillParams,
  DisabledOpenClawSkill,
  enableOpenClawSkill,
  EnableOpenClawSkillParams,
  EnabledOpenClawSkill,
  InstallOpenClawSkillParams,
  InstalledOpenClawSkill,
} from './openclaw-market.js';
import {
  createCursorAgent,
  followupCursorAgent,
  stopCursorAgent,
  syncCursorAgent,
} from './cursor-jobs.js';
import { formatOutbound } from './router.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onMarketplaceChanged: () => void;
  enableOpenClawSkill?: (
    params: EnableOpenClawSkillParams,
  ) => Promise<EnabledOpenClawSkill>;
  disableOpenClawSkill?: (
    params: DisableOpenClawSkillParams,
  ) => Promise<DisabledOpenClawSkill>;
  installOpenClawSkill?: (
    params: InstallOpenClawSkillParams,
  ) => Promise<InstalledOpenClawSkill>;
  createCursorAgent?: typeof createCursorAgent;
  followupCursorAgent?: typeof followupCursorAgent;
  stopCursorAgent?: typeof stopCursorAgent;
  syncCursorAgent?: typeof syncCursorAgent;
  onCursorChanged?: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                const text =
                  typeof data.text === 'string'
                    ? formatOutbound(data.text)
                    : '';
                if (!text) {
                  fs.unlinkSync(filePath);
                  continue;
                }
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    skill_url?: string;
    skill_id_or_url?: string;
    cursor_agent_id?: string;
    model?: string;
    source_repository?: string;
    source_ref?: string;
    source_pr_url?: string;
    auto_create_pr?: boolean;
    open_as_cursor_github_app?: boolean;
    skip_reviewer_request?: boolean;
    branch_name?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const runSkillEnable =
    deps.enableOpenClawSkill ||
    deps.installOpenClawSkill ||
    enableOpenClawSkill;
  const runSkillDisable = deps.disableOpenClawSkill || disableOpenClawSkill;
  const runCreateCursorAgent = deps.createCursorAgent || createCursorAgent;
  const runFollowupCursorAgent =
    deps.followupCursorAgent || followupCursorAgent;
  const runStopCursorAgent = deps.stopCursorAgent || stopCursorAgent;
  const runSyncCursorAgent = deps.syncCursorAgent || syncCursorAgent;

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'enable_openclaw_skill':
    case 'install_openclaw_skill':
      if (data.skill_url && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, skillUrl: data.skill_url },
            'Cannot install skill: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder, skillUrl: data.skill_url },
            'Unauthorized install_openclaw_skill attempt blocked',
          );
          break;
        }

        try {
          const enabled = await runSkillEnable({
            groupFolder: targetFolder,
            skillUrl: data.skill_url,
          });
          logger.info(
            {
              sourceGroup,
              targetFolder,
              skillId: enabled.skillId,
              skillUrl: data.skill_url,
              enabledPath: enabled.enabledPath,
            },
            'OpenClaw skill enabled via IPC',
          );
          deps.onMarketplaceChanged();

          const securityBits = [
            enabled.security.openClawStatus
              ? `OpenClaw ${enabled.security.openClawStatus}`
              : null,
            enabled.security.virusTotalStatus
              ? `VirusTotal ${enabled.security.virusTotalStatus}`
              : null,
          ].filter(Boolean);

          const message = [
            `Enabled community skill "${enabled.displayName}" in this chat.`,
            securityBits.length > 0
              ? `Security signals: ${securityBits.join(', ')}.`
              : 'Security signals were unavailable from the registry page.',
            'It will be available on your next message.',
          ].join(' ');

          await deps.sendMessage(targetJid, message);
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
              skillUrl: data.skill_url,
            },
            'OpenClaw skill enable failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't enable that community skill: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid enable_openclaw_skill request - missing required fields',
        );
      }
      break;

    case 'disable_openclaw_skill':
      if (data.skill_id_or_url && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, skillIdOrUrl: data.skill_id_or_url },
            'Cannot disable skill: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            {
              sourceGroup,
              targetFolder,
              skillIdOrUrl: data.skill_id_or_url,
            },
            'Unauthorized disable_openclaw_skill attempt blocked',
          );
          break;
        }

        try {
          const disabled = await runSkillDisable({
            groupFolder: targetFolder,
            skillIdOrUrl: data.skill_id_or_url,
          });
          logger.info(
            {
              sourceGroup,
              targetFolder,
              skillId: disabled.skillId,
              removedPath: disabled.removedPath,
            },
            'OpenClaw skill disabled via IPC',
          );
          deps.onMarketplaceChanged();

          await deps.sendMessage(
            targetJid,
            `Disabled community skill "${disabled.displayName}" for this chat. It will no longer be available on the next message.`,
          );
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
              skillIdOrUrl: data.skill_id_or_url,
            },
            'OpenClaw skill disable failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't disable that community skill: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid disable_openclaw_skill request - missing required fields',
        );
      }
      break;

    case 'create_cursor_agent':
      if (data.prompt && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, prompt: data.prompt.slice(0, 80) },
            'Cannot create Cursor agent: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized create_cursor_agent attempt blocked',
          );
          break;
        }

        try {
          const created = await runCreateCursorAgent({
            groupFolder: targetFolder,
            chatJid: targetJid,
            promptText: data.prompt,
            requestedBy: sourceGroup,
            model: data.model,
            sourceRepository: data.source_repository,
            sourceRef: data.source_ref,
            sourcePrUrl: data.source_pr_url,
            autoCreatePr: data.auto_create_pr,
            openAsCursorGithubApp: data.open_as_cursor_github_app,
            skipReviewerRequest: data.skip_reviewer_request,
            branchName: data.branch_name,
          });
          deps.onCursorChanged?.();

          const targetBits = [
            created.targetUrl ? `URL: ${created.targetUrl}.` : null,
            created.targetPrUrl ? `PR: ${created.targetPrUrl}.` : null,
          ]
            .filter(Boolean)
            .join(' ');

          await deps.sendMessage(
            targetJid,
            `Started Cursor agent ${created.id} (status: ${created.status}). ${targetBits}`.trim(),
          );
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
            },
            'Cursor agent create failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't start that Cursor agent job: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid create_cursor_agent request - missing required fields',
        );
      }
      break;

    case 'followup_cursor_agent':
      if (data.cursor_agent_id && data.prompt && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, agentId: data.cursor_agent_id },
            'Cannot follow up Cursor agent: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder, agentId: data.cursor_agent_id },
            'Unauthorized followup_cursor_agent attempt blocked',
          );
          break;
        }

        try {
          const followed = await runFollowupCursorAgent({
            groupFolder: targetFolder,
            chatJid: targetJid,
            agentId: data.cursor_agent_id,
            promptText: data.prompt,
          });
          deps.onCursorChanged?.();

          await deps.sendMessage(
            targetJid,
            `Sent follow-up to Cursor agent ${followed.id}. Current status: ${followed.status}.`,
          );
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
              agentId: data.cursor_agent_id,
            },
            'Cursor follow-up failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't send that follow-up to Cursor agent ${data.cursor_agent_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid followup_cursor_agent request - missing required fields',
        );
      }
      break;

    case 'stop_cursor_agent':
      if (data.cursor_agent_id && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, agentId: data.cursor_agent_id },
            'Cannot stop Cursor agent: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder, agentId: data.cursor_agent_id },
            'Unauthorized stop_cursor_agent attempt blocked',
          );
          break;
        }

        try {
          const stopped = await runStopCursorAgent({
            groupFolder: targetFolder,
            chatJid: targetJid,
            agentId: data.cursor_agent_id,
          });
          deps.onCursorChanged?.();

          await deps.sendMessage(
            targetJid,
            `Stop requested for Cursor agent ${stopped.id}. Current status: ${stopped.status}.`,
          );
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
              agentId: data.cursor_agent_id,
            },
            'Cursor stop failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't stop Cursor agent ${data.cursor_agent_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid stop_cursor_agent request - missing required fields',
        );
      }
      break;

    case 'sync_cursor_agent':
      if (data.cursor_agent_id && data.targetJid) {
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid, agentId: data.cursor_agent_id },
            'Cannot sync Cursor agent: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder, agentId: data.cursor_agent_id },
            'Unauthorized sync_cursor_agent attempt blocked',
          );
          break;
        }

        try {
          const synced = await runSyncCursorAgent({
            groupFolder: targetFolder,
            chatJid: targetJid,
            agentId: data.cursor_agent_id,
          });
          deps.onCursorChanged?.();

          await deps.sendMessage(
            targetJid,
            `Synced Cursor agent ${synced.agent.id}. Status: ${synced.agent.status}. Artifacts indexed: ${synced.artifacts.length}.`,
          );
        } catch (err) {
          logger.error(
            {
              err,
              sourceGroup,
              targetJid,
              agentId: data.cursor_agent_id,
            },
            'Cursor sync failed',
          );
          await deps.sendMessage(
            targetJid,
            `I couldn't sync Cursor agent ${data.cursor_agent_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.warn(
          { data },
          'Invalid sync_cursor_agent request - missing required fields',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
