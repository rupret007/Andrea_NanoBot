import {
  listCausalBeliefs,
  listCounterfactualActionOptions,
  listCounterfactualComparisons,
  listGoalMilestones,
  listGoalPlannerRuns,
  listGoalPlanSteps,
  listHierarchicalGoals,
  listProactiveOpportunities,
  upsertCausalBelief,
  upsertCounterfactualActionOption,
  upsertCounterfactualComparison,
  upsertGoalMilestone,
  upsertGoalPlannerRun,
  upsertGoalPlanStep,
  upsertHierarchicalGoal,
  updateHierarchicalGoalStatus,
} from './db.js';
import { buildAutonomousImprovementLabReport } from './autonomous-improvement-lab.js';
import { buildLiveProofGauntletReport } from './live-proof-gauntlet.js';
import { buildPatchWorkbenchReport } from './patch-workbench.js';
import {
  applyProactiveOpportunityControl,
  buildProactiveOpportunityReport,
  formatProactiveOpportunityReport,
} from './proactive-opportunities.js';
import { buildRealityGroundingReport } from './reality-grounding.js';
import { buildToolReliabilityDoctorReport } from './tool-reliability.js';
import type {
  CausalBelief,
  CognitiveExecutiveChannel,
  CounterfactualActionOption,
  CounterfactualComparison,
  GoalMilestone,
  GoalPlannerDoctorReport,
  GoalPlannerRun,
  GoalPlanStep,
  HierarchicalGoal,
  ProactiveOpportunity,
  RealityDoctorReport,
} from './types.js';

type PlannerChannel = CognitiveExecutiveChannel | 'operator' | 'internal';

interface PlanInput {
  text: string;
  channel?: PlannerChannel;
  groupFolder?: string | null;
  now?: Date | string;
  persist?: boolean;
  reality?: RealityDoctorReport;
}

export interface GoalDirectedPlanResult {
  run: GoalPlannerRun;
  goal?: HierarchicalGoal | null;
  milestones: GoalMilestone[];
  steps: GoalPlanStep[];
  comparison?: CounterfactualComparison | null;
  options: CounterfactualActionOption[];
  opportunity?: ProactiveOpportunity | null;
  reality: RealityDoctorReport;
  response: string;
}

const PRIVACY = {
  metadataOnly: true as const,
  rawPromptsStored: false as const,
  rawPrivateBodiesStored: false as const,
  hiddenReasoningStored: false as const,
  secretsRedacted: true as const,
  contentPolicy:
    'metadata-only summaries; no raw private bodies, prompts, hidden reasoning, provider debates, raw tool output, or secrets',
  approvalPolicy:
    'goals and opportunities propose or stage actions; existing approval gates execute or block side effects',
};

function nowIso(input?: Date | string): string {
  if (!input) return new Date().toISOString();
  return input instanceof Date ? input.toISOString() : input;
}

