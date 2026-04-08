import { randomUUID } from 'crypto';

import {
  getDelegationRule,
  listDelegationRulesForGroup,
  updateDelegationRule,
  upsertDelegationRule,
} from './db.js';
import type {
  ActionBundleActionRecord,
  ActionBundleActionStatus,
  ActionBundleActionType,
  ActionBundleOriginKind,
  ActionBundlePresentationChannel,
  ActionBundleSnapshot,
  ChannelInlineAction,
  DelegationApprovalMode,
  DelegationPromptPattern,
  DelegationRuleAction,
  DelegationRuleConditions,
  DelegationRuleRecord,
  DelegationRuleStatus,
  DelegationSafetyLevel,
  DelegationTriggerScope,
  DelegationTriggerType,
  MissionCategory,
  OutcomeReviewHorizon,
  OutcomeStatus,
  RitualType,
} from './types.js';

export interface DelegationRuleActionContext {
  groupFolder: string;
  channel: ActionBundlePresentationChannel;
  actionType: ActionBundleActionType;
  originKind?: ActionBundleOriginKind | null;
  missionCategory?: MissionCategory | null;
  personName?: string | null;
  threadTitle?: string | null;
  promptPattern?: DelegationPromptPattern | null;
  ritualType?: RitualType | null;
  reviewHorizon?: OutcomeReviewHorizon | null;
  communicationContext?:
    | 'reply_followthrough'
    | 'household_followthrough'
    | 'general'
    | null;
}

export interface RuleAwareActionPlan<TPayload = unknown> {
  actionType: ActionBundleActionType;
  targetSystem: ActionBundleActionRecord['targetSystem'];
  summary: string;
  requiresConfirmation: boolean;
  initialStatus?: ActionBundleActionStatus;
  payload: TPayload;
  delegationRuleId?: string | null;
  delegationMode?: DelegationApprovalMode | null;
  delegationExplanation?: string | null;
}

export interface DelegationRuleMatchResult {
  rule?: DelegationRuleRecord;
  delegatedAction?: DelegationRuleAction;
  effectiveApprovalMode: DelegationApprovalMode;
  safetyLevel: DelegationSafetyLevel;
  explanation?: string | null;
  autoApplied: boolean;
}

export interface DelegationRuleIntent {
  kind:
    | 'show_rules'
    | 'pause_rule'
    | 'disable_rule'
    | 'always_ask'
    | 'stop_automatic'
    | 'why_rule'
    | 'create_preview';
  requestedApprovalMode?: DelegationApprovalMode;
  explicitPromptPattern?: DelegationPromptPattern;
  explicitActionType?: ActionBundleActionType;
  timingHint?: string;
  personName?: string;
  threadHint?: string;
  explicitTriggerType?: DelegationTriggerType;
  explicitScope?: DelegationTriggerScope;
  communicationContext?:
    | 'reply_followthrough'
    | 'household_followthrough'
    | 'general';
}

export interface DelegationRulePreview {
  previewId: string;
  title: string;
  triggerType: DelegationTriggerType;
  triggerScope: DelegationTriggerScope;
  conditions: DelegationRuleConditions;
  delegatedActions: DelegationRuleAction[];
  approvalMode: DelegationApprovalMode;
  status: DelegationRuleStatus;
  safetyLevel: DelegationSafetyLevel;
  channelApplicability: ActionBundlePresentationChannel[];
  explanation: string;
  safetyNote: string;
}

export interface DelegationRulePreviewResult {
  handled: boolean;
  preview?: DelegationRulePreview;
  clarificationQuestion?: string;
}

export interface DelegationRulePresentation {
  text: string;
  inlineActionRows: ChannelInlineAction[][];
}

export interface DelegationRuleContext {
  groupFolder: string;
  channel: ActionBundlePresentationChannel;
  currentBundle?: ActionBundleSnapshot | null;
  actionTypeHint?: ActionBundleActionType | null;
  originKind?: ActionBundleOriginKind | null;
  missionCategory?: MissionCategory | null;
  personName?: string | null;
  threadTitle?: string | null;
  promptPattern?: DelegationPromptPattern | null;
  ritualType?: RitualType | null;
  reviewHorizon?: OutcomeReviewHorizon | null;
  communicationContext?:
    | 'reply_followthrough'
    | 'household_followthrough'
    | 'general'
    | null;
}

