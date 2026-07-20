import { createHash, randomUUID } from 'node:crypto';

import type { AssistantCapabilityId } from './assistant-capabilities.js';
import {
  ADAPTIVE_COGNITION_VERSION,
  buildAdaptivePlanGraph,
  createAdaptiveProblemFrame,
  type AdaptiveActionCandidate,
} from './adaptive-cognition-engine.js';
import {
  continueAssistantCapabilityFromPriorSubjectData,
  matchAssistantCapabilityRequest,
  type AssistantCapabilityContinuationSubjectData,
  type AssistantCapabilityMatch,
} from './assistant-capability-router.js';
import { redactCouncilText } from './council-safety.js';
import type { SelectedWorkContext } from './daily-command-center.js';
import {
  getAllTasks,
  isDatabaseInitialized,
  listActionBundlesForGroup,
  listCognitiveExecutiveRuns,
  listCognitiveExecutiveToolChoices,
  listCognitiveReflectionSignals,
  listCognitiveWorldSnapshots,
  listCommunicationThreadsForGroup,
  listEverydayListItems,
  listLearningDistillations,
  listLifeThreadsForGroup,
  listMessageActionsForGroup,
  listMissionsForGroup,
  listOutcomesForGroup,
  listSkillPlaybooks,
  listWorldFacts,
  upsertCognitiveExecutiveRun,
  upsertCognitiveExecutiveToolChoice,
  upsertCognitiveReflectionSignal,
  upsertCognitiveWorldSnapshot,
} from './db.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import {
  analyzeMetacognitiveTurn,
  buildMetacognitionDoctorReport,
  type MetacognitiveTurnAnalysis,
} from './metacognition.js';
import { scoreRouteCandidate } from './tool-reliability.js';
import type {
  CognitiveExecutiveChannel,
  CognitiveExecutiveDoctorReport,
  CognitiveExecutiveIntentFamily,
  CognitiveExecutiveRouteClass,
  CognitiveExecutiveRunRecord,
  CognitiveExecutiveToolChoice,
  CognitiveExecutiveToolId,
  CognitiveExplanation,
  CognitivePlan,
  CognitivePlanStep,
  CognitiveReflectionSignal,
  CognitiveRequest,
  CognitiveResult,
  CognitiveState,
  CognitiveWorkspaceContextBlock,
  CognitiveWorldSnapshot,
  CognitiveWorldSnapshotItem,
  NewMessage,
  PersonalContextPacket,
} from './types.js';
import {
  describeLifeThreadCommitment,
  projectEffectiveLifeThread,
  shouldProactivelySurfaceCommitment,
} from './life-thread-commitment.js';
import { resolveLifeThreadTimeZone } from './life-threads.js';

export interface BeginCognitiveExecutiveInput {
  rawAsk: string;
  channel: CognitiveExecutiveChannel;
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  actorId?: string | null;
  turnId?: string | null;
  requestRoute?: string | null;
  selectedWork?: SelectedWorkContext | null;
  activeContextSummary?: string | null;
  priorSubjectData?: Record<string, unknown> | null;
  replyTo?: NewMessage['reply_to'] | null;
  integrationReport?: IntegrationDoctorReport;
  capabilityMatchOverride?: AssistantCapabilityMatch | null;
  now?: Date;
  persist?: boolean;
  personalContextPacket?: PersonalContextPacket | null;
}

export interface CognitiveExecutiveContext {
  request: CognitiveRequest;
  state: CognitiveState;
  plan: CognitivePlan;
  result: CognitiveResult;
  run: CognitiveExecutiveRunRecord;
  snapshot: CognitiveWorldSnapshot;
  snapshotItems: CognitiveWorldSnapshotItem[];
  toolChoices: CognitiveExecutiveToolChoice[];
  explanation: CognitiveExplanation;
  capabilityMatch?: AssistantCapabilityMatch | null;
  metacognition?: MetacognitiveTurnAnalysis | null;
  personalContextPacket?: PersonalContextPacket | null;
}

export interface FinalizeCognitiveExecutiveInput {
  context?: CognitiveExecutiveContext | null;
  status?: CognitiveResult['status'];
  resultSummary?: string | null;
  changedSummary?: string | null;
  openSummary?: string | null;
  failureSummary?: string | null;
  fallbackUsed?: boolean;
  blockerClass?: string | null;
  nextAction?: string | null;
  now?: Date;
  persist?: boolean;
}

export const COGNITIVE_EXECUTIVE_PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  secretsRedacted: true,
} as const;

const EXECUTIVE_INTENTS = new Set<CognitiveExecutiveIntentFamily>([
  'next_action',
  'loose_ends',
  'plan_tonight',
  'open_loops',
  'reply_help',
  'save_for_later',
  'list_status',
  'ambiguous_action',
  'explain_choice',
]);

const MUTATING_ACTION_RE =
  /\b(send|sent|delete|remove|buy|purchase|order|commit|push|restart|stop service|change service|create event|add (?:that|it|this) to (?:my )?calendar|schedule (?:that|it|this)|cancel)\b/i;

