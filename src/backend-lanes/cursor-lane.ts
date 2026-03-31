import {
  createCursorAgent,
  followupCursorAgent,
  getCursorAgentArtifacts,
  getCursorAgentConversation,
  getCursorArtifactDownloadLink,
  getCursorTerminalOutput,
  getCursorTerminalStatus,
  listCursorJobInventory,
  runCursorTerminalCommand,
  stopCursorAgent,
  stopCursorTerminal,
  syncCursorAgent,
  type CreateCursorAgentParams,
  type CursorAgentView,
  type CursorArtifactDownloadLinkView,
  type CursorArtifactView,
  type CursorConversationMessageView,
  type CursorJobInventory,
  type CursorTerminalCommandRunView,
  type CursorTerminalOutputLineView,
  type CursorTerminalStatusView,
} from '../cursor-jobs.js';
import { listCursorAgentArtifacts } from '../db.js';
import type {
  BackendActionDescriptor,
  BackendCapabilitySet,
  BackendCreateJobParams,
  BackendFileEntry,
  BackendFollowUpJobParams,
  BackendGetJobLogsParams,
  BackendGetJobParams,
  BackendJobDetails,
  BackendJobFilesResult,
  BackendJobHandle,
  BackendPrimaryOutputResult,
  BackendJobSummary,
  BackendLane,
  BackendListJobsParams,
  BackendStopJobParams,
} from './types.js';

const CURSOR_LANE_CAPABILITIES: BackendCapabilitySet = {
  canCreateJob: true,
  canFollowUp: true,
  canGetLogs: true,
  canStop: true,
  canRefresh: true,
  canViewOutput: true,
  canViewFiles: true,
  actionIds: [
    'job.refresh',
    'job.output',
    'job.files',
    'job.followup',
    'job.stop',
    'cursor.download',
    'cursor.open',
    'cursor.terminal_status',
    'cursor.terminal_log',
    'cursor.terminal_help',
    'cursor.terminal_run',
    'cursor.terminal_stop',
  ],
};

function toBackendFileEntry(record: CursorArtifactView): BackendFileEntry {
  return {
    path: record.absolutePath,
    sizeBytes: record.sizeBytes,
    updatedAt: record.updatedAt,
    downloadUrl: record.downloadUrl,
  };
}

function summarizeCursorJob(record: CursorAgentView): string | null {
  return (
    record.sourceRepository ||
    record.targetUrl ||
    record.targetPrUrl ||
    record.summary
  );
}

function toBackendJobSummary(record: CursorAgentView): BackendJobSummary {
  return {
    handle: { laneId: 'cursor', jobId: record.id },
    title:
      record.provider === 'cloud'
        ? 'Cursor Cloud job'
        : 'Desktop bridge session',
    status: record.status,
    summary: summarizeCursorJob(record),
    updatedAt: record.updatedAt || record.lastSyncedAt,
    createdAt: record.createdAt,
    sourceRepository: record.sourceRepository,
    targetUrl: record.targetUrl,
    laneLabel: 'Cursor',
    capabilities: CURSOR_LANE_CAPABILITIES,
  };
}

function toBackendJobDetails(record: CursorAgentView): BackendJobDetails {
  return {
    ...toBackendJobSummary(record),
    metadata: {
      provider: record.provider,
      model: record.model,
      promptText: record.promptText,
      sourceRef: record.sourceRef,
      sourcePrUrl: record.sourcePrUrl,
      targetPrUrl: record.targetPrUrl,
      targetBranchName: record.targetBranchName,
      autoCreatePr: record.autoCreatePr,
      openAsCursorGithubApp: record.openAsCursorGithubApp,
      skipReviewerRequest: record.skipReviewerRequest,
      createdBy: record.createdBy,
      lastSyncedAt: record.lastSyncedAt,
    },
  };
}

function assertCursorHandle(handle: BackendJobHandle): string {
  if (handle.laneId !== 'cursor') {
    throw new Error(
      `Cursor lane cannot handle ${handle.laneId} job ${handle.jobId}.`,
    );
  }
  return handle.jobId;
}

