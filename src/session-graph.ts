import crypto from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  getAllAgentThreads,
  getAllSessions,
  isDatabaseInitialized,
  listAgentOSEpisodes,
  listAgentOSEpisodeSteps,
  listAgentOSRoleHandoffs,
  listAgentRuntimeCheckpoints,
  listAgentRuntimeEvents,
  listAgentRuntimeRuns,
  listCognitiveCheckpoints,
  listCognitiveHandoffs,
  listCognitiveRuns,
  listCommunicationThreadsForGroup,
  listCompanionHandoffsForGroup,
  listLifeThreadsForGroup,
  listLogicBeliefStates,
  listLogicClaims,
  listRuntimeBackendJobsForGroup,
  listSessionClusters,
  listSessionContinuityThreads,
  listSessionGraphEdges,
  listSessionGraphLinkDecisions,
  listSessionGraphNodes,
  listSessionGraphSnapshots,
  listSessionGraphSuggestions,
  listSupervisorBlackboards,
  listSupervisorHandoffMessages,
  listSupervisorRuns,
  listTruthAnswerAudits,
  listWorldModelClaims,
  listWorldModelSnapshots,
  listWorldModelVerificationNeeds,
  upsertSessionCluster,
  upsertSessionContinuityThread,
  upsertSessionGraphEdge,
  upsertSessionGraphLinkDecision,
  upsertSessionGraphNode,
  upsertSessionGraphSnapshot,
  upsertSessionGraphSuggestion,
} from './db.js';
import { buildIntegrationDoctorReport } from './integration-doctor.js';
import { isValidGroupFolder } from './group-folder.js';
import type { IntegrationStatus } from './integration-doctor.js';
import type {
  CognitiveReplayPacket,
  SessionCluster,
  SessionContinuityActionItem,
  SessionContinuityActionKind,
  SessionContinuityCockpit,
  SessionContinuityFocus,
  SessionContinuityThread,
  SessionGraphDoctorReport,
  SessionGraphEdge,
  SessionGraphEdgeKind,
  SessionGraphLinkDecision,
  SessionGraphNode,
  SessionGraphNodeKind,
  SessionGraphSnapshot,
  SessionGraphSuggestion,
} from './types.js';

type LinkDecisionStatus = SessionGraphEdge['status'];

interface SessionGraphBuildOptions {
  generatedAt?: string;
  persist?: boolean;
  limit?: number;
}

type NodeDraft = SessionGraphNode & {
  linkKeys: Set<string>;
  semanticText: string;
};

const SESSION_GRAPH_PRIVACY: CognitiveReplayPacket['privacy'] = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
};

const UNSAFE_SESSION_GRAPH_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|raw private (?:body|message)|raw message body|provider debate|chain[- ]of[- ]thought|hidden reasoning|full prompt|secret[:=]|password[:=]/i;

const STOPWORDS = new Set([
  'andrea',
  'status',
  'proof',
  'next',
  'action',
  'current',
  'latest',
  'safe',
  'check',
  'checks',
  'run',
  'runs',
  'thread',
  'session',
  'graph',
  'runtime',
  'supervisor',
  'cognitive',
  'agent',
  'world',
  'truth',
  'logic',
  'the',
  'that',
  'this',
  'with',
  'from',
  'for',
  'into',
  'what',
  'when',
  'where',
  'why',
  'how',
]);

export const SESSION_GRAPH_SOURCE_REFS = [
  'andrea-v17-runtime-spine:checkpoint/guardrail/event metadata spine',
  'andrea-v18-supervisor-core:shared blackboard and handoff metadata',
  'andrea-v16-world-model:freshness/proof debt metadata',
  'andrea-v15-truth-engine:answer support and stale-proof audit metadata',
];

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function graphId(prefix: string, value: string): string {
  return `session_graph:${prefix}:${hashText(value)}`;
}

function fingerprint(value: string | null | undefined): string {
  if (!value) return '';
  return `fp:${hashText(value)}`;
}

function privacyJson(): string {
  return JSON.stringify(SESSION_GRAPH_PRIVACY);
}

function scrubJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubJsonValue(item));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = scrubJsonValue(child);
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  if (UNSAFE_SESSION_GRAPH_RE.test(value)) {
    return '[redacted unsafe session metadata]';
  }
  return value
    .replace(
      /\bsk-(?:proj-|ant-api\d*-|api-)?[A-Za-z0-9_-]{16,}/g,
      '[REDACTED_SECRET]',
    )
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_SECRET]')
    .replace(/\bBSA-[A-Za-z0-9_-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED_SECRET]')
    .replace(/\bcrsr_[A-Za-z0-9_]{16,}/g, '[REDACTED_SECRET]')
    .replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED_SECRET]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
    .replace(
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{4}\b/g,
      '[redacted-phone]',
    );
}

function safeJson(value: unknown, limit = 3200): string {
  const scrubbed = scrubJsonValue(value ?? null);
  const serialized = JSON.stringify(scrubbed);
  if (serialized.length <= limit) return serialized;
  if (Array.isArray(scrubbed)) {
    return JSON.stringify({
      truncated: true,
      total: scrubbed.length,
      items: scrubbed.slice(
        0,
        Math.max(1, Math.min(80, Math.floor(limit / 48))),
      ),
    });
  }
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, Math.max(32, limit - 80)),
  });
}

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function uniqueStrings(
  values: Array<string | null | undefined>,
  limit = 80,
): string[] {
  return Array.from(
    new Set(
      values.filter((item): item is string => Boolean(item && item.trim())),
    ),
  ).slice(0, limit);
}

function sanitizeSummary(
  value: string | null | undefined,
  limit = 420,
): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'No summary recorded.';
  if (UNSAFE_SESSION_GRAPH_RE.test(text)) {
    return '[redacted unsafe session metadata]';
  }
  return redactCouncilText(text, limit);
}

function extractEmbeddedNextAction(value: string | null | undefined): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || UNSAFE_SESSION_GRAPH_RE.test(text)) return '';
  const match = /\bNext:\s*(.+)$/i.exec(text);
  return match?.[1] ? sanitizeSummary(match[1], 900) : '';
}

function safeSourceId(kind: SessionGraphNodeKind, rawSourceId: string): string {
  return `${kind}:${fingerprint(rawSourceId)}`;
}

function refString(
  record: Pick<SessionGraphNode, 'refsJson'>,
  key: string,
): string {
  try {
    const parsed = JSON.parse(record.refsJson);
    const value = parsed?.[key];
    return typeof value === 'string' ? sanitizeSummary(value, 900) : '';
  } catch {
    return '';
  }
}

function node(input: {
  snapshotId: string;
  generatedAt: string;
  nodeKind: SessionGraphNodeKind;
  sourceKind?: string;
  rawSourceId: string;
  updatedAt?: string | null;
  groupFolder?: string | null;
  channel?: string | null;
  threadKey?: string | null;
  personKey?: string | null;
  status?: string | null;
  confidence?: number;
  summary?: string | null;
  refs?: Record<string, unknown>;
  evidenceIds?: string[];
  linkKeys?: Array<string | null | undefined>;
  semanticText?: string | null;
}): NodeDraft {
  const nodeId = graphId('node', `${input.nodeKind}:${input.rawSourceId}`);
  const sanitizedSummary = sanitizeSummary(input.summary || input.rawSourceId);
  return {
    nodeId,
    snapshotId: input.snapshotId,
    createdAt: input.generatedAt,
    updatedAt: input.updatedAt || input.generatedAt,
    nodeKind: input.nodeKind,
    sourceKind: input.sourceKind || input.nodeKind,
    sourceId: safeSourceId(input.nodeKind, input.rawSourceId),
    groupFolder: input.groupFolder || null,
    channel: input.channel || null,
    threadKey: input.threadKey ? fingerprint(input.threadKey) : null,
    personKey: input.personKey ? fingerprint(input.personKey) : null,
    status: sanitizeSummary(input.status || 'known', 160),
    confidence: Math.max(0, Math.min(input.confidence ?? 0.9, 1)),
    summary: sanitizedSummary,
    refsJson: safeJson(
      {
        ...input.refs,
        sourceFingerprint: fingerprint(input.rawSourceId),
      },
      3200,
    ),
    evidenceIdsJson: safeJson(input.evidenceIds || [], 3200),
    privacyJson: privacyJson(),
    linkKeys: new Set(
      (input.linkKeys || [])
        .filter((key): key is string => Boolean(key && key.trim()))
        .map((key) => key.trim()),
    ),
    semanticText: sanitizeSummary(
      [input.semanticText, input.summary, input.status]
        .filter(Boolean)
        .join(' '),
      900,
    ),
  };
}

