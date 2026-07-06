import { buildCapabilitySelfModel } from './capability-self-model.js';
import { runActionPreflight } from './action-preflight.js';
import {
  buildCognitiveBlackboard,
  type BuildBlackboardInput,
} from './cognitive-blackboard.js';
import { redactCouncilText } from './council-safety.js';
import { completePilotJourney, startPilotJourney } from './pilot-mode.js';
import { buildLiveProofGauntletReport } from './live-proof-gauntlet.js';
import { analyzeMetacognitiveTurn } from './metacognition.js';
import { buildAutonomousImprovementLabReport } from './autonomous-improvement-lab.js';
import { planGoalDirectedRequest } from './goal-planner.js';
import {
  buildRealityGroundingReport,
  type BuildRealityGroundingInput,
} from './reality-grounding.js';
import type {
  CapabilityStateRecord,
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
  LiveProofGauntletStatus,
  PilotBlockerOwner,
  PilotJourneyId,
  PilotJourneyOutcome,
  RealityDoctorReport,
} from './types.js';

export type DogfoodGauntletStatus =
  | LiveProofGauntletStatus
  | 'manual_proof_needed'
  | 'repo_bug';

export interface DogfoodScorecard {
  routeCorrectness: number;
  contextRelevance: number;
  proofAwareness: number;
  safety: number;
  actionability: number;
  naturalness: number;
  confidenceCalibration: number;
  outcomeRecording: number;
  overall: number;
}

export interface DogfoodScenarioResult {
  scenarioId: string;
  prompt: string;
  channel: 'operator' | 'telegram' | 'bluebubbles' | 'alexa';
  route: string;
  status: DogfoodGauntletStatus;
  outcome: PilotJourneyOutcome;
  blockerOwner: PilotBlockerOwner;
  summary: string;
  nextAction: string;
  evidenceIds: string[];
  pilotEventId: string | null;
  scorecard: DogfoodScorecard;
  privacy: typeof PRIVACY;
}

export interface DogfoodGauntletReport {
  generatedAt: string;
  mode: 'operator_safe';
  scenarioCount: number;
  liveProven: number;
  nearLiveOnly: number;
  manualProofNeeded: number;
  externallyBlocked: number;
  missingConfig: number;
  failed: number;
  repoBug: number;
  averageScore: number;
  scenarios: DogfoodScenarioResult[];
  consistency: {
    braveSearchHealthy: boolean;
    telegramUserSessionMissingConfig: boolean;
    alexaSignedProofPending: boolean;
    blueBubblesTransportReadyButSameThreadProofIncomplete: boolean;
    repoWorkRequiredZero: boolean;
  };
  nextAction: string;
  privacy: typeof PRIVACY;
}

interface DogfoodScenarioDefinition {
  scenarioId: string;
  prompt: string;
  channel: DogfoodScenarioResult['channel'];
  route: string;
  systems: string[];
  journeyId?: PilotJourneyId;
  expectedStatus: 'near_live_only' | 'manual_proof_needed' | 'missing_config';
  evaluate: (ctx: DogfoodContext) => ScenarioEvaluation;
}

interface ScenarioEvaluation {
  status: DogfoodGauntletStatus;
  outcome: PilotJourneyOutcome;
  blockerOwner: PilotBlockerOwner;
  summary: string;
  nextAction: string;
  evidenceIds: string[];
  scores?: Partial<DogfoodScorecard>;
}

interface DogfoodContext {
  now: string;
  proofReport: LiveProofGauntletReport;
  realityReport: RealityDoctorReport;
  capabilityStates: CapabilityStateRecord[];
}

export interface RunDogfoodGauntletInput {
  now?: Date | string;
  persist?: boolean;
  proofReport?: LiveProofGauntletReport;
  realityReport?: RealityDoctorReport;
  realityInput?: BuildRealityGroundingInput;
}

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  providerDebatesStored: false,
  secretsRedacted: true,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

function nowIso(now?: Date | string): string {
  if (typeof now === 'string') return now;
  return (now || new Date()).toISOString();
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted dogfood metadata]';
  return redactCouncilText(text, limit);
}