async function findCursorJob(
  params: BackendGetJobParams,
): Promise<CursorAgentView | null> {
  const agentId = assertCursorHandle(params.handle);
  const inventory = await listCursorJobInventory({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
    limit: 100,
  });
  return (
    [
      ...inventory.cloudTracked,
      ...inventory.desktopTracked,
      ...inventory.cloudRecoverable,
      ...inventory.desktopRecoverable,
    ].find((record) => record.id === agentId) || null
  );
}

function requireCursorGroupFolder(groupFolder: string | undefined): string {
  if (!groupFolder) {
    throw new Error('Cursor group folder is required for this operation.');
  }
  return groupFolder;
}

export interface CursorBackendLane extends BackendLane {
  createCursorJob(params: BackendCreateJobParams): Promise<CursorAgentView>;
  followUpCursorJob(params: BackendFollowUpJobParams): Promise<CursorAgentView>;
  stopCursorJob(params: BackendStopJobParams): Promise<CursorAgentView>;
  getInventory(params: BackendListJobsParams): Promise<CursorJobInventory>;
  syncJob(params: BackendGetJobParams): Promise<{
    job: BackendJobDetails;
    cursorJob: CursorAgentView;
    artifacts: CursorArtifactView[];
  }>;
  getConversation(
    params: BackendGetJobLogsParams,
  ): Promise<CursorConversationMessageView[]>;
  getCursorFiles(params: BackendGetJobParams): Promise<CursorArtifactView[]>;
  getDownloadLink(params: {
    handle: BackendJobHandle;
    groupFolder: string;
    chatJid: string;
    absolutePath: string;
  }): Promise<CursorArtifactDownloadLinkView>;
  getTrackedArtifactCount(jobId: string): number;
  getActionDescriptors(
    record: BackendJobDetails | CursorAgentView,
  ): BackendActionDescriptor[];
  getTerminalStatus(
    params: BackendGetJobParams,
  ): Promise<CursorTerminalStatusView>;
  getTerminalOutput(
    params: BackendGetJobLogsParams,
  ): Promise<CursorTerminalOutputLineView[]>;
  runTerminalCommand(params: {
    handle: BackendJobHandle;
    groupFolder: string;
    chatJid: string;
    commandText: string;
  }): Promise<CursorTerminalCommandRunView>;
  stopTerminal(params: BackendGetJobParams): Promise<CursorTerminalStatusView>;
}

