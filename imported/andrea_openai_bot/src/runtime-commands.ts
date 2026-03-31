import path from 'path';
import fs from 'fs';

import {
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
} from './operator-command-gate.js';
import type { RuntimeOrchestrationService } from './runtime-orchestration.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface RuntimeJobSnapshot {
  groupFolder: string | null;
  groupJid: string;
  active: boolean;
  idleWaiting: boolean;
  pendingMessages: boolean;
  pendingTaskCount: number;
  containerName?: string | null;
}

export interface ResolvedRuntimeGroup {
  jid: string;
  folder: string;
}

export interface RuntimeCommandDependencies {
  sendToChat(chatJid: string, text: string): Promise<void>;
  getStatusMessage(): string;
  getRuntimeJobs(): RuntimeJobSnapshot[];
  findGroupByFolder(folder: string): ResolvedRuntimeGroup | null;
  requestStop(groupJid: string): boolean;
  orchestration?: Pick<
    RuntimeOrchestrationService,
    'followUp' | 'getJobLogs' | 'listJobs' | 'stopJob'
  >;
  queueFollowup(args: {
    operatorChatJid: string;
    targetGroupJid: string;
    targetFolder: string;
    prompt: string;
  }): Promise<void>;
}

export function formatRuntimeJobsMessage(jobs: RuntimeJobSnapshot[]): string {
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

export function readLatestRuntimeLog(
  groupFolder: string,
  lineLimit: number,
): string | null {
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

export async function dispatchRuntimeCommand(
  deps: RuntimeCommandDependencies,
  operatorChatJid: string,
  rawTrimmed: string,
  commandToken: string,
): Promise<boolean> {
  if (RUNTIME_STATUS_COMMANDS.has(commandToken)) {
    await deps.sendToChat(operatorChatJid, deps.getStatusMessage());
    return true;
  }

  if (RUNTIME_JOBS_COMMANDS.has(commandToken)) {
    await deps.sendToChat(
      operatorChatJid,
      formatRuntimeJobsMessage(deps.getRuntimeJobs()),
    );
    return true;
  }

  if (RUNTIME_FOLLOWUP_COMMANDS.has(commandToken)) {
    const parts = rawTrimmed.split(/\s+/);
    const targetFolder = parts[1];
    const followupText = parts.slice(2).join(' ').trim();
    if (!targetFolder || !followupText) {
      await deps.sendToChat(
        operatorChatJid,
        'Usage: /runtime-followup GROUP_FOLDER TEXT',
      );
      return true;
    }

    const target = deps.findGroupByFolder(targetFolder);
    if (!target) {
      await deps.sendToChat(
        operatorChatJid,
        `No registered group found for folder "${targetFolder}".`,
      );
      return true;
    }

    if (deps.orchestration) {
      await deps.orchestration.followUp({
        groupFolder: target.folder,
        prompt: followupText,
        source: {
          system: 'operator_command',
          actorRef: operatorChatJid,
        },
      });
    } else {
      await deps.queueFollowup({
        operatorChatJid,
        targetGroupJid: target.jid,
        targetFolder: target.folder,
        prompt: followupText,
      });
    }
    await deps.sendToChat(
      operatorChatJid,
      `Queued runtime follow-up for ${targetFolder}.`,
    );
    return true;
  }

  if (RUNTIME_STOP_COMMANDS.has(commandToken)) {
    const parts = rawTrimmed.split(/\s+/);
    const targetFolder = parts[1];
    if (!targetFolder) {
      await deps.sendToChat(
        operatorChatJid,
        'Usage: /runtime-stop GROUP_FOLDER',
      );
      return true;
    }

    const target = deps.findGroupByFolder(targetFolder);
    if (!target) {
      await deps.sendToChat(
        operatorChatJid,
        `No registered group found for folder "${targetFolder}".`,
      );
      return true;
    }

    let stopped = false;
    if (deps.orchestration) {
      const activeJob = deps.orchestration
        .listJobs({ groupFolder: target.folder, limit: 20 })
        .jobs.find((job) => job.status === 'running');

      if (activeJob) {
        const stopResult = await deps.orchestration.stopJob({
          jobId: activeJob.jobId,
          source: {
            system: 'operator_command',
            actorRef: operatorChatJid,
          },
        });
        stopped = stopResult.liveStopAccepted || stopResult.job.stopRequested;
      }
    }

    if (!stopped) {
      stopped = deps.requestStop(target.jid);
    }

    await deps.sendToChat(
      operatorChatJid,
      stopped
        ? `Requested runtime stop for ${targetFolder}.`
        : `No active runtime job found for ${targetFolder}.`,
    );
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
      await deps.sendToChat(
        operatorChatJid,
        'Usage: /runtime-logs GROUP_FOLDER [LINES]',
      );
      return true;
    }

    const target = deps.findGroupByFolder(targetFolder);
    if (!target) {
      await deps.sendToChat(
        operatorChatJid,
        `No registered group found for folder "${targetFolder}".`,
      );
      return true;
    }

    let logText: string | null = null;
    if (deps.orchestration) {
      const latestJob = deps.orchestration
        .listJobs({ groupFolder: target.folder, limit: 20 })
        .jobs.find((job) => Boolean(job.logFile));

      if (latestJob) {
        const jobLogs = deps.orchestration.getJobLogs({
          jobId: latestJob.jobId,
          lines: lineLimit,
        });
        logText = jobLogs.logText
          ? `Runtime job ${latestJob.jobId}\n${jobLogs.logText}`
          : null;
      }
    }

    if (!logText) {
      logText = readLatestRuntimeLog(target.folder, lineLimit);
    }

    await deps.sendToChat(
      operatorChatJid,
      logText || `No runtime logs found yet for ${targetFolder}.`,
    );
    return true;
  }

  return false;
}