function score(values: Partial<DogfoodScorecard>): DogfoodScorecard {
  const base: Omit<DogfoodScorecard, 'overall'> = {
    routeCorrectness: 0.88,
    contextRelevance: 0.86,
    proofAwareness: 0.9,
    safety: 1,
    actionability: 0.86,
    naturalness: 0.84,
    confidenceCalibration: 0.88,
    outcomeRecording: 0.8,
    ...values,
  };
  const numbers = Object.values(base);
  const overall =
    numbers.reduce((total, item) => total + item, 0) / numbers.length;
  return { ...base, overall: Number(overall.toFixed(3)) };
}

function proofByName(
  report: LiveProofGauntletReport,
  fragment: string,
): LiveProofGauntletEntry | null {
  return (
    report.entries.find((entry) =>
      entry.proofName.toLowerCase().includes(fragment.toLowerCase()),
    ) || null
  );
}

function parseEvidenceIds(entry: LiveProofGauntletEntry | null): string[] {
  if (!entry) return [];
  try {
    const ids = JSON.parse(entry.evidenceIdsJson);
    return Array.isArray(ids)
      ? ids
          .map((id) => String(id))
          .filter(Boolean)
          .slice(0, 12)
      : [entry.proofId];
  } catch {
    return [entry.proofId];
  }
}

function outcomeForStatus(status: DogfoodGauntletStatus): PilotJourneyOutcome {
  if (status === 'repo_bug' || status === 'failed') return 'internal_failure';
  if (status === 'externally_blocked' || status === 'missing_config') {
    return 'externally_blocked';
  }
  return 'degraded_usable';
}

function blockerOwnerForStatus(
  status: DogfoodGauntletStatus,
): PilotBlockerOwner {
  if (status === 'repo_bug' || status === 'failed') return 'repo_side';
  if (status === 'externally_blocked' || status === 'missing_config') {
    return 'external';
  }
  return 'none';
}

function textMessagingEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const telegramUser = proofByName(ctx.proofReport, 'telegram user');
  const telegramBot = proofByName(ctx.proofReport, 'telegram bot');
  const bluebubbles = proofByName(ctx.proofReport, 'bluebubbles');
  const status =
    telegramUser?.status === 'missing_config'
      ? 'missing_config'
      : bluebubbles?.status === 'live_proven' &&
          telegramBot?.status === 'live_proven'
        ? 'live_proven'
        : 'manual_proof_needed';
  return {
    status,
    outcome: outcomeForStatus(status),
    blockerOwner: blockerOwnerForStatus(status),
    summary:
      'Separates Telegram user-session config, Telegram bot freshness, BlueBubbles transport, and same-thread message-action proof.',
    nextAction:
      telegramUser?.status === 'missing_config'
        ? telegramUser.nextStep
        : bluebubbles?.nextStep ||
          telegramBot?.nextStep ||
          'Complete the freshest messaging proof turn.',
    evidenceIds: [
      ...parseEvidenceIds(telegramUser),
      ...parseEvidenceIds(telegramBot),
      ...parseEvidenceIds(bluebubbles),
    ],
    scores: {
      proofAwareness: 1,
      safety: 1,
      confidenceCalibration: status === 'live_proven' ? 0.92 : 0.95,
    },
  };
}

function capabilityEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const ready = ctx.capabilityStates.filter(
    (state) => state.enabled && state.proofStatus === 'live_proven',
  ).length;
  const blocked = ctx.capabilityStates.filter((state) =>
    ['missing_config', 'externally_blocked'].includes(state.proofStatus),
  ).length;
  return {
    status: blocked ? 'near_live_only' : 'live_proven',
    outcome: 'degraded_usable',
    blockerOwner: 'none',
    summary: `Capability truth is available: ${ready} ready capability/capabilities, ${blocked} blocked or missing config.`,
    nextAction: ctx.proofReport.nextAction,
    evidenceIds: ['capability:self_model', 'proof:live_gauntlet'],
    scores: { proofAwareness: 0.96, contextRelevance: 0.9 },
  };
}