const SECRET_OR_PRIVATE_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought/i;

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/(^|[\s([{-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeText(value: string | null | undefined, limit = 640): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (SECRET_OR_PRIVATE_RE.test(normalized)) {
    return '[redacted executive metadata]';
  }
  return redactCouncilText(normalized, limit);
}

function safeJson(value: unknown, limit = 6000): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            preview: json.slice(0, Math.max(32, limit - 120)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function safeIdArrayJson(
  values: Array<string | null | undefined>,
  limit = 3200,
): string {
  const ids = Array.from(
    new Set(
      values
        .map((value) =>
          String(value || '')
            .replace(/[^A-Za-z0-9:_-]+/g, '_')
            .slice(0, 220),
        )
        .filter(Boolean),
    ),
  );
  const json = JSON.stringify(ids);
  if (json.length <= limit) return json;
  return JSON.stringify({ truncated: true, ids: ids.slice(0, 24) });
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function privacyJson(): string {
  return safeJson(COGNITIVE_EXECUTIVE_PRIVACY, 1200);
}

function summarizeAsk(input: {
  text: string;
  channel: CognitiveExecutiveChannel;
  intentFamily: CognitiveExecutiveIntentFamily;
}): string {
  const wordCount = normalizeText(input.text)
    .split(/\s+/)
    .filter(Boolean).length;
  const hasReference = /\b(that|this|it|here|reply|thread|message)\b/i.test(
    input.text,
  );
  return `User asked for ${input.intentFamily} on ${input.channel}; shape=${wordCount}_words; reference=${hasReference ? 'yes' : 'no'}.`;
}

export function detectCognitiveExecutiveIntent(rawText: string): {
  family: CognitiveExecutiveIntentFamily;
  confidence: number;
  reason: string;
} {
  const text = normalizeText(rawText).toLowerCase();
  if (!text) return { family: 'other', confidence: 0, reason: 'empty ask' };
  if (
    /\b(why did you suggest that|why did you choose|what are you using to decide|why didn'?t you|why are you bringing that up|current focus)\b/.test(
      text,
    )
  ) {
    return {
      family: 'explain_choice',
      confidence: 0.92,
      reason: 'matched executive explanation wording',
    };
  }
  if (
    /^(send me the full(?:er)? version|what('?s| is) blocking this|what('?s| is) the blocker|handle this|handle that|take care of this|take care of that|deal with this|deal with that)\b/.test(
      text,
    )
  ) {
    return {
      family: 'ambiguous_action',
      confidence: 0.88,
      reason: 'matched reference-bound action ask',
    };
  }
  if (
    /^(what should i do next|what'?s next|whats next|what is next)\b/.test(text)
  ) {
    return {
      family: 'next_action',
      confidence: 0.94,
      reason: 'matched next-action ask',
    };
  }
  if (
    /^(what am i forgetting|what am i probably missing|what should i not forget|tell me what i'?m forgetting|anything i should know)\b/.test(
      text,
    )
  ) {
    return {
      family: 'loose_ends',
      confidence: 0.94,
      reason: 'matched loose-ends ask',
    };
  }
  if (
    /\b(help me plan tonight|plan tonight|walk me through tonight|tonight under control)\b/.test(
      text,
    )
  ) {
    return {
      family: 'plan_tonight',
      confidence: 0.93,
      reason: 'matched tonight planning ask',
    };
  }
  if (
    /^(what'?s still open|whats still open|what is still open|what do i owe people|what texts need me)\b/.test(
      text,
    )
  ) {
    return {
      family: 'open_loops',
      confidence: 0.9,
      reason: 'matched open-loop ask',
    };
  }
  if (
    /^(what should i say back|what should i send back|draft a reply|draft a response|give me a short reply)\b/.test(
      text,
    )
  ) {
    return {
      family: 'reply_help',
      confidence: 0.95,
      reason: 'matched reply-help ask',
    };
  }
  if (
    /^(save that|save this|save it|save that for later|remember that for later|capture that)\b/.test(
      text,
    )
  ) {
    return {
      family: 'save_for_later',
      confidence: 0.88,
      reason: 'matched save-for-later ask',
    };
  }
  if (
    /^(what'?s on my list|whats on my list|what do i still need|what do we need|show me my list|what errands|what bills)\b/.test(
      text,
    )
  ) {
    return {
      family: 'list_status',
      confidence: 0.9,
      reason: 'matched list/status ask',
    };
  }
  if (
    /^(handle this for me|can you handle this|take care of this|do this for me|deal with this)\b/.test(
      text,
    )
  ) {
    return {
      family: 'ambiguous_action',
      confidence: 0.86,
      reason: 'matched ambiguous action ask',
    };
  }
  return {
    family: 'other',
    confidence: 0.25,
    reason: 'outside initial executive flow set',
  };
}

export function isCognitiveExecutiveCandidate(rawText: string): boolean {
  const detected = detectCognitiveExecutiveIntent(rawText);
  return EXECUTIVE_INTENTS.has(detected.family) && detected.family !== 'other';
}

export function isCognitiveExecutiveNaturalRequest(rawText: string): boolean {
  return /\b(cognitive executive|executive loop|why did you suggest that|what are you using to decide|why didn'?t you add it to my calendar|why are you bringing that up|current focus)\b/i.test(
    rawText,
  );
}

function routeClassForCapability(
  capabilityId: AssistantCapabilityId | null | undefined,
): CognitiveExecutiveRouteClass {
  if (!capabilityId) return 'clarify';
  if (capabilityId.startsWith('daily.')) return 'daily_companion';
  if (capabilityId.startsWith('staff.')) return 'chief_of_staff';
  if (capabilityId.startsWith('missions.')) return 'missions';
  if (capabilityId.startsWith('communication.'))
    return 'communication_companion';
  if (capabilityId.startsWith('capture.')) return 'everyday_capture';
  if (capabilityId.startsWith('knowledge.')) return 'knowledge_library';
  if (capabilityId.startsWith('research.')) return 'research';
  if (capabilityId.startsWith('work.')) return 'work_cockpit';
  if (capabilityId.startsWith('followthrough.')) return 'message_actions';
  return 'direct_answer';
}

function toolForRoute(
  routeClass: CognitiveExecutiveRouteClass,
): CognitiveExecutiveToolId {
  switch (routeClass) {
    case 'daily_companion':
    case 'chief_of_staff':
      return 'reminders';
    case 'missions':
      return 'missions';
    case 'communication_companion':
      return 'communication_companion';
    case 'everyday_capture':
      return 'everyday_capture';
    case 'knowledge_library':
      return 'knowledge_library';
    case 'research':
      return 'research';
    case 'message_actions':
      return 'message_actions';
    case 'work_cockpit':
      return 'work_cockpit';
    case 'telegram_handoff':
      return 'telegram_handoff';
    case 'clarify':
      return 'clarifying_question';
    default:
      return 'local_direct_answer';
  }
}

function approvalRequiredFor(input: {
  text: string;
  routeClass: CognitiveExecutiveRouteClass;
  capabilityId?: AssistantCapabilityId | null;
}): boolean {
  if (MUTATING_ACTION_RE.test(input.text)) return true;
  if (input.routeClass === 'message_actions') return true;
  if (
    input.capabilityId === 'missions.execute' ||
    input.capabilityId === 'capture.convert_item'
  ) {
    return true;
  }
  return false;
}

function statusForTool(
  toolId: CognitiveExecutiveToolId,
  integrationReport: IntegrationDoctorReport,
): CognitiveExecutiveToolChoice['status'] {
  const statuses = integrationReport.statuses;
  const findState = (ids: string[]) =>
    statuses.find((status) =>
      ids.some((id) => status.integrationId.includes(id)),
    )?.state;
  const state =
    toolId === 'research'
      ? findState(['research', 'brave'])
      : toolId === 'calendar'
        ? findState(['calendar'])
        : toolId === 'communication_companion' || toolId === 'message_actions'
          ? findState(['bluebubbles'])
          : toolId === 'telegram_handoff'
            ? findState(['telegram'])
            : 'healthy';
  if (!state || state === 'healthy') return 'available';
  if (
    state === 'needs_proof' ||
    state === 'near_live_only' ||
    state === 'degraded_but_usable'
  ) {
    return 'degraded';
  }
  return 'blocked';
}

function degradedToolsFromIntegration(
  integrationReport: IntegrationDoctorReport,
): Array<{ toolId: CognitiveExecutiveToolId; status: IntegrationStatus }> {
  const map: Array<[CognitiveExecutiveToolId, string[]]> = [
    ['calendar', ['google_calendar']],
    ['communication_companion', ['bluebubbles']],
    ['message_actions', ['bluebubbles']],
    ['research', ['research', 'brave_search']],
    ['telegram_handoff', ['telegram']],
  ];
  return map.flatMap(([toolId, ids]) => {
    const match = integrationReport.statuses.find((status) =>
      ids.includes(status.integrationId),
    );
    return match && match.state !== 'healthy'
      ? [{ toolId, status: match }]
      : [];
  });
}

function makeItem(input: {
  snapshotId: string;
  itemKind: CognitiveWorldSnapshotItem['itemKind'];
  sourceId: string;
  summary: string;
  priority: number;
  confidence?: number;
  freshness?: CognitiveWorldSnapshotItem['freshness'];
  reasonUsed: string;
  sourceIds?: string[];
  reasonOmitted?: string | null;
}): CognitiveWorldSnapshotItem {
  return {
    itemId: hashId(
      'cogexec:item',
      `${input.snapshotId}|${input.itemKind}|${input.sourceId}`,
    ),
    itemKind: input.itemKind,
    sourceId: input.sourceId.replace(/[^A-Za-z0-9:_-]+/g, '_').slice(0, 220),
    sourceIdsJson: safeIdArrayJson(input.sourceIds || [input.sourceId]),
    summary: safeText(input.summary, 360),
    freshness: input.freshness || 'recent',
    confidence: clamp01(input.confidence ?? 0.72),
    priority: clamp01(input.priority),
    reasonUsed: safeText(input.reasonUsed, 220),
    reasonOmitted: input.reasonOmitted
      ? safeText(input.reasonOmitted, 220)
      : null,
  };
}

export function buildCognitiveWorldSnapshot(input: {
  groupFolder: string;
  intentFamily?: CognitiveExecutiveIntentFamily;
  selectedWork?: SelectedWorkContext | null;
  integrationReport?: IntegrationDoctorReport;
  now?: Date;
  persist?: boolean;
  personalContextPacket?: PersonalContextPacket | null;
}): { snapshot: CognitiveWorldSnapshot; items: CognitiveWorldSnapshotItem[] } {
  const createdAt = nowIso(input.now);
  const snapshotNow = input.now || new Date(createdAt);
  const snapshotId = hashId(
    'cogexec:snapshot',
    `${input.groupFolder}|${createdAt}|${input.intentFamily || 'general'}`,
  );
  const integrationReport =
    input.integrationReport || buildIntegrationDoctorReport({ now: input.now });
  const items: CognitiveWorldSnapshotItem[] = [];

  const conflictedItemIds = new Set(
    (input.personalContextPacket?.conflicts || []).flatMap(
      (conflict) => conflict.itemIds,
    ),
  );
  for (const contextItem of input.personalContextPacket?.items || []) {
    const conflicted = conflictedItemIds.has(contextItem.itemId);
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'personal_context',
        sourceId: contextItem.citation,
        sourceIds: [contextItem.itemId, contextItem.citation],
        summary: contextItem.summary,
        freshness:
          contextItem.freshness === 'fresh'
            ? 'fresh'
            : contextItem.freshness === 'stale'
              ? 'stale'
              : 'unknown',
        confidence: conflicted
          ? Math.min(contextItem.confidence, 0.45)
          : contextItem.confidence,
        priority: conflicted
          ? Math.min(contextItem.score || 0.5, 0.45)
          : contextItem.score || 0.62,
        reasonUsed: conflicted
          ? 'personal context conflict requires clarification before reliance'
          : 'cited personal context is relevant to this turn',
      }),
    );
  }

  const safeList = <T>(fn: () => T[], fallback: T[] = []): T[] => {
    try {
      return isDatabaseInitialized() ? fn() : fallback;
    } catch {
      return fallback;
    }
  };

  if (
    input.selectedWork &&
    !/^(done|completed|cancelled|canceled)$/i.test(
      input.selectedWork.statusLabel,
    )
  ) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'selected_work',
        sourceId: `work:${input.selectedWork.title}`,
        summary: `Current work: ${input.selectedWork.title} (${input.selectedWork.statusLabel}).`,
        priority: input.intentFamily === 'next_action' ? 0.94 : 0.88,
        confidence: 0.8,
        freshness: 'fresh',
        reasonUsed: 'selected current work is active',
      }),
    );
  }

  for (const task of safeList(() =>
    getAllTasks()
      .filter(
        (candidate) =>
          candidate.group_folder === input.groupFolder &&
          candidate.status === 'active',
      )
      .slice(0, 5),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'reminder',
        sourceId: task.id,
        summary: `Reminder active; next run ${task.next_run || 'not scheduled'}.`,
        priority: task.next_run ? 0.78 : 0.54,
        freshness: 'recent',
        reasonUsed: 'active reminder can affect next-action guidance',
      }),
    );
  }

  for (const thread of safeList(() =>
    listCommunicationThreadsForGroup({
      groupFolder: input.groupFolder,
      followupStates: ['reply_needed', 'scheduled', 'waiting_on_them'],
      limit: 5,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'communication_thread',
        sourceId: thread.id,
        summary: `${thread.title}: ${thread.followupState}; urgency ${thread.urgency}.`,
        priority:
          thread.followupState === 'reply_needed'
            ? 0.9
            : thread.urgency === 'tonight' || thread.urgency === 'overdue'
              ? 0.84
              : 0.62,
        freshness: 'recent',
        reasonUsed: 'open communication loop',
      }),
    );
  }

  for (const mission of safeList(() =>
    listMissionsForGroup({
      groupFolder: input.groupFolder,
      statuses: ['active', 'blocked', 'proposed'],
      includeUnconfirmed: true,
      limit: 5,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'mission',
        sourceId: mission.missionId,
        summary: `${mission.title}: ${mission.status}.`,
        priority: mission.status === 'blocked' ? 0.86 : 0.74,
        freshness: 'recent',
        reasonUsed: 'mission can provide plan/action context',
      }),
    );
  }

  for (const thread of safeList(() =>
    listLifeThreadsForGroup(input.groupFolder, ['active', 'paused'])
      .map((candidate) => projectEffectiveLifeThread(candidate, snapshotNow))
      .filter((candidate) =>
        shouldProactivelySurfaceCommitment(candidate, snapshotNow),
      )
      .slice(0, 5),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'life_thread',
        sourceId: thread.id,
        summary: `${thread.title}: ${describeLifeThreadCommitment(
          thread,
          snapshotNow,
          resolveLifeThreadTimeZone(thread.groupFolder),
        )}`,
        priority: 0.76,
        freshness: 'recent',
        reasonUsed: 'life thread may be the current focus',
      }),
    );
  }

  for (const bundle of safeList(() =>
    listActionBundlesForGroup({
      groupFolder: input.groupFolder,
      statuses: ['open', 'partially_done'],
      limit: 4,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'action_bundle',
        sourceId: bundle.bundle.bundleId,
        summary: `${bundle.bundle.title}: ${bundle.actions.filter((action) => action.status !== 'executed').length} open action(s).`,
        priority: 0.82,
        freshness: 'fresh',
        reasonUsed: 'open follow-through review is resumable',
      }),
    );
  }

  for (const item of safeList(() =>
    listEverydayListItems(input.groupFolder, {
      states: ['open', 'snoozed', 'deferred'],
      limit: 6,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'list_item',
        sourceId: item.itemId,
        summary: `${item.title}: ${item.state}.`,
        priority:
          input.intentFamily === 'list_status' ||
          item.scope === 'household' ||
          item.dueAt
            ? 0.78
            : 0.45,
        freshness: 'recent',
        reasonUsed: 'open list item',
      }),
    );
  }

  for (const action of safeList(() =>
    listMessageActionsForGroup({
      groupFolder: input.groupFolder,
      statuses: ['drafted', 'approved', 'deferred', 'failed'],
      limit: 4,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'message_action',
        sourceId: action.messageActionId,
        summary: `Message action ${action.sendStatus}; approval=${action.requiresApproval ? 'yes' : 'no'}.`,
        priority: action.requiresApproval ? 0.86 : 0.7,
        freshness: 'fresh',
        reasonUsed: 'message action may need approval or follow-up',
      }),
    );
  }

  for (const outcome of safeList(() =>
    listOutcomesForGroup({
      groupFolder: input.groupFolder,
      statuses: ['partial', 'failed', 'deferred', 'unknown'],
      limit: 5,
      now: createdAt,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'outcome',
        sourceId: outcome.outcomeId,
        summary: `${outcome.sourceType}: ${outcome.status}; ${outcome.nextFollowupText || outcome.blockerText || 'needs review'}.`,
        priority: outcome.status === 'failed' ? 0.84 : 0.62,
        freshness: 'recent',
        reasonUsed: 'recent outcome can improve route choice',
      }),
    );
  }

  for (const fact of safeList(() =>
    listWorldFacts({
      groupFolder: input.groupFolder,
      statuses: ['confirmed', 'suggested', 'pending_confirmation', 'stale'],
      limit: 8,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'world_fact',
        sourceId: fact.factId,
        summary: `${fact.factType}: ${fact.summary}`,
        priority:
          fact.status === 'confirmed'
            ? 0.82
            : fact.status === 'pending_confirmation'
              ? 0.56
              : fact.status === 'stale'
                ? 0.42
                : 0.5,
        confidence: fact.confidence,
        freshness: fact.status === 'stale' ? 'stale' : 'recent',
        reasonUsed:
          fact.status === 'confirmed'
            ? 'confirmed learned world fact'
            : 'learned fact is reviewable and not treated as certain',
      }),
    );
  }

  for (const skill of safeList(() =>
    listSkillPlaybooks({
      groupFolder: input.groupFolder,
      statuses: ['active', 'suggested'],
      limit: 6,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'skill_playbook',
        sourceId: skill.skillId,
        summary: `${skill.status} skill: ${skill.title}.`,
        priority: skill.status === 'active' ? 0.8 : 0.48,
        confidence: skill.reliabilityScore,
        freshness: 'recent',
        reasonUsed:
          skill.status === 'active'
            ? 'active learned skill can shape the route'
            : 'suggested skill is visible but not automatic',
      }),
    );
  }

  for (const learning of safeList(() =>
    listLearningDistillations({
      groupFolder: input.groupFolder,
      statuses: ['suggested', 'pending_confirmation'],
      limit: 5,
    }),
  )) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'learning_candidate',
        sourceId: learning.distillationId,
        summary: `${learning.outputKind}: ${learning.summary}`,
        priority: learning.status === 'pending_confirmation' ? 0.58 : 0.44,
        confidence: learning.status === 'pending_confirmation' ? 0.64 : 0.52,
        freshness: 'recent',
        reasonUsed: 'pending learning can improve future routing after review',
      }),
    );
  }

  const degradedForSnapshot = degradedToolsFromIntegration(
    integrationReport,
  ).filter(
    (item, index, array) =>
      array.findIndex(
        (candidate) =>
          candidate.status.integrationId === item.status.integrationId,
      ) === index,
  );
  for (const degraded of degradedForSnapshot) {
    items.push(
      makeItem({
        snapshotId,
        itemKind: 'integration',
        sourceId: degraded.status.integrationId,
        summary: `${degraded.status.label}: ${degraded.status.state}. Next: ${degraded.status.nextAction || 'status only'}.`,
        priority:
          degraded.status.state === 'needs_proof' ||
          degraded.status.state === 'manual_action_required'
            ? 0.9
            : 0.72,
        freshness: 'fresh',
        reasonUsed: 'degraded integration affects tool choice',
      }),
    );
  }

  const ranked = items.sort((a, b) => b.priority - a.priority);
  const used = ranked.slice(0, 10);
  const omitted = ranked.slice(10);
  const degradedTools = degradedToolsFromIntegration(integrationReport).map(
    (item) => ({
      toolId: item.toolId,
      state: item.status.state,
      nextAction: item.status.nextAction,
    }),
  );
  const snapshot: CognitiveWorldSnapshot = {
    snapshotId,
    createdAt,
    groupFolder: input.groupFolder,
    status:
      ranked.length === 0
        ? 'empty'
        : degradedTools.length > 0
          ? 'needs_verification'
          : 'ready',
    currentFocus:
      used[0]?.summary || 'No active focus found in bounded snapshot.',
    itemsJson: safeJson(used, 6000),
    usedItemIdsJson: safeIdArrayJson(used.map((item) => item.itemId)),
    omittedItemIdsJson: safeIdArrayJson(omitted.map((item) => item.itemId)),
    degradedToolsJson: safeJson(degradedTools, 2400),
    evidenceIdsJson: safeIdArrayJson(
      used.flatMap((item) => [item.itemId, item.sourceId]),
    ),
    nextAction:
      used[0]?.summary ||
      'Ask one clarifying question or answer directly with current context.',
    privacyJson: privacyJson(),
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertCognitiveWorldSnapshot(snapshot);
  }
  return { snapshot, items: used };
}