function edge(input: {
  snapshotId: string;
  generatedAt: string;
  edgeKind: SessionGraphEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  confidence?: number;
  status?: LinkDecisionStatus;
  reason: string;
  evidenceIds?: string[];
  reviewNeeded?: boolean;
}): SessionGraphEdge {
  const sorted = [input.fromNodeId, input.toNodeId].sort().join(':');
  return {
    edgeId: graphId(
      'edge',
      `${input.snapshotId}:${input.edgeKind}:${sorted}:${input.reason}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.generatedAt,
    edgeKind: input.edgeKind,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    confidence: Math.max(0, Math.min(input.confidence ?? 0.9, 1)),
    status: input.status || 'accepted',
    reason: sanitizeSummary(input.reason, 640),
    evidenceIdsJson: safeJson(input.evidenceIds || [], 2400),
    reviewNeeded: Boolean(input.reviewNeeded),
    privacyJson: privacyJson(),
  };
}

function linkDecision(
  record: SessionGraphEdge,
  generatedAt: string,
): SessionGraphLinkDecision {
  return {
    decisionId: graphId('decision', record.edgeId),
    snapshotId: record.snapshotId,
    createdAt: generatedAt,
    edgeId: record.edgeId,
    decisionStatus: record.status,
    confidence: record.confidence,
    reason: record.reason,
    sourceNodeIdsJson: safeJson([record.fromNodeId, record.toNodeId], 1200),
    privacyJson: privacyJson(),
  };
}

function semanticTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+@._-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  return new Set(tokens.slice(0, 80));
}

function overlapScore(left: string, right: string): number {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  if (leftTokens.size < 2 || rightTokens.size < 2) return 0;
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  );
  const union = new Set([...leftTokens, ...rightTokens]);
  if (intersection.length < 2) return 0;
  return intersection.length / union.size;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function addUnique<T extends { nodeId?: string; edgeId?: string }>(
  records: T[],
  record: T,
): void {
  const key = record.nodeId || record.edgeId;
  if (!key) {
    records.push(record);
    return;
  }
  if (
    !records.some((existing) => (existing.nodeId || existing.edgeId) === key)
  ) {
    records.push(record);
  }
}

function collectCoreNodes(
  snapshotId: string,
  generatedAt: string,
  limit: number,
): NodeDraft[] {
  const nodes: NodeDraft[] = [];
  const sessions = getAllSessions();
  for (const [groupFolder, sessionId] of Object.entries(sessions)) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'assistant_session',
        rawSourceId: `${groupFolder}:${sessionId}`,
        groupFolder: isValidGroupFolder(groupFolder) ? groupFolder : null,
        status: 'persisted',
        summary: `Assistant session for ${groupFolder}.`,
        refs: { groupFolder },
        linkKeys: [
          `assistant_session:${sessionId}`,
          `agent_thread:${sessionId}`,
        ],
        semanticText: groupFolder,
      }),
    );
  }

  const agentThreads = getAllAgentThreads();
  for (const [groupFolder, thread] of Object.entries(agentThreads)) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'agent_thread',
        rawSourceId: `${groupFolder}:${thread.thread_id}`,
        updatedAt: thread.updated_at || generatedAt,
        groupFolder: isValidGroupFolder(groupFolder) ? groupFolder : null,
        status: thread.runtime,
        summary: `Agent thread for ${groupFolder} using ${thread.runtime}.`,
        refs: {
          runtime: thread.runtime,
          threadFingerprint: fingerprint(thread.thread_id),
          lastResponseFingerprint: fingerprint(thread.last_response_id || ''),
        },
        linkKeys: [
          `agent_thread:${thread.thread_id}`,
          thread.last_response_id
            ? `agent_response:${thread.last_response_id}`
            : null,
        ],
        semanticText: `${groupFolder} ${thread.runtime}`,
      }),
    );
  }

  const runtimeRuns = listAgentRuntimeRuns({
    cognitiveRunOrigin: 'live',
    limit,
  });
  for (const run of runtimeRuns) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'runtime_run',
        rawSourceId: run.runtimeRunId,
        updatedAt: run.updatedAt,
        groupFolder: run.groupFolder,
        channel: run.channel,
        status: run.status,
        summary: run.goalSummary,
        refs: { taskFamily: run.taskFamily, mode: run.mode },
        evidenceIds: [
          run.worldSnapshotId,
          run.logicBeliefStateId,
          run.truthAuditId,
          ...parseArray(run.evidencePacketIdsJson),
        ].filter((item): item is string => Boolean(item)),
        linkKeys: [
          `runtime:${run.runtimeRunId}`,
          run.turnId ? `turn:${run.turnId}` : null,
          run.worldSnapshotId ? `world:${run.worldSnapshotId}` : null,
          run.agentOSEpisodeId ? `episode:${run.agentOSEpisodeId}` : null,
          run.cognitiveRunId ? `cognitive:${run.cognitiveRunId}` : null,
          run.logicBeliefStateId ? `logic:${run.logicBeliefStateId}` : null,
          run.truthAuditId ? `truth:${run.truthAuditId}` : null,
          ...parseArray(run.checkpointIdsJson).map((id) => `checkpoint:${id}`),
        ],
        semanticText: `${run.goalSummary} ${run.taskFamily} ${run.nextAction}`,
      }),
    );
  }

  for (const checkpoint of listAgentRuntimeCheckpoints({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'runtime_checkpoint',
        rawSourceId: checkpoint.checkpointId,
        updatedAt: checkpoint.updatedAt,
        status: checkpoint.status,
        summary: checkpoint.nextAction,
        refs: {
          threadFingerprint: fingerprint(checkpoint.threadId),
          checkpointNs: checkpoint.checkpointNs,
        },
        linkKeys: [
          `runtime:${checkpoint.runtimeRunId}`,
          `checkpoint:${checkpoint.checkpointId}`,
          `thread:${checkpoint.threadId}`,
        ],
        semanticText: `${checkpoint.checkpointNs} ${checkpoint.nextAction}`,
      }),
    );
  }

  for (const event of listAgentRuntimeEvents({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'runtime_event',
        rawSourceId: event.eventId,
        updatedAt: event.createdAt,
        status: event.severity,
        summary: event.summary,
        refs: { eventKind: event.eventKind, truncated: event.truncated },
        linkKeys: [`runtime:${event.runtimeRunId}`],
        semanticText: `${event.eventKind} ${event.summary}`,
      }),
    );
  }

  for (const supervisorRun of listSupervisorRuns({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'supervisor_run',
        rawSourceId: supervisorRun.supervisorRunId,
        updatedAt: supervisorRun.updatedAt,
        status: supervisorRun.status,
        summary: supervisorRun.goalSummary,
        refs: {
          activeParticipant: supervisorRun.activeParticipant,
          turnCount: supervisorRun.turnCount,
        },
        linkKeys: [
          `supervisor:${supervisorRun.supervisorRunId}`,
          `runtime:${supervisorRun.runtimeRunId}`,
          `blackboard:${supervisorRun.blackboardId}`,
          ...parseArray(supervisorRun.handoffIdsJson).map(
            (id) => `handoff:${id}`,
          ),
        ],
        semanticText: `${supervisorRun.goalSummary} ${supervisorRun.nextAction}`,
      }),
    );
  }

  for (const blackboard of listSupervisorBlackboards({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'supervisor_blackboard',
        rawSourceId: blackboard.blackboardId,
        updatedAt: blackboard.updatedAt,
        status: blackboard.status,
        summary: blackboard.goalSummary,
        refs: {
          proofDebt: blackboard.proofDebtJson,
          approvalState: blackboard.approvalStateJson,
        },
        evidenceIds: parseArray(blackboard.evidenceIdsJson),
        linkKeys: [
          `blackboard:${blackboard.blackboardId}`,
          `supervisor:${blackboard.supervisorRunId}`,
          `runtime:${blackboard.runtimeRunId}`,
        ],
        semanticText: `${blackboard.goalSummary} ${blackboard.nextAction}`,
      }),
    );
  }

  for (const handoff of listSupervisorHandoffMessages({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'supervisor_handoff',
        rawSourceId: handoff.handoffId,
        updatedAt: handoff.createdAt,
        status: handoff.status,
        summary: handoff.reason,
        refs: { fromRole: handoff.fromRole, toRole: handoff.toRole },
        linkKeys: [
          `supervisor:${handoff.supervisorRunId}`,
          `handoff:${handoff.handoffId}`,
        ],
        semanticText: `${handoff.fromRole} ${handoff.toRole} ${handoff.reason}`,
      }),
    );
  }

  return nodes;
}

function collectAgentCognitionNodes(
  snapshotId: string,
  generatedAt: string,
  limit: number,
): NodeDraft[] {
  const nodes: NodeDraft[] = [];
  const liveRuns = listCognitiveRuns({ runOrigin: 'live', limit: 1000 });
  const liveRunIds = new Set(liveRuns.map((run) => run.runId));
  for (const run of liveRuns.slice(0, limit)) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'cognitive_run',
        rawSourceId: run.runId,
        updatedAt: run.updatedAt,
        groupFolder: run.groupFolder,
        channel: run.channel,
        status: run.status,
        summary: run.goalSummary,
        refs: { taskFamily: run.taskFamily, mode: run.cognitiveMode },
        evidenceIds: parseArray(run.evidenceContractJson),
        linkKeys: [
          `cognitive:${run.runId}`,
          run.turnId ? `turn:${run.turnId}` : null,
          run.councilRunId ? `council:${run.councilRunId}` : null,
          run.linkedSkillCardId ? `skill:${run.linkedSkillCardId}` : null,
        ],
        semanticText: `${run.goalSummary} ${run.taskFamily} ${run.nextAction}`,
      }),
    );
  }

  for (const checkpoint of listCognitiveCheckpoints({ limit: 200 })
    .filter((item) => liveRunIds.has(item.runId))
    .slice(0, limit)) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'cognitive_checkpoint',
        rawSourceId: checkpoint.checkpointId,
        updatedAt: checkpoint.updatedAt,
        groupFolder: checkpoint.groupFolder,
        channel: checkpoint.channel,
        status: checkpoint.status,
        summary: checkpoint.summary,
        refs: { checkpointKind: checkpoint.checkpointKind },
        linkKeys: [
          `cognitive:${checkpoint.runId}`,
          `checkpoint:${checkpoint.checkpointId}`,
        ],
        semanticText: `${checkpoint.summary} ${checkpoint.nextAction}`,
      }),
    );
  }

  for (const handoff of listCognitiveHandoffs({ limit: 200 })
    .filter((item) => liveRunIds.has(item.runId))
    .slice(0, limit)) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'cognitive_handoff',
        rawSourceId: handoff.handoffId,
        updatedAt: handoff.createdAt,
        status: handoff.status,
        summary: handoff.reason,
        refs: { fromRole: handoff.fromRole, toRole: handoff.toRole },
        evidenceIds: parseArray(handoff.evidenceRefsJson),
        linkKeys: [
          `cognitive:${handoff.runId}`,
          `handoff:${handoff.handoffId}`,
        ],
        semanticText: `${handoff.fromRole} ${handoff.toRole} ${handoff.reason}`,
      }),
    );
  }

  for (const episode of listAgentOSEpisodes({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'agent_os_episode',
        rawSourceId: episode.episodeId,
        updatedAt: episode.updatedAt,
        groupFolder: episode.groupFolder,
        channel: episode.channel,
        status: episode.status,
        summary: episode.goalSummary,
        refs: { taskFamily: episode.taskFamily, mode: episode.mode },
        evidenceIds: parseArray(episode.evidenceIdsJson),
        linkKeys: [
          `episode:${episode.episodeId}`,
          episode.rootRunId ? `cognitive:${episode.rootRunId}` : null,
          episode.activeRunId ? `cognitive:${episode.activeRunId}` : null,
          ...parseArray(episode.linkedRunIdsJson).map(
            (id) => `cognitive:${id}`,
          ),
          ...parseArray(episode.councilRunIdsJson).map((id) => `council:${id}`),
        ],
        semanticText: `${episode.goalSummary} ${episode.taskFamily} ${episode.nextAction}`,
      }),
    );
  }

  for (const step of listAgentOSEpisodeSteps({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'agent_os_step',
        rawSourceId: step.stepId,
        updatedAt: step.createdAt,
        status: step.status,
        summary: step.summary,
        refs: { stepKind: step.stepKind, actorRole: step.actorRole },
        evidenceIds: parseArray(step.evidenceRefsJson),
        linkKeys: [
          `episode:${step.episodeId}`,
          step.runId ? `cognitive:${step.runId}` : null,
        ],
        semanticText: `${step.stepKind} ${step.summary} ${step.nextAction}`,
      }),
    );
  }

  for (const handoff of listAgentOSRoleHandoffs({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'agent_os_handoff',
        rawSourceId: handoff.handoffId,
        updatedAt: handoff.createdAt,
        status: handoff.status,
        summary: handoff.reason,
        refs: { fromRole: handoff.fromRole, toRole: handoff.toRole },
        evidenceIds: parseArray(handoff.evidenceRefsJson),
        linkKeys: [
          `episode:${handoff.episodeId}`,
          handoff.runId ? `cognitive:${handoff.runId}` : null,
          `handoff:${handoff.handoffId}`,
        ],
        semanticText: `${handoff.fromRole} ${handoff.toRole} ${handoff.reason}`,
      }),
    );
  }

  return nodes;
}

function collectKnowledgeNodes(
  snapshotId: string,
  generatedAt: string,
  limit: number,
): NodeDraft[] {
  const nodes: NodeDraft[] = [];
  for (const snapshot of listWorldModelSnapshots({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'world_snapshot',
        rawSourceId: snapshot.snapshotId,
        updatedAt: snapshot.updatedAt,
        status: snapshot.status,
        summary: snapshot.summary,
        refs: { confidence: snapshot.confidence },
        evidenceIds: [
          ...parseArray(snapshot.claimIdsJson),
          ...parseArray(snapshot.evidenceRefIdsJson),
          ...parseArray(snapshot.verificationNeedIdsJson),
        ],
        linkKeys: [
          `world:${snapshot.snapshotId}`,
          snapshot.logicBeliefStateId
            ? `logic:${snapshot.logicBeliefStateId}`
            : null,
          snapshot.truthAuditId ? `truth:${snapshot.truthAuditId}` : null,
          snapshot.agentOSEpisodeId
            ? `episode:${snapshot.agentOSEpisodeId}`
            : null,
          snapshot.cognitiveRunId
            ? `cognitive:${snapshot.cognitiveRunId}`
            : null,
        ],
        semanticText: `${snapshot.summary} ${snapshot.bestNextAction}`,
      }),
    );
  }

  for (const claim of listWorldModelClaims({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'world_claim',
        rawSourceId: claim.claimId,
        updatedAt: claim.updatedAt,
        status: claim.status,
        summary: claim.summary,
        refs: { domain: claim.domain, claimKind: claim.claimKind },
        evidenceIds: [
          ...parseArray(claim.evidenceRefIdsJson),
          ...parseArray(claim.verificationNeedIdsJson),
        ],
        linkKeys: [
          `world:${claim.snapshotId}`,
          `claim:${claim.claimId}`,
          ...parseArray(claim.verificationNeedIdsJson).map(
            (id) => `proof:${id}`,
          ),
        ],
        semanticText: `${claim.subject} ${claim.summary} ${claim.nextAction}`,
      }),
    );
  }

  for (const need of listWorldModelVerificationNeeds({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'world_verification_need',
        rawSourceId: need.needId,
        updatedAt: need.updatedAt,
        status: need.status,
        summary: need.summary,
        refs: {
          domain: need.domain,
          actionKind: need.actionKind,
          blockerClass: need.blockerClass,
          safeToRunAutomatically: need.safeToRunAutomatically,
        },
        evidenceIds: parseArray(need.evidenceRefIdsJson),
        linkKeys: [`world:${need.snapshotId}`, `proof:${need.needId}`],
        semanticText: `${need.domain} ${need.summary} ${need.nextAction}`,
      }),
    );
  }

  for (const belief of listLogicBeliefStates({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'logic_belief',
        rawSourceId: belief.beliefStateId,
        updatedAt: belief.updatedAt,
        status: belief.status,
        summary: belief.summary,
        refs: { subject: belief.subject, confidence: belief.confidence },
        evidenceIds: [
          ...parseArray(belief.topClaimIdsJson),
          ...parseArray(belief.contradictionIdsJson),
          ...parseArray(belief.missingPremiseIdsJson),
        ],
        linkKeys: [
          `logic:${belief.beliefStateId}`,
          ...parseArray(belief.topClaimIdsJson).map(
            (id) => `logic_claim:${id}`,
          ),
        ],
        semanticText: `${belief.subject} ${belief.summary} ${belief.nextAction}`,
      }),
    );
  }

  for (const claim of listLogicClaims({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'logic_claim',
        rawSourceId: claim.claimId,
        updatedAt: claim.updatedAt,
        status: claim.status,
        summary: claim.objectSummary,
        refs: { subject: claim.subject, predicate: claim.predicate },
        evidenceIds: parseArray(claim.evidenceIdsJson),
        linkKeys: [
          `logic_claim:${claim.claimId}`,
          claim.sourceEpisodeId ? `episode:${claim.sourceEpisodeId}` : null,
          claim.sourceRunId ? `cognitive:${claim.sourceRunId}` : null,
        ],
        semanticText: `${claim.subject} ${claim.predicate} ${claim.objectSummary}`,
      }),
    );
  }

  for (const audit of listTruthAnswerAudits({ limit })) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'truth_audit',
        rawSourceId: audit.auditId,
        updatedAt: audit.updatedAt,
        channel: audit.channel,
        status: audit.status,
        summary: audit.verdictSummary,
        refs: { subject: audit.subject, supportGrade: audit.supportGrade },
        evidenceIds: [
          ...parseArray(audit.claimIdsJson),
          ...parseArray(audit.evidenceIdsJson),
          ...parseArray(audit.unsupportedClaimIdsJson),
        ],
        linkKeys: [
          `truth:${audit.auditId}`,
          audit.turnId ? `turn:${audit.turnId}` : null,
        ],
        semanticText: `${audit.subject} ${audit.verdictSummary} ${audit.bestNextAction}`,
      }),
    );
  }

  return nodes;
}

function collectCommunicationNodes(
  snapshotId: string,
  generatedAt: string,
  limit: number,
  groupFolders: string[],
): NodeDraft[] {
  const nodes: NodeDraft[] = [];
  for (const groupFolder of groupFolders) {
    if (!isValidGroupFolder(groupFolder)) continue;
    for (const thread of listCommunicationThreadsForGroup({
      groupFolder,
      includeDisabled: true,
      limit,
    })) {
      const nodeKind: SessionGraphNodeKind =
        thread.channel === 'bluebubbles'
          ? 'bluebubbles_thread'
          : 'communication_thread';
      addUnique(
        nodes,
        node({
          snapshotId,
          generatedAt,
          nodeKind,
          rawSourceId: thread.id,
          updatedAt: thread.updatedAt,
          groupFolder,
          channel: thread.channel,
          threadKey: thread.channelChatJid || thread.id,
          status: thread.followupState,
          summary: `${thread.title}. ${thread.lastInboundSummary || thread.lastOutboundSummary || ''}`,
          refs: {
            urgency: thread.urgency,
            suggestedNextAction: thread.suggestedNextAction,
            inferenceState: thread.inferenceState,
            trackingMode: thread.trackingMode,
            chatFingerprint: fingerprint(thread.channelChatJid || ''),
          },
          evidenceIds: [thread.lastMessageId].filter((item): item is string =>
            Boolean(item),
          ),
          linkKeys: [
            `communication:${thread.id}`,
            thread.channelChatJid ? `thread:${thread.channelChatJid}` : null,
            thread.linkedTaskId ? `task:${thread.linkedTaskId}` : null,
            ...thread.linkedLifeThreadIds.map((id) => `life:${id}`),
          ],
          semanticText: `${thread.title} ${thread.lastInboundSummary || ''} ${thread.lastOutboundSummary || ''} ${thread.suggestedNextAction || ''}`,
        }),
      );
    }

    for (const lifeThread of listLifeThreadsForGroup(groupFolder)) {
      addUnique(
        nodes,
        node({
          snapshotId,
          generatedAt,
          nodeKind: 'life_thread',
          rawSourceId: lifeThread.id,
          updatedAt: lifeThread.lastUpdatedAt,
          groupFolder,
          status: lifeThread.status,
          summary: `${lifeThread.title}. ${lifeThread.summary}`,
          refs: {
            category: lifeThread.category,
            scope: lifeThread.scope,
            sensitivity: lifeThread.sensitivity,
            surfaceMode: lifeThread.surfaceMode,
          },
          linkKeys: [
            `life:${lifeThread.id}`,
            lifeThread.linkedTaskId ? `task:${lifeThread.linkedTaskId}` : null,
            lifeThread.mergedIntoThreadId
              ? `life:${lifeThread.mergedIntoThreadId}`
              : null,
          ],
          semanticText: `${lifeThread.title} ${lifeThread.summary} ${lifeThread.nextAction || ''}`,
        }),
      );
    }

    for (const handoff of listCompanionHandoffsForGroup({
      groupFolder,
      limit,
    })) {
      addUnique(
        nodes,
        node({
          snapshotId,
          generatedAt,
          nodeKind: 'companion_handoff',
          rawSourceId: handoff.handoffId,
          updatedAt: handoff.updatedAt,
          groupFolder,
          channel: handoff.originChannel,
          threadKey: handoff.targetChatJid || handoff.threadId || null,
          status: handoff.status,
          summary: handoff.voiceSummary || handoff.lastCommunicationSummary,
          refs: {
            originChannel: handoff.originChannel,
            targetChannel: handoff.targetChannel,
            requiresConfirmation: handoff.requiresConfirmation,
            targetChatFingerprint: fingerprint(handoff.targetChatJid || ''),
          },
          linkKeys: [
            `handoff:${handoff.handoffId}`,
            handoff.threadId ? `thread:${handoff.threadId}` : null,
            handoff.targetChatJid ? `thread:${handoff.targetChatJid}` : null,
            handoff.communicationThreadId
              ? `communication:${handoff.communicationThreadId}`
              : null,
            handoff.taskId ? `task:${handoff.taskId}` : null,
            ...parseArray(handoff.communicationLifeThreadIdsJson).map(
              (id) => `life:${id}`,
            ),
          ],
          semanticText: `${handoff.voiceSummary} ${handoff.lastCommunicationSummary || ''} ${handoff.followupSuggestionsJson || ''}`,
        }),
      );
    }

    for (const job of listRuntimeBackendJobsForGroup(
      'andrea_openai',
      groupFolder,
      limit,
    )) {
      addUnique(
        nodes,
        node({
          snapshotId,
          generatedAt,
          nodeKind: 'runtime_backend_job',
          sourceKind: 'runtime_backend_job',
          rawSourceId: `${job.backend_id}:${job.job_id}`,
          updatedAt: job.updated_at,
          groupFolder,
          channel: 'telegram',
          threadKey: job.chat_jid || job.thread_id,
          status: job.status,
          summary:
            job.prompt_preview || job.latest_output_text || job.error_text,
          refs: {
            backendId: job.backend_id,
            selectedRuntime: job.selected_runtime,
            chatFingerprint: fingerprint(job.chat_jid),
          },
          linkKeys: [
            `operator_job:${job.backend_id}:${job.job_id}`,
            job.thread_id ? `thread:${job.thread_id}` : null,
            job.chat_jid ? `thread:${job.chat_jid}` : null,
          ],
          semanticText: `${job.prompt_preview} ${job.latest_output_text || ''} ${job.error_text || ''}`,
        }),
      );
    }
  }
  return nodes;
}

function collectProofNodes(
  snapshotId: string,
  generatedAt: string,
): NodeDraft[] {
  const nodes: NodeDraft[] = [];
  const report = buildIntegrationDoctorReport();
  for (const status of report.statuses) {
    addUnique(
      nodes,
      node({
        snapshotId,
        generatedAt,
        nodeKind: 'proof_state',
        sourceKind: 'integration_doctor',
        rawSourceId: status.integrationId,
        updatedAt: report.generatedAt,
        status: status.state,
        summary: `${status.label}: ${status.state}. ${
          status.detail || 'No integration detail recorded.'
        }${status.nextAction ? ` Next: ${status.nextAction}` : ''}`,
        refs: {
          integrationId: status.integrationId,
          proofState: status.proofState,
          blockerOwner: status.blockerOwner,
          repairability: status.repairability,
          nextAction: status.nextAction,
        },
        linkKeys: [`proof:${status.integrationId}`],
        semanticText: `${status.label} ${status.state} ${status.detail} ${status.nextAction}`,
      }),
    );
  }
  return nodes;
}

function addDeterministicEdges(
  nodes: NodeDraft[],
  snapshotId: string,
  generatedAt: string,
): SessionGraphEdge[] {
  const byKey = new Map<string, NodeDraft[]>();
  for (const item of nodes) {
    for (const key of item.linkKeys) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)?.push(item);
    }
  }
  const edges: SessionGraphEdge[] = [];
  for (const [key, linkedNodes] of byKey.entries()) {
    const unique = Array.from(
      new Map(linkedNodes.map((item) => [item.nodeId, item])).values(),
    );
    if (unique.length < 2 || unique.length > 12) continue;
    for (let index = 0; index < unique.length - 1; index += 1) {
      const left = unique[index];
      const right = unique[index + 1];
      const kind: SessionGraphEdgeKind = key.startsWith('thread:')
        ? 'same_channel_thread'
        : key.startsWith('handoff:')
          ? 'handoff'
          : key.startsWith('checkpoint:')
            ? 'resume_checkpoint'
            : key.startsWith('proof:')
              ? 'proof_dependency'
              : key.startsWith('claim:') || key.startsWith('logic_claim:')
                ? 'evidence_support'
                : 'explicit_id';
      addUnique(
        edges,
        edge({
          snapshotId,
          generatedAt,
          edgeKind: kind,
          fromNodeId: left.nodeId,
          toNodeId: right.nodeId,
          confidence: kind === 'same_channel_thread' ? 0.92 : 0.98,
          reason: `Deterministic link on ${key.split(':')[0]} metadata.`,
          evidenceIds: parseArray(left.evidenceIdsJson).concat(
            parseArray(right.evidenceIdsJson),
          ),
        }),
      );
    }
  }
  return edges;
}

function addSemanticEdges(
  nodes: NodeDraft[],
  edges: SessionGraphEdge[],
  snapshotId: string,
  generatedAt: string,
): SessionGraphEdge[] {
  const highLevel = nodes.filter((item) =>
    [
      'agent_os_episode',
      'runtime_run',
      'supervisor_run',
      'communication_thread',
      'bluebubbles_thread',
      'life_thread',
      'world_claim',
      'logic_belief',
      'truth_audit',
    ].includes(item.nodeKind),
  );
  const existingPairs = new Set(
    edges.map((item) => [item.fromNodeId, item.toNodeId].sort().join(':')),
  );
  for (let outer = 0; outer < highLevel.length; outer += 1) {
    for (let inner = outer + 1; inner < highLevel.length; inner += 1) {
      const left = highLevel[outer];
      const right = highLevel[inner];
      if (left.nodeKind === right.nodeKind && left.nodeKind !== 'life_thread')
        continue;
      const pair = [left.nodeId, right.nodeId].sort().join(':');
      if (existingPairs.has(pair)) continue;
      const score = overlapScore(left.semanticText, right.semanticText);
      if (score < 0.22) continue;
      const accepted = score >= 0.42;
      const semanticEdge = edge({
        snapshotId,
        generatedAt,
        edgeKind: 'semantic_candidate',
        fromNodeId: left.nodeId,
        toNodeId: right.nodeId,
        confidence: Math.min(0.9, 0.45 + score),
        status: accepted ? 'accepted' : 'review_needed',
        reason: accepted
          ? 'Sanitized summaries share a strong non-generic theme.'
          : 'Sanitized summaries may refer to the same theme; review before treating as one thread.',
        evidenceIds: parseArray(left.evidenceIdsJson).concat(
          parseArray(right.evidenceIdsJson),
        ),
        reviewNeeded: !accepted,
      });
      addUnique(edges, semanticEdge);
      existingPairs.add(pair);
    }
  }
  return edges;
}

function clusterStatus(input: {
  nodes: SessionGraphNode[];
  staleProof: string[];
  approvals: string[];
  blockers: string[];
}): SessionCluster['status'] {
  if (input.approvals.length > 0 || input.blockers.length > 0) return 'blocked';
  if (input.staleProof.length > 0) return 'stale';
  if (input.nodes.some((item) => item.status.includes('review')))
    return 'review_needed';
  if (
    input.nodes.some((item) =>
      /active|open|running|awaiting/i.test(item.status),
    )
  ) {
    return 'active';
  }
  return 'quiet';
}

function buildClusters(
  nodes: NodeDraft[],
  edges: SessionGraphEdge[],
  snapshotId: string,
  generatedAt: string,
): SessionCluster[] {
  const union = new UnionFind();
  for (const item of nodes) union.add(item.nodeId);
  for (const item of edges) {
    if (item.status === 'accepted' && !item.reviewNeeded) {
      union.union(item.fromNodeId, item.toNodeId);
    }
  }
  const grouped = new Map<string, NodeDraft[]>();
  for (const item of nodes) {
    const root = union.find(item.nodeId);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)?.push(item);
  }
  return [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 80)
    .map(([root, groupedNodes], index): SessionCluster => {
      const nodeIds = groupedNodes.map((item) => item.nodeId);
      const clusterEdges = edges.filter(
        (item) =>
          nodeIds.includes(item.fromNodeId) && nodeIds.includes(item.toNodeId),
      );
      const surfaces = Array.from(
        new Set(
          groupedNodes
            .flatMap((item) => [item.channel, item.nodeKind])
            .filter((item): item is string => Boolean(item)),
        ),
      ).slice(0, 20);
      const blockers = groupedNodes
        .filter((item) =>
          /blocked|failed|externally_blocked|manual_action_required/i.test(
            item.status,
          ),
        )
        .map((item) => `${item.nodeKind}: ${item.summary}`)
        .slice(0, 8);
      const staleProof = groupedNodes
        .filter(
          (item) =>
            item.nodeKind === 'proof_state' &&
            !/healthy|live_proven/i.test(item.status),
        )
        .map((item) => item.summary)
        .slice(0, 8);
      const approvals = groupedNodes
        .filter((item) => /approval/i.test(`${item.status} ${item.summary}`))
        .map((item) => `${item.nodeKind}: ${item.summary}`)
        .slice(0, 8);
      const recent =
        groupedNodes
          .map((item) => item.updatedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || generatedAt;
      const themeNode =
        groupedNodes.find((item) =>
          [
            'runtime_run',
            'agent_os_episode',
            'communication_thread',
            'life_thread',
          ].includes(item.nodeKind),
        ) || groupedNodes[0];
      const bestNext =
        approvals[0] ||
        blockers[0] ||
        staleProof[0] ||
        groupedNodes.find((item) => item.summary !== 'No summary recorded.')
          ?.summary ||
        'Inspect linked session metadata.';
      return {
        clusterId: graphId('cluster', `${snapshotId}:${root}:${index}`),
        snapshotId,
        createdAt: generatedAt,
        updatedAt: recent,
        status: clusterStatus({
          nodes: groupedNodes,
          staleProof,
          approvals,
          blockers,
        }),
        currentTheme: sanitizeSummary(themeNode.summary, 640),
        nodeIdsJson: safeJson(nodeIds, 3200),
        edgeIdsJson: safeJson(
          clusterEdges.map((item) => item.edgeId),
          3200,
        ),
        linkedSurfacesJson: safeJson(surfaces, 2400),
        activeBlockersJson: safeJson(blockers, 2400),
        staleProofJson: safeJson(staleProof, 2400),
        openApprovalsJson: safeJson(approvals, 2400),
        lastMeaningfulActivityAt: recent,
        evidenceIdsJson: safeJson(
          Array.from(
            new Set(
              groupedNodes.flatMap((item) => parseArray(item.evidenceIdsJson)),
            ),
          ).slice(0, 80),
          3200,
        ),
        bestNextAction: sanitizeSummary(bestNext, 900),
        privacyJson: privacyJson(),
      };
    });
}

function buildSuggestions(
  clusters: SessionCluster[],
  nodes: NodeDraft[],
  edges: SessionGraphEdge[],
  snapshotId: string,
  generatedAt: string,
): SessionGraphSuggestion[] {
  const suggestions: SessionGraphSuggestion[] = [];
  const clusterByNode = new Map<string, SessionCluster>();
  for (const cluster of clusters) {
    for (const nodeId of parseArray(cluster.nodeIdsJson)) {
      clusterByNode.set(nodeId, cluster);
    }
  }

  const addSuggestion = (input: {
    kind: SessionGraphSuggestion['suggestionKind'];
    priority: number;
    status?: SessionGraphSuggestion['status'];
    summary: string;
    nextAction: string;
    sourceNodeIds: string[];
    evidenceIds?: string[];
    approvalRequired?: boolean;
  }) => {
    const cluster = input.sourceNodeIds
      .map((id) => clusterByNode.get(id))
      .find(Boolean);
    suggestions.push({
      suggestionId: graphId(
        'suggestion',
        `${snapshotId}:${input.kind}:${input.summary}:${input.sourceNodeIds.join(':')}`,
      ),
      snapshotId,
      clusterId: cluster?.clusterId || null,
      createdAt: generatedAt,
      suggestionKind: input.kind,
      priority: Math.max(0, Math.min(input.priority, 1)),
      status: input.status || 'open',
      summary: sanitizeSummary(input.summary, 900),
      nextAction: sanitizeSummary(input.nextAction, 900),
      sourceNodeIdsJson: safeJson(input.sourceNodeIds, 2400),
      evidenceIdsJson: safeJson(input.evidenceIds || [], 2400),
      approvalRequired: Boolean(input.approvalRequired),
      privacyJson: privacyJson(),
    });
  };

  for (const item of nodes) {
    if (
      (item.nodeKind === 'runtime_checkpoint' ||
        item.nodeKind === 'cognitive_checkpoint') &&
      /open|pending/i.test(item.status)
    ) {
      addSuggestion({
        kind: 'resume',
        priority: 0.88,
        summary: `Resume checkpoint linked to ${item.nodeKind}.`,
        nextAction: item.summary || 'Resume from the latest safe checkpoint.',
        sourceNodeIds: [item.nodeId],
        evidenceIds: parseArray(item.evidenceIdsJson),
      });
    }
    if (
      item.nodeKind === 'proof_state' &&
      !/healthy|live_proven/i.test(item.status)
    ) {
      const manual = /manual|external|needs_proof|near_live_only/i.test(
        item.status,
      );
      addSuggestion({
        kind: manual ? 'complete_proof' : 'verify',
        priority: manual ? 0.82 : 0.72,
        summary: item.summary,
        nextAction:
          refString(item, 'nextAction') ||
          extractEmbeddedNextAction(item.summary) ||
          'Complete the exact proof step shown by integration status.',
        sourceNodeIds: [item.nodeId],
      });
    }
    if (/approval/i.test(`${item.status} ${item.summary}`)) {
      addSuggestion({
        kind: 'resume',
        priority: 0.78,
        summary: `Open approval boundary in ${item.nodeKind}.`,
        nextAction:
          'Review the approval packet or resume token; do not auto-execute it.',
        sourceNodeIds: [item.nodeId],
        approvalRequired: true,
      });
    }
  }

  for (const item of edges.filter((candidate) => candidate.reviewNeeded)) {
    addSuggestion({
      kind: 'review_link',
      priority: 0.45,
      status: 'review_needed',
      summary: item.reason,
      nextAction:
        'Review this candidate continuity link before merging the sessions.',
      sourceNodeIds: [item.fromNodeId, item.toNodeId],
    });
  }

  if (suggestions.length === 0 && clusters[0]) {
    addSuggestion({
      kind: 'inspect_status',
      priority: 0.35,
      summary: 'No open continuity blocker was detected.',
      nextAction:
        'Inspect the largest cluster if you want to resume a prior goal.',
      sourceNodeIds: parseArray(clusters[0].nodeIdsJson).slice(0, 3),
    });
  }

  return suggestions
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 80);
}

function buildContinuityThreads(
  clusters: SessionCluster[],
  snapshotId: string,
  generatedAt: string,
): SessionContinuityThread[] {
  return clusters.slice(0, 40).map(
    (cluster, index): SessionContinuityThread => ({
      continuityThreadId: graphId(
        'continuity',
        `${snapshotId}:${cluster.clusterId}:${index}`,
      ),
      snapshotId,
      clusterId: cluster.clusterId,
      createdAt: generatedAt,
      updatedAt: cluster.updatedAt,
      title: sanitizeSummary(cluster.currentTheme, 240),
      status:
        cluster.status === 'review_needed'
          ? 'needs_review'
          : cluster.status === 'stale'
            ? 'stale'
            : cluster.status === 'quiet'
              ? 'resolved'
              : 'active',
      nodeIdsJson: cluster.nodeIdsJson,
      summary: sanitizeSummary(
        `${cluster.currentTheme} Surfaces: ${parseArray(cluster.linkedSurfacesJson).join(', ') || 'metadata'}.`,
        900,
      ),
      nextAction: cluster.bestNextAction,
      privacyJson: privacyJson(),
    }),
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function recencyBoost(
  value: string | null | undefined,
  generatedAt: string,
): number {
  if (!value) return 0;
  const then = Date.parse(value);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0;
  const ageHours = Math.max(0, (now - then) / 36e5);
  if (ageHours <= 1) return 0.12;
  if (ageHours <= 24) return 0.08;
  if (ageHours <= 72) return 0.04;
  return 0;
}

function continuityActionKind(
  suggestion: SessionGraphSuggestion,
): SessionContinuityActionKind {
  if (suggestion.suggestionKind === 'review_link')
    return 'review_candidate_link';
  if (suggestion.suggestionKind === 'verify') return 'run_safe_verification';
  if (suggestion.suggestionKind === 'complete_proof')
    return 'complete_manual_proof';
  if (suggestion.suggestionKind === 'resume' && suggestion.approvalRequired) {
    return 'review_approval';
  }
  if (suggestion.suggestionKind === 'resume') return 'resume_checkpoint';
  return 'inspect_cluster';
}

function continuityActionStatus(
  kind: SessionContinuityActionKind,
): SessionContinuityActionItem['status'] {
  if (kind === 'review_candidate_link') return 'review_needed';
  if (kind === 'review_approval') return 'blocked_by_approval';
  if (kind === 'complete_manual_proof') return 'needs_manual';
  return 'ready';
}

function continuityActionPriority(
  suggestion: SessionGraphSuggestion,
  kind: SessionContinuityActionKind,
): number {
  const text = `${suggestion.summary} ${suggestion.nextAction}`.toLowerCase();
  const baseByKind: Record<SessionContinuityActionKind, number> = {
    complete_manual_proof: 0.84,
    review_approval: 0.8,
    resume_checkpoint: 0.66,
    run_safe_verification: 0.62,
    inspect_cluster: 0.42,
    review_candidate_link: 0.26,
  };
  let priority = Math.max(suggestion.priority, baseByKind[kind]);
  if (/bluebubbles|imessage|messages bridge/.test(text)) priority += 0.16;
  if (/alexa/.test(text)) priority += 0.12;
  if (/telegram/.test(text)) priority += 0.08;
  if (/google calendar|calendar/.test(text)) priority += 0.04;
  if (
    /feature proof|near-live product|ordinary chat|daily guidance/.test(text)
  ) {
    priority -= 0.08;
  }
  if (/quota|rate limit|externally_blocked/.test(text)) priority -= 0.04;
  if (suggestion.approvalRequired) priority += 0.05;
  return clamp01(priority);
}

function normalizeActionKey(value: string): string {
  return sanitizeSummary(value, 300)
    .toLowerCase()
    .replace(/\bfp:[a-f0-9]{16}\b/g, 'fp')
    .replace(/session_graph:[a-z_]+:[a-f0-9]{16}/g, 'session_graph:id')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContinuityFocuses(
  clusters: SessionCluster[],
  generatedAt: string,
): SessionContinuityFocus[] {
  return clusters
    .map((cluster): SessionContinuityFocus => {
      const blockers = parseArray(cluster.activeBlockersJson);
      const staleProof = parseArray(cluster.staleProofJson);
      const approvals = parseArray(cluster.openApprovalsJson);
      const surfaces = parseArray(cluster.linkedSurfacesJson);
      const evidenceIds = parseArray(cluster.evidenceIdsJson);
      const statusBase: Record<SessionCluster['status'], number> = {
        blocked: 0.72,
        stale: 0.62,
        active: 0.56,
        review_needed: 0.44,
        quiet: 0.18,
      };
      const priority = clamp01(
        statusBase[cluster.status] +
          Math.min(0.12, blockers.length * 0.04) +
          Math.min(0.1, staleProof.length * 0.035) +
          Math.min(0.12, approvals.length * 0.05) +
          recencyBoost(cluster.lastMeaningfulActivityAt, generatedAt),
      );
      return {
        focusId: graphId('focus', `${cluster.snapshotId}:${cluster.clusterId}`),
        clusterId: cluster.clusterId,
        status: cluster.status,
        priority,
        title: sanitizeSummary(cluster.currentTheme, 220),
        linkedSurfaces: surfaces.slice(0, 10),
        blockers: blockers.slice(0, 5),
        staleProof: staleProof.slice(0, 5),
        approvals: approvals.slice(0, 5),
        lastMeaningfulActivityAt: cluster.lastMeaningfulActivityAt || null,
        bestNextAction: sanitizeSummary(cluster.bestNextAction, 640),
        evidenceIds: evidenceIds.slice(0, 30),
      };
    })
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 10);
}

function buildContinuityActions(
  suggestions: SessionGraphSuggestion[],
): SessionContinuityActionItem[] {
  type Draft = SessionContinuityActionItem & { count: number };
  const byKey = new Map<string, Draft>();
  for (const suggestion of suggestions) {
    const kind = continuityActionKind(suggestion);
    const status = continuityActionStatus(kind);
    const summaryStem =
      kind === 'complete_manual_proof'
        ? suggestion.summary.split('.').slice(0, 1).join('.')
        : suggestion.summary;
    const key = [
      kind,
      status,
      normalizeActionKey(summaryStem),
      normalizeActionKey(suggestion.nextAction),
    ].join('|');
    const sourceNodeIds = parseArray(suggestion.sourceNodeIdsJson);
    const evidenceIds = parseArray(suggestion.evidenceIdsJson);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.priority = Math.max(
        existing.priority,
        continuityActionPriority(suggestion, kind),
      );
      existing.sourceSuggestionIds = uniqueStrings(
        existing.sourceSuggestionIds.concat(suggestion.suggestionId),
      );
      existing.sourceNodeIds = uniqueStrings(
        existing.sourceNodeIds.concat(sourceNodeIds),
      );
      existing.evidenceIds = uniqueStrings(
        existing.evidenceIds.concat(evidenceIds),
      );
      existing.approvalRequired =
        existing.approvalRequired || suggestion.approvalRequired;
      if (!existing.clusterId && suggestion.clusterId)
        existing.clusterId = suggestion.clusterId;
      continue;
    }
    byKey.set(key, {
      actionId: graphId('action', key),
      kind,
      priority: continuityActionPriority(suggestion, kind),
      status,
      summary: sanitizeSummary(suggestion.summary, 560),
      nextAction: sanitizeSummary(suggestion.nextAction, 700),
      clusterId: suggestion.clusterId || null,
      sourceSuggestionIds: [suggestion.suggestionId],
      sourceNodeIds,
      evidenceIds,
      approvalRequired: suggestion.approvalRequired,
      count: 1,
    });
  }
  return [...byKey.values()]
    .map(({ count, ...action }) => ({
      ...action,
      summary:
        count > 1
          ? sanitizeSummary(
              `${count} related continuity items: ${action.summary}`,
              700,
            )
          : action.summary,
    }))
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 18);
}

export function buildSessionContinuityCockpit(input: {
  generatedAt: string;
  clusters: SessionCluster[];
  suggestions: SessionGraphSuggestion[];
  proofDebt: SessionGraphDoctorReport['proofDebt'];
  reviewNeededCount: number;
}): SessionContinuityCockpit {
  const focuses = buildContinuityFocuses(input.clusters, input.generatedAt);
  const actionQueue = buildContinuityActions(input.suggestions);
  const staleProof = actionQueue
    .filter(
      (item) =>
        item.kind === 'complete_manual_proof' ||
        item.kind === 'run_safe_verification',
    )
    .slice(0, 8);
  const approvalQueue = actionQueue
    .filter((item) => item.approvalRequired || item.kind === 'review_approval')
    .slice(0, 8);
  const reviewQueue = actionQueue
    .filter((item) => item.kind === 'review_candidate_link')
    .slice(0, 8);
  const firstUseful =
    actionQueue.find((item) => item.kind !== 'review_candidate_link') ||
    actionQueue[0];
  const nextAction =
    firstUseful?.nextAction ||
    focuses[0]?.bestNextAction ||
    'No continuity action is currently queued.';
  const status: SessionContinuityCockpit['status'] =
    input.clusters.length === 0
      ? 'empty'
      : firstUseful?.status === 'review_needed' || input.reviewNeededCount > 0
        ? 'needs_review'
        : 'ready';
  return {
    generatedAt: input.generatedAt,
    status,
    focusCount: focuses.length,
    actionCount: actionQueue.length,
    focuses,
    actionQueue,
    staleProof,
    approvalQueue,
    reviewQueue,
    proofDebt: input.proofDebt,
    reviewNeededCount: input.reviewNeededCount,
    nextAction,
    privacy: SESSION_GRAPH_PRIVACY,
  };
}

function sourceLedger(nodes: NodeDraft[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((acc, item) => {
    acc[item.nodeKind] = (acc[item.nodeKind] || 0) + 1;
    return acc;
  }, {});
}

function publicNode(record: NodeDraft): SessionGraphNode {
  const {
    linkKeys: _linkKeys,
    semanticText: _semanticText,
    ...safeRecord
  } = record;
  return safeRecord;
}

function groupFoldersFromSources(): string[] {
  const folders = new Set<string>(['main']);
  for (const groupFolder of Object.keys(getAllSessions())) {
    if (isValidGroupFolder(groupFolder)) folders.add(groupFolder);
  }
  for (const groupFolder of Object.keys(getAllAgentThreads())) {
    if (isValidGroupFolder(groupFolder)) folders.add(groupFolder);
  }
  for (const run of listAgentRuntimeRuns({
    cognitiveRunOrigin: 'live',
    limit: 100,
  })) {
    if (run.groupFolder && isValidGroupFolder(run.groupFolder)) {
      folders.add(run.groupFolder);
    }
  }
  return [...folders];
}

function emptyReport(generatedAt: string): SessionGraphDoctorReport {
  const snapshot: SessionGraphSnapshot = {
    snapshotId: graphId('snapshot', `empty:${generatedAt}`),
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status: 'empty',
    nodeCount: 0,
    edgeCount: 0,
    clusterCount: 0,
    suggestionCount: 0,
    sourceLedgerJson: safeJson({}),
    summary: 'Session Graph has no metadata yet.',
    nextAction:
      'Create or resume a task so the Session Graph has session metadata to connect.',
    privacyJson: privacyJson(),
  };
  return {
    generatedAt,
    ok: true,
    snapshot,
    nodes: [],
    edges: [],
    clusters: [],
    continuityThreads: [],
    linkDecisions: [],
    suggestions: [],
    proofDebt: { total: 0, stale: 0, manualProof: 0, safeReadOnly: 0 },
    cockpit: buildSessionContinuityCockpit({
      generatedAt,
      clusters: [],
      suggestions: [],
      proofDebt: { total: 0, stale: 0, manualProof: 0, safeReadOnly: 0 },
      reviewNeededCount: 0,
    }),
    reviewNeededCount: 0,
    nextAction: snapshot.nextAction,
    privacy: SESSION_GRAPH_PRIVACY,
  };
}

export function buildSessionGraphReport(
  options: SessionGraphBuildOptions = {},
): SessionGraphDoctorReport {
  const generatedAt = options.generatedAt || nowIso();
  if (!isDatabaseInitialized()) return emptyReport(generatedAt);
  const limit = Math.max(10, Math.min(options.limit || 120, 500));
  const snapshotId = graphId('snapshot', generatedAt);
  const groupFolders = groupFoldersFromSources();
  const nodes = [
    ...collectCoreNodes(snapshotId, generatedAt, limit),
    ...collectAgentCognitionNodes(snapshotId, generatedAt, limit),
    ...collectKnowledgeNodes(snapshotId, generatedAt, limit),
    ...collectCommunicationNodes(snapshotId, generatedAt, limit, groupFolders),
    ...collectProofNodes(snapshotId, generatedAt),
  ];

  let edges = addDeterministicEdges(nodes, snapshotId, generatedAt);
  edges = addSemanticEdges(nodes, edges, snapshotId, generatedAt);
  const clusters = buildClusters(nodes, edges, snapshotId, generatedAt);
  const suggestions = buildSuggestions(
    clusters,
    nodes,
    edges,
    snapshotId,
    generatedAt,
  );
  const continuityThreads = buildContinuityThreads(
    clusters,
    snapshotId,
    generatedAt,
  );
  const linkDecisions = edges.map((item) => linkDecision(item, generatedAt));
  const proofStatuses: IntegrationStatus[] =
    buildIntegrationDoctorReport().statuses;
  const proofDebt = proofStatuses.reduce(
    (acc, status) => {
      if (status.state !== 'healthy') {
        acc.total += 1;
        if (
          status.state === 'needs_proof' ||
          status.state === 'near_live_only'
        ) {
          acc.stale += 1;
        }
        if (
          status.blockerOwner === 'manual' ||
          status.blockerOwner === 'external'
        ) {
          acc.manualProof += 1;
        } else {
          acc.safeReadOnly += 1;
        }
      }
      return acc;
    },
    { total: 0, stale: 0, manualProof: 0, safeReadOnly: 0 },
  );
  const reviewNeededCount = edges.filter((item) => item.reviewNeeded).length;
  const cockpit = buildSessionContinuityCockpit({
    generatedAt,
    clusters,
    suggestions,
    proofDebt,
    reviewNeededCount,
  });
  const nextAction =
    cockpit.nextAction ||
    suggestions[0]?.nextAction ||
    clusters[0]?.bestNextAction ||
    'No continuity blocker was detected; inspect graph clusters for context.';
  const snapshot: SessionGraphSnapshot = {
    snapshotId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status:
      nodes.length === 0
        ? 'empty'
        : edges.length === 0
          ? 'partial'
          : 'compiled',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    clusterCount: clusters.length,
    suggestionCount: suggestions.length,
    sourceLedgerJson: safeJson(
      {
        ...sourceLedger(nodes),
        sourceRefs: SESSION_GRAPH_SOURCE_REFS,
      },
      3600,
    ),
    summary: sanitizeSummary(
      `Session Graph connected ${nodes.length} metadata nodes into ${clusters.length} continuity clusters.`,
      900,
    ),
    nextAction,
    privacyJson: privacyJson(),
  };

  if (options.persist !== false) {
    upsertSessionGraphSnapshot(snapshot);
    for (const item of nodes) upsertSessionGraphNode(item);
    for (const item of edges) upsertSessionGraphEdge(item);
    for (const item of clusters) upsertSessionCluster(item);
    for (const item of continuityThreads) upsertSessionContinuityThread(item);
    for (const item of suggestions) upsertSessionGraphSuggestion(item);
    for (const item of linkDecisions) upsertSessionGraphLinkDecision(item);
  }

  const publicNodes = nodes.map((item) => publicNode(item));

  return {
    generatedAt,
    ok: true,
    snapshot,
    nodes: publicNodes,
    edges,
    clusters,
    continuityThreads,
    linkDecisions,
    suggestions,
    proofDebt,
    cockpit,
    reviewNeededCount,
    nextAction,
    privacy: SESSION_GRAPH_PRIVACY,
  };
}

export function loadSessionGraphReport(
  snapshotId?: string | null,
): SessionGraphDoctorReport {
  const generatedAt = nowIso();
  if (!isDatabaseInitialized()) return emptyReport(generatedAt);
  const snapshot =
    (snapshotId
      ? listSessionGraphSnapshots({ limit: 1000 }).find(
          (item) => item.snapshotId === snapshotId,
        )
      : listSessionGraphSnapshots({ limit: 1 })[0]) ||
    buildSessionGraphReport({ generatedAt, persist: true }).snapshot;
  const nodes = listSessionGraphNodes({
    snapshotId: snapshot.snapshotId,
    limit: 5000,
  });
  const edges = listSessionGraphEdges({
    snapshotId: snapshot.snapshotId,
    limit: 5000,
  });
  const clusters = listSessionClusters({
    snapshotId: snapshot.snapshotId,
    limit: 1000,
  });
  const continuityThreads = listSessionContinuityThreads({
    snapshotId: snapshot.snapshotId,
    limit: 1000,
  });
  const linkDecisions = listSessionGraphLinkDecisions({
    snapshotId: snapshot.snapshotId,
    limit: 5000,
  });
  const suggestions = listSessionGraphSuggestions({
    snapshotId: snapshot.snapshotId,
    limit: 1000,
  });
  const proofDebt = {
    total: suggestions.filter(
      (item) => item.suggestionKind === 'complete_proof',
    ).length,
    stale: suggestions.filter(
      (item) => item.suggestionKind === 'complete_proof',
    ).length,
    manualProof: suggestions.filter(
      (item) =>
        item.suggestionKind === 'complete_proof' && item.approvalRequired,
    ).length,
    safeReadOnly: suggestions.filter((item) => item.suggestionKind === 'verify')
      .length,
  };
  const reviewNeededCount = edges.filter((item) => item.reviewNeeded).length;
  const cockpit = buildSessionContinuityCockpit({
    generatedAt,
    clusters,
    suggestions,
    proofDebt,
    reviewNeededCount,
  });
  return {
    generatedAt,
    ok: true,
    snapshot,
    nodes,
    edges,
    clusters,
    continuityThreads,
    linkDecisions,
    suggestions,
    proofDebt,
    cockpit,
    reviewNeededCount,
    nextAction:
      cockpit.nextAction || suggestions[0]?.nextAction || snapshot.nextAction,
    privacy: SESSION_GRAPH_PRIVACY,
  };
}

export function formatSessionContinuityCockpit(
  cockpit: SessionContinuityCockpit,
): string {
  return redactCouncilText(
    [
      'Continuity Cockpit',
      `Status: ${cockpit.status}; focus=${cockpit.focusCount}, actions=${cockpit.actionCount}, proofDebt=${cockpit.proofDebt.total}, reviewLinks=${cockpit.reviewNeededCount}`,
      '',
      'Top focus',
      ...(cockpit.focuses.slice(0, 4).length
        ? cockpit.focuses.slice(0, 4).map((focus) => {
            const surfaces = focus.linkedSurfaces.slice(0, 5).join(', ');
            return `- ${focus.status} (${focus.priority.toFixed(2)}): ${focus.title} (${surfaces || 'metadata'}). Next: ${focus.bestNextAction}`;
          })
        : ['- none yet']),
      '',
      'Action queue',
      ...(cockpit.actionQueue.slice(0, 6).length
        ? cockpit.actionQueue.slice(0, 6).map((action) => {
            const approval = action.approvalRequired
              ? ' approval-required'
              : '';
            return `- ${action.kind}/${action.status}${approval} (${action.priority.toFixed(2)}): ${action.nextAction}`;
          })
        : ['- no continuity action queued']),
      '',
      `Best next action: ${cockpit.nextAction}`,
      sessionGraphPrivacyStatement(),
    ].join('\n'),
    5000,
  );
}

export function formatSessionGraphReport(
  report: SessionGraphDoctorReport,
): string {
  const topClusters = report.clusters.slice(0, 4);
  const topActions = report.cockpit.actionQueue.slice(0, 5);
  return redactCouncilText(
    [
      'Session Graph',
      `Snapshot: ${report.snapshot.status}; nodes=${report.snapshot.nodeCount}, edges=${report.snapshot.edgeCount}, clusters=${report.snapshot.clusterCount}`,
      `Proof debt: ${report.proofDebt.total} total, ${report.proofDebt.stale} stale/proof-needed, ${report.reviewNeededCount} link(s) need review`,
      `Cockpit: ${report.cockpit.status}; focus=${report.cockpit.focusCount}, actions=${report.cockpit.actionCount}`,
      '',
      'Continuity clusters',
      ...(topClusters.length
        ? topClusters.map((cluster) => {
            const surfaces = parseArray(cluster.linkedSurfacesJson)
              .slice(0, 5)
              .join(', ');
            return `- ${cluster.status}: ${cluster.currentTheme} (${surfaces || 'metadata'}). Next: ${cluster.bestNextAction}`;
          })
        : ['- none yet']),
      '',
      'Suggested next safe actions',
      ...(topActions.length
        ? topActions.map(
            (action) =>
              `- ${action.kind}/${action.status}: ${action.nextAction}`,
          )
        : ['- Inspect status after the next meaningful turn.']),
      '',
      sessionGraphPrivacyStatement(),
    ].join('\n'),
    5000,
  );
}

export function sessionGraphPrivacyStatement(): string {
  return 'Privacy: metadata-only graph; no raw prompts, private message bodies, model deliberations, raw tool output, or secrets are stored.';
}

export function buildSessionGraphStatusText(): string {
  return formatSessionGraphReport(buildSessionGraphReport());
}

export function isSessionGraphNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'session graph status' ||
    normalized === 'continuity status' ||
    normalized === 'what sessions are connected?' ||
    normalized === 'what sessions are connected' ||
    normalized === 'what belongs together?' ||
    normalized === 'what belongs together' ||
    normalized === 'what are you working on?' ||
    normalized === 'resume that' ||
    normalized === 'what should you verify next?' ||
    normalized === 'why did you choose that?' ||
    /\b(session graph|continuity layer|connected sessions|belongs together)\b/i.test(
      normalized,
    )
  );
}