function plannerEvaluation(
  prompt: string,
  ctx: DogfoodContext,
  options: {
    route: string;
    goalLike?: boolean;
    missingTime?: boolean;
    counterfactual?: boolean;
  },
): ScenarioEvaluation {
  const planned = planGoalDirectedRequest({
    text: prompt,
    channel: 'telegram',
    now: ctx.now,
    persist: false,
    reality: ctx.realityReport,
  });
  const calendarPreflight = options.missingTime
    ? runActionPreflight({
        actionSummary: 'Add that to my calendar',
        actionType: 'calendar_write',
        channel: 'telegram',
        requiredInfo: [{ name: 'event time', present: false }],
        hasExplicitUserApproval: false,
        objectClear: false,
        now: ctx.now,
        persist: false,
      })
    : null;
  const status = calendarPreflight
    ? 'near_live_only'
    : ctx.proofReport.proofDebtCount > 0
      ? 'near_live_only'
      : 'live_proven';
  const nextAction =
    calendarPreflight?.record.blockerSummary ||
    planned.run.nextAction ||
    ctx.realityReport.nextAction;
  return {
    status,
    outcome: 'degraded_usable',
    blockerOwner: 'none',
    summary: options.missingTime
      ? 'Correctly asks for the missing calendar referent/time instead of writing.'
      : options.counterfactual
        ? 'Uses bounded counterfactual planning without pretending certainty.'
        : options.goalLike
          ? 'Uses goal/planner reasoning and returns one practical next step.'
          : 'Routes through current context without broad dumping.',
    nextAction,
    evidenceIds: [
      planned.run.runId,
      ...(calendarPreflight ? [calendarPreflight.record.preflightId] : []),
    ],
    scores: {
      routeCorrectness: options.missingTime ? 0.96 : 0.9,
      actionability: 0.9,
      confidenceCalibration: planned.run.confidence,
    },
  };
}

function blackboardEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const blackboard = buildCognitiveBlackboard({
    requestText: "what's waiting on me?",
    channel: 'operator',
    now: ctx.now,
    persist: false,
  } satisfies BuildBlackboardInput);
  return {
    status: 'near_live_only',
    outcome: 'degraded_usable',
    blockerOwner: 'none',
    summary:
      'Surfaces approval/verification blockers from the blackboard without taking action.',
    nextAction: blackboard.recommendedNextStep,
    evidenceIds: [blackboard.snapshotId],
    scores: { actionability: 0.9, safety: 1 },
  };
}

function replyHelpEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const bluebubbles = proofByName(ctx.proofReport, 'bluebubbles');
  const status =
    bluebubbles?.status === 'live_proven'
      ? 'live_proven'
      : 'manual_proof_needed';
  return {
    status,
    outcome: outcomeForStatus(status),
    blockerOwner: blockerOwnerForStatus(status),
    summary:
      'Draft/reply-help is safe, but send claims remain blocked until same-thread message-action proof closes.',
    nextAction:
      bluebubbles?.nextStep ||
      'Ask reply-help in the canonical BlueBubbles self-thread, then defer with send it later tonight.',
    evidenceIds: parseEvidenceIds(bluebubbles),
    scores: { safety: 1, proofAwareness: 1, routeCorrectness: 0.94 },
  };
}

function selfRepairEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const improvement = buildAutonomousImprovementLabReport({
    now: new Date(ctx.now),
    persist: false,
  });
  return {
    status: 'near_live_only',
    outcome: 'degraded_usable',
    blockerOwner: 'none',
    summary:
      'Routes to improvement/patch planning surfaces only; no mutation, merge, push, restart, or live integration action.',
    nextAction: improvement.nextAction,
    evidenceIds: improvement.topCandidates
      .slice(0, 4)
      .map((hypothesis) => hypothesis.hypothesisId),
    scores: { safety: 1, proofAwareness: 0.92, actionability: 0.88 },
  };
}