function buildRequest(input: BeginCognitiveExecutiveInput): CognitiveRequest {
  const createdAt = nowIso(input.now);
  const detected = detectCognitiveExecutiveIntent(input.rawAsk);
  return {
    requestId: hashId(
      'cogexec:request',
      `${input.turnId || randomUUID()}|${createdAt}`,
    ),
    createdAt,
    rawAsk: input.rawAsk,
    normalizedAsk: normalizeText(input.rawAsk),
    channel: input.channel,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid || null,
    threadId: input.threadId || null,
    actorId: input.actorId || null,
    activeContextSummary: input.activeContextSummary
      ? safeText(input.activeContextSummary, 360)
      : null,
    intentFamily: detected.family,
    confidence: detected.confidence,
  };
}

function selectCapability(input: {
  request: CognitiveRequest;
  priorSubjectData?: Record<string, unknown> | null;
  override?: AssistantCapabilityMatch | null;
}): AssistantCapabilityMatch | null {
  if (input.override) return input.override;
  const continuation = input.priorSubjectData
    ? continueAssistantCapabilityFromPriorSubjectData(
        input.request.normalizedAsk,
        input.priorSubjectData as AssistantCapabilityContinuationSubjectData,
      )
    : null;
  if (continuation) {
    return {
      ...continuation,
      reason: `${continuation.reason}; cognitive executive used active context`,
    };
  }
  if (input.request.intentFamily === 'ambiguous_action') return null;
  if (input.request.intentFamily === 'explain_choice') return null;
  const direct = matchAssistantCapabilityRequest(input.request.normalizedAsk);
  if (direct) return direct;
  if (input.request.intentFamily === 'save_for_later') {
    return null;
  }
  return null;
}