export interface DelegationRuleListPresentation {
  text: string;
  inlineActionRows: ChannelInlineAction[][];
  focusRuleIds: string[];
  primaryRuleId?: string;
}

const DEFAULT_RULE_CHANNELS: ActionBundlePresentationChannel[] = [
  'telegram',
  'alexa',
  'bluebubbles',
];

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function titleCaseAction(actionType: ActionBundleActionType): string {
  switch (actionType) {
    case 'create_reminder':
      return 'reminder';
    case 'draft_follow_up':
      return 'draft';
    case 'save_to_thread':
      return 'thread save';
    case 'save_to_library':
      return 'library save';
    case 'pin_to_ritual':
      return 'ritual pin';
    case 'send_to_telegram':
      return 'Telegram handoff';
    case 'reference_current_work':
      return 'current-work reference';
    default:
      return 'follow-through';
  }
}

function formatChannelList(channels: ActionBundlePresentationChannel[]): string {
  const unique = [...new Set(channels)];
  if (unique.length === DEFAULT_RULE_CHANNELS.length) return 'all Andrea channels';
  return unique.join(', ');
}

function parseRuleConditions(
  rule: DelegationRuleRecord,
): DelegationRuleConditions {
  return parseJsonSafe<DelegationRuleConditions>(rule.conditionsJson, {});
}

function parseRuleActions(rule: DelegationRuleRecord): DelegationRuleAction[] {
  return parseJsonSafe<DelegationRuleAction[]>(rule.delegatedActionsJson, []);
}

function parseRuleChannels(
  rule: Pick<DelegationRuleRecord, 'channelApplicabilityJson'>,
): ActionBundlePresentationChannel[] {
  const parsed = parseJsonSafe<ActionBundlePresentationChannel[]>(
    rule.channelApplicabilityJson,
    DEFAULT_RULE_CHANNELS,
  );
  return parsed.length > 0 ? parsed : DEFAULT_RULE_CHANNELS;
}

export function classifyDelegationSafety(
  actionType: ActionBundleActionType,
): DelegationSafetyLevel {
  switch (actionType) {
    case 'save_to_thread':
    case 'save_to_library':
    case 'pin_to_ritual':
    case 'reference_current_work':
    case 'send_to_telegram':
    case 'draft_follow_up':
    case 'create_reminder':
      return 'safe_to_auto_after_delegation';
    default:
      return 'always_requires_fresh_approval';
  }
}

function approvalModeSafetyRank(mode: DelegationApprovalMode): number {
  switch (mode) {
    case 'always_ask':
      return 0;
    case 'suggest_only':
      return 1;
    case 'ask_once_then_remember':
      return 2;
    case 'auto_apply_when_safe':
      return 3;
    default:
      return 4;
  }
}

function specificityScore(conditions: DelegationRuleConditions): number {
  let score = 0;
  if (conditions.actionType) score += 5;
  if (conditions.originKind) score += 4;
  if (conditions.personName) score += 3;
  if (conditions.threadTitle) score += 3;
  if (conditions.promptPattern) score += 3;
  if (conditions.missionCategory) score += 2;
  if (conditions.ritualType) score += 2;
  if (conditions.reviewHorizon) score += 2;
  if (conditions.communicationContext) score += 2;
  return score;
}

function actionTypeMatches(
  conditionType: DelegationRuleConditions['actionType'],
  actionType: ActionBundleActionType,
): boolean {
  return !conditionType || conditionType === actionType;
}

function textFieldMatches(
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  if (!normalizeText(expected)) return true;
  return normalizeText(expected).toLowerCase() === normalizeText(actual).toLowerCase();
}

function ruleMatchesContext(
  rule: DelegationRuleRecord,
  context: DelegationRuleActionContext,
): boolean {
  if (!parseRuleChannels(rule).includes(context.channel)) return false;
  const conditions = parseRuleConditions(rule);
  if (!actionTypeMatches(conditions.actionType, context.actionType)) return false;
  if (conditions.originKind && conditions.originKind !== context.originKind) return false;
  if (
    conditions.missionCategory &&
    conditions.missionCategory !== context.missionCategory
  ) {
    return false;
  }
  if (!textFieldMatches(conditions.personName, context.personName)) return false;
  if (!textFieldMatches(conditions.threadTitle, context.threadTitle)) return false;
  if (
    conditions.promptPattern &&
    conditions.promptPattern !== context.promptPattern
  ) {
    return false;
  }
  if (conditions.ritualType && conditions.ritualType !== context.ritualType) {
    return false;
  }
  if (
    conditions.reviewHorizon &&
    conditions.reviewHorizon !== context.reviewHorizon
  ) {
    return false;
  }
  if (
    conditions.communicationContext &&
    conditions.communicationContext !== context.communicationContext
  ) {
    return false;
  }
  return rule.status === 'active';
}