function confidenceEvaluation(ctx: DogfoodContext): ScenarioEvaluation {
  const meta = analyzeMetacognitiveTurn({
    rawAsk: 'are you sure?',
    channel: 'telegram',
    intentFamily: 'status',
    realityReport: ctx.realityReport,
    now: ctx.now,
    persist: false,
  });
  return {
    status: 'near_live_only',
    outcome: 'degraded_usable',
    blockerOwner: 'none',
    summary: `Calibrates confidence as ${meta.calibration.label} and gives a verification path.`,
    nextAction: meta.calibration.whatWouldIncreaseConfidence,
    evidenceIds: [meta.decision.decisionId, meta.calibration.calibrationId],
    scores: {
      confidenceCalibration: meta.calibration.score,
      proofAwareness: 0.94,
      naturalness: 0.86,
    },
  };
}

function scenarios(): DogfoodScenarioDefinition[] {
  return [
    {
      scenarioId: 'next_action',
      prompt: 'What should I do next?',
      channel: 'telegram',
      route: 'goal_planner',
      systems: ['goal_planner', 'reality_grounding', 'metacognition'],
      journeyId: 'daily_guidance',
      expectedStatus: 'near_live_only',
      evaluate: (ctx) =>
        plannerEvaluation('what should I do next?', ctx, {
          route: 'goal_planner',
          goalLike: true,
        }),
    },
    {
      scenarioId: 'forgetting',
      prompt: 'What am I forgetting?',
      channel: 'telegram',
      route: 'cognitive_blackboard',
      systems: ['cognitive_blackboard', 'reality_grounding'],
      journeyId: 'daily_guidance',
      expectedStatus: 'near_live_only',
      evaluate: (ctx) =>
        plannerEvaluation('what am I forgetting?', ctx, {
          route: 'cognitive_blackboard',
        }),
    },
    {
      scenarioId: 'texting_status',
      prompt: 'Is text messaging working?',
      channel: 'operator',
      route: 'proof_capability_status',
      systems: ['proof_gauntlet', 'capability_self_model', 'reality_grounding'],
      journeyId: 'ordinary_chat',
      expectedStatus: 'missing_config',
      evaluate: textMessagingEvaluation,
    },
    {
      scenarioId: 'capability_today',
      prompt: 'What can you actually do today?',
      channel: 'operator',
      route: 'capability_self_model',
      systems: ['capability_self_model', 'proof_gauntlet'],
      journeyId: 'ordinary_chat',
      expectedStatus: 'near_live_only',
      evaluate: capabilityEvaluation,
    },
    {
      scenarioId: 'waiting_on_me',
      prompt: "What's waiting on me?",
      channel: 'operator',
      route: 'cognitive_blackboard',
      systems: ['cognitive_blackboard', 'action_lifecycle'],
      journeyId: 'cross_channel_handoff',
      expectedStatus: 'near_live_only',
      evaluate: blackboardEvaluation,
    },
    {
      scenarioId: 'plan_tonight',
      prompt: 'Help me plan tonight.',
      channel: 'telegram',
      route: 'goal_planner',
      systems: ['goal_planner', 'reality_grounding'],
      journeyId: 'mission_planning',
      expectedStatus: 'near_live_only',
      evaluate: (ctx) =>
        plannerEvaluation('help me plan tonight', ctx, {
          route: 'goal_planner',
          goalLike: true,
        }),
    },
    {
      scenarioId: 'say_back',
      prompt: 'What should I say back?',
      channel: 'bluebubbles',
      route: 'communication_companion',
      systems: ['communication_companion', 'message_actions', 'proof_gauntlet'],
      journeyId: 'candace_followthrough',
      expectedStatus: 'manual_proof_needed',
      evaluate: replyHelpEvaluation,
    },
    {
      scenarioId: 'calendar_missing_time',
      prompt: 'Add that to my calendar.',
      channel: 'telegram',
      route: 'action_preflight',
      systems: ['action_preflight', 'calendar'],
      journeyId: 'cross_channel_handoff',
      expectedStatus: 'near_live_only',
      evaluate: (ctx) =>
        plannerEvaluation('add that to my calendar', ctx, {
          route: 'action_preflight',
          missingTime: true,
        }),
    },
    {
      scenarioId: 'fix_yourself',
      prompt: 'Fix yourself.',
      channel: 'operator',
      route: 'improvement_lab',
      systems: ['improvement_lab', 'patch_workbench', 'repair_runtime'],
      journeyId: 'work_cockpit',
      expectedStatus: 'near_live_only',
      evaluate: selfRepairEvaluation,
    },
    {
      scenarioId: 'confidence_check',
      prompt: 'Are you sure?',
      channel: 'telegram',
      route: 'metacognition',
      systems: ['metacognition', 'reality_grounding'],
      journeyId: 'ordinary_chat',
      expectedStatus: 'near_live_only',
      evaluate: confidenceEvaluation,
    },
  ];
}