function concreteClarifyingQuestion(request: CognitiveRequest): string {
  const text = request.normalizedAsk.toLowerCase();
  if (/^send me the full(?:er)? version\b/.test(text)) {
    return 'What should I send the full version of?';
  }
  if (
    /^what('?s| is) blocking this\b/.test(text) ||
    /^what('?s| is) the blocker\b/.test(text)
  ) {
    return 'Which plan, thread, or task should I check for the blocker?';
  }
  if (
    /^(handle this|handle that|take care of this|take care of that|deal with this|deal with that)\b/.test(
      text,
    )
  ) {
    return 'What should I handle, and should I keep it to a draft for approval?';
  }
  return 'What target should I use for this?';
}

function buildPlan(input: {
  request: CognitiveRequest;
  snapshot: CognitiveWorldSnapshot;
  snapshotItems: CognitiveWorldSnapshotItem[];
  capabilityMatch: AssistantCapabilityMatch | null;
  integrationReport: IntegrationDoctorReport;
  metacognition?: MetacognitiveTurnAnalysis | null;
}): { plan: CognitivePlan; toolChoices: CognitiveExecutiveToolChoice[] } {
  const capabilityId = input.capabilityMatch?.capabilityId || null;
  let routeClass = routeClassForCapability(capabilityId);
  if (input.request.intentFamily === 'ambiguous_action' && !capabilityId) {
    routeClass = 'clarify';
  }
  if (input.metacognition?.decision.mode === 'clarify_first') {
    routeClass = 'clarify';
  }
  if (input.request.intentFamily === 'explain_choice') {
    routeClass = 'direct_answer';
  }
  const selectedTool = toolForRoute(routeClass);
  const approvalRequired =
    approvalRequiredFor({
      text: input.request.normalizedAsk,
      routeClass,
      capabilityId,
    }) ||
    input.metacognition?.calibration.actionAllowed === 'approval_only' ||
    input.metacognition?.decision.approvalRequirement === 'approval_required';
  const selectedToolStatus = approvalRequired
    ? 'approval_required'
    : statusForTool(selectedTool, input.integrationReport);
  const selectedRiskFlags = [
    ...(approvalRequired ? ['approval_required'] : []),
    ...(selectedToolStatus === 'degraded' ? ['tool_degraded'] : []),
    ...(selectedToolStatus === 'blocked' ? ['tool_blocked'] : []),
  ];
  const baseConfidence =
    input.capabilityMatch || routeClass === 'direct_answer'
      ? input.request.confidence
      : Math.min(input.request.confidence, 0.58);
  const provisionalRouteKey =
    capabilityId || `cognitive_executive.${routeClass}`;
  const routeScore = scoreRouteCandidate({
    routeKey: provisionalRouteKey,
    channel: input.request.channel,
    baseConfidence,
  });
  if (routeScore.cap < baseConfidence) {
    selectedRiskFlags.push('confidence_capped_by_reliability');
  }
  if (input.metacognition?.warnings.length) {
    selectedRiskFlags.push(
      ...input.metacognition.warnings.map(
        (warning) => `metacognition:${warning.warningKind}`,
      ),
    );
  }
  const reliabilityReason = routeScore.reasons.join(' ');
  const reliabilityFallback =
    routeScore.fallbackRoute ||
    (selectedToolStatus === 'blocked'
      ? 'clarify_or_local_direct_answer'
      : routeClass === 'clarify'
        ? 'ask_one_clarifying_question'
        : null);
  const usedContext = input.snapshotItems.slice(0, 5).map((item) => ({
    id: item.itemId,
    kind: item.itemKind,
    reason: item.reasonUsed,
  }));
  const ignoredContext = input.snapshotItems.slice(5).map((item) => ({
    id: item.itemId,
    kind: item.itemKind,
    reason: 'lower priority for this turn',
  }));
  const steps: CognitivePlanStep[] = [
    {
      stepId: hashId('cogexec:step', `${input.request.requestId}|observe`),
      order: 1,
      label: 'Observe current bounded context.',
      toolId: 'local_direct_answer',
      policyClass: 'read_only',
      expectedOutput: 'Cognitive request and compact world snapshot.',
    },
    {
      stepId: hashId('cogexec:step', `${input.request.requestId}|decide`),
      order: 2,
      label:
        routeClass === 'clarify'
          ? 'Ask one clarifying question before action.'
          : `Route to ${routeClass}.`,
      toolId: selectedTool,
      policyClass: approvalRequired
        ? 'approval_required'
        : selectedToolStatus === 'blocked'
          ? 'clarify'
          : 'read_only',
      expectedOutput:
        capabilityId || routeClass === 'clarify'
          ? 'Existing route handler or clarification.'
          : 'Local executive explanation.',
    },
  ];
  const adaptiveFrame = createAdaptiveProblemFrame({
    createdAt: input.request.createdAt,
    objective: summarizeAsk({
      text: input.request.normalizedAsk,
      channel: input.request.channel,
      intentFamily: input.request.intentFamily,
    }),
    taskFamily: input.request.intentFamily,
    channel: input.request.channel,
    route: provisionalRouteKey,
    successCriteria: [
      {
        description:
          'The selected route addresses the bounded request with fresh evidence or asks one concrete clarification.',
        requiredEvidenceClasses: ['observed', 'user_attested'],
        minimumConfidence: 0.65,
      },
      {
        description:
          'Approval, tool health, reliability caps, and privacy constraints remain satisfied.',
        requiredEvidenceClasses: ['observed'],
        minimumConfidence: 0.8,
      },
    ],
    constraints: [
      'The deterministic route policy is the maximum authority envelope.',
      'A route-confidence score can narrow action but cannot grant mutation authority.',
      'Do not persist raw asks, private bodies, hidden reasoning, raw tool output, or secrets.',
    ],
    assumptions: [
      `intent:${input.request.intentFamily}`,
      `route_confidence:${routeScore.confidence.toFixed(3)}`,
    ],
    unknowns:
      routeClass === 'clarify'
        ? [
            {
              description: concreteClarifyingQuestion(input.request),
              impact: 'blocking',
              resolvableBy: ['user_clarification'],
            },
          ]
        : selectedToolStatus === 'blocked'
          ? [
              {
                description: `${selectedTool} is blocked for the selected route.`,
                impact: 'degrading',
                resolvableBy: ['tool_health_observation', 'fallback_route'],
              },
            ]
          : [],
    authority: {
      actorScope: `${input.request.channel}:${input.request.groupFolder}`,
      maximumActionClass: approvalRequired
        ? 'approval_gated_mutation'
        : routeClass === 'clarify' || routeClass === 'direct_answer'
          ? 'reasoning_only'
          : 'read_only',
      approvedActionIds: [],
    },
    risk: {
      level: approvalRequired
        ? 'high'
        : selectedToolStatus === 'blocked'
          ? 'medium'
          : 'low',
      flags: selectedRiskFlags,
    },
    contextRefs: [
      input.snapshot.snapshotId,
      ...input.snapshotItems.slice(0, 5).map((item) => item.itemId),
    ],
  });
  const executiveOutcomeCriterionId =
    adaptiveFrame.successCriteria[0]!.criterionId;
  adaptiveFrame.contextRefs.push(
    `target:${executiveOutcomeCriterionId}:${hashId('cogexec:target', input.request.requestId)}`,
  );
  if (approvalRequired) {
    adaptiveFrame.contextRefs.push(
      `receipt_required:${executiveOutcomeCriterionId}`,
    );
  }
  const routeActionId = `executive:${provisionalRouteKey}`;
  const adaptiveActions: AdaptiveActionCandidate[] = [
    {
      actionId: 'executive:observe-policy',
      title: 'Observe bounded context and enforced route policy',
      purpose:
        'Use the compact world snapshot, route reliability, and integration health as typed observations.',
      toolId: 'local_direct_answer',
      actionClass: 'local_lookup',
      mutationClass: 'none',
      approvalRequired: false,
      requiredEvidence: ['snapshot', 'route_reliability', 'integration_health'],
      producesCriterionIds: [adaptiveFrame.successCriteria[1]!.criterionId],
      expectedEvidenceClass: 'observed',
      priority: 1,
      maxAttempts: 1,
      timeoutMs: 2_000,
    },
    {
      actionId: routeActionId,
      title:
        routeClass === 'clarify'
          ? 'Ask one concrete clarification'
          : `Route through ${selectedTool}`,
      purpose:
        routeClass === 'clarify'
          ? concreteClarifyingQuestion(input.request)
          : `Use ${selectedTool} only within the selected route and policy envelope.`,
      toolId: selectedTool,
      actionClass:
        routeClass === 'clarify'
          ? 'clarification'
          : routeClass === 'direct_answer'
            ? 'reasoning'
            : approvalRequired
              ? 'approval_gate'
              : 'read_only_integration',
      mutationClass: 'none',
      approvalRequired,
      requiredEvidence: ['route_result', 'completion_verification'],
      producesCriterionIds: [adaptiveFrame.successCriteria[0]!.criterionId],
      expectedEvidenceClass: 'observed',
      priority: 0.95,
      maxAttempts: selectedToolStatus === 'degraded' ? 2 : 1,
      timeoutMs: 15_000,
    },
    ...(reliabilityFallback
      ? [
          {
            actionId: `executive:fallback:${reliabilityFallback}`,
            title: 'Use the bounded fallback route',
            purpose: reliabilityFallback,
            toolId: 'clarifying_question' as const,
            actionClass: 'clarification' as const,
            mutationClass: 'none' as const,
            approvalRequired: false,
            requiredEvidence: ['explicit_blocker_or_clarification'],
            producesCriterionIds: [
              adaptiveFrame.successCriteria[0]!.criterionId,
            ],
            expectedEvidenceClass: 'user_attested' as const,
            priority: 0.8,
            maxAttempts: 1,
            timeoutMs: 5_000,
            alternativeForActionId: routeActionId,
            recoveryForFailureClasses: [
              'tool_blocked',
              'tool_degraded',
              'low_route_reliability',
            ],
          },
        ]
      : []),
  ];
  const adaptivePlan = buildAdaptivePlanGraph({
    createdAt: input.request.createdAt,
    frame: adaptiveFrame,
    actions: adaptiveActions,
    maxNodeExecutions: 12,
    maxRuntimeMs: 20_000,
  });
  const plan: CognitivePlan = {
    planId: hashId('cogexec:plan', input.request.requestId),
    createdAt: input.request.createdAt,
    selectedRoute: routeClass,
    routeKey: provisionalRouteKey,
    capabilityId,
    confidence: Math.min(
      routeScore.confidence,
      input.metacognition?.calibration.score ?? routeScore.confidence,
    ),
    stepsJson: safeJson(
      {
        adaptiveEngineVersion: ADAPTIVE_COGNITION_VERSION,
        adaptiveFrame,
        adaptivePlan,
        compatibilitySteps: steps,
      },
      12_000,
    ),
    involvedToolsJson: safeJson([selectedTool], 1200),
    approvalRequired,
    fallbackRoute: reliabilityFallback,
    explanation:
      routeClass === 'clarify'
        ? concreteClarifyingQuestion(input.request)
        : [
            `The ask matches ${input.request.intentFamily}; ${selectedTool} is the narrowest useful route.`,
            input.metacognition
              ? `Reasoning mode: ${input.metacognition.decision.mode}; confidence ${input.metacognition.calibration.label}.`
              : null,
            reliabilityReason ? `Reliability note: ${reliabilityReason}` : null,
          ]
            .filter(Boolean)
            .join(' '),
    usedContextJson: safeJson(usedContext, 2400),
    ignoredContextJson: safeJson(ignoredContext, 2400),
  };
  const choice: CognitiveExecutiveToolChoice = {
    choiceId: hashId(
      'cogexec:tool',
      `${input.request.requestId}|${selectedTool}`,
    ),
    runId: hashId('cogexec:run', input.request.requestId),
    createdAt: input.request.createdAt,
    toolId: selectedTool,
    capabilityId,
    selected: true,
    status: selectedToolStatus,
    confidence: plan.confidence,
    approvalRequired,
    reason: plan.explanation,
    fallbackToolId:
      selectedToolStatus === 'blocked' || routeClass === 'clarify'
        ? 'clarifying_question'
        : null,
    riskFlagsJson: safeJson(selectedRiskFlags, 1200),
    privacyJson: privacyJson(),
  };
  return { plan, toolChoices: [choice] };
}

function buildState(input: {
  request: CognitiveRequest;
  snapshot: CognitiveWorldSnapshot;
  snapshotItems: CognitiveWorldSnapshotItem[];
  selectedWork?: SelectedWorkContext | null;
}): CognitiveState {
  const activeThread = input.snapshotItems.find(
    (item) =>
      item.itemKind === 'communication_thread' ||
      item.itemKind === 'life_thread',
  );
  const activeMission = input.snapshotItems.find(
    (item) => item.itemKind === 'mission',
  );
  const activeList = input.snapshotItems.find(
    (item) => item.itemKind === 'list_item',
  );
  const activeMessage = input.snapshotItems.find(
    (item) => item.itemKind === 'message_action',
  );
  const relevantOpenLoops = input.snapshotItems
    .filter((item) =>
      [
        'communication_thread',
        'mission',
        'action_bundle',
        'message_action',
      ].includes(item.itemKind),
    )
    .slice(0, 6);
  const deadlines = input.snapshotItems
    .filter((item) =>
      ['reminder', 'calendar_pressure', 'list_item'].includes(item.itemKind),
    )
    .slice(0, 6);
  return {
    stateId: hashId('cogexec:state', input.request.requestId),
    createdAt: input.request.createdAt,
    currentFocus: input.snapshot.currentFocus,
    activePerson: null,
    activeThreadId: activeThread?.sourceId || null,
    activeMissionId: activeMission?.sourceId || null,
    activeListId: activeList?.sourceId || null,
    activeMessageActionId: activeMessage?.sourceId || null,
    activeWorkItem: input.selectedWork?.title || null,
    relevantOpenLoopsJson: safeJson(relevantOpenLoops, 2400),
    relevantDeadlinesJson: safeJson(deadlines, 2400),
    availableToolsJson: safeJson(
      [
        'local_direct_answer',
        'calendar',
        'reminders',
        'everyday_capture',
        'communication_companion',
        'life_threads',
        'missions',
        'action_bundles',
        'knowledge_library',
        'research',
        'message_actions',
        'work_cockpit',
        'telegram_handoff',
        'clarifying_question',
      ],
      1800,
    ),
    degradedToolsJson: input.snapshot.degradedToolsJson,
    recentOutcomesJson: safeJson(
      input.snapshotItems
        .filter((item) => item.itemKind === 'outcome')
        .slice(0, 4),
      1800,
    ),
    snapshotId: input.snapshot.snapshotId,
  };
}

function initialResult(input: {
  request: CognitiveRequest;
  plan: CognitivePlan;
}): CognitiveResult {
  return {
    resultId: hashId('cogexec:result', input.request.requestId),
    createdAt: input.request.createdAt,
    status:
      input.plan.selectedRoute === 'clarify'
        ? 'clarified'
        : input.plan.approvalRequired
          ? 'approval_staged'
          : 'planned',
    doneSummary:
      input.plan.selectedRoute === 'clarify'
        ? 'Prepared one clarifying question.'
        : `Selected ${input.plan.routeKey}.`,
    failureSummary: null,
    changedSummary: null,
    openSummary:
      input.plan.selectedRoute === 'clarify'
        ? 'Need target, timing, or approval before acting.'
        : null,
    rememberSummary: null,
    reviewLaterSummary: null,
    nextSuggestion:
      input.plan.selectedRoute === 'clarify'
        ? 'Ask for the missing action target or approval context.'
        : 'Let the existing capability handler complete the route.',
  };
}

function buildExplanation(input: {
  runId: string;
  request: CognitiveRequest;
  plan: CognitivePlan;
  snapshotItems: CognitiveWorldSnapshotItem[];
}): CognitiveExplanation {
  const degraded = input.snapshotItems.filter(
    (item) => item.itemKind === 'integration',
  );
  return {
    explanationId: hashId('cogexec:explain', input.runId),
    runId: input.runId,
    createdAt: input.request.createdAt,
    routeChosen: input.plan.explanation,
    contextUsedJson: input.plan.usedContextJson,
    contextIgnoredJson: input.plan.ignoredContextJson,
    approvalReason: input.plan.approvalRequired
      ? 'The request may cross a send/write/delete/service boundary, so approval stays required.'
      : null,
    degradedToolReason: degraded.length
      ? degraded
          .slice(0, 3)
          .map((item) => item.summary)
          .join(' | ')
      : null,
    fallbackReason: input.plan.fallbackRoute || null,
    nextSafeAction:
      input.plan.selectedRoute === 'clarify'
        ? 'Ask one clarifying question.'
        : 'Proceed through the selected existing capability.',
    privacyJson: privacyJson(),
  };
}

function runRecord(input: {
  runId: string;
  request: CognitiveRequest;
  state: CognitiveState;
  plan: CognitivePlan;
  result: CognitiveResult;
  snapshot: CognitiveWorldSnapshot;
  explanation: CognitiveExplanation;
}): CognitiveExecutiveRunRecord {
  return {
    runId: input.runId,
    createdAt: input.request.createdAt,
    updatedAt: input.result.createdAt,
    status: input.result.status,
    channel: input.request.channel,
    groupFolder: input.request.groupFolder,
    chatJid: input.request.chatJid,
    threadId: input.request.threadId,
    actorId: input.request.actorId,
    intentFamily: input.request.intentFamily,
    confidence: input.plan.confidence,
    routeClass: input.plan.selectedRoute,
    routeKey: input.plan.routeKey,
    capabilityId: input.plan.capabilityId,
    approvalRequired: input.plan.approvalRequired,
    requestSummary: summarizeAsk({
      text: input.request.rawAsk,
      channel: input.request.channel,
      intentFamily: input.request.intentFamily,
    }),
    stateSummary: safeText(input.state.currentFocus, 700),
    planSummary: safeText(input.plan.explanation, 700),
    resultSummary: safeText(input.result.doneSummary, 700),
    explanationJson: safeJson(input.explanation, 2400),
    usedContextJson: input.plan.usedContextJson,
    ignoredContextJson: input.plan.ignoredContextJson,
    degradedToolsJson: input.state.degradedToolsJson,
    evidenceIdsJson: input.snapshot.evidenceIdsJson,
    snapshotId: input.snapshot.snapshotId,
    outcomeSignalId: null,
    nextAction: input.result.nextSuggestion,
    privacyJson: privacyJson(),
  };
}

export function beginCognitiveExecutiveTurn(
  input: BeginCognitiveExecutiveInput,
): CognitiveExecutiveContext | null {
  const request = buildRequest(input);
  if (
    !EXECUTIVE_INTENTS.has(request.intentFamily) ||
    request.intentFamily === 'other'
  ) {
    return null;
  }
  const integrationReport =
    input.integrationReport || buildIntegrationDoctorReport({ now: input.now });
  const { snapshot, items } = buildCognitiveWorldSnapshot({
    groupFolder: input.groupFolder,
    intentFamily: request.intentFamily,
    selectedWork: input.selectedWork,
    integrationReport,
    now: input.now,
    persist: input.persist,
    personalContextPacket: input.personalContextPacket,
  });
  const capabilityMatch = selectCapability({
    request,
    priorSubjectData: input.priorSubjectData,
    override: input.capabilityMatchOverride,
  });
  const state = buildState({
    request,
    snapshot,
    snapshotItems: items,
    selectedWork: input.selectedWork,
  });
  const metacognition = analyzeMetacognitiveTurn({
    rawAsk: input.rawAsk,
    channel: input.channel,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    threadId: input.threadId,
    intentFamily: request.intentFamily,
    activeContextSummary: input.activeContextSummary,
    selectedWorkSummary: input.selectedWork
      ? `${input.selectedWork.title} (${input.selectedWork.statusLabel}): ${
          input.selectedWork.summary || input.selectedWork.laneLabel
        }`
      : null,
    snapshot,
    snapshotItems: items,
    now: input.now,
    persist: input.persist,
  });
  const { plan, toolChoices } = buildPlan({
    request,
    snapshot,
    snapshotItems: items,
    capabilityMatch,
    integrationReport,
    metacognition,
  });
  const result = initialResult({ request, plan });
  const runId = hashId('cogexec:run', request.requestId);
  const explanation = buildExplanation({
    runId,
    request,
    plan,
    snapshotItems: items,
  });
  const run = runRecord({
    runId,
    request,
    state,
    plan,
    result,
    snapshot,
    explanation,
  });
  const context: CognitiveExecutiveContext = {
    request,
    state,
    plan,
    result,
    run,
    snapshot,
    snapshotItems: items,
    toolChoices: toolChoices.map((choice) => ({ ...choice, runId })),
    explanation,
    capabilityMatch,
    metacognition,
    personalContextPacket: input.personalContextPacket,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertCognitiveExecutiveRun(run);
    for (const choice of context.toolChoices) {
      upsertCognitiveExecutiveToolChoice(choice);
    }
    const signal = buildReflectionSignal({
      context,
      status: 'route_chosen',
      outcome: 'unknown',
      summary: `Executive selected ${run.routeKey} for ${run.intentFamily}.`,
      nextAction: run.nextAction,
      fallbackUsed: Boolean(plan.fallbackRoute),
      now: input.now,
    });
    upsertCognitiveReflectionSignal(signal);
    upsertCognitiveExecutiveRun({ ...run, outcomeSignalId: signal.signalId });
    context.run = { ...run, outcomeSignalId: signal.signalId };
  }
  return context;
}

function buildReflectionSignal(input: {
  context: CognitiveExecutiveContext;
  status: CognitiveReflectionSignal['signalKind'];
  outcome: CognitiveReflectionSignal['outcome'];
  summary: string;
  nextAction: string;
  fallbackUsed?: boolean;
  frictionKey?: string | null;
  now?: Date;
}): CognitiveReflectionSignal {
  const createdAt = nowIso(input.now);
  return {
    signalId: hashId(
      'cogexec:signal',
      `${input.context.run.runId}|${input.status}|${createdAt}`,
    ),
    runId: input.context.run.runId,
    createdAt,
    routeKey: input.context.plan.routeKey,
    capabilityId: input.context.plan.capabilityId,
    signalKind: input.status,
    outcome: input.outcome,
    routeConfidence: input.context.plan.confidence,
    fallbackUsed: Boolean(input.fallbackUsed),
    userResponse: 'unknown',
    frictionKey: input.frictionKey || null,
    summary: safeText(input.summary, 700),
    nextAction: safeText(input.nextAction, 700),
    privacyJson: privacyJson(),
  };
}

export function finalizeCognitiveExecutiveTurn(
  input: FinalizeCognitiveExecutiveInput,
): CognitiveExecutiveRunRecord | null {
  const context = input.context;
  if (!context) return null;
  const updatedAt = nowIso(input.now);
  const status = input.status || 'handled';
  const summary =
    input.resultSummary ||
    (status === 'failed'
      ? 'Executive-routed capability failed.'
      : status === 'approval_staged'
        ? 'Executive-routed capability staged approval.'
        : 'Executive-routed capability handled the turn.');
  const signalKind: CognitiveReflectionSignal['signalKind'] =
    status === 'failed'
      ? 'action_failed'
      : status === 'deferred'
        ? 'action_deferred'
        : status === 'approval_staged'
          ? 'approval_staged'
          : 'answer_sent';
  const outcome: CognitiveReflectionSignal['outcome'] =
    status === 'failed'
      ? 'fail'
      : status === 'deferred' || status === 'approval_staged'
        ? 'deferred'
        : 'success';
  const signal = buildReflectionSignal({
    context,
    status: signalKind,
    outcome,
    summary,
    nextAction: input.nextAction || context.result.nextSuggestion,
    fallbackUsed: input.fallbackUsed,
    frictionKey:
      input.blockerClass ||
      (status === 'failed' ? `${context.plan.routeKey}:failed` : null),
    now: input.now,
  });
  const run: CognitiveExecutiveRunRecord = {
    ...context.run,
    updatedAt,
    status,
    resultSummary: safeText(summary, 900),
    outcomeSignalId: signal.signalId,
    nextAction: safeText(
      input.nextAction || context.result.nextSuggestion,
      900,
    ),
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertCognitiveReflectionSignal(signal);
    upsertCognitiveExecutiveRun(run);
  }
  return run;
}

export function buildStoredCognitiveExecutiveReport(): CognitiveExecutiveDoctorReport {
  const generatedAt = nowIso();
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      ok: false,
      latestRun: null,
      latestSnapshot: null,
      toolChoices: [],
      reflectionSignals: [],
      nextAction:
        'Initialize the database before reading Cognitive Executive state.',
      privacy: COGNITIVE_EXECUTIVE_PRIVACY,
    };
  }
  const latestRun = listCognitiveExecutiveRuns({ limit: 1 })[0] || null;
  const latestSnapshot =
    (latestRun?.snapshotId
      ? listCognitiveWorldSnapshots({ limit: 20 }).find(
          (snapshot) => snapshot.snapshotId === latestRun.snapshotId,
        )
      : null) ||
    listCognitiveWorldSnapshots({ limit: 1 })[0] ||
    null;
  const toolChoices = latestRun
    ? listCognitiveExecutiveToolChoices({ runId: latestRun.runId, limit: 20 })
    : [];
  const reflectionSignals = latestRun
    ? listCognitiveReflectionSignals({ runId: latestRun.runId, limit: 20 })
    : listCognitiveReflectionSignals({ limit: 10 });
  return {
    generatedAt,
    ok: true,
    latestRun,
    latestSnapshot,
    toolChoices,
    reflectionSignals,
    nextAction:
      latestRun?.nextAction ||
      'Run one of the eight executive flows to create a decision trace.',
    privacy: COGNITIVE_EXECUTIVE_PRIVACY,
  };
}