function safetyNoteFor(
  safetyLevel: DelegationSafetyLevel,
  actionType: ActionBundleActionType,
): string {
  if (safetyLevel === 'always_requires_fresh_approval') {
    return `Andrea will still ask each time before ${titleCaseAction(actionType)} because that action family stays guarded.`;
  }
  if (safetyLevel === 'never_automate') {
    return 'Andrea will never automate that kind of action.';
  }
  if (safetyLevel === 'safe_to_suggest_only') {
    return 'Andrea can suggest that by default, but it will not auto-apply it.';
  }
  return 'Andrea can reuse this as a bounded default when it is safe to do so.';
}

function explanationForMatch(
  rule: DelegationRuleRecord,
  effectiveApprovalMode: DelegationApprovalMode,
  actionType: ActionBundleActionType,
): string {
  if (effectiveApprovalMode === 'auto_apply_when_safe') {
    return `Used your saved ${titleCaseAction(actionType)} rule here.`;
  }
  if (
    rule.approvalMode === 'ask_once_then_remember' &&
    effectiveApprovalMode === 'always_ask'
  ) {
    return `I remembered your ${titleCaseAction(actionType)} default, but I kept asking this first time.`;
  }
  if (effectiveApprovalMode === 'suggest_only') {
    return `Surfaced because of your saved ${titleCaseAction(actionType)} rule.`;
  }
  return `I kept asking because this ${titleCaseAction(actionType)} still needs a fresh check.`;
}

function effectiveApprovalModeForRule(
  rule: DelegationRuleRecord,
  safetyLevel: DelegationSafetyLevel,
): DelegationApprovalMode {
  if (safetyLevel === 'never_automate') return 'always_ask';
  if (safetyLevel === 'always_requires_fresh_approval') {
    return rule.approvalMode === 'suggest_only' ? 'suggest_only' : 'always_ask';
  }
  if (safetyLevel === 'safe_to_suggest_only') return 'suggest_only';
  if (
    rule.approvalMode === 'ask_once_then_remember' &&
    rule.timesUsed < 1
  ) {
    return 'always_ask';
  }
  if (rule.approvalMode === 'ask_once_then_remember') {
    return 'auto_apply_when_safe';
  }
  return rule.approvalMode;
}

export function findMatchingDelegationRule(
  context: DelegationRuleActionContext,
): DelegationRuleMatchResult {
  const activeRules = listDelegationRulesForGroup({
    groupFolder: context.groupFolder,
    statuses: ['active'],
    limit: 100,
  });
  const candidates = activeRules
    .filter((rule) => ruleMatchesContext(rule, context))
    .sort((left, right) => {
      const specificityDiff =
        specificityScore(parseRuleConditions(right)) -
        specificityScore(parseRuleConditions(left));
      if (specificityDiff !== 0) return specificityDiff;
      return approvalModeSafetyRank(left.approvalMode) - approvalModeSafetyRank(right.approvalMode);
    });

  const rule = candidates[0];
  if (!rule) {
    return {
      effectiveApprovalMode: 'always_ask',
      safetyLevel: classifyDelegationSafety(context.actionType),
      autoApplied: false,
    };
  }
  const safetyLevel = classifyDelegationSafety(context.actionType);
  const effectiveApprovalMode = effectiveApprovalModeForRule(rule, safetyLevel);
  const delegatedAction =
    parseRuleActions(rule).find(
      (action) => action.actionType === context.actionType,
    ) || parseRuleActions(rule)[0];
  return {
    rule,
    delegatedAction,
    effectiveApprovalMode,
    safetyLevel,
    explanation: explanationForMatch(rule, effectiveApprovalMode, context.actionType),
    autoApplied: effectiveApprovalMode === 'auto_apply_when_safe',
  };
}