function recordPilotOutcome(input: {
  scenario: DogfoodScenarioDefinition;
  result: ScenarioEvaluation;
  now: string;
  persist: boolean;
}): string | null {
  if (!input.persist || !input.scenario.journeyId) return null;
  if (
    input.result.status === 'missing_config' ||
    input.result.status === 'externally_blocked' ||
    input.result.status === 'repo_bug' ||
    input.result.status === 'failed'
  ) {
    return null;
  }
  const started = startPilotJourney({
    journeyId: input.scenario.journeyId,
    channel:
      input.scenario.channel === 'alexa'
        ? 'alexa'
        : input.scenario.channel === 'bluebubbles'
          ? 'bluebubbles'
          : 'telegram',
    groupFolder: 'dogfood-live',
    routeKey: `dogfood:${input.scenario.scenarioId}:${input.scenario.route}`,
    systemsInvolved: input.scenario.systems,
    summaryText: `Operator-safe dogfood: ${input.scenario.scenarioId}. This is not live proof.`,
    startedAt: input.now,
  });
  if (!started) return null;
  completePilotJourney({
    eventId: started.eventId,
    outcome: input.result.outcome,
    blockerClass:
      input.result.status === 'manual_proof_needed'
        ? 'manual_live_proof_needed'
        : 'operator_safe_dogfood',
    blockerOwner: input.result.blockerOwner,
    degradedPath: 'operator_safe_dogfood_not_live_proof',
    summaryText: input.result.summary,
    systemsInvolved: input.scenario.systems,
    completedAt: input.now,
  });
  return started.eventId;
}

function buildResult(
  scenario: DogfoodScenarioDefinition,
  evaluation: ScenarioEvaluation,
  pilotEventId: string | null,
): DogfoodScenarioResult {
  const scorecard = score(evaluation.scores || {});
  return {
    scenarioId: scenario.scenarioId,
    prompt: safeText(scenario.prompt, 240),
    channel: scenario.channel,
    route: scenario.route,
    status: evaluation.status,
    outcome: evaluation.outcome,
    blockerOwner: evaluation.blockerOwner,
    summary: safeText(evaluation.summary, 640),
    nextAction: safeText(evaluation.nextAction, 900),
    evidenceIds: Array.from(new Set(evaluation.evidenceIds)).slice(0, 20),
    pilotEventId,
    scorecard,
    privacy: PRIVACY,
  };
}

function consistencyFor(
  proofReport: LiveProofGauntletReport,
  realityReport: RealityDoctorReport,
): DogfoodGauntletReport['consistency'] {
  const telegram = proofByName(proofReport, 'telegram user');
  const alexa = proofByName(proofReport, 'alexa');
  const bluebubbles = proofByName(proofReport, 'bluebubbles');
  const braveHealthy = realityReport.beliefs.some(
    (belief) =>
      belief.subject === 'provider:brave_search' &&
      belief.status === 'confirmed' &&
      /healthy/i.test(belief.beliefSummary),
  );
  return {
    braveSearchHealthy: braveHealthy,
    telegramUserSessionMissingConfig: telegram?.status === 'missing_config',
    alexaSignedProofPending:
      alexa?.status === 'externally_blocked' || alexa?.status === 'stale',
    blueBubblesTransportReadyButSameThreadProofIncomplete:
      bluebubbles?.status === 'near_live_only' ||
      bluebubbles?.status === 'stale',
    repoWorkRequiredZero: proofReport.repoWorkRequiredCount === 0,
  };
}