export function createCursorBackendLane(): CursorBackendLane {
  async function createCursorJob(
    params: BackendCreateJobParams,
  ): Promise<CursorAgentView> {
    return createCursorAgent({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      promptText: params.promptText,
      requestedBy: params.requestedBy,
      ...(params.options as Partial<CreateCursorAgentParams> | undefined),
    });
  }

  async function followUpCursorJob(
    params: BackendFollowUpJobParams,
  ): Promise<CursorAgentView> {
    return followupCursorAgent({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      agentId: assertCursorHandle(params.handle),
      promptText: params.promptText,
    });
  }

  async function stopCursorJob(
    params: BackendStopJobParams,
  ): Promise<CursorAgentView> {
    return stopCursorAgent({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      agentId: assertCursorHandle(params.handle),
    });
  }

  return {
    id: 'cursor',
    label: 'Cursor',
    getCapabilities() {
      return CURSOR_LANE_CAPABILITIES;
    },
    async createCursorJob(params) {
      return createCursorJob(params);
    },
    async createJob(params) {
      const created = await createCursorJob(params);
      return toBackendJobDetails(created);
    },
    async followUpCursorJob(params) {
      return followUpCursorJob(params);
    },
    async followUp(params) {
      const followed = await followUpCursorJob(params);
      return toBackendJobDetails(followed);
    },
    async getJob(params) {
      const record = await findCursorJob(params);
      return record ? toBackendJobDetails(record) : null;
    },
    async listJobs(params) {
      const inventory = await listCursorJobInventory({
        groupFolder: requireCursorGroupFolder(params.groupFolder),
        chatJid: params.chatJid,
        limit: params.limit,
      });
      return [
        ...inventory.cloudTracked,
        ...inventory.desktopTracked,
        ...inventory.cloudRecoverable,
        ...inventory.desktopRecoverable,
      ].map(toBackendJobSummary);
    },
    async refreshJob(params) {
      const refreshed = await syncCursorAgent({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
      return toBackendJobDetails(refreshed.agent);
    },
    async getPrimaryOutput(params): Promise<BackendPrimaryOutputResult> {
      const messages = await getCursorAgentConversation({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        limit: params.limit ?? 40,
      });
      const text =
        messages.length > 0
          ? messages
              .map((message) => {
                const compact = message.content.replace(/\s+/g, ' ').trim();
                return `[${message.role}] ${compact}`;
              })
              .join('\n')
          : null;
      return {
        handle: params.handle,
        text,
        source: messages.length > 0 ? 'conversation' : 'none',
        lineCount: messages.length,
      };
    },
    async getFiles(params): Promise<BackendJobFilesResult> {
      const files = await getCursorAgentArtifacts({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
      return {
        handle: params.handle,
        supported: true,
        files: files.map(toBackendFileEntry),
        note: null,
      };
    },
    getActionDescriptors(job) {
      const provider =
        'provider' in job
          ? job.provider
          : job.metadata?.provider === 'desktop'
            ? 'desktop'
            : 'cloud';
      if (provider === 'desktop') {
        return [
          { actionId: 'job.refresh', label: 'Sync' },
          { actionId: 'job.output', label: 'Messages' },
          { actionId: 'cursor.terminal_status', label: 'Terminal Status' },
          { actionId: 'cursor.terminal_log', label: 'Terminal Log' },
          { actionId: 'cursor.terminal_help', label: 'Terminal Help' },
        ];
      }

      return [
        { actionId: 'job.refresh', label: 'Sync' },
        { actionId: 'job.output', label: 'Text' },
        { actionId: 'job.files', label: 'Files' },
        ...(('targetUrl' in job ? job.targetUrl : null)
          ? [
              {
                actionId: 'cursor.open',
                label: 'Open',
                kind: 'url' as const,
                url: ('targetUrl' in job ? job.targetUrl : null) || undefined,
              },
            ]
          : []),
        { actionId: 'job.followup', label: 'Follow Up' },
        { actionId: 'job.stop', label: 'Stop' },
      ];
    },
    async getJobLogs(params) {
      const messages = await getCursorAgentConversation({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        limit: params.limit ?? 40,
      });
      const logText =
        messages.length > 0
          ? messages
              .map((message) => {
                const compact = message.content.replace(/\s+/g, ' ').trim();
                return `[${message.role}] ${compact}`;
              })
              .join('\n')
          : null;
      return {
        handle: params.handle,
        logText,
        lines: messages.length,
        logFile: null,
      };
    },
    async stopJob(params) {
      const stopped = await stopCursorJob(params);
      return toBackendJobDetails(stopped);
    },
    async stopCursorJob(params) {
      return stopCursorJob(params);
    },
    async getInventory(params) {
      return listCursorJobInventory({
        groupFolder: requireCursorGroupFolder(params.groupFolder),
        chatJid: params.chatJid,
        limit: params.limit,
      });
    },
    async syncJob(params) {
      const synced = await syncCursorAgent({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
      return {
        job: toBackendJobDetails(synced.agent),
        cursorJob: synced.agent,
        artifacts: synced.artifacts,
      };
    },
    async getConversation(params) {
      return getCursorAgentConversation({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        limit: params.limit ?? 40,
      });
    },
    async getCursorFiles(params) {
      return getCursorAgentArtifacts({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
    },
    async getDownloadLink(params) {
      return getCursorArtifactDownloadLink({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        absolutePath: params.absolutePath,
      });
    },
    getTrackedArtifactCount(jobId) {
      return listCursorAgentArtifacts(jobId).length;
    },
    async getTerminalStatus(params) {
      return getCursorTerminalStatus({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
    },
    async getTerminalOutput(params) {
      return getCursorTerminalOutput({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        limit: params.limit ?? 40,
      });
    },
    async runTerminalCommand(params) {
      return runCursorTerminalCommand({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
        commandText: params.commandText,
      });
    },
    async stopTerminal(params) {
      return stopCursorTerminal({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        agentId: assertCursorHandle(params.handle),
      });
    },
  };
}