function withDelegatedOverrides<TPayload extends { type?: string; timingHint?: string | null; threadTitle?: string | null }>(
  payload: TPayload,
  delegatedAction: DelegationRuleAction | undefined,
): TPayload {
  if (!delegatedAction) return payload;
  if (payload.type === 'create_reminder' && delegatedAction.timingHint) {
    return { ...payload, timingHint: delegatedAction.timingHint } as TPayload;
  }
  if (payload.type === 'save_to_thread' && delegatedAction.threadTitle) {
    return { ...payload, threadTitle: delegatedAction.threadTitle } as TPayload;
  }
  return payload;
}

export function applyDelegationRulesToActionPlans<TPayload extends { type?: string; timingHint?: string | null; threadTitle?: string | null }>(
  params: {
    groupFolder: string;
    channel: ActionBundlePresentationChannel;
    originKind?: ActionBundleOriginKind | null;
    missionCategory?: MissionCategory | null;
    personName?: string | null;
    threadTitle?: string | null;
    promptPattern?: DelegationPromptPattern | null;
    ritualType?: RitualType | null;
    reviewHorizon?: OutcomeReviewHorizon | null;
    communicationContext?:
      | 'reply_followthrough'
      | 'household_followthrough'
      | 'general'
      | null;
    actions: RuleAwareActionPlan<TPayload>[];
  },
): RuleAwareActionPlan<TPayload>[] {
  return params.actions.map((action) => {
    const match = findMatchingDelegationRule({
      groupFolder: params.groupFolder,
      channel: params.channel,
      actionType: action.actionType,
      originKind: params.originKind,
      missionCategory: params.missionCategory,
      personName: params.personName,
      threadTitle: params.threadTitle,
      promptPattern: params.promptPattern,
      ritualType: params.ritualType,
      reviewHorizon: params.reviewHorizon,
      communicationContext: params.communicationContext,
    });
    if (!match.rule) return action;
    return {
      ...action,
      payload: withDelegatedOverrides(action.payload, match.delegatedAction),
      requiresConfirmation: match.effectiveApprovalMode !== 'auto_apply_when_safe',
      initialStatus:
        match.effectiveApprovalMode === 'auto_apply_when_safe'
          ? 'approved'
          : action.initialStatus || 'proposed',
      delegationRuleId: match.rule.ruleId,
      delegationMode: match.effectiveApprovalMode,
      delegationExplanation: match.explanation || undefined,
    };
  });
}

export function recordDelegationRuleUsage(params: {
  ruleId: string;
  autoApplied?: boolean;
  outcomeStatus?: OutcomeStatus | null;
  now?: Date;
}): void {
  const rule = getDelegationRule(params.ruleId);
  if (!rule) return;
  updateDelegationRule(rule.ruleId, {
    timesUsed: rule.timesUsed + 1,
    timesAutoApplied:
      rule.timesAutoApplied + (params.autoApplied ? 1 : 0),
    lastUsedAt: (params.now || new Date()).toISOString(),
    lastOutcomeStatus:
      params.outcomeStatus !== undefined
        ? params.outcomeStatus
        : rule.lastOutcomeStatus,
  });
}

export function recordDelegationRuleOverride(
  ruleId: string,
  now = new Date(),
): void {
  const rule = getDelegationRule(ruleId);
  if (!rule) return;
  updateDelegationRule(rule.ruleId, {
    timesOverridden: rule.timesOverridden + 1,
    lastUsedAt: now.toISOString(),
  });
}

export function getDelegationRuleHelpfulness(
  rule: DelegationRuleRecord,
): 'useful' | 'mixed' | 'needs revision' {
  if (rule.timesOverridden >= 2 && rule.timesOverridden >= rule.timesUsed) {
    return 'needs revision';
  }
  if (rule.timesOverridden > 0) return 'mixed';
  return 'useful';
}