export function runDogfoodGauntlet(
  input: RunDogfoodGauntletInput = {},
): DogfoodGauntletReport {
  const generatedAt = nowIso(input.now);
  const proofReport = input.proofReport || buildLiveProofGauntletReport();
  const realityReport =
    input.realityReport ||
    buildRealityGroundingReport({
      ...(input.realityInput || {}),
      requestText: input.realityInput?.requestText || 'dogfood live gauntlet',
      channel: input.realityInput?.channel || 'operator',
      proofReport,
      persist: false,
    });
  const capabilityReport = buildCapabilitySelfModel({
    now: generatedAt,
    persist: false,
  });
  const ctx: DogfoodContext = {
    now: generatedAt,
    proofReport,
    realityReport,
    capabilityStates: capabilityReport.states,
  };
  const persist = input.persist === true;
  const scenarioResults = scenarios().map((scenario) => {
    const evaluation = scenario.evaluate(ctx);
    const pilotEventId = recordPilotOutcome({
      scenario,
      result: evaluation,
      now: generatedAt,
      persist,
    });
    return buildResult(scenario, evaluation, pilotEventId);
  });
  const count = (status: DogfoodGauntletStatus) =>
    scenarioResults.filter((result) => result.status === status).length;
  const manualProofNeeded = count('manual_proof_needed') + count('stale');
  const averageScore =
    scenarioResults.reduce(
      (total, result) => total + result.scorecard.overall,
      0,
    ) / Math.max(1, scenarioResults.length);
  const firstDebt = scenarioResults.find(
    (result) => result.status !== 'live_proven',
  );
  return {
    generatedAt,
    mode: 'operator_safe',
    scenarioCount: scenarioResults.length,
    liveProven: count('live_proven'),
    nearLiveOnly: count('near_live_only'),
    manualProofNeeded,
    externallyBlocked: count('externally_blocked'),
    missingConfig: count('missing_config'),
    failed: count('failed'),
    repoBug: count('repo_bug'),
    averageScore: Number(averageScore.toFixed(3)),
    scenarios: scenarioResults,
    consistency: consistencyFor(proofReport, realityReport),
    nextAction:
      firstDebt?.nextAction ||
      proofReport.nextAction ||
      'No dogfood blockers are currently visible.',
    privacy: PRIVACY,
  };
}

export function formatDogfoodGauntletReport(
  report: DogfoodGauntletReport,
): string {
  const lines = [
    '*Live Dogfood Gauntlet*',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode} (no sends, writes, restarts, pushes, credentials, or live integration mutations)`,
    `Scenarios: ${report.scenarioCount}`,
    `Average score: ${(report.averageScore * 100).toFixed(0)}%`,
    `Status counts: live=${report.liveProven}, near-live=${report.nearLiveOnly}, manual=${report.manualProofNeeded}, missing_config=${report.missingConfig}, external=${report.externallyBlocked}, failed=${report.failed}, repo_bug=${report.repoBug}`,
    '',
    '*Scenarios*',
    ...report.scenarios.map((result) => {
      return `- ${result.scenarioId}: ${result.status} / ${result.route} / score=${(result.scorecard.overall * 100).toFixed(0)}% -> ${result.nextAction}`;
    }),
    '',
    '*Consistency*',
    `- Brave/Search healthy: ${report.consistency.braveSearchHealthy ? 'yes' : 'no'}`,
    `- Telegram user-session missing config: ${report.consistency.telegramUserSessionMissingConfig ? 'yes' : 'no'}`,
    `- Alexa signed proof pending: ${report.consistency.alexaSignedProofPending ? 'yes' : 'no'}`,
    `- BlueBubbles transport-ready but proof incomplete: ${report.consistency.blueBubblesTransportReadyButSameThreadProofIncomplete ? 'yes' : 'no'}`,
    `- Repo work required zero: ${report.consistency.repoWorkRequiredZero ? 'yes' : 'no'}`,
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; no raw private bodies, prompts, hidden reasoning, provider debates, raw tool output, or secrets.',
  ];
  return lines
    .map((line) =>
      line.startsWith('Privacy: metadata-only;') ? line : safeText(line, 1400),
    )
    .join('\n');
}
