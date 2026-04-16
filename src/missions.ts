import { randomUUID } from 'crypto';

import type { SelectedWorkContext } from './daily-command-center.js';
import {
  getLifeThread,
  getMission,
  listMissionsForGroup,
  listProfileSubjectsForGroup,
  listMissionSteps,
  replaceMissionSteps,
  upsertMission,
} from './db.js';
import { buildChiefOfStaffSnapshot } from './chief-of-staff.js';
import { buildCommunicationOpenLoops } from './communication-companion.js';
import { searchKnowledgeLibrary } from './knowledge-library.js';
import { findLifeThreadForExplicitLookup } from './life-threads.js';
import { syncOutcomeFromMissionRecord } from './outcome-reviews.js';
import { buildSignatureFlowText } from './signature-flows.js';
import type {
  ChiefOfStaffConfidence,
  ChiefOfStaffHorizon,
  ChiefOfStaffScope,
  MissionExecutionContext,
  MissionPlanSnapshot,
  MissionRecord,
  MissionStepRecord,
  MissionSuggestedAction,
  MissionSuggestedActionKind,
  LifeThread,
  ProfileSubject,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export interface MissionPriorContext {
  personName?: string;
  threadId?: string;
  threadTitle?: string;
  conversationFocus?: string;
  lastAnswerSummary?: string;
  knowledgeSourceIds?: string[];
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  chiefOfStaffContextJson?: string;
  missionId?: string;
  missionSummary?: string;
  missionSuggestedActionsJson?: string;
  missionBlockersJson?: string;
  missionStepFocusJson?: string;
}

export interface MissionTurnInput {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  text: string;
  mode: 'propose' | 'view' | 'manage' | 'explain';
  chatJid?: string;
  conversationSummary?: string;
  replyText?: string;
  selectedWork?: SelectedWorkContext | null;
  priorContext?: MissionPriorContext;
  now?: Date;
}

export interface MissionTurnResult {
  ok: boolean;
  summaryText: string;
  detailText: string;
  replyText: string;
  mission: MissionRecord;
  steps: MissionStepRecord[];
  blockers: string[];
  suggestedActions: MissionSuggestedAction[];
  explainabilityLines: string[];
  confidence: ChiefOfStaffConfidence;
  stepFocus?: MissionStepRecord | null;
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeThreadTitleForDisplay(
  threadTitle: string | null | undefined,
): string | null {
  const trimmed = normalizeText(threadTitle || '');
  if (!trimmed) return null;
  return /^(?:follow[- ]?up|thread|carryover|open loops?)$/i.test(trimmed)
    ? null
    : trimmed;
}

function humanizeChiefSignal(signal: string): string {
  const normalized = normalizeText(signal)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'life_threads':
      return 'your ongoing threads';
    case 'communication_threads':
      return 'recent conversations';
    case 'calendar':
    case 'calendar_events':
      return 'your calendar';
    case 'reminders':
      return 'your reminders';
    case 'current_work':
      return 'current work';
    case 'knowledge_library':
      return 'saved material';
    case 'everyday_capture':
      return 'your lists and captures';
    case 'chief_of_staff':
      return 'your broader daily context';
    case 'missions':
      return 'your active plan';
    case 'ritual_profile':
      return 'your routines';
    default:
      return normalized.replace(/_/g, ' ');
  }
}

function joinHumanReadableList(values: string[]): string {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function buildMissionThreadAnchor(params: {
  linkedLifeThreadTitle?: string | null;
  linkedSubjects: ProfileSubject[];
}): string | null {
  const displayThreadTitle = normalizeThreadTitleForDisplay(
    params.linkedLifeThreadTitle,
  );
  if (displayThreadTitle) return displayThreadTitle;

  const personName = normalizeText(params.linkedSubjects[0]?.displayName || '');
  return personName ? `${personName} thread` : null;
}

function safeJsonParse<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clipText(value: string, max = 160): string {
  const normalized = normalizeText(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function canonicalizeName(value: string): string {
  return normalizeText(value).toLowerCase();
}

function isCompletedSelectedWork(
  work: SelectedWorkContext | null | undefined,
): boolean {
  return Boolean(
    work &&
      /^(done|succeeded|success|completed|complete|stopped|cancelled|canceled)$/i.test(
        work.statusLabel.trim(),
      ),
  );
}

function resolveRelevantSelectedWork(params: {
  selectedWork?: SelectedWorkContext | null;
  objective: string;
  category?: MissionRecord['category'] | null;
}): SelectedWorkContext | null {
  const work = params.selectedWork;
  if (!work || isCompletedSelectedWork(work)) return null;
  if (params.category === 'work') return work;
  if (
    /blocked|waiting/i.test(work.statusLabel) ||
    /blocked|waiting/i.test(work.summary || '')
  ) {
    return work;
  }
  return /\b(work|ship|code|bug|pr|deploy|cursor|codex|project|runtime|release)\b/i.test(
    params.objective,
  )
    ? work
    : null;
}

function inferHorizon(text: string): ChiefOfStaffHorizon {
  const lower = text.toLowerCase();
  if (/\btonight\b/.test(lower)) return 'tonight';
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  if (/\bweekend\b/.test(lower)) return 'weekend';
  if (/\bnext few days\b/.test(lower)) return 'next_few_days';
  if (/\bthis week\b/.test(lower)) return 'this_week';
  return 'today';
}

function extractObjective(input: MissionTurnInput): string {
  const normalized = normalizeText(input.text);
  const stripped = normalized
    .replace(
      /^(help me plan|make a plan for|make a plan|turn this into a plan|help me organize this|help me organize|help me figure out the next steps for|help me figure out the next steps|what('?s| is) my plan for|what('?s| is) the plan for|help me prepare for)\s+/i,
      '',
    )
    .trim();
  if (stripped && stripped.toLowerCase() !== normalized.toLowerCase()) {
    return stripped.replace(/[?.!]+$/, '');
  }
  return (
    input.priorContext?.conversationFocus?.trim() ||
    input.priorContext?.lastAnswerSummary?.trim() ||
    input.priorContext?.lastCommunicationSummary?.trim() ||
    input.replyText?.trim() ||
    input.conversationSummary?.trim() ||
    normalized
  );
}

function buildMissionTitle(objective: string): string {
  const normalized = clipText(objective, 72).replace(/[?.!]+$/, '');
  if (!normalized) return 'Untitled mission';
  if (/^plan\b/i.test(normalized)) return normalized;
  return `Plan ${normalized}`;
}

function resolveLinkedSubjects(
  groupFolder: string,
  objective: string,
  priorContext?: MissionPriorContext,
): ProfileSubject[] {
  const subjects = listProfileSubjectsForGroup(groupFolder);
  const seen = new Set<string>();
  const add = (subject: ProfileSubject | undefined) => {
    if (subject && !seen.has(subject.id)) {
      seen.add(subject.id);
    }
  };
  if (priorContext?.personName) {
    const personName = priorContext.personName;
    add(
      subjects.find(
        (subject) =>
          subject.kind === 'person' &&
          canonicalizeName(subject.displayName) ===
            canonicalizeName(personName),
      ),
    );
  }
  for (const subject of subjects) {
    const patterns = [subject.displayName, subject.canonicalName].filter(
      (pattern): pattern is string => Boolean(pattern),
    );
    if (
      patterns.some((pattern) =>
        new RegExp(
          `\\b${pattern.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`,
          'i',
        ).test(objective),
      )
    ) {
      add(subject);
    }
  }
  return subjects.filter((subject) => seen.has(subject.id));
}

function resolveStoredLinkedSubjects(
  groupFolder: string,
  existing?: MissionRecord,
): ProfileSubject[] {
  if (!existing?.linkedSubjectIds.length) return [];
  const subjects = listProfileSubjectsForGroup(groupFolder);
  const selected = new Set(existing.linkedSubjectIds);
  return subjects.filter((subject) => selected.has(subject.id));
}

function mergeLinkedSubjects(
  primary: ProfileSubject[],
  secondary: ProfileSubject[],
): ProfileSubject[] {
  const merged = new Map<string, ProfileSubject>();
  for (const subject of [...primary, ...secondary]) {
    merged.set(subject.id, subject);
  }
  return [...merged.values()];
}

function resolveStoredLinkedLifeThread(
  existing?: MissionRecord,
): LifeThread | null {
  if (!existing?.linkedLifeThreadIds.length) return null;
  for (const threadId of existing.linkedLifeThreadIds) {
    const thread = getLifeThread(threadId);
    if (thread) return thread;
  }
  return null;
}

function resolveLinkedLifeThread(
  groupFolder: string,
  objective: string,
  priorContext?: MissionPriorContext,
) {
  return (
    (priorContext?.threadTitle
      ? findLifeThreadForExplicitLookup({
          groupFolder,
          query: priorContext.threadTitle,
        })
      : null) ||
    findLifeThreadForExplicitLookup({
      groupFolder,
      query: objective,
    })
  );
}

function inferMissionCategory(params: {
  objective: string;
  linkedSubjects: ProfileSubject[];
  linkedLifeThreadTitle?: string | null;
  selectedWork?: SelectedWorkContext | null;
}): MissionRecord['category'] {
  const lower = params.objective.toLowerCase();
  if (
    /\b(dinner|meeting|event|leave|trip|weekend|tonight|tomorrow|prep|prepare)\b/.test(
      lower,
    )
  ) {
    return 'event_prep';
  }
  if (/\b(reply|follow up|text|message|call|band|conversation)\b/.test(lower)) {
    return params.linkedSubjects.some((subject) => subject.kind === 'person')
      ? 'communication'
      : 'mixed';
  }
  if (
    params.selectedWork ||
    /\b(work|ship|code|bug|pr|deploy|cursor|codex|project)\b/.test(lower)
  ) {
    return 'work';
  }
  if (/\b(home|house|household|errand|grocer)\b/.test(lower)) {
    return 'household';
  }
  if (
    params.linkedLifeThreadTitle &&
    /\b(candace|family)\b/.test(params.linkedLifeThreadTitle.toLowerCase())
  ) {
    return 'family';
  }
  return 'mixed';
}

function inferMissionScope(
  category: MissionRecord['category'],
  linkedSubjects: ProfileSubject[],
  selectedWork?: SelectedWorkContext | null,
): ChiefOfStaffScope {
  if (category === 'work' || selectedWork) return 'work';
  if (category === 'household') return 'household';
  if (category === 'family') return 'family';
  if (
    category === 'communication' &&
    linkedSubjects.some((subject) =>
      ['candace', 'family'].includes(subject.canonicalName),
    )
  ) {
    return 'family';
  }
  if (category === 'communication') return 'mixed';
  if (category === 'event_prep') {
    return linkedSubjects.length > 0 ? 'mixed' : 'personal';
  }
  return 'mixed';
}

function shouldUseKnowledge(objective: string): boolean {
  return /\b(prepare|prep|meeting|compare|decide|weekend|trip|event|research)\b/i.test(
    objective,
  );
}

function inferUserJudgmentNeeded(objective: string): boolean {
  return /\b(decide|choose|which|whether|best)\b/i.test(objective);
}

function buildMissionBlockers(params: {
  objective: string;
  horizon: ChiefOfStaffHorizon;
  selectedWork?: SelectedWorkContext | null;
  openLoopSummary?: string;
  openLoopLead?: string;
  linkedLifeThreadTitle?: string | null;
  linkedSubjects: ProfileSubject[];
}): string[] {
  const blockers: string[] = [];
  const lower = params.objective.toLowerCase();
  if (
    params.horizon === 'today' &&
    !/\b(today|tonight|tomorrow|week|weekend|friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(
      lower,
    )
  ) {
    blockers.push('The timing still looks fuzzy.');
  }
  if (
    /\b(dinner|meeting|conversation|follow up|reply|band|candace)\b/.test(
      lower,
    ) &&
    params.linkedSubjects.length === 0
  ) {
    blockers.push('The main person or thread is not pinned down yet.');
  }
  if (
    params.selectedWork?.summary &&
    /blocked|waiting/i.test(params.selectedWork.summary)
  ) {
    blockers.push(
      `Current work still has pressure around ${params.selectedWork.title}.`,
    );
  }
  if (
    params.openLoopSummary &&
    !/^nothing important/i.test(params.openLoopSummary)
  ) {
    blockers.push(
      params.openLoopLead ||
        'There is still at least one open conversation in the mix.',
    );
  }
  if (
    !params.linkedLifeThreadTitle &&
    inferUserJudgmentNeeded(params.objective)
  ) {
    blockers.push(
      'You still need to make one judgment call before the plan fully settles.',
    );
  }
  return blockers.slice(0, 3);
}

function buildMissionExplainability(params: {
  chiefSignalsUsed: string[];
  linkedLifeThreadTitle?: string | null;
  linkedSubjects: ProfileSubject[];
  knowledgeTitles: string[];
  blockers: string[];
}): string[] {
  const lines: string[] = [];
  const threadAnchor = buildMissionThreadAnchor({
    linkedLifeThreadTitle: params.linkedLifeThreadTitle,
    linkedSubjects: params.linkedSubjects,
  });
  if (params.chiefSignalsUsed.length > 0) {
    const humanizedSignals = [
      ...new Set(
        params.chiefSignalsUsed
          .map((signal) => humanizeChiefSignal(signal))
          .filter(Boolean),
      ),
    ];
    if (humanizedSignals.length > 0) {
      lines.push(`I pulled that from ${joinHumanReadableList(humanizedSignals)}.`);
    }
  }
  if (threadAnchor) {
    lines.push(`I kept the ${threadAnchor} in view.`);
  }
  if (params.linkedSubjects.length > 0) {
    lines.push(
      `I kept ${params.linkedSubjects
        .map((subject) => subject.displayName)
        .slice(0, 2)
        .join(' and ')} in mind.`,
    );
  }
  if (params.knowledgeTitles.length > 0) {
    lines.push(
      `Saved material may help: ${params.knowledgeTitles.join(', ')}.`,
    );
  }
  if (params.blockers.length > 0) {
    lines.push(
      `The plan is still constrained by ${params.blockers[0]!.toLowerCase()}`,
    );
  }
  return lines.slice(0, 3);
}

function buildMissionSummary(params: {
  title: string;
  blockers: string[];
  horizon: ChiefOfStaffHorizon;
  canDoNow: string | null;
}): string {
  const subject = params.title.replace(/^plan\s+/i, '').trim() || params.title;
  const firstMove = params.canDoNow
    ? params.canDoNow.replace(/^to\s+/i, '').trim()
    : null;
  if (firstMove) {
    const normalizedFirstMove = `${firstMove.charAt(0).toLowerCase()}${firstMove.slice(1)}`;
    return `For ${subject}, the first move is to ${normalizedFirstMove}.`;
  }
  if (params.blockers.length > 0) {
    return `For ${subject}, clear ${params.blockers[0]!.replace(/\.$/, '').toLowerCase()}.`;
  }
  return `For ${params.horizon.replace(/_/g, ' ')}, get ${subject.toLowerCase()} into a clear order.`;
}

function buildMissionSteps(params: {
  missionId: string;
  objective: string;
  horizon: ChiefOfStaffHorizon;
  linkedLifeThreadTitle?: string | null;
  linkedSubjects: ProfileSubject[];
  selectedWork?: SelectedWorkContext | null;
  knowledgeTitles: string[];
  blockers: string[];
  existingSteps?: MissionStepRecord[];
  simplify?: boolean;
  expand?: boolean;
  now: Date;
}): MissionStepRecord[] {
  if (params.expand && params.existingSteps?.length) {
    const base = params.existingSteps.filter(
      (step) => step.stepStatus !== 'done',
    );
    const focus = base[0] || params.existingSteps[0];
    if (focus) {
      const expanded = [
        {
          stepId: `${focus.stepId}:a`,
          missionId: params.missionId,
          position: 1,
          title: `Clarify ${focus.title.toLowerCase()}`,
          detail:
            focus.detail || `Pin down the first move for ${params.objective}.`,
          stepStatus: focus.stepStatus,
          requiresUserJudgment: focus.requiresUserJudgment,
          suggestedActionKind: focus.suggestedActionKind,
          linkedRefJson: focus.linkedRefJson || null,
          lastUpdatedAt: params.now.toISOString(),
        },
        {
          stepId: `${focus.stepId}:b`,
          missionId: params.missionId,
          position: 2,
          title: `Move ${focus.title.toLowerCase()} forward`,
          detail:
            'Once that is clear, make the concrete follow-through happen.',
          stepStatus: 'pending' as const,
          requiresUserJudgment: false,
          suggestedActionKind: focus.suggestedActionKind,
          linkedRefJson: focus.linkedRefJson || null,
          lastUpdatedAt: params.now.toISOString(),
        },
      ];
      const remainder = params.existingSteps
        .filter((step) => step.stepId !== focus.stepId)
        .slice(0, 3)
        .map((step, index) => ({
          ...step,
          position: expanded.length + index + 1,
          lastUpdatedAt: params.now.toISOString(),
        }));
      return [...expanded, ...remainder];
    }
  }

  const rawSteps: Array<{
    title: string;
    detail?: string;
    requiresUserJudgment?: boolean;
    suggestedActionKind?: MissionSuggestedActionKind;
    linkedRefJson?: string | null;
  }> = [];
  const threadAnchor = buildMissionThreadAnchor({
    linkedLifeThreadTitle: params.linkedLifeThreadTitle,
    linkedSubjects: params.linkedSubjects,
  });

  if (params.linkedSubjects.length > 0) {
    const firstPerson = params.linkedSubjects[0]!;
    rawSteps.push({
      title: `Check in with ${firstPerson.displayName}`,
      detail: `Pin down the timing, expectation, or open question with ${firstPerson.displayName}.`,
      requiresUserJudgment: false,
      suggestedActionKind: 'draft_follow_up',
      linkedRefJson: JSON.stringify({ personName: firstPerson.displayName }),
    });
  } else if (
    /\b(today|tonight|tomorrow|weekend|friday|saturday|sunday)\b/i.test(
      params.objective,
    )
  ) {
    rawSteps.push({
      title: 'Lock the timing',
      detail:
        'Confirm when this needs to happen so the rest of the plan has a real anchor.',
      requiresUserJudgment: true,
      suggestedActionKind: 'create_reminder',
    });
  } else {
    rawSteps.push({
      title: 'Define the immediate target',
      detail: `Name what success looks like for ${params.objective}.`,
      requiresUserJudgment: inferUserJudgmentNeeded(params.objective),
    });
  }

  if (params.linkedLifeThreadTitle) {
    rawSteps.push({
      title: threadAnchor
        ? `Tie this back to ${threadAnchor}`
        : 'Keep this tied to the ongoing thread',
      detail:
        'Keep the ongoing thread context in view so this plan does not drift away from the bigger picture.',
      requiresUserJudgment: false,
      suggestedActionKind: 'link_thread',
      linkedRefJson: JSON.stringify({
        threadTitle: params.linkedLifeThreadTitle,
      }),
    });
  }

  if (params.knowledgeTitles.length > 0) {
    rawSteps.push({
      title: 'Review the saved material you already have',
      detail: `Use ${params.knowledgeTitles.join(', ')} before you re-open the problem from scratch.`,
      requiresUserJudgment: false,
      suggestedActionKind: 'save_to_library',
    });
  }

  if (params.selectedWork) {
    rawSteps.push({
      title: `Protect room for ${params.selectedWork.title}`,
      detail:
        'Do not let current work erase this plan from the next window you actually have.',
      requiresUserJudgment: false,
      suggestedActionKind: 'reference_current_work',
      linkedRefJson: JSON.stringify({
        title: params.selectedWork.title,
        laneLabel: params.selectedWork.laneLabel,
      }),
    });
  }

  if (params.blockers.length > 0) {
    rawSteps.push({
      title: 'Clear the main blocker',
      detail: params.blockers[0],
      requiresUserJudgment: true,
    });
  }

  rawSteps.push({
    title:
      params.horizon === 'tonight'
        ? 'Leave one thing in motion for tonight'
        : 'Set the next move in motion',
    detail:
      params.horizon === 'tonight'
        ? 'Make sure one concrete follow-through is ready for tonight.'
        : 'Leave yourself with one concrete next action instead of a vague plan.',
    requiresUserJudgment: false,
    suggestedActionKind: 'create_reminder',
  });

  return (params.simplify ? rawSteps.slice(0, 3) : rawSteps.slice(0, 5)).map(
    (step, index) => ({
      stepId: params.existingSteps?.[index]?.stepId || randomUUID(),
      missionId: params.missionId,
      position: index + 1,
      title: step.title,
      detail: step.detail || null,
      stepStatus:
        params.blockers.length > 0 && index === 0 && !step.suggestedActionKind
          ? ('blocked' as const)
          : ('pending' as const),
      requiresUserJudgment: step.requiresUserJudgment === true,
      suggestedActionKind: step.suggestedActionKind || null,
      linkedRefJson: step.linkedRefJson || null,
      lastUpdatedAt: params.now.toISOString(),
    }),
  );
}

function buildMissionSuggestedActions(params: {
  linkedLifeThreadTitle?: string | null;
  linkedSubjects: ProfileSubject[];
  knowledgeSourceIds: string[];
  selectedWork?: SelectedWorkContext | null;
  blockers: string[];
  steps: MissionStepRecord[];
  mutedKinds: MissionSuggestedActionKind[];
}): MissionSuggestedAction[] {
  const suggestions: MissionSuggestedAction[] = [];
  const threadAnchor = buildMissionThreadAnchor({
    linkedLifeThreadTitle: params.linkedLifeThreadTitle,
    linkedSubjects: params.linkedSubjects,
  });
  const add = (action: MissionSuggestedAction | null) => {
    if (!action) return;
    if (params.mutedKinds.includes(action.kind)) return;
    if (suggestions.some((existing) => existing.kind === action.kind)) return;
    suggestions.push(action);
  };

  const firstStepWithAction = params.steps.find(
    (step) => step.suggestedActionKind && step.stepStatus !== 'done',
  );
  if (firstStepWithAction?.suggestedActionKind) {
    add({
      kind: firstStepWithAction.suggestedActionKind,
      label:
        firstStepWithAction.suggestedActionKind === 'draft_follow_up'
          ? 'Draft the follow-up'
          : firstStepWithAction.suggestedActionKind === 'create_reminder'
            ? 'Set a reminder'
            : firstStepWithAction.suggestedActionKind === 'link_thread'
              ? 'Link the thread'
              : firstStepWithAction.suggestedActionKind === 'save_to_library'
                ? 'Save the supporting note'
                : firstStepWithAction.suggestedActionKind ===
                    'reference_current_work'
                  ? 'Keep current work in view'
                  : 'Move the next action forward',
      reason:
        firstStepWithAction.detail ||
        'This is the cleanest concrete move from the plan.',
      requiresConfirmation:
        firstStepWithAction.suggestedActionKind !== 'reference_current_work',
      linkedRefJson: firstStepWithAction.linkedRefJson || null,
    });
  }

  if (params.blockers.length > 0) {
    add({
      kind: 'create_reminder',
      label: 'Keep the blocker from slipping',
      reason: params.blockers[0]!,
      requiresConfirmation: true,
    });
  }
  if (params.linkedLifeThreadTitle) {
    add({
      kind: 'link_thread',
      label: threadAnchor
        ? `Track this under ${threadAnchor}`
        : 'Keep this tied to the ongoing thread',
      reason:
        'That keeps the plan tied to the ongoing matter instead of floating separately.',
      requiresConfirmation: true,
      linkedRefJson: JSON.stringify({
        threadTitle: params.linkedLifeThreadTitle,
      }),
    });
  }
  if (params.linkedSubjects.length > 0) {
    add({
      kind: 'draft_follow_up',
      label: `Draft the message to ${params.linkedSubjects[0]!.displayName}`,
      reason: 'The plan still depends on a real conversation moving.',
      requiresConfirmation: true,
      linkedRefJson: JSON.stringify({
        personName: params.linkedSubjects[0]!.displayName,
      }),
    });
  }
  if (params.knowledgeSourceIds.length > 0) {
    add({
      kind: 'save_to_library',
      label: 'Keep the useful material attached',
      reason: 'This plan already has saved context worth keeping close.',
      requiresConfirmation: true,
    });
  }
  if (params.selectedWork) {
    add({
      kind: 'reference_current_work',
      label: `Keep ${params.selectedWork.title} in the execution picture`,
      reason: 'That work context changes what you can realistically move next.',
      requiresConfirmation: false,
      linkedRefJson: JSON.stringify({
        title: params.selectedWork.title,
        laneLabel: params.selectedWork.laneLabel,
      }),
    });
  }

  return suggestions.slice(0, 3);
}

function buildMissionDetailText(snapshot: MissionPlanSnapshot): string {
  return buildSignatureFlowText({
    lead: snapshot.mission.summary,
    detailLines: [
      ...snapshot.steps.map(
        (step) =>
          `${step.position}. ${step.title}${step.detail ? ` - ${step.detail}` : ''}`,
      ),
      snapshot.blockers[0] ? `Blocker: ${snapshot.blockers[0]}` : null,
      ...snapshot.explainabilityLines.slice(1).map((line) => `Why: ${line}`),
    ],
    nextAction:
      snapshot.suggestedActions[0]?.label ||
      snapshot.steps.find((step) => step.stepStatus !== 'done')?.title ||
      null,
    whyLine: snapshot.explainabilityLines[0],
  });
}

function isMissionBlockerExplainRequest(text: string): boolean {
  return /\b(what('?s| is) blocking this|what('?s| is) the blocker|what am i missing for this)\b/i.test(
    text,
  );
}

function formatMissionReply(
  input: Pick<MissionTurnInput, 'channel' | 'mode' | 'text'>,
  channel: MissionTurnInput['channel'],
  snapshot: MissionPlanSnapshot,
  stepFocus: MissionStepRecord | null,
): string {
  const blocker = snapshot.blockers[0];
  const action = snapshot.suggestedActions[0]?.label;
  const lowerFirst = (value: string) =>
    value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
  if (
    input.mode === 'explain' &&
    isMissionBlockerExplainRequest(input.text || '')
  ) {
    if (channel === 'alexa') {
      if (blocker) {
        return stepFocus
          ? `The main blocker right now is this: ${blocker} Next, clear it by ${stepFocus.title}.`
          : `The main blocker right now is this: ${blocker}`;
      }
      return action
        ? `I do not see a major blocker right now. Next, ${lowerFirst(action)}.`
        : 'I do not see a major blocker right now.';
    }

    return buildSignatureFlowText({
      lead: blocker
        ? `The main blocker right now is this: ${blocker}`
        : 'I do not see a major blocker right now.',
      detailLines: stepFocus ? [`Clear it by: ${stepFocus.title}.`] : [],
      nextAction: action || stepFocus?.title || null,
      whyLine: snapshot.explainabilityLines[0],
    });
  }

  if (channel === 'alexa') {
    const parts = [snapshot.mission.summary];
    const summaryKey = snapshot.mission.summary.toLowerCase();
    if (stepFocus) {
      const stepTitle = lowerFirst(stepFocus.title);
      if (!summaryKey.includes(stepTitle)) {
        parts.push(`Next, ${stepTitle}.`);
      }
    }
    if (blocker) {
      parts.push(
        `The main blocker is ${blocker.replace(/\.$/, '').toLowerCase()}.`,
      );
    } else if (action) {
      parts.push(`If you want, I can ${lowerFirst(action)}.`);
    }
    return parts.join(' ');
  }
  return buildSignatureFlowText({
    lead: snapshot.mission.summary,
    detailLines: snapshot.steps.map(
      (step) =>
        `${step.position}. ${step.title}${step.detail ? ` - ${step.detail}` : ''}`,
    ),
    nextAction: action || stepFocus?.title || null,
    whyLine: blocker || snapshot.explainabilityLines[0],
  });
}

function resolveExistingMission(
  input: MissionTurnInput,
): MissionRecord | undefined {
  const normalizedText = normalizeText(input.text);
  const referencesPriorMission = /\b(this|that)\b/i.test(normalizedText);

  if (input.mode === 'propose') {
    if (referencesPriorMission) {
      if (input.priorContext?.missionId) {
        return getMission(input.priorContext.missionId);
      }
      return listMissionsForGroup({
        groupFolder: input.groupFolder,
        includeUnconfirmed: true,
        limit: 1,
      })[0];
    }
    return undefined;
  }

  if (input.priorContext?.missionId) {
    return getMission(input.priorContext.missionId);
  }
  return undefined;
}

function resolveManageTargetAction(
  utterance: string,
  suggestedActions: MissionSuggestedAction[],
): MissionSuggestedActionKind | null {
  const lower = utterance.toLowerCase();
  if (/draft it|draft that/.test(lower)) return 'draft_follow_up';
  if (/remind me|set a reminder/.test(lower)) return 'create_reminder';
  if (/save that|save this/.test(lower)) return 'save_to_library';
  if (/track that/.test(lower)) return 'link_thread';
  if (/research/.test(lower)) return 'start_research';
  if (/ritual|tonight/.test(lower)) return 'pin_to_ritual';
  return suggestedActions[0]?.kind || null;
}

async function buildMissionSnapshot(
  input: MissionTurnInput,
  existing?: MissionRecord,
): Promise<{
  snapshot: MissionPlanSnapshot;
  stepFocus: MissionStepRecord | null;
}> {
  const now = input.now || new Date();
  const objective = existing?.objective || extractObjective(input);
  const linkedSubjects = mergeLinkedSubjects(
    resolveStoredLinkedSubjects(input.groupFolder, existing),
    resolveLinkedSubjects(input.groupFolder, objective, input.priorContext),
  );
  const linkedLifeThread =
    resolveStoredLinkedLifeThread(existing) ||
    resolveLinkedLifeThread(input.groupFolder, objective, input.priorContext);
  const horizon = existing?.dueHorizon || inferHorizon(input.text);
  const chief = await buildChiefOfStaffSnapshot({
    channel: input.channel,
    groupFolder: input.groupFolder,
    text: input.text,
    mode:
      input.mode === 'explain'
        ? 'explain'
        : /\bprepare|prep\b/i.test(objective)
          ? 'prepare'
          : /\bweek|weekend|tomorrow|tonight\b/i.test(input.text)
            ? 'plan_horizon'
            : 'prioritize',
    chatJid: input.chatJid,
    selectedWork: input.selectedWork || null,
    priorChiefOfStaffContextJson: input.priorContext?.chiefOfStaffContextJson,
    priorCommunicationSubjectIds: input.priorContext?.communicationSubjectIds,
    priorKnowledgeSourceIds: input.priorContext?.knowledgeSourceIds,
    now,
  });
  const openLoops = buildCommunicationOpenLoops({
    channel: input.channel,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    text: input.text,
    conversationSummary: input.conversationSummary,
    priorContext: {
      personName: input.priorContext?.personName,
      communicationSubjectIds: input.priorContext?.communicationSubjectIds,
      communicationThreadId: input.priorContext?.communicationThreadId,
      communicationLifeThreadIds:
        input.priorContext?.communicationLifeThreadIds,
      lastCommunicationSummary: input.priorContext?.lastCommunicationSummary,
    },
    now,
  });
  const knowledgeSources = shouldUseKnowledge(objective)
    ? searchKnowledgeLibrary({
        groupFolder: input.groupFolder,
        query: objective,
        requestedSourceIds: input.priorContext?.knowledgeSourceIds,
        limit: 3,
      }).sources.slice(0, 2)
    : [];
  const inferredCategory = inferMissionCategory({
    objective,
    linkedSubjects,
    linkedLifeThreadTitle: linkedLifeThread?.title || null,
    selectedWork: input.selectedWork || null,
  });
  const category = existing?.category || inferredCategory;
  const selectedWork = resolveRelevantSelectedWork({
    selectedWork: input.selectedWork || null,
    objective,
    category,
  });
  const scope =
    existing?.scope ||
    inferMissionScope(category, linkedSubjects, selectedWork);
  const blockers = buildMissionBlockers({
    objective,
    horizon,
    selectedWork,
    openLoopSummary: openLoops.summaryText,
    openLoopLead: openLoops.items[0]?.summaryText,
    linkedLifeThreadTitle: linkedLifeThread?.title || null,
    linkedSubjects,
  });
  const existingSteps = existing ? listMissionSteps(existing.missionId) : [];
  const simplify = /\bmake it simpler\b/i.test(input.text);
  const expand = /\bbreak it down more\b/i.test(input.text);
  const missionId = existing?.missionId || randomUUID();
  const steps = buildMissionSteps({
    missionId,
    objective,
    horizon,
    linkedLifeThreadTitle: linkedLifeThread?.title || null,
    linkedSubjects,
    selectedWork,
    knowledgeTitles: knowledgeSources.map((source) => source.title),
    blockers,
    existingSteps,
    simplify,
    expand,
    now,
  });
  const suggestedActions = buildMissionSuggestedActions({
    linkedLifeThreadTitle: linkedLifeThread?.title || null,
    linkedSubjects,
    knowledgeSourceIds: knowledgeSources.map((source) => source.sourceId),
    selectedWork,
    blockers,
    steps,
    mutedKinds: existing?.mutedSuggestedActionKinds || [],
  });
  const stepFocus =
    steps.find((step) => step.stepStatus !== 'done') || steps[0] || null;
  const confidence: ChiefOfStaffConfidence =
    blockers.length === 0 && suggestedActions.length > 1
      ? 'high'
      : steps.length >= 3
        ? 'medium'
        : 'low';
  const mission: MissionRecord = {
    missionId,
    groupFolder: input.groupFolder,
    title: buildMissionTitle(objective),
    objective,
    category,
    status: existing?.status || 'proposed',
    scope,
    linkedLifeThreadIds: linkedLifeThread ? [linkedLifeThread.id] : [],
    linkedSubjectIds: linkedSubjects.map((subject) => subject.id),
    linkedReminderIds: existing?.linkedReminderIds || [],
    linkedCurrentWorkJson:
      existing?.linkedCurrentWorkJson ||
      (selectedWork ? JSON.stringify(selectedWork) : null),
    linkedKnowledgeSourceIds: knowledgeSources.map((source) => source.sourceId),
    summary: buildMissionSummary({
      title: buildMissionTitle(objective),
      blockers,
      horizon,
      canDoNow: stepFocus?.title || null,
    }),
    suggestedNextActionJson: suggestedActions[0]
      ? JSON.stringify(suggestedActions[0])
      : null,
    blockersJson: JSON.stringify(blockers),
    dueHorizon: horizon,
    dueAt: existing?.dueAt || null,
    mutedSuggestedActionKinds: existing?.mutedSuggestedActionKinds || [],
    createdAt: existing?.createdAt || now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    userConfirmed: existing?.userConfirmed || false,
  };
  return {
    snapshot: {
      mission,
      steps,
      blockers,
      suggestedActions,
      explainabilityLines: buildMissionExplainability({
        chiefSignalsUsed: chief.snapshot.signalsUsed,
        linkedLifeThreadTitle: linkedLifeThread?.title || null,
        linkedSubjects,
        knowledgeTitles: knowledgeSources.map((source) => source.title),
        blockers,
      }),
      confidence,
    },
    stepFocus,
  };
}

function persistMissionSnapshot(snapshot: MissionPlanSnapshot): void {
  upsertMission(snapshot.mission);
  replaceMissionSteps(snapshot.mission.missionId, snapshot.steps);
  syncOutcomeFromMissionRecord(snapshot.mission, snapshot.steps);
}

export async function buildMissionTurn(
  input: MissionTurnInput,
): Promise<MissionTurnResult> {
  const now = input.now || new Date();
  const existing = resolveExistingMission(input);
  const { snapshot, stepFocus } = await buildMissionSnapshot(input, existing);
  let mission = snapshot.mission;
  let steps = snapshot.steps;
  let blockers = [...snapshot.blockers];
  let suggestedActions = [...snapshot.suggestedActions];

  if (input.mode === 'manage') {
    const lower = input.text.toLowerCase();
    if (/save this plan|activate this/.test(lower)) {
      mission = {
        ...mission,
        status: 'active',
        userConfirmed: true,
        lastUpdatedAt: now.toISOString(),
      };
    } else if (/pause that plan/.test(lower)) {
      mission = {
        ...mission,
        status: 'paused',
        lastUpdatedAt: now.toISOString(),
      };
    } else if (/close that plan/.test(lower)) {
      mission = {
        ...mission,
        status: 'archived',
        lastUpdatedAt: now.toISOString(),
      };
    } else if (/mark (?:this|that) (?:done|handled)/.test(lower)) {
      mission = {
        ...mission,
        status: 'completed',
        lastUpdatedAt: now.toISOString(),
      };
      steps = steps.map((step) => ({
        ...step,
        stepStatus: 'done',
        lastUpdatedAt: now.toISOString(),
      }));
    } else if (/stop suggesting that|not now/.test(lower)) {
      const target = resolveManageTargetAction(input.text, suggestedActions);
      mission = {
        ...mission,
        mutedSuggestedActionKinds: target
          ? [...new Set([...mission.mutedSuggestedActionKinds, target])]
          : mission.mutedSuggestedActionKinds,
        lastUpdatedAt: now.toISOString(),
      };
      suggestedActions = suggestedActions.filter(
        (action) => action.kind !== target,
      );
      mission.suggestedNextActionJson = suggestedActions[0]
        ? JSON.stringify(suggestedActions[0])
        : null;
    }
  }

  const finalSnapshot: MissionPlanSnapshot = {
    ...snapshot,
    mission,
    steps,
    blockers,
    suggestedActions,
  };
  persistMissionSnapshot(finalSnapshot);

  return {
    ok: true,
    summaryText: mission.summary,
    detailText: buildMissionDetailText(finalSnapshot),
    replyText: formatMissionReply(input, input.channel, finalSnapshot, stepFocus),
    mission,
    steps,
    blockers,
    suggestedActions,
    explainabilityLines: finalSnapshot.explainabilityLines,
    confidence: finalSnapshot.confidence,
    stepFocus,
  };
}

export function buildMissionExecutionContext(
  missionId: string,
): MissionExecutionContext | null {
  const mission = getMission(missionId);
  if (!mission) return null;
  const steps = listMissionSteps(missionId);
  const suggestedActions = safeJsonParse<MissionSuggestedAction[]>(
    mission.suggestedNextActionJson
      ? `[${mission.suggestedNextActionJson}]`
      : '[]',
    [],
  );
  const stepFocus = steps.find((step) => step.stepStatus !== 'done') || null;
  return {
    mission,
    steps,
    stepFocus,
    suggestedActions,
  };
}

export function pickMissionActionFromUtterance(params: {
  utterance: string;
  suggestedActions: MissionSuggestedAction[];
}): MissionSuggestedActionKind | null {
  const lower = params.utterance.toLowerCase();
  if (/start (?:the )?research/.test(lower)) return 'start_research';
  if (/remind me/.test(lower)) return 'create_reminder';
  if (/draft it|draft that/.test(lower)) return 'draft_follow_up';
  if (/save (?:that|this)/.test(lower)) return 'save_to_library';
  if (/track (?:that|this)/.test(lower)) return 'link_thread';
  if (/tonight'?s ritual|evening reset|pin/.test(lower)) return 'pin_to_ritual';
  if (/current work/.test(lower)) return 'reference_current_work';
  return params.suggestedActions[0]?.kind || null;
}

export function updateMissionAfterExecution(params: {
  missionId: string;
  actionKind: MissionSuggestedActionKind;
  linkedReminderId?: string | null;
  linkedKnowledgeSourceId?: string | null;
  linkedLifeThreadId?: string | null;
  linkedCurrentWorkJson?: string | null;
}): MissionRecord | null {
  const mission = getMission(params.missionId);
  if (!mission) return null;
  const updated: MissionRecord = {
    ...mission,
    linkedReminderIds: params.linkedReminderId
      ? [...new Set([...mission.linkedReminderIds, params.linkedReminderId])]
      : mission.linkedReminderIds,
    linkedKnowledgeSourceIds: params.linkedKnowledgeSourceId
      ? [
          ...new Set([
            ...mission.linkedKnowledgeSourceIds,
            params.linkedKnowledgeSourceId,
          ]),
        ]
      : mission.linkedKnowledgeSourceIds,
    linkedLifeThreadIds: params.linkedLifeThreadId
      ? [
          ...new Set([
            ...mission.linkedLifeThreadIds,
            params.linkedLifeThreadId,
          ]),
        ]
      : mission.linkedLifeThreadIds,
    linkedCurrentWorkJson:
      params.linkedCurrentWorkJson || mission.linkedCurrentWorkJson || null,
    status: mission.status === 'proposed' ? 'active' : mission.status,
    userConfirmed:
      mission.userConfirmed || params.actionKind !== 'reference_current_work',
    lastUpdatedAt: new Date().toISOString(),
  };
  upsertMission(updated);
  const steps = listMissionSteps(params.missionId);
  const targetStep = steps.find(
    (step) =>
      step.suggestedActionKind === params.actionKind &&
      step.stepStatus !== 'done',
  );
  if (targetStep) {
    replaceMissionSteps(
      params.missionId,
      steps.map((step) =>
        step.stepId === targetStep.stepId
          ? {
              ...step,
              stepStatus:
                params.actionKind === 'reference_current_work'
                  ? 'waiting'
                  : 'done',
              lastUpdatedAt: updated.lastUpdatedAt,
            }
          : step,
      ),
    );
  }
  syncOutcomeFromMissionRecord(updated, listMissionSteps(params.missionId));
  return updated;
}

export function getMissionCarryoverSignal(params: { groupFolder: string }): {
  missionId: string;
  summaryText: string;
  sourceLabel: string;
} | null {
  const mission =
    listMissionsForGroup({
      groupFolder: params.groupFolder,
      statuses: ['active', 'blocked'],
      includeUnconfirmed: false,
      limit: 1,
    })[0] || null;
  if (!mission) return null;
  const steps = listMissionSteps(mission.missionId);
  const nextStep = steps.find((step) => step.stepStatus !== 'done');
  return {
    missionId: mission.missionId,
    summaryText: nextStep?.title
      ? `${mission.title}: ${nextStep.title}.`
      : mission.summary,
    sourceLabel: mission.title,
  };
}