export function interpretDelegationRuleUtterance(
  rawText: string,
): DelegationRuleIntent | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (!normalized) return null;
  if (/^show my rules\b/.test(normalized)) return { kind: 'show_rules' };
  if (/^why did that fire\b/.test(normalized)) return { kind: 'why_rule' };
  if (/^pause that rule\b/.test(normalized)) return { kind: 'pause_rule' };
  if (/^disable that rule\b/.test(normalized)) return { kind: 'disable_rule' };
  if (
    /^always ask before doing that\b/.test(normalized) ||
    /^always ask before that\b/.test(normalized)
  ) {
    return { kind: 'always_ask' };
  }
  if (/^stop doing that automatically\b/.test(normalized)) {
    return { kind: 'stop_automatic' };
  }
  const saveThatTiming = normalized.match(
    /^when i say save that,? use (.+?) by default$/,
  );
  if (saveThatTiming?.[1]) {
    return {
      kind: 'create_preview',
      requestedApprovalMode: 'auto_apply_when_safe',
      explicitPromptPattern: 'save_that',
      explicitActionType: 'create_reminder',
      timingHint: saveThatTiming[1].trim(),
      explicitTriggerType: 'prompt_pattern',
    };
  }
  if (/^always send the full version to telegram\b/.test(normalized)) {
    return {
      kind: 'create_preview',
      requestedApprovalMode: 'auto_apply_when_safe',
      explicitPromptPattern: 'send_full_version',
      explicitActionType: 'send_to_telegram',
      explicitTriggerType: 'prompt_pattern',
    };
  }
  const candaceReminder = normalized.match(
    /^if ([a-z][a-z' -]+) asks about (.+), remind me (.+)$/,
  );
  if (candaceReminder?.[1] && candaceReminder?.[3]) {
    return {
      kind: 'create_preview',
      requestedApprovalMode: 'auto_apply_when_safe',
      explicitActionType: 'create_reminder',
      timingHint: candaceReminder[3].trim(),
      personName: candaceReminder[1]
        .trim()
        .replace(/\b\w/g, (value) => value.toUpperCase()),
      threadHint: candaceReminder[2].trim(),
      explicitTriggerType: 'communication_context',
      explicitScope: 'household',
      communicationContext: 'household_followthrough',
    };
  }
  if (
    /^(do this automatically next time|don't ask me every time about that)\b/.test(
      normalized,
    )
  ) {
    return {
      kind: 'create_preview',
      requestedApprovalMode: 'auto_apply_when_safe',
    };
  }
  if (
    /^(remember this as my default|remember that as my default)\b/.test(
      normalized,
    )
  ) {
    return {
      kind: 'create_preview',
      requestedApprovalMode: 'ask_once_then_remember',
    };
  }
  return null;
}

function inferRuleTitle(params: {
  actionType: ActionBundleActionType;
  personName?: string | null;
  threadTitle?: string | null;
  originKind?: ActionBundleOriginKind | null;
}): string {
  if (params.personName) {
    return `${titleCaseAction(params.actionType)} default for ${params.personName}`;
  }
  if (params.threadTitle) {
    return `${titleCaseAction(params.actionType)} default for ${params.threadTitle}`;
  }
  if (params.originKind) {
    return `${titleCaseAction(params.actionType)} default for ${params.originKind.replace(/_/g, ' ')}`;
  }
  return `Default ${titleCaseAction(params.actionType)} rule`;
}

function actionFromSnapshot(
  utterance: string,
  snapshot: ActionBundleSnapshot | null | undefined,
): ActionBundleActionRecord | undefined {
  if (!snapshot) return undefined;
  const normalized = normalizeText(utterance).toLowerCase();
  const pending =
    snapshot.actions.filter((action) =>
      ['proposed', 'approved'].includes(action.status),
    ) || snapshot.actions;
  if (/reminder/.test(normalized)) {
    return pending.find((action) => action.actionType === 'create_reminder');
  }
  if (/draft/.test(normalized)) {
    return pending.find((action) => action.actionType === 'draft_follow_up');
  }
  if (/thread|save/.test(normalized)) {
    return pending.find((action) => action.actionType === 'save_to_thread');
  }
  if (/library/.test(normalized)) {
    return pending.find((action) => action.actionType === 'save_to_library');
  }
  if (/telegram|full/.test(normalized)) {
    return pending.find((action) => action.actionType === 'send_to_telegram');
  }
  return pending[0];
}

export function buildDelegationRulePreview(params: {
  utterance: string;
  context: DelegationRuleContext;
}): DelegationRulePreviewResult {
  const intent = interpretDelegationRuleUtterance(params.utterance);
  if (!intent || intent.kind !== 'create_preview') {
    return { handled: false };
  }

  const explicitActionType = intent.explicitActionType;
  const focusedAction =
    explicitActionType ||
    params.context.actionTypeHint ||
    actionFromSnapshot(params.utterance, params.context.currentBundle)?.actionType;
  if (!focusedAction) {
    return {
      handled: true,
      clarificationQuestion:
        'Tell me which action you want me to remember, like the reminder, draft, or thread save.',
    };
  }

  const actionRecord = actionFromSnapshot(
    params.utterance,
    params.context.currentBundle,
  );
  const payload = actionRecord
    ? parseJsonSafe<{ timingHint?: string | null; threadTitle?: string | null }>(
        actionRecord.payloadJson,
        {},
      )
    : {};
  const safetyLevel = classifyDelegationSafety(focusedAction);
  const triggerType = intent.explicitTriggerType || 'bundle_type';
  const triggerScope = intent.explicitScope || 'mixed';
  const approvalMode = intent.requestedApprovalMode || 'ask_once_then_remember';
  const personName = intent.personName || params.context.personName || null;
  const threadTitle =
    intent.threadHint ||
    params.context.threadTitle ||
    payload.threadTitle ||
    null;
  const conditions: DelegationRuleConditions = {
    promptPattern: intent.explicitPromptPattern || params.context.promptPattern || undefined,
    actionType: focusedAction,
    originKind: params.context.originKind || params.context.currentBundle?.bundle.originKind || undefined,
    missionCategory: params.context.missionCategory || undefined,
    personName,
    threadTitle,
    ritualType: params.context.ritualType || undefined,
    reviewHorizon: params.context.reviewHorizon || undefined,
    communicationContext:
      intent.communicationContext || params.context.communicationContext || undefined,
  };
  const delegatedActions: DelegationRuleAction[] = [
    {
      actionType: focusedAction,
      timingHint: intent.timingHint || payload.timingHint || null,
      threadTitle,
    },
  ];
  const preview: DelegationRulePreview = {
    previewId: randomUUID(),
    title: inferRuleTitle({
      actionType: focusedAction,
      personName,
      threadTitle,
      originKind: conditions.originKind,
    }),
    triggerType,
    triggerScope,
    conditions,
    delegatedActions,
    approvalMode,
    status: 'active',
    safetyLevel,
    channelApplicability: DEFAULT_RULE_CHANNELS,
    explanation:
      approvalMode === 'always_ask'
        ? `Andrea will keep asking before ${titleCaseAction(focusedAction)} in similar situations.`
        : approvalMode === 'auto_apply_when_safe'
          ? `Andrea will use this ${titleCaseAction(focusedAction)} pattern automatically when it is safe and the same kind of situation comes up.`
          : `Andrea will remember this ${titleCaseAction(focusedAction)} pattern as your default and get smoother after the first confirmed use.`,
    safetyNote: safetyNoteFor(safetyLevel, focusedAction),
  };
  return { handled: true, preview };
}

export function saveDelegationRuleFromPreview(
  groupFolder: string,
  preview: DelegationRulePreview,
  now = new Date(),
): DelegationRuleRecord {
  const record: DelegationRuleRecord = {
    ruleId: randomUUID(),
    groupFolder,
    title: preview.title,
    triggerType: preview.triggerType,
    triggerScope: preview.triggerScope,
    conditionsJson: JSON.stringify(preview.conditions),
    delegatedActionsJson: JSON.stringify(preview.delegatedActions),
    approvalMode: preview.approvalMode,
    status: preview.status,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    timesUsed: 0,
    timesAutoApplied: 0,
    timesOverridden: 0,
    lastOutcomeStatus: null,
    userConfirmed: true,
    channelApplicabilityJson: JSON.stringify(preview.channelApplicability),
    safetyLevel: preview.safetyLevel,
  };
  upsertDelegationRule(record);
  return record;
}

export function buildDelegationRulePreviewPresentation(
  preview: DelegationRulePreview,
): DelegationRulePresentation {
  return {
    text: [
      '*Delegation rule preview*',
      `*${preview.title}*`,
      preview.explanation,
      '',
      `Trigger: ${preview.triggerType.replace(/_/g, ' ')}`,
      `Action: ${titleCaseAction(preview.delegatedActions[0]?.actionType || 'save_to_thread')}`,
      preview.delegatedActions[0]?.timingHint
        ? `Default timing: ${preview.delegatedActions[0].timingHint}`
        : null,
      `Approval mode: ${preview.approvalMode.replace(/_/g, ' ')}`,
      `Applies in: ${formatChannelList(preview.channelApplicability)}`,
      preview.safetyNote,
    ]
      .filter(Boolean)
      .join('\n'),
    inlineActionRows: [
      [
        {
          label: 'Save rule',
          actionId: `/rule-confirm ${preview.previewId}`,
        },
        {
          label: 'Cancel',
          actionId: `/rule-cancel ${preview.previewId}`,
        },
      ],
    ],
  };
}

function describeRule(rule: DelegationRuleRecord): string {
  const helpfulness = getDelegationRuleHelpfulness(rule);
  const conditions = parseRuleConditions(rule);
  const target = parseRuleActions(rule)[0];
  const targetLabel = target ? titleCaseAction(target.actionType) : 'follow-through';
  const scope =
    conditions.personName ||
    conditions.threadTitle ||
    conditions.originKind?.replace(/_/g, ' ') ||
    'general';
  return `${targetLabel} for ${scope} (${rule.approvalMode.replace(/_/g, ' ')}, ${helpfulness})`;
}

export function buildDelegationRuleListPresentation(params: {
  groupFolder: string;
  channel: ActionBundlePresentationChannel;
}): DelegationRuleListPresentation {
  const rules = listDelegationRulesForGroup({
    groupFolder: params.groupFolder,
    limit: 12,
  });
  if (rules.length === 0) {
    return {
      text: 'Andrea: You do not have any saved delegation rules yet.',
      inlineActionRows: [],
      focusRuleIds: [],
    };
  }
  const focusRules = rules.slice(0, 2);
  const lines = ['*Delegation rules*', ...rules.slice(0, 6).map((rule, index) => `${index + 1}. ${rule.title} — ${describeRule(rule)}`)];
  const rows: ChannelInlineAction[][] = [];
  for (const [index, rule] of focusRules.entries()) {
    const prefix = `${index + 1}.`;
    rows.push([
      { label: `${prefix} Pause`, actionId: `/rule-pause ${rule.ruleId}` },
      { label: `${prefix} Always ask`, actionId: `/rule-always-ask ${rule.ruleId}` },
      { label: `${prefix} Why this fired`, actionId: `/rule-why ${rule.ruleId}` },
    ]);
    rows.push([
      { label: `${prefix} Disable`, actionId: `/rule-disable ${rule.ruleId}` },
      { label: `${prefix} Auto-apply when safe`, actionId: `/rule-auto-safe ${rule.ruleId}` },
      { label: `${prefix} Use only here`, actionId: `/rule-use-here ${rule.ruleId}` },
    ]);
  }
  return {
    text: lines.join('\n'),
    inlineActionRows: rows,
    focusRuleIds: focusRules.map((rule) => rule.ruleId),
    primaryRuleId: focusRules[0]?.ruleId,
  };
}

export function buildDelegationRuleWhyText(
  rule: DelegationRuleRecord,
): string {
  const conditions = parseRuleConditions(rule);
  const actions = parseRuleActions(rule);
  const action = actions[0];
  const helpfulness = getDelegationRuleHelpfulness(rule);
  return [
    `Andrea: I used "${rule.title}" here.`,
    '',
    `It matches ${conditions.personName || conditions.threadTitle || conditions.originKind || 'this kind of flow'} and points to ${action ? titleCaseAction(action.actionType) : 'the saved next step'}.`,
    `Approval mode: ${rule.approvalMode.replace(/_/g, ' ')}.`,
    `Safety: ${rule.safetyLevel.replace(/_/g, ' ')}.`,
    `Recent signal: ${helpfulness}.`,
  ].join('\n');
}

export function updateDelegationRuleMode(
  ruleId: string,
  approvalMode: DelegationApprovalMode,
): DelegationRuleRecord | undefined {
  const rule = getDelegationRule(ruleId);
  if (!rule) return undefined;
  updateDelegationRule(ruleId, { approvalMode, status: 'active' });
  return getDelegationRule(ruleId);
}

export function retargetDelegationRuleChannels(
  ruleId: string,
  channels: ActionBundlePresentationChannel[],
): DelegationRuleRecord | undefined {
  const rule = getDelegationRule(ruleId);
  if (!rule) return undefined;
  updateDelegationRule(ruleId, {
    channelApplicabilityJson: JSON.stringify(channels),
    status: 'active',
  });
  return getDelegationRule(ruleId);
}