function summarizeJsonList(value: string, label: string, limit = 3): string {
  let parsed: unknown[] = [];
  try {
    const raw = JSON.parse(value || '[]');
    parsed = Array.isArray(raw) ? raw : [];
  } catch {
    parsed = parseJsonArray(value);
  }
  if (!parsed.length) return `${label}: none`;
  const rendered = parsed.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const record = item as {
        toolId?: string;
        state?: string;
        status?: string;
        nextAction?: string;
      };
      return [record.toolId, record.state || record.status]
        .filter(Boolean)
        .join(': ');
    }
    return String(item);
  });
  return `${label}: ${rendered.slice(0, limit).join(', ')}${rendered.length > limit ? ` (+${rendered.length - limit})` : ''}`;
}

function summarizeLearnedSnapshotContext(
  snapshot: CognitiveWorldSnapshot | null | undefined,
): string {
  if (!snapshot) return 'Learned context: none';
  try {
    const parsed = JSON.parse(snapshot.itemsJson || '[]') as Array<{
      itemKind?: string;
      summary?: string;
      confidence?: number;
    }>;
    const learned = parsed.filter((item) =>
      ['world_fact', 'skill_playbook', 'learning_candidate'].includes(
        item.itemKind || '',
      ),
    );
    if (!learned.length) return 'Learned context: none selected';
    return `Learned context: ${learned
      .slice(0, 3)
      .map(
        (item) =>
          `${item.itemKind} (${Number(item.confidence || 0).toFixed(2)}): ${item.summary || ''}`,
      )
      .join('; ')}${learned.length > 3 ? ` (+${learned.length - 3})` : ''}`;
  } catch {
    return 'Learned context: unavailable';
  }
}