function jsonIds(ids: Array<string | null | undefined>): string {
  return JSON.stringify(
    Array.from(new Set(ids.filter((id): id is string => Boolean(id)))).slice(
      0,
      48,
    ),
  );
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function stripAssistantInvocation(text: string): string {
  return text
    .replace(/^@andrea[:,]?\s*/i, '')
    .replace(/^andrea[:,]?\s*/i, '')
    .trim();
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function id(prefix: string, ...parts: string[]): string {
  return `${prefix}_${stableHash(parts.join('|'))}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function redactText(text: string, max = 900): string {
  return normalize(text)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]')
    .replace(/GOCSPX-[0-9A-Za-z_-]+/g, '[REDACTED_SECRET]')
    .slice(0, max);
}

function classifyIntent(text: string): GoalPlannerRun['intent'] {
  const lower = text.toLowerCase();
  if (/\bwhat if\b|\bdo nothing\b|\bcounterfactual\b/.test(lower)) {
    return 'counterfactual';
  }
  if (
    /\b(make this a goal|turn this into a goal|active goals|what goals|pause that goal|mark that done|show me the plan|simplify the plan)\b/.test(
      lower,
    )
  ) {
    return 'goal_update';
  }
  if (/\bblocking|blocked|safest next step|verify next\b/.test(lower)) {
    return 'proof_task';
  }
  if (
    /\b(add|put|schedule).*\bcalendar\b|\bcalendar\b.*\b(write|add|schedule)\b/.test(
      lower,
    )
  ) {
    return 'clarify';
  }
  if (/\bwhat should i say back|reply|draft|send|text|message\b/.test(lower)) {
    return 'communication_draft';
  }
  if (
    /\b(help me|plan|prepare|stay on top|follow through|get .* done|what should i do next|work on|trying to accomplish)\b/.test(
      lower,
    )
  ) {
    return /\bwhat should i do next|what should i work on|safest next step\b/.test(
      lower,
    )
      ? 'plan'
      : 'goal_proposal';
  }
  return 'direct';
}

function scopeFor(text: string): HierarchicalGoal['scope'] {
  const lower = text.toLowerCase();
  if (/\bhouse|home|grocer|errand|bill|meal|dinner|weekend\b/.test(lower)) {
    return 'household';
  }
  if (/\bcandace|reply|message|text|say back|relationship\b/.test(lower)) {
    return 'relationship';
  }
  if (/\bandrea|proof|repo|code|work cockpit|patch|build\b/.test(lower)) {
    return 'andrea_project';
  }
  if (/\bwork|cursor|runtime|project\b/.test(lower)) return 'work';
  return 'general';
}

function titleFor(text: string): string {
  const lower = text.toLowerCase();
  if (/\bandrea\b/.test(lower)) return 'Move Andrea closer to done';
  if (/\bweekend\b/.test(lower)) return 'Prepare for the weekend';
  if (/\btomorrow\b/.test(lower)) return 'Prepare for tomorrow';
  if (/\bhouse|home\b/.test(lower)) return 'Stay on top of the house';
  if (/\bcandace\b/.test(lower)) return 'Follow through with Candace';
  if (/\btonight\b/.test(lower)) return 'Plan tonight';
  if (/\bwhat should i do next|what should i work on\b/.test(lower)) {
    return 'Choose the next useful move';
  }
  return redactText(text, 80) || 'Goal-directed request';
}

function priorityFor(
  text: string,
  reality: RealityDoctorReport,
): HierarchicalGoal['priority'] {
  const lower = text.toLowerCase();
  if (/\burgent|today|tonight|blocking|broken\b/.test(lower)) return 'high';
  if (reality.proofDebt.repoWorkRequired > 0) return 'high';
  return 'normal';
}

function defaultCausalBeliefs(now: string): CausalBelief[] {
  return [
    {
      beliefId: 'causal_bluebubbles_stale_proof_blocks_send_claims',
      createdAt: now,
      updatedAt: now,
      causeAction: 'Treat stale BlueBubbles proof as fully working messaging.',
      expectedEffect:
        'Andrea may overclaim send readiness; safer route is draft, save, remind, or ask for same-thread proof.',
      contextWhereLikelyTrue:
        'BlueBubbles transport is reachable but same-thread message-action proof is stale or incomplete.',
      confidence: 0.92,
      evidenceRefsJson: jsonIds(['proof:bluebubbles']),
      contradictingEvidenceRefsJson: jsonIds([]),
      lastTestedAt: null,
      sensitivity: 'low',
      status: 'likely',
      nextAction:
        'Before send-related claims, check proof freshness and stage drafts/approvals when proof is stale.',
      privacyJson: jsonValue(PRIVACY),
    },
    {
      beliefId: 'causal_calendar_missing_time_asks_before_write',
      createdAt: now,
      updatedAt: now,
      causeAction: 'Write a calendar event without a specific time.',
      expectedEffect:
        'Calendar state becomes ambiguous; safer route is ask for the missing time before writing.',
      contextWhereLikelyTrue:
        'Calendar write intent is present but time/date is incomplete.',
      confidence: 0.95,
      evidenceRefsJson: jsonIds(['policy:calendar_write']),
      contradictingEvidenceRefsJson: jsonIds([]),
      lastTestedAt: null,
      sensitivity: 'low',
      status: 'likely',
      nextAction: 'Ask one concise time/date question before calendar writes.',
      privacyJson: jsonValue(PRIVACY),
    },
    {
      beliefId: 'causal_provider_quota_routes_to_fallback',
      createdAt: now,
      updatedAt: now,
      causeAction: 'Keep calling a provider that is quota or auth blocked.',
      expectedEffect:
        'The user waits longer and confidence is overstated; safer route is local knowledge or a healthy provider.',
      contextWhereLikelyTrue:
        'Provider health or tool reliability reports quota/auth/transport block.',
      confidence: 0.9,
      evidenceRefsJson: jsonIds(['tool_reliability:providers']),
      contradictingEvidenceRefsJson: jsonIds([]),
      lastTestedAt: null,
      sensitivity: 'low',
      status: 'likely',
      nextAction:
        'Skip known-blocked optional providers and say confidence is reduced.',
      privacyJson: jsonValue(PRIVACY),
    },
    {
      beliefId: 'causal_rejected_default_lowers_confidence',
      createdAt: now,
      updatedAt: now,
      causeAction: 'Continue using a default the user rejected.',
      expectedEffect:
        'Suggestions feel tone-deaf; safer route is lower confidence and ask before reusing the pattern.',
      contextWhereLikelyTrue:
        'Learning controls or skill status mark a default rejected/paused.',
      confidence: 0.88,
      evidenceRefsJson: jsonIds(['learning:rejections']),
      contradictingEvidenceRefsJson: jsonIds([]),
      lastTestedAt: null,
      sensitivity: 'personal',
      status: 'likely',
      nextAction: 'Respect paused/dismissed skills and learned defaults.',
      privacyJson: jsonValue(PRIVACY),
    },
    {
      beliefId: 'causal_evening_next_action_prefers_one_move',
      createdAt: now,
      updatedAt: now,
      causeAction: 'Answer evening next-action asks with a broad status dump.',
      expectedEffect:
        'The user gets more cognitive load; safer route is one practical near-term move with a short reason.',
      contextWhereLikelyTrue:
        'The user asks what to do next, what to work on, or how to plan tonight.',
      confidence: 0.86,
      evidenceRefsJson: jsonIds(['executive:next_action']),
      contradictingEvidenceRefsJson: jsonIds([]),
      lastTestedAt: null,
      sensitivity: 'low',
      status: 'likely',
      nextAction: 'Choose one primary next move, then offer one action.',
      privacyJson: jsonValue(PRIVACY),
    },
  ];
}

function seedCausalBeliefs(now: string, persist: boolean): CausalBelief[] {
  const existing = listCausalBeliefs({ limit: 20 });
  const byId = new Map(existing.map((belief) => [belief.beliefId, belief]));
  const seeded = defaultCausalBeliefs(now).map((belief) => {
    const current = byId.get(belief.beliefId);
    return current ? { ...belief, createdAt: current.createdAt } : belief;
  });
  if (persist) {
    for (const belief of seeded) upsertCausalBelief(belief);
  }
  return seeded;
}

function evidenceFromReality(reality: RealityDoctorReport): string[] {
  return [
    reality.snapshot.snapshotId,
    ...reality.verificationNeeds.slice(0, 8).map((need) => need.needId),
    ...reality.contradictions.slice(0, 8).map((item) => item.contradictionId),
  ];
}

function createGoal(input: {
  text: string;
  now: string;
  groupFolder?: string | null;
  status: HierarchicalGoal['status'];
  reality: RealityDoctorReport;
}): HierarchicalGoal {
  const title = titleFor(input.text);
  const scope = scopeFor(input.text);
  return {
    goalId: id('goal', input.groupFolder || 'global', title, input.text),
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    title,
    objective:
      input.status === 'active'
        ? `Actively coordinate existing Andrea systems for: ${title}.`
        : `Proposed goal for: ${redactText(input.text, 220)}.`,
    scope,
    owner: scope === 'andrea_project' ? 'andrea' : 'shared',
    status: input.status,
    priority: priorityFor(input.text, input.reality),
    confidence: input.status === 'active' ? 0.82 : 0.72,
    evidenceRefsJson: jsonIds(evidenceFromReality(input.reality)),
    relatedWorldFactIdsJson: jsonIds([]),
    relatedSkillIdsJson: jsonIds([]),
    relatedMissionIdsJson: jsonIds([]),
    relatedReminderIdsJson: jsonIds([]),
    relatedActionBundleIdsJson: jsonIds([]),
    reviewCadence:
      scope === 'household' || scope === 'andrea_project'
        ? 'weekly'
        : 'on_demand',
    approvalBoundary:
      scope === 'andrea_project' ? 'operator_only' : 'approval_required',
    allowedActionsJson: jsonValue([
      'plan',
      'draft',
      'read_status',
      'suggest_next_step',
      'stage_approval',
    ]),
    disallowedActionsJson: jsonValue([
      'send_without_approval',
      'write_calendar_without_details',
      'restart_or_push_without_approval',
      'treat_manual_proof_debt_as_repo_bug',
    ]),
    nextAction: nextActionFor(input.text, input.reality),
    privacyJson: jsonValue(PRIVACY),
  };
}

function nextActionFor(text: string, reality: RealityDoctorReport): string {
  const lower = text.toLowerCase();
  if (/\bandrea\b/.test(lower)) {
    return reality.proofDebt.total
      ? 'Close the highest-value proof debt first, then use the improvement lab for repo-side candidates.'
      : 'Run the improvement lab and choose one low-risk validated candidate.';
  }
  if (/\bcandace|say back|reply|message|text\b/.test(lower)) {
    return 'Draft a short reply first; send only after same-thread approval and proof confidence are fresh.';
  }
  if (/\bcalendar|add .*calendar|schedule\b/.test(lower)) {
    return 'Confirm the missing time/date before staging any calendar write.';
  }
  if (/\bweekend|house|home|tonight|tomorrow\b/.test(lower)) {
    return 'Pick one concrete household or schedule move, then stage any reminders or calendar changes for approval.';
  }
  return 'Choose one reversible next step and keep side effects staged for approval.';
}

function buildMilestones(
  goal: HierarchicalGoal,
  text: string,
  now: string,
): GoalMilestone[] {
  const lower = text.toLowerCase();
  const titles = /\bandrea\b/.test(lower)
    ? [
        [
          'Ground current proof debt',
          'Know which blockers are proof/manual vs repo-side.',
        ],
        [
          'Choose one low-risk improvement',
          'Use improvement lab evidence instead of guesswork.',
        ],
        [
          'Validate before landing',
          'Run focused tests before any commit or push.',
        ],
      ]
    : /\bweekend|house|home\b/.test(lower)
      ? [
          [
            'Check the real constraints',
            'Use calendar/list/open-loop context before planning.',
          ],
          [
            'Pick the first practical move',
            'Choose one household or schedule item with high payoff.',
          ],
          [
            'Stage follow-through',
            'Prepare reminders/drafts only where approval allows.',
          ],
        ]
      : /\bcandace|reply|say back|message\b/.test(lower)
        ? [
            [
              'Understand the thread state',
              'Use communication context without exposing raw private bodies.',
            ],
            [
              'Draft one warm response',
              'Create a reply candidate before any send.',
            ],
            [
              'Confirm the action boundary',
              'Send only through same-thread approval.',
            ],
          ]
        : [
            [
              'Clarify the target outcome',
              'Define what done means for this request.',
            ],
            [
              'Choose the safest next action',
              'Prefer reversible work and proof-guided checks.',
            ],
            ['Record outcome', 'Capture what worked or stayed blocked.'],
          ];
  return titles.map(([title, outcome], index) => ({
    milestoneId: id('milestone', goal.goalId, String(index), title),
    goalId: goal.goalId,
    createdAt: now,
    updatedAt: now,
    title,
    desiredOutcome: outcome,
    dueOrReviewWindow: index === 0 ? 'now' : 'next review',
    status: index === 0 ? 'active' : 'proposed',
    blockerIdsJson: jsonIds([]),
    dependenciesJson: jsonValue(index === 0 ? [] : [titles[index - 1][0]]),
    evidenceRefsJson: goal.evidenceRefsJson,
    privacyJson: jsonValue(PRIVACY),
  }));
}

function buildPlanSteps(input: {
  goal: HierarchicalGoal;
  milestones: GoalMilestone[];
  text: string;
  now: string;
  reality: RealityDoctorReport;
}): GoalPlanStep[] {
  const lower = input.text.toLowerCase();
  const proofNeeded = input.reality.verificationNeeds[0];
  const rows: Array<{
    action: string;
    tool: string;
    approval: GoalPlanStep['approvalRequirement'];
    status: GoalPlanStep['status'];
    risk: GoalPlanStep['riskLevel'];
    fallback: string;
    next: string;
  }> = [];

  if (/\bandrea\b/.test(lower)) {
    rows.push(
      {
        action:
          'Review reality/proof debt and separate manual proof from repo work.',
        tool: 'reality_grounding',
        approval: 'read_only',
        status: 'ready',
        risk: 'low',
        fallback: 'Use proof gauntlet report if reality report is stale.',
        next: proofNeeded?.nextAction || 'Run debug:reality and proof:guided.',
      },
      {
        action: 'Inspect improvement lab and patch workbench candidates.',
        tool: 'improvement_lab',
        approval: 'read_only',
        status: 'ready',
        risk: 'low',
        fallback: 'Keep manual proof tasks out of repo-patch candidates.',
        next: 'Run debug:improvement and select only low-risk repo-side candidates.',
      },
      {
        action: 'Validate focused tests before any repo landing.',
        tool: 'test_runner',
        approval: 'operator_only',
        status: 'approval_required',
        risk: 'medium',
        fallback: 'Report the exact failing suite and next repair step.',
        next: 'Ask for operator approval before commit/push/restart.',
      },
    );
  } else if (/\bcalendar|add .*calendar|schedule\b/.test(lower)) {
    rows.push({
      action:
        'Ask for the missing event time/date before staging the calendar write.',
      tool: 'calendar',
      approval: 'approval_required',
      status: 'blocked',
      risk: 'medium',
      fallback: 'Save as a reminder/draft until timing is known.',
      next: 'Ask one clarifying question for the event time.',
    });
  } else if (/\bsend|text|message|say back|reply|bluebubbles\b/.test(lower)) {
    rows.push(
      {
        action: 'Draft the response using communication companion context.',
        tool: 'communication_companion',
        approval: 'read_only',
        status: 'ready',
        risk: 'low',
        fallback: 'Ask for the thread/person if ambiguous.',
        next: 'Create a draft, not a send.',
      },
      {
        action: 'Check same-thread proof before any send claim.',
        tool: 'bluebubbles_proof',
        approval: 'manual_external',
        status: 'approval_required',
        risk: 'high',
        fallback: 'Save or remind instead of sending.',
        next:
          proofNeeded?.nextAction ||
          'Complete same-thread proof before sending.',
      },
    );
  } else {
    rows.push(
      {
        action:
          'Use the compact world/reality snapshot to choose one practical move.',
        tool: 'cognitive_executive',
        approval: 'read_only',
        status: 'ready',
        risk: 'low',
        fallback: 'Ask one clarifying question if confidence stays low.',
        next: 'Choose the highest-confidence reversible next move.',
      },
      {
        action:
          'Stage any reminder, calendar, message, or operator side effect for approval.',
        tool: 'approval_gate',
        approval: 'approval_required',
        status: 'proposed',
        risk: 'medium',
        fallback: 'Offer a draft/checklist instead.',
        next: 'Keep side effects staged until approved.',
      },
    );
  }

  return rows.slice(0, 5).map((row, index) => ({
    stepId: id('goal_step', input.goal.goalId, String(index), row.action),
    goalId: input.goal.goalId,
    milestoneId:
      input.milestones[index % input.milestones.length]?.milestoneId || null,
    createdAt: input.now,
    updatedAt: input.now,
    position: index + 1,
    actionSummary: row.action,
    requiredContextJson: jsonValue({
      realitySnapshot: input.reality.snapshot.snapshotId,
      verificationNeeds: input.reality.verificationNeeds
        .slice(0, 4)
        .map((need) => need.needId),
    }),
    requiredTool: row.tool,
    approvalRequirement: row.approval,
    estimatedEffort: row.tool === 'test_runner' ? 'medium' : 'small',
    riskLevel: row.risk,
    fallback: row.fallback,
    status: row.status,
    evidenceRefsJson: jsonIds(evidenceFromReality(input.reality)),
    nextAction: row.next,
    privacyJson: jsonValue(PRIVACY),
  }));
}

function optionScore(option: {
  expectedBenefit: number;
  effort: number;
  risk: number;
  toolReliability: number;
  approvalPenalty: number;
}): number {
  return clamp01(
    option.expectedBenefit * 0.35 +
      option.toolReliability * 0.25 +
      (1 - option.effort) * 0.16 +
      (1 - option.risk) * 0.16 -
      option.approvalPenalty * 0.08,
  );
}

function buildCounterfactual(input: {
  text: string;
  now: string;
  reality: RealityDoctorReport;
  persist: boolean;
}): {
  comparison: CounterfactualComparison;
  options: CounterfactualActionOption[];
} {
  const comparisonId = id('counterfactual', input.text, input.now.slice(0, 10));
  const evidence = jsonIds(evidenceFromReality(input.reality));
  const reliability = buildToolReliabilityDoctorReport();
  const degraded = reliability.topDegraded.length;
  const raw = [
    {
      suffix: 'do_nothing',
      actionSummary: 'Do nothing right now.',
      expectedBenefit: 0.18,
      effort: 0.02,
      risk: input.reality.proofDebt.total ? 0.62 : 0.42,
      requiredProof:
        'No new proof required, but stale proof debt remains open.',
      toolReliability: 0.75,
      approvalRequirement: 'read_only' as const,
      possibleFailure: 'Open loops and proof debt remain unresolved.',
      fallbackPlan: 'Set a review checkpoint instead of acting.',
      approvalPenalty: 0,
    },
    {
      suffix: 'safe_next_step',
      actionSummary:
        'Take one reversible next step from the highest-confidence plan.',
      expectedBenefit: 0.76,
      effort: 0.35,
      risk: 0.24,
      requiredProof: 'Use current reality snapshot and avoid side effects.',
      toolReliability: degraded ? 0.68 : 0.84,
      approvalRequirement: 'read_only' as const,
      possibleFailure:
        'The selected step may still be low impact if context is stale.',
      fallbackPlan: 'Ask one clarifying question.',
      approvalPenalty: 0,
    },
    {
      suffix: 'verify_first',
      actionSummary:
        'Run or request the safest verification step before acting.',
      expectedBenefit: input.reality.verificationNeeds.length ? 0.82 : 0.56,
      effort: 0.4,
      risk: 0.18,
      requiredProof:
        input.reality.verificationNeeds[0]?.nextAction ||
        'Use status/proof reads only.',
      toolReliability: 0.8,
      approvalRequirement: input.reality.verificationNeeds.length
        ? ('manual_external' as const)
        : ('read_only' as const),
      possibleFailure: 'Manual proof may still require the user.',
      fallbackPlan: 'Proceed with a draft or plan instead of a side effect.',
      approvalPenalty: input.reality.verificationNeeds.length ? 0.25 : 0,
    },
  ];
  const options = raw.map((item) => {
    const score = optionScore(item);
    return {
      optionId: id('cf_option', comparisonId, item.suffix),
      comparisonId,
      createdAt: input.now,
      actionSummary: item.actionSummary,
      expectedBenefit: item.expectedBenefit,
      effort: item.effort,
      risk: item.risk,
      requiredProof: item.requiredProof,
      toolReliability: item.toolReliability,
      approvalRequirement: item.approvalRequirement,
      possibleFailure: item.possibleFailure,
      fallbackPlan: item.fallbackPlan,
      score,
      evidenceRefsJson: evidence,
      privacyJson: jsonValue(PRIVACY),
    };
  });
  const selected = options.slice().sort((a, b) => b.score - a.score)[0];
  const comparison: CounterfactualComparison = {
    comparisonId,
    createdAt: input.now,
    requestSummary: redactText(input.text, 260),
    selectedOptionId: selected.optionId,
    optionIdsJson: jsonIds(options.map((option) => option.optionId)),
    decision:
      selected.approvalRequirement === 'manual_external'
        ? 'clarify'
        : 'recommend',
    reason: selected.optionId.endsWith('verify_first')
      ? 'Verification reduces stale-proof risk before action.'
      : 'The selected option has the best benefit/risk/effort balance.',
    confidence: selected.score,
    nextAction: selected.fallbackPlan,
    privacyJson: jsonValue(PRIVACY),
  };
  if (input.persist) {
    upsertCounterfactualComparison(comparison);
    for (const option of options) upsertCounterfactualActionOption(option);
  }
  return { comparison, options };
}

function findMatchingGoal(
  text: string,
  groupFolder?: string | null,
): HierarchicalGoal | undefined {
  const lower = text.toLowerCase();
  const goals = listHierarchicalGoals({
    groupFolder,
    statuses: ['active', 'proposed', 'blocked'],
    limit: 12,
  });
  return goals.find((goal) => {
    const title = goal.title.toLowerCase();
    if (lower.includes('andrea') && title.includes('andrea')) return true;
    if (lower.includes('house') && title.includes('house')) return true;
    if (lower.includes('weekend') && title.includes('weekend')) return true;
    if (lower.includes('candace') && title.includes('candace')) return true;
    if (lower.includes('plan') && title.includes('plan')) return true;
    return false;
  });
}

function applyGoalControl(
  text: string,
  groupFolder: string | null | undefined,
  now: string,
): string | null {
  const lower = text.toLowerCase();
  if (!/\b(pause that goal|mark that done|make this a goal)\b/.test(lower)) {
    return null;
  }
  const goals = listHierarchicalGoals({
    groupFolder,
    statuses: ['proposed', 'active', 'blocked'],
    limit: 5,
  });
  const goal = goals[0];
  if (!goal) return 'I do not have a current goal candidate to update yet.';
  if (/\bpause that goal\b/.test(lower)) {
    updateHierarchicalGoalStatus(goal.goalId, 'paused', now);
    return `Paused goal: ${goal.title}.`;
  }
  if (/\bmark that done\b/.test(lower)) {
    updateHierarchicalGoalStatus(goal.goalId, 'completed', now);
    return `Marked done: ${goal.title}.`;
  }
  if (/\bmake this a goal\b/.test(lower)) {
    updateHierarchicalGoalStatus(goal.goalId, 'active', now);
    return `Made it active: ${goal.title}.`;
  }
  return null;
}

function summarizeGoalResponse(result: {
  run: GoalPlannerRun;
  goal?: HierarchicalGoal | null;
  steps: GoalPlanStep[];
  comparison?: CounterfactualComparison | null;
  options: CounterfactualActionOption[];
  opportunity?: ProactiveOpportunity | null;
}): string {
  if (result.comparison) {
    const selected = result.options.find(
      (option) => option.optionId === result.comparison?.selectedOptionId,
    );
    return [
      selected
        ? `Best move: ${selected.actionSummary}`
        : result.comparison.reason,
      `Why: ${result.comparison.reason}`,
      `Next: ${result.comparison.nextAction}`,
    ].join('\n');
  }
  if (!result.goal) {
    return `${result.run.summary}\nNext: ${result.run.nextAction}`;
  }
  const primaryStep = result.steps[0];
  const lines = [
    `${result.goal.status === 'active' ? 'Active goal' : 'Proposed goal'}: ${result.goal.title}`,
    `Why this: ${result.run.summary}`,
    primaryStep
      ? `Next move: ${primaryStep.actionSummary}`
      : `Next move: ${result.goal.nextAction}`,
  ];
  if (result.opportunity) {
    lines.push(`Suggestion: ${result.opportunity.suggestedAction}`);
  }
  if (result.run.approvalRequired) {
    lines.push('Approval: required before any send/write/operator action.');
  }
  return lines.join('\n');
}

export function planGoalDirectedRequest(
  input: PlanInput,
): GoalDirectedPlanResult {
  const now = nowIso(input.now);
  const persist = input.persist !== false;
  const text = redactText(stripAssistantInvocation(input.text), 900);
  const groupFolder = input.groupFolder || null;
  const channel = input.channel || 'operator';
  const reality =
    input.reality ||
    buildRealityGroundingReport({
      requestText: text,
      channel,
      persist: false,
    });
  const control = applyGoalControl(text, groupFolder, now);
  seedCausalBeliefs(now, persist);
  const intent = classifyIntent(text);
  const opportunityReport = buildProactiveOpportunityReport({
    groupFolder,
    now: new Date(now),
    persist,
    realityReport: reality,
  });

  let goal: HierarchicalGoal | null | undefined;
  let milestones: GoalMilestone[] = [];
  let steps: GoalPlanStep[] = [];
  let comparison: CounterfactualComparison | null = null;
  let options: CounterfactualActionOption[] = [];
  const activeOpportunity = opportunityReport.topOpportunity || null;

  if (control) {
    const run: GoalPlannerRun = {
      runId: id('goal_run', now, text),
      createdAt: now,
      updatedAt: now,
      groupFolder,
      channel,
      requestSummary: text,
      intent: 'goal_update',
      selectedGoalId:
        listHierarchicalGoals({ groupFolder, limit: 1 })[0]?.goalId || null,
      selectedComparisonId: null,
      selectedOpportunityId: null,
      candidateGoalIdsJson: jsonIds(
        listHierarchicalGoals({ groupFolder, limit: 5 }).map(
          (item) => item.goalId,
        ),
      ),
      candidateOpportunityIdsJson: jsonIds([]),
      verificationNeedIdsJson: jsonIds(
        reality.verificationNeeds.map((need) => need.needId),
      ),
      approvalRequired: false,
      confidence: 0.86,
      summary: control,
      nextAction: 'Continue with the next safe step when ready.',
      privacyJson: jsonValue(PRIVACY),
    };
    if (persist) upsertGoalPlannerRun(run);
    return {
      run,
      goal: null,
      milestones,
      steps,
      comparison,
      options,
      opportunity: null,
      reality,
      response: `${control}\nNext: ${run.nextAction}`,
    };
  }

  if (intent === 'counterfactual') {
    const built = buildCounterfactual({ text, now, reality, persist });
    comparison = built.comparison;
    options = built.options;
  } else if (intent !== 'direct' && intent !== 'no_action') {
    const matched = findMatchingGoal(text, groupFolder);
    goal =
      matched ||
      createGoal({
        text,
        now,
        groupFolder,
        status: /\bmake this a goal\b/i.test(text) ? 'active' : 'proposed',
        reality,
      });
    milestones = buildMilestones(goal, text, now);
    steps = buildPlanSteps({ goal, milestones, text, now, reality });
    if (persist) {
      upsertHierarchicalGoal(goal);
      for (const milestone of milestones) upsertGoalMilestone(milestone);
      for (const step of steps) upsertGoalPlanStep(step);
    }
  }

  const needs = reality.verificationNeeds.slice(0, 8);
  const approvalRequired =
    steps.some((step) => step.approvalRequirement !== 'read_only') ||
    Boolean(comparison?.decision === 'stage_approval');
  const candidateGoals = listHierarchicalGoals({
    groupFolder,
    statuses: ['active', 'proposed', 'blocked'],
    limit: 8,
  });
  const candidateOpportunities = opportunityReport.opportunities.slice(0, 8);
  const summary =
    goal?.title === 'Choose the next useful move' && activeOpportunity
      ? `The highest-value safe suggestion is ${activeOpportunity.opportunitySummary}.`
      : comparison
        ? comparison.reason
        : goal
          ? `${goal.title} is being handled as a ${goal.status} goal with ${steps.length} safe/staged step(s).`
          : activeOpportunity
            ? `Use the current opportunity: ${activeOpportunity.opportunitySummary}.`
            : 'No durable goal was needed; answer directly or ask one clarification if context is missing.';
  const nextAction =
    steps[0]?.nextAction ||
    comparison?.nextAction ||
    activeOpportunity?.suggestedAction ||
    reality.nextAction;
  const confidence = clamp01(
    (goal?.confidence ||
      comparison?.confidence ||
      activeOpportunity?.confidence ||
      0.64) -
      needs.length * 0.02 -
      reality.contradictions.length * 0.04,
  );
  const run: GoalPlannerRun = {
    runId: id('goal_run', now, text),
    createdAt: now,
    updatedAt: now,
    groupFolder,
    channel,
    requestSummary: text,
    intent,
    selectedGoalId: goal?.goalId || null,
    selectedComparisonId: comparison?.comparisonId || null,
    selectedOpportunityId: activeOpportunity?.opportunityId || null,
    candidateGoalIdsJson: jsonIds(candidateGoals.map((item) => item.goalId)),
    candidateOpportunityIdsJson: jsonIds(
      candidateOpportunities.map((item) => item.opportunityId),
    ),
    verificationNeedIdsJson: jsonIds(needs.map((need) => need.needId)),
    approvalRequired,
    confidence,
    summary,
    nextAction,
    privacyJson: jsonValue(PRIVACY),
  };
  if (persist) upsertGoalPlannerRun(run);
  const response = summarizeGoalResponse({
    run,
    goal,
    steps,
    comparison,
    options,
    opportunity: activeOpportunity,
  });
  return {
    run,
    goal,
    milestones,
    steps,
    comparison,
    options,
    opportunity: activeOpportunity,
    reality,
    response,
  };
}

export function buildHierarchicalPlannerReport(
  params: {
    groupFolder?: string | null;
    requestText?: string;
    persist?: boolean;
    now?: Date | string;
  } = {},
): GoalPlannerDoctorReport {
  const now = nowIso(params.now);
  const persist = params.persist !== false;
  const requestText =
    params.requestText ||
    'what should I do next with current goals and proof debt?';
  const result = planGoalDirectedRequest({
    text: requestText,
    channel: 'operator',
    groupFolder: params.groupFolder,
    now,
    persist,
  });
  const activeGoals = listHierarchicalGoals({
    groupFolder: params.groupFolder,
    statuses: ['active'],
    limit: 10,
  });
  const proposedGoals = listHierarchicalGoals({
    groupFolder: params.groupFolder,
    statuses: ['proposed'],
    limit: 10,
  });
  const blockedGoals = listHierarchicalGoals({
    groupFolder: params.groupFolder,
    statuses: ['blocked'],
    limit: 10,
  });
  const staleGoals = listHierarchicalGoals({
    groupFolder: params.groupFolder,
    statuses: ['paused', 'archived'],
    limit: 10,
  });
  const goalIds = [
    ...activeGoals,
    ...proposedGoals,
    ...blockedGoals,
    ...staleGoals,
  ].map((goal) => goal.goalId);
  const milestones = goalIds.flatMap((goalId) =>
    listGoalMilestones({ goalId, limit: 5 }),
  );
  const planSteps = goalIds.flatMap((goalId) =>
    listGoalPlanSteps({ goalId, limit: 5 }),
  );
  const comparisons = listCounterfactualComparisons({ limit: 8 });
  const options = comparisons.flatMap((comparison) =>
    listCounterfactualActionOptions({
      comparisonId: comparison.comparisonId,
      limit: 4,
    }),
  );
  const causalBeliefs = seedCausalBeliefs(now, persist);
  const opportunities = listProactiveOpportunities({
    groupFolder: params.groupFolder,
    statuses: ['proposed', 'shown', 'snoozed'],
    limit: 10,
  });
  return {
    generatedAt: now,
    latestRun: result.run || listGoalPlannerRuns({ limit: 1 })[0] || null,
    activeGoals,
    proposedGoals,
    blockedGoals,
    staleGoals,
    milestones,
    planSteps,
    comparisons,
    options,
    causalBeliefs,
    opportunities,
    nextAction: result.run.nextAction,
    privacy: PRIVACY,
  };
}

export function formatGoalPlannerReport(
  report: GoalPlannerDoctorReport,
): string {
  const latest = report.latestRun;
  const comparison = report.comparisons[0];
  const topOptions = comparison
    ? report.options
        .filter((option) => option.comparisonId === comparison.comparisonId)
        .slice(0, 3)
    : [];
  const lines = [
    '*Hierarchical Goal Planner*',
    `Generated: ${report.generatedAt}`,
    latest
      ? `Latest: ${latest.intent} / confidence=${latest.confidence.toFixed(2)} / approval=${latest.approvalRequired ? 'required' : 'not_required'}`
      : 'Latest: none',
    latest ? `Summary: ${latest.summary}` : '',
    '',
    '*Goals*',
    `- active=${report.activeGoals.length}, proposed=${report.proposedGoals.length}, blocked=${report.blockedGoals.length}, paused/archived=${report.staleGoals.length}`,
    ...[...report.activeGoals, ...report.proposedGoals, ...report.blockedGoals]
      .slice(0, 8)
      .map(
        (goal) =>
          `- ${goal.status}/${goal.priority}: ${goal.title} -> ${goal.nextAction}`,
      ),
    '',
    '*Plan Steps*',
    ...(report.planSteps.length
      ? report.planSteps.slice(0, 8).map((step) => {
          return `- ${step.status}/${step.approvalRequirement}: ${step.actionSummary} -> ${step.nextAction}`;
        })
      : ['- none']),
    '',
    '*Causal Beliefs*',
    ...(report.causalBeliefs.length
      ? report.causalBeliefs.slice(0, 8).map((belief) => {
          return `- ${belief.status} (${belief.confidence.toFixed(2)}): ${belief.causeAction} => ${belief.expectedEffect}`;
        })
      : ['- none']),
    '',
    '*Counterfactuals*',
    ...(comparison
      ? [
          `- ${comparison.decision} (${comparison.confidence.toFixed(2)}): ${comparison.reason}`,
          ...topOptions.map(
            (option) =>
              `  - score=${option.score.toFixed(2)} / ${option.approvalRequirement}: ${option.actionSummary}`,
          ),
        ]
      : ['- none']),
    '',
    '*Opportunities*',
    ...(report.opportunities.length
      ? report.opportunities.slice(0, 6).map((opportunity) => {
          return `- ${opportunity.status}/${opportunity.urgency}: ${opportunity.opportunitySummary} -> ${opportunity.suggestedAction}`;
        })
      : ['- none']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: metadata-only; no raw private bodies, prompts, hidden reasoning, provider debates, raw tool output, or secrets.',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildGoalPlannerStatusText(): string {
  return formatGoalPlannerReport(
    buildHierarchicalPlannerReport({ persist: false }),
  );
}

export function isGoalPlannerNaturalRequest(text: string): boolean {
  const lower = text
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/u, '');
  return (
    lower === 'what goals are active' ||
    lower === 'what are we trying to accomplish' ||
    lower === 'show me the plan' ||
    lower === 'simplify the plan' ||
    lower === 'what is blocking this' ||
    lower === "what's blocking this" ||
    lower === 'what is the safest next step' ||
    lower === "what's the safest next step" ||
    lower === 'what if we do nothing' ||
    lower === 'what should i do next' ||
    lower === 'what should i work on' ||
    lower === 'stop suggesting that' ||
    lower === 'do not bring this up unless i ask' ||
    /\b(make this a goal|pause that goal|mark that done|help me prepare|help me plan tonight|help me stay on top|help me follow through|help me get andrea closer|what should we do about that|what would happen if we do nothing|why this plan|why did you suggest that)\b/.test(
      lower,
    )
  );
}

export function formatGoalPlannerNaturalResponse(text: string): string {
  const lower = text
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/u, '');
  if (
    lower === 'what goals are active' ||
    lower === 'what are we trying to accomplish' ||
    lower === 'show me the plan' ||
    lower === 'simplify the plan'
  ) {
    return formatGoalPlannerReport(
      buildHierarchicalPlannerReport({ requestText: lower, persist: false }),
    );
  }
  if (
    /\bstop suggesting that|do not bring this up unless i ask\b/.test(lower)
  ) {
    const result = applyProactiveOpportunityControl({ text, now: new Date() });
    return result.handled
      ? `${result.message}\n${formatProactiveOpportunityReport(
          buildProactiveOpportunityReport({ persist: false }),
        )}`
      : result.message;
  }
  const result = planGoalDirectedRequest({
    text,
    channel: 'telegram',
    persist: true,
  });
  return result.response;
}

export function buildGoalProjectInputs(): {
  proofDebt: ReturnType<typeof buildLiveProofGauntletReport>;
  improvement: ReturnType<typeof buildAutonomousImprovementLabReport>;
  patchWorkbench: ReturnType<typeof buildPatchWorkbenchReport>;
} {
  return {
    proofDebt: buildLiveProofGauntletReport(),
    improvement: buildAutonomousImprovementLabReport({ persist: false }),
    patchWorkbench: buildPatchWorkbenchReport({
      mode: 'dry_run',
      persist: false,
    }),
  };
}