export function formatCognitiveExecutiveReport(
  report: CognitiveExecutiveDoctorReport = buildStoredCognitiveExecutiveReport(),
): string {
  const run = report.latestRun;
  const metacognition = buildMetacognitionDoctorReport();
  if (!run) {
    return [
      '*Cognitive Executive*',
      'No executive turn has been recorded yet.',
      `Next: ${report.nextAction}`,
      'Privacy: metadata-only.',
    ].join('\n');
  }
  const selectedTool =
    report.toolChoices.find((choice) => choice.selected) ||
    report.toolChoices[0];
  return [
    '*Cognitive Executive*',
    `Status: ${run.status}`,
    `Intent: ${run.intentFamily} (${run.confidence.toFixed(2)})`,
    `Route: ${run.routeKey}`,
    `Tool: ${selectedTool?.toolId || 'none'} (${selectedTool?.status || 'unknown'})`,
    metacognition.decision
      ? `Reasoning: ${metacognition.decision.mode} / ${metacognition.calibration?.label || 'unknown'} confidence`
      : 'Reasoning: none recorded',
    `Focus: ${run.stateSummary}`,
    `Why: ${run.planSummary}`,
    metacognition.focus
      ? `Attention: ${metacognition.focus.primaryFocus}`
      : null,
    metacognition.warnings.length
      ? `Warnings: ${metacognition.warnings.map((warning) => warning.warningKind).join(', ')}`
      : 'Warnings: none',
    summarizeLearnedSnapshotContext(report.latestSnapshot),
    run.approvalRequired
      ? 'Approval: required before any side effect.'
      : 'Approval: not required for this route.',
    summarizeJsonList(run.degradedToolsJson, 'Degraded tools'),
    `Next: ${run.nextAction}`,
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, raw tool output, or secrets are stored.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildCognitiveExecutiveStatusText(): string {
  return formatCognitiveExecutiveReport(buildStoredCognitiveExecutiveReport());
}

export function formatLatestCognitiveExecutiveExplanation(): string {
  const report = buildStoredCognitiveExecutiveReport();
  const metacognition = buildMetacognitionDoctorReport();
  const run = report.latestRun;
  if (!run) {
    return 'I do not have a recent executive route to explain yet.';
  }
  let parsed: Partial<CognitiveExplanation> = {};
  try {
    parsed = JSON.parse(run.explanationJson) as Partial<CognitiveExplanation>;
  } catch {
    parsed = {};
  }
  const selectedTool =
    report.toolChoices.find((choice) => choice.selected) ||
    report.toolChoices[0];
  return [
    `I chose ${run.routeKey} because ${parsed.routeChosen || run.planSummary}`,
    selectedTool
      ? `I used ${selectedTool.toolId} because ${selectedTool.reason}`
      : 'I did not record a selected tool.',
    metacognition.decision
      ? `I used ${metacognition.decision.mode} mode because ${metacognition.decision.modeReason}`
      : null,
    metacognition.calibration
      ? `Confidence was ${metacognition.calibration.label}: ${metacognition.calibration.reason}`
      : null,
    parsed.degradedToolReason
      ? `I avoided or caveated degraded tools: ${parsed.degradedToolReason}`
      : null,
    parsed.approvalReason
      ? `Approval stayed in place: ${parsed.approvalReason}`
      : null,
    `Next: ${parsed.nextSafeAction || run.nextAction}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function contextBlockFromExecutiveRun(
  run: CognitiveExecutiveRunRecord,
): Pick<
  CognitiveWorkspaceContextBlock,
  'sourceId' | 'summary' | 'evidenceIdsJson' | 'privacyJson'
> {
  return {
    sourceId: run.runId,
    summary: `${run.intentFamily} -> ${run.routeKey}. ${run.nextAction}`,
    evidenceIdsJson: run.evidenceIdsJson,
    privacyJson: run.privacyJson,
  };
}
