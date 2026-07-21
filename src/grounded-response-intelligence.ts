import { createHash } from 'node:crypto';

import type { GroundedDecisionKind } from './grounded-cognitive-executive.js';
import type { GroundedContextBundle } from './grounded-memory.js';
import type { PersonalContextPacket } from './types.js';
import type { UnifiedGroundedCognitiveFrame } from './unified-grounded-cognition.js';

/**
 * Grounded Response Intelligence is an advisory-only layer. It may describe
 * what a reply must cover and evaluate draft text, but it owns no tools,
 * credentials, approvals, routes, durable work, or delivery authority.
 */
export const GROUNDED_RESPONSE_INTELLIGENCE_VERSION = '1.0.0';
export const GROUNDED_RESPONSE_MAX_INTENTS = 8;
export const GROUNDED_RESPONSE_MAX_CONTEXT_CHARS = 6_000;
export const GROUNDED_RESPONSE_MAX_GUIDANCE_CHARS = 4_000;

export type GroundedAdvisoryMode = 'off' | 'shadow' | 'assistive';
export type GroundedIntentActionClass =
  | 'informational'
  | 'research'
  | 'calendar_read'
  | 'calendar_write'
  | 'reminder_read'
  | 'reminder_write'
  | 'communication_read'
  | 'communication_write'
  | 'repository_read'
  | 'repository_write'
  | 'external_mutation'
  | 'unknown';
export type GroundedIntentMutability =
  | 'informational'
  | 'read_only'
  | 'approval_gated'
  | 'externally_mutating';
export type GroundedResponsePosture =
  | 'answer'
  | 'ask'
  | 'research'
  | 'defer'
  | 'stop_safely';

export interface GroundedIntentClause {
  intentId: string;
  ordinal: number;
  originalClause: string;
  normalizedObjective: string;
  target: string;
  actionClass: GroundedIntentActionClass;
  mutability: GroundedIntentMutability;
  approvalRequired: boolean;
  supportedRoute: string | null;
  evidenceNeeded: string[];
  relationshipIntentIds: string[];
  keywords: string[];
}

export interface GroundedSelectedEvidence {
  ref: string;
  source:
    | 'current_turn'
    | 'grounded_memory'
    | 'context_graph'
    | 'goal'
    | 'route_health'
    | 'tool_health'
    | 'provider_receipt'
    | 'approval'
    | 'blocker';
  summary: string;
  confidence: number;
  epistemicStatus:
    | 'direct'
    | 'observed'
    | 'accepted'
    | 'inferred'
    | 'uncertain';
  mayStateAsFact: boolean;
}

export interface GroundedResponseContract {
  requiredIntentIds: string[];
  responseOrder: string[];
  allowedFacts: string[];
  uncertaintyDisclosures: string[];
  prohibitedClaims: string[];
  approvalBoundaries: string[];
  usefulReadOnlyWork: string[];
  nextUserDecision: string | null;
  maxRepairAttempts: 1;
}

export interface GroundedDeliberationPacket {
  packetId: string;
  version: string;
  createdAt: string;
  turnId: string;
  mode: GroundedAdvisoryMode;
  intents: GroundedIntentClause[];
  selectedEvidence: GroundedSelectedEvidence[];
  excludedEvidence: Array<{ ref: string; reason: string }>;
  contradictions: string[];
  unknowns: string[];
  commitments: string[];
  blockers: string[];
  recommendedPosture: GroundedResponsePosture;
  responseContract: GroundedResponseContract;
  budgets: {
    contextChars: number;
    contextLimit: number;
    intentCount: number;
    intentLimit: number;
    truncated: boolean;
  };
  executionAuthority: false;
  authorityStatement: string;
}

export type GroundedResponseIssueKind =
  | 'intent_missing'
  | 'target_missing'
  | 'unsupported_completion'
  | 'contradiction_undisclosed'
  | 'stale_memory_misuse'
  | 'approval_boundary'
  | 'partial_failure_hidden'
  | 'follow_through_missing'
  | 'evidence_missing'
  | 'unnecessary_repetition'
  | 'authority_violation'
  | 'privacy_violation';

export interface GroundedResponseIssue {
  kind: GroundedResponseIssueKind;
  severity: 'repair' | 'block';
  intentId: string | null;
  detail: string;
}

export interface GroundedResponseEvaluation {
  status: 'pass' | 'repair' | 'block';
  score: number;
  coveredIntentIds: string[];
  missedIntentIds: string[];
  preservedTargetIds: string[];
  issues: GroundedResponseIssue[];
  metrics: {
    intentCoverage: number;
    targetPreservation: number;
    truthfulness: number;
    approvalCorrectness: number;
    continuity: number;
    repetition: number;
    calibration: number;
    partialFailureHonesty: number;
    evidenceCoverage: number;
  };
  invariantResults: {
    noExecutionAuthority: boolean;
    noPrivacyViolation: boolean;
    noUnsupportedCompletion: boolean;
    allOriginalClausesRetained: boolean;
  };
  evaluatedChars: number;
}

export interface GroundedResponseRepairResult {
  text: string;
  applied: boolean;
  attempts: 0 | 1;
  reason: string;
  evaluation: GroundedResponseEvaluation;
}

const REQUEST_VERBS =
  /\b(?:tell|show|explain|find|look|research|check|compare|summarize|list|cite|confirm|continue|resume|report|outline|review|read|answer|use|treat|record|evaluate|prefer|correction|what|when|where|which|who|why|how|is|are|was|were|did|does|can|could|would|please|schedule|book|create|add|move|reschedule|cancel|delete|remove|remind|message|text|send|reply|email|call|implement|fix|debug|diagnose|commit|push|deploy|restart|save|transfer|buy|purchase|order|post)\b/i;
const MUTATION_REQUEST =
  /^(?:(?:and|then|also)\s+)*(?:(?:can|could|would|will)\s+you\s+|(?:i\s+(?:want|need)\s+you\s+to\s+)|please\s+)?(?:send|message|text|email|reply|schedule|book|create|add|move|reschedule|cancel|delete|remove|change|edit|update|remind|save|transfer|post|implement|fix|commit|push|deploy|restart|buy|purchase|order)\b/i;
const COMPLETION_CLAIMS =
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:sent|scheduled|booked|created|added|moved|rescheduled|cancelled|canceled|deleted|updated|fixed|implemented|committed|pushed|deployed|restarted|purchased|ordered)\b|\b(?:done|completed successfully|all set)\b/i;
const UNCERTAINTY_LANGUAGE =
  /\b(?:uncertain|conflict|contradict|not sure|cannot verify|can't verify|unverified|stale|may be|might be|appears|based on)\b/i;
const APPROVAL_LANGUAGE =
  /\b(?:approve|approval|permission|confirm before|if you want me to|would you like me to)\b/i;
const FAILURE_LANGUAGE =
  /\b(?:failed|blocked|couldn't|could not|can't|cannot|partial|only|not yet|still need|have not|did not|will not|won't|refuse)\b/i;
const SECRET_PATTERN = /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/i;
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'for',
  'from',
  'give',
  'have',
  'help',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'should',
  'that',
  'the',
  'then',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'you',
  'your',
  'also',
  'check',
  'compare',
  'confirm',
  'current',
  'explain',
  'find',
  'list',
  'project',
  'research',
  'schedule',
  'send',
  'summarize',
]);

function bounded(value: string | null | undefined, limit = 420): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function resolveGroundedAdvisoryMode(
  value = process.env.GROUNDED_ADVISORY_MODE,
): GroundedAdvisoryMode {
  const normalized = String(value || 'shadow')
    .trim()
    .toLowerCase();
  return normalized === 'off' || normalized === 'assistive'
    ? normalized
    : 'shadow';
}

function splitOutsideQuotes(text: string): string[] {
  const candidates: string[] = [];
  let current = '';
  let quote: string | null = null;
  const push = () => {
    const value = bounded(current, 800).replace(/^[,;:\s]+|[,;:\s]+$/g, '');
    if (value) candidates.push(value);
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (
      (char === '"' || char === "'" || char === '“' || char === '”') &&
      text[index - 1] !== '\\'
    ) {
      if (!quote) quote = char === '”' ? '“' : char;
      else if (quote === char || (quote === '“' && char === '”')) quote = null;
      current += char;
      continue;
    }
    if (!quote && (char === ';' || char === '\n' || /[.!?]/.test(char))) {
      current += char;
      push();
      continue;
    }
    if (!quote) {
      const remaining = text.slice(index);
      const connector = remaining.match(/^\s+(?:and then|then|also|plus)\s+/i);
      if (
        connector &&
        REQUEST_VERBS.test(current) &&
        REQUEST_VERBS.test(remaining.slice(connector[0].length))
      ) {
        push();
        index += connector[0].length - 1;
        continue;
      }
      const andConnector = remaining.match(/^\s+and\s+/i);
      if (
        andConnector &&
        REQUEST_VERBS.test(current) &&
        REQUEST_VERBS.test(remaining.slice(andConnector[0].length))
      ) {
        push();
        index += andConnector[0].length - 1;
        continue;
      }
    }
    current += char;
  }
  push();
  return candidates;
}

function classifyAction(clause: string): {
  actionClass: GroundedIntentActionClass;
  mutability: GroundedIntentMutability;
  route: string | null;
  evidence: string[];
} {
  const text = clause.toLowerCase();
  // Mutation words are frequently nouns or historical references (for
  // example, "was the message delivered?" or "after restart"). Authority
  // classification therefore requires a request-shaped leading verb instead
  // of treating any mention of a mutation as a request to perform one.
  const mutation = MUTATION_REQUEST.test(text);
  if (
    /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:schedule|book|reschedule)\b/.test(
      text,
    )
  ) {
    return {
      actionClass: 'calendar_write',
      mutability: 'approval_gated',
      route: 'calendar_write',
      evidence: [
        'approval bound to the exact calendar change',
        'provider receipt',
        'post-write read-back',
      ],
    };
  }
  if (/\b(?:calendar|meeting|event|appointment)\b/.test(text)) {
    return mutation
      ? {
          actionClass: 'calendar_write',
          mutability: 'approval_gated',
          route: 'calendar_write',
          evidence: [
            'approval bound to the exact calendar change',
            'provider receipt',
            'post-write read-back',
          ],
        }
      : {
          actionClass: 'calendar_read',
          mutability: 'read_only',
          route: 'calendar_read',
          evidence: ['fresh calendar observation'],
        };
  }
  if (/\b(?:remind|reminder|to-?do|task)\b/.test(text)) {
    return mutation
      ? {
          actionClass: 'reminder_write',
          mutability: 'approval_gated',
          route: 'reminder_write',
          evidence: [
            'approval bound to the exact reminder',
            'provider receipt',
            'post-write verification',
          ],
        }
      : {
          actionClass: 'reminder_read',
          mutability: 'read_only',
          route: 'reminder_read',
          evidence: ['fresh reminder observation'],
        };
  }
  if (
    /\b(?:send|message|text|email|reply|telegram|imessage|bluebubbles)\b/.test(
      text,
    )
  ) {
    return mutation
      ? {
          actionClass: 'communication_write',
          mutability: 'approval_gated',
          route: 'communication_write',
          evidence: [
            'fresh recipient and content confirmation',
            'explicit approval',
            'same-target provider receipt',
          ],
        }
      : {
          actionClass: 'communication_read',
          mutability: 'read_only',
          route: 'communication_read',
          evidence: ['fresh conversation observation'],
        };
  }
  if (
    /\b(?:repo|repository|code|bug|test|commit|push|deploy|restart|service)\b/.test(
      text,
    )
  ) {
    return mutation
      ? {
          actionClass: 'repository_write',
          mutability: 'approval_gated',
          route: 'repository_work',
          evidence: [
            'scoped repository state',
            'validation results',
            'verified git/runtime outcome',
          ],
        }
      : {
          actionClass: 'repository_read',
          mutability: 'read_only',
          route: 'repository_read',
          evidence: ['fresh repository or runtime evidence'],
        };
  }
  if (/\b(?:research|look up|search|find|latest|current)\b/.test(text)) {
    return {
      actionClass: 'research',
      mutability: 'read_only',
      route: 'research',
      evidence: ['current attributable sources'],
    };
  }
  if (/\b(?:buy|purchase|order|pay|transfer|submit|post|save)\b/.test(text)) {
    return {
      actionClass: 'external_mutation',
      mutability: 'externally_mutating',
      route: null,
      evidence: [
        'explicit scoped approval',
        'authoritative external receipt',
        'goal-state verification',
      ],
    };
  }
  return {
    actionClass: REQUEST_VERBS.test(text) ? 'informational' : 'unknown',
    mutability: REQUEST_VERBS.test(text) ? 'informational' : 'read_only',
    route: REQUEST_VERBS.test(text) ? 'direct_assistant' : null,
    evidence: REQUEST_VERBS.test(text)
      ? ['grounded explanation or direct answer']
      : ['clarified objective and target'],
  };
}

function keywordsFor(text: string): string[] {
  return unique(text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) || [])
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .slice(0, 8);
}

function targetFor(clause: string, keywords: string[]): string {
  const quoted = clause.match(/["“]([^"”]{2,120})["”]/)?.[1];
  if (quoted) return bounded(quoted, 160);
  const about = clause.match(/\b(?:about|for|to|on)\s+(.{2,160})$/i)?.[1];
  return bounded(about || keywords.slice(-3).join(' ') || clause, 160).replace(
    /[?.!,;:]+$/g,
    '',
  );
}

export function decomposeGroundedIntents(text: string): GroundedIntentClause[] {
  const clauses = splitOutsideQuotes(bounded(text, 4_000)).slice(
    0,
    GROUNDED_RESPONSE_MAX_INTENTS,
  );
  const intents = clauses.map((originalClause, ordinal) => {
    const classified = classifyAction(originalClause);
    const keywords = keywordsFor(originalClause);
    const target = targetFor(originalClause, keywords);
    const intentId = stableId('gri:intent', `${ordinal}|${originalClause}`);
    return {
      intentId,
      ordinal,
      originalClause,
      normalizedObjective: bounded(
        originalClause.replace(/^(?:and|then|also|please)\s+/i, ''),
        240,
      ),
      target,
      actionClass: classified.actionClass,
      mutability: classified.mutability,
      approvalRequired:
        classified.mutability === 'approval_gated' ||
        classified.mutability === 'externally_mutating',
      supportedRoute: classified.route,
      evidenceNeeded: classified.evidence,
      relationshipIntentIds: [] as string[],
      keywords,
    } satisfies GroundedIntentClause;
  });
  return intents.map((intent, index) => ({
    ...intent,
    relationshipIntentIds: intents
      .filter((_candidate, candidateIndex) => candidateIndex !== index)
      .map((candidate) => candidate.intentId),
  }));
}

function postureFrom(
  intents: GroundedIntentClause[],
  executiveDecision: GroundedDecisionKind | null | undefined,
  contradictions: string[],
  blockers: string[],
): GroundedResponsePosture {
  if (executiveDecision === 'stop_safely') return 'stop_safely';
  if (
    intents.some(
      (intent) =>
        intent.mutability === 'externally_mutating' &&
        /\b(?:secret|password|token|credential)\b/i.test(intent.originalClause),
    )
  )
    return 'stop_safely';
  if (blockers.length > 0) return 'defer';
  if (
    intents.some(
      (intent) =>
        intent.approvalRequired &&
        /^(?:it|them|that|(?:book\s+)?(?:the\s+)?appointment|(?:schedule\s+)?(?:the\s+)?meeting)$/i.test(
          intent.target,
        ),
    )
  )
    return 'ask';
  if (intents.some((intent) => intent.actionClass === 'unknown')) return 'ask';
  if (intents.some((intent) => intent.actionClass === 'research'))
    return 'research';
  if (contradictions.length > 0 || executiveDecision === 'research')
    return 'research';
  if (executiveDecision === 'ask') return 'ask';
  if (executiveDecision === 'defer') return 'defer';
  return 'answer';
}

export function buildGroundedDeliberationPacket(input: {
  turnId: string;
  text: string;
  mode?: GroundedAdvisoryMode;
  now?: string;
  memoryBundle?: GroundedContextBundle | null;
  personalContextPacket?: PersonalContextPacket | null;
  executiveDecision?: GroundedDecisionKind | null;
  routeHealth?: Array<{ route: string; status: string; detail?: string }>;
  blockers?: string[];
  /**
   * When present, this is the canonical evidence/intents source. Memory and
   * context inputs remain for backward-compatible standalone diagnostics.
   */
  unifiedFrame?: UnifiedGroundedCognitiveFrame | null;
}): GroundedDeliberationPacket {
  const createdAt = input.now || new Date().toISOString();
  const frame = input.unifiedFrame || null;
  const mode = frame?.mode || input.mode || resolveGroundedAdvisoryMode();
  const intents = frame?.intents || decomposeGroundedIntents(input.text);
  const bundle = input.memoryBundle || null;
  const personal = input.personalContextPacket || null;
  const legacySelectedEvidence: GroundedSelectedEvidence[] = [
    {
      ref: `turn:${input.turnId}`,
      source: 'current_turn',
      summary: bounded(input.text, 360),
      confidence: 1,
      epistemicStatus: 'direct',
      mayStateAsFact: true,
    },
    ...(bundle?.items || []).map((item) => ({
      ref: item.recordId,
      source: 'grounded_memory' as const,
      summary: bounded(item.statement, 240),
      confidence: item.confidence,
      epistemicStatus:
        item.sourceType === 'inference' || item.sourceType === 'assumption'
          ? ('inferred' as const)
          : ('accepted' as const),
      mayStateAsFact:
        item.sourceType !== 'inference' && item.sourceType !== 'assumption',
    })),
    ...(personal?.items || []).slice(0, 8).map((item) => ({
      ref: item.citation,
      source: 'context_graph' as const,
      summary: bounded(item.summary, 240),
      confidence: item.confidence,
      epistemicStatus:
        item.freshness === 'stale'
          ? ('uncertain' as const)
          : ('accepted' as const),
      mayStateAsFact: item.freshness === 'fresh' && item.confidence >= 0.65,
    })),
    ...(bundle?.goals || []).slice(0, 6).map((goal) => ({
      ref: goal.goalId,
      source: 'goal' as const,
      summary: bounded(
        `${goal.title} (${goal.state})${goal.nextProposedStep ? `; next: ${goal.nextProposedStep}` : ''}`,
        240,
      ),
      confidence: goal.state === 'active' ? 0.9 : 0.75,
      epistemicStatus: 'accepted' as const,
      mayStateAsFact: true,
    })),
    ...(input.routeHealth || []).slice(0, 6).map((route) => ({
      ref: `route:${route.route}`,
      source: 'route_health' as const,
      summary: bounded(
        `${route.route}: ${route.status}${route.detail ? ` — ${route.detail}` : ''}`,
        240,
      ),
      confidence: 0.9,
      epistemicStatus: 'observed' as const,
      mayStateAsFact: true,
    })),
  ];
  const unifiedSelectedEvidence: GroundedSelectedEvidence[] = (
    frame?.evidence || []
  ).map((item) => ({
    ref: item.evidenceId,
    source:
      item.sourceClass === 'current_user_statement'
        ? ('current_turn' as const)
        : item.sourceClass === 'accepted_durable_memory' ||
            item.sourceClass === 'reviewed_inference' ||
            item.sourceClass === 'unresolved_assumption'
          ? ('grounded_memory' as const)
          : item.sourceClass === 'commitment_or_goal' ||
              item.sourceClass === 'verified_goal_outcome'
            ? ('goal' as const)
            : item.sourceClass === 'tool_health_observation'
              ? ('tool_health' as const)
              : item.sourceClass === 'verified_provider_receipt'
                ? ('provider_receipt' as const)
                : item.sourceClass === 'approval_record'
                  ? ('approval' as const)
                  : ('route_health' as const),
    summary: bounded(item.claim, 240),
    confidence: item.confidence,
    epistemicStatus:
      item.epistemicStatus === 'direct'
        ? ('direct' as const)
        : item.epistemicStatus === 'observed' ||
            item.epistemicStatus === 'verified'
          ? ('observed' as const)
          : item.epistemicStatus === 'accepted'
            ? ('accepted' as const)
            : item.epistemicStatus === 'inferred'
              ? ('inferred' as const)
              : ('uncertain' as const),
    mayStateAsFact: item.mayStateToUser,
  }));
  const selectedEvidence = frame
    ? unifiedSelectedEvidence
    : legacySelectedEvidence;
  const contradictions = frame
    ? unique(
        frame.arbitrations
          .filter((item) => item.outcome === 'contradicted')
          .map((item) => item.reason),
      ).slice(0, 8)
    : unique([
        ...(bundle?.contradictions || []).map((item) => item.note),
        ...(personal?.conflicts || []).map(
          (item) =>
            `Context graph has unresolved conflict for ${item.subjectKey}.`,
        ),
      ]).slice(0, 8);
  const unknowns = frame
    ? unique(
        frame.arbitrations
          .filter((item) =>
            [
              'accepted_with_uncertainty',
              'stale',
              'insufficient_evidence',
              'requires_user_clarification',
            ].includes(item.outcome),
          )
          .map((item) => item.reason),
      ).slice(0, 10)
    : unique([
        ...(bundle?.uncertainties || []),
        ...selectedEvidence
          .filter((item) => !item.mayStateAsFact)
          .map(
            (item) =>
              `${item.ref} is ${item.epistemicStatus}, not verified fact.`,
          ),
      ]).slice(0, 10);
  const blockers = unique(input.blockers || []).slice(0, 8);
  const commitments = frame
    ? unique([
        ...frame.commitments.map(
          (item) => `${item.commitmentId}: ${item.summary} (${item.state})`,
        ),
        ...frame.goals
          .filter((goal) => ['active', 'blocked', 'stale'].includes(goal.state))
          .map((goal) => `${goal.goalId}: ${goal.title} (${goal.state})`),
      ]).slice(0, 8)
    : (bundle?.goals || [])
        .filter((goal) => ['active', 'blocked'].includes(goal.state))
        .map((goal) => `${goal.goalId}: ${goal.title} (${goal.state})`)
        .slice(0, 8);
  const recommendedPosture: GroundedResponsePosture = frame
    ? frame.chosenPosture === 'ask_clarification' ||
      frame.chosenPosture === 'request_approval'
      ? 'ask'
      : frame.chosenPosture === 'research_read_only'
        ? 'research'
        : frame.chosenPosture === 'defer_missing_precondition'
          ? 'defer'
          : frame.chosenPosture === 'stop_safely'
            ? 'stop_safely'
            : 'answer'
    : postureFrom(intents, input.executiveDecision, contradictions, blockers);
  const mutating = intents.filter((intent) => intent.approvalRequired);
  const responseContract: GroundedResponseContract = {
    requiredIntentIds: intents.map((intent) => intent.intentId),
    responseOrder: intents.map((intent) => intent.intentId),
    allowedFacts: selectedEvidence
      .filter((item) => item.mayStateAsFact)
      .map((item) => item.summary)
      .slice(0, 12),
    uncertaintyDisclosures: unique([...contradictions, ...unknowns]).slice(
      0,
      8,
    ),
    prohibitedClaims: unique([
      ...(frame?.prohibitedCompletionClaims || []),
      'Do not claim an external mutation completed without authoritative same-target evidence.',
      'Do not present inference, stale context, or unresolved contradiction as verified fact.',
      'Do not imply that this advisory packet grants approval or execution authority.',
      ...(blockers.length > 0
        ? ['Do not hide a blocker or describe a partial outcome as complete.']
        : []),
    ]),
    approvalBoundaries: unique([
      ...(frame?.approvalBoundaries || []),
      ...mutating.map(
        (intent) =>
          `Intent ${intent.intentId} requires existing action-specific approval; this packet cannot satisfy or consume it.`,
      ),
    ]),
    usefulReadOnlyWork: intents
      .filter(
        (intent) =>
          intent.mutability === 'read_only' ||
          intent.mutability === 'informational',
      )
      .map((intent) => intent.intentId),
    nextUserDecision:
      mutating.length > 0
        ? `Approve or refine the exact scope for: ${mutating.map((intent) => intent.target).join('; ')}`
        : recommendedPosture === 'ask'
          ? 'Clarify the ambiguous objective or target.'
          : null,
    maxRepairAttempts: 1,
  };
  let contextChars = selectedEvidence.reduce(
    (sum, item) => sum + item.summary.length,
    0,
  );
  const boundedEvidence: GroundedSelectedEvidence[] = [];
  for (const item of selectedEvidence) {
    const next = bounded(item.summary, 240);
    if (
      boundedEvidence.length > 0 &&
      boundedEvidence.reduce(
        (sum, evidence) => sum + evidence.summary.length,
        0,
      ) +
        next.length >
        GROUNDED_RESPONSE_MAX_CONTEXT_CHARS
    )
      break;
    boundedEvidence.push({ ...item, summary: next });
  }
  contextChars = boundedEvidence.reduce(
    (sum, item) => sum + item.summary.length,
    0,
  );
  return {
    packetId: stableId(
      'gri:packet',
      `${input.turnId}|${createdAt}|${intents.map((intent) => intent.originalClause).join('|')}`,
    ),
    version: GROUNDED_RESPONSE_INTELLIGENCE_VERSION,
    createdAt,
    turnId: input.turnId,
    mode,
    intents,
    selectedEvidence: boundedEvidence,
    excludedEvidence: frame
      ? frame.excludedEvidence
          .slice(0, 20)
          .map((item) => ({ ref: item.ref, reason: item.reason }))
      : (bundle?.excluded || [])
          .slice(0, 20)
          .map((item) => ({ ref: item.recordId, reason: item.reason })),
    contradictions,
    unknowns,
    commitments,
    blockers,
    recommendedPosture,
    responseContract,
    budgets: {
      contextChars,
      contextLimit: GROUNDED_RESPONSE_MAX_CONTEXT_CHARS,
      intentCount: intents.length,
      intentLimit: GROUNDED_RESPONSE_MAX_INTENTS,
      truncated:
        intents.length >= GROUNDED_RESPONSE_MAX_INTENTS ||
        Boolean(bundle?.budget.truncated) ||
        boundedEvidence.length < selectedEvidence.length,
    },
    executionAuthority: false,
    authorityStatement:
      'Advisory only: this packet cannot call tools, execute actions, grant or consume approval, alter routes, schedule work, or authorize delivery.',
  };
}

function intentCovered(intent: GroundedIntentClause, reply: string): boolean {
  const lower = reply.toLowerCase();
  if (
    lower.includes(`not yet addressed ${intent.target.toLowerCase()}`) ||
    lower.includes(
      `for ${intent.target.toLowerCase()}, i have not yet established a complete grounded answer`,
    )
  ) {
    return false;
  }
  const anchors = intent.keywords.filter((word) => word.length >= 4);
  if (anchors.length === 0) return lower.includes(intent.target.toLowerCase());
  return anchors.some((word) => lower.includes(word));
}

function targetCovered(intent: GroundedIntentClause, reply: string): boolean {
  const lower = reply.toLowerCase();
  if (
    lower.includes(`not yet addressed ${intent.target.toLowerCase()}`) ||
    lower.includes(
      `for ${intent.target.toLowerCase()}, i have not yet established a complete grounded answer`,
    )
  ) {
    return false;
  }
  const targetWords = keywordsFor(intent.target).filter(
    (word) => word.length >= 4,
  );
  if (targetWords.length === 0) return intentCovered(intent, reply);
  return targetWords.some((word) => reply.toLowerCase().includes(word));
}

export function evaluateGroundedResponse(
  packet: GroundedDeliberationPacket,
  replyText: string,
): GroundedResponseEvaluation {
  const rawReply = String(replyText ?? '').trim();
  const reply =
    rawReply.length > 12_000 ? `${rawReply.slice(0, 11_999)}…` : rawReply;
  const issues: GroundedResponseIssue[] = [];
  const covered = packet.intents.filter((intent) =>
    intentCovered(intent, reply),
  );
  const preserved = packet.intents.filter((intent) =>
    targetCovered(intent, reply),
  );
  for (const intent of packet.intents) {
    if (!covered.some((item) => item.intentId === intent.intentId)) {
      issues.push({
        kind: 'intent_missing',
        severity: 'repair',
        intentId: intent.intentId,
        detail: `Reply does not address clause ${intent.ordinal + 1}: ${intent.normalizedObjective}`,
      });
    } else if (!preserved.some((item) => item.intentId === intent.intentId)) {
      issues.push({
        kind: 'target_missing',
        severity: 'repair',
        intentId: intent.intentId,
        detail: `Reply addresses the clause but does not preserve target “${intent.target}”.`,
      });
    }
  }
  const hasCompletionClaim = COMPLETION_CLAIMS.test(reply);
  const mutatingIntents = packet.intents.filter(
    (intent) => intent.approvalRequired,
  );
  const hasVerifiedMutationEvidence = packet.selectedEvidence.some(
    (item) =>
      item.source === 'route_health' &&
      item.mayStateAsFact &&
      /(?:receipt|verified|success)/i.test(item.summary),
  );
  if (
    hasCompletionClaim &&
    mutatingIntents.length > 0 &&
    !hasVerifiedMutationEvidence
  ) {
    issues.push({
      kind: 'unsupported_completion',
      severity: 'block',
      intentId: mutatingIntents[0]?.intentId || null,
      detail:
        'Reply claims a mutation completed without authoritative same-target evidence.',
    });
  }
  if (
    (packet.contradictions.length > 0 || packet.unknowns.length > 0) &&
    !UNCERTAINTY_LANGUAGE.test(reply)
  ) {
    issues.push({
      kind: 'contradiction_undisclosed',
      severity: 'repair',
      intentId: null,
      detail: 'Reply does not disclose relevant contradiction or uncertainty.',
    });
  }
  if (
    packet.unknowns.some((unknown) => /\b(?:stale|expired)\b/i.test(unknown)) &&
    !UNCERTAINTY_LANGUAGE.test(reply)
  ) {
    issues.push({
      kind: 'stale_memory_misuse',
      severity: 'repair',
      intentId: null,
      detail:
        'Reply relies on a stale or expired memory without qualification.',
    });
  }
  if (
    mutatingIntents.length > 0 &&
    !APPROVAL_LANGUAGE.test(reply) &&
    !FAILURE_LANGUAGE.test(reply) &&
    !hasVerifiedMutationEvidence
  ) {
    issues.push({
      kind: 'approval_boundary',
      severity: 'block',
      intentId: mutatingIntents[0]?.intentId || null,
      detail: 'Reply omits the existing action-specific approval boundary.',
    });
  }
  if (packet.blockers.length > 0 && !FAILURE_LANGUAGE.test(reply)) {
    issues.push({
      kind: 'partial_failure_hidden',
      severity: 'repair',
      intentId: null,
      detail: 'Reply does not disclose an active blocker or partial outcome.',
    });
  }
  if (
    packet.intents.some((intent) =>
      /\b(?:cite|citation|source|sources)\b/i.test(intent.originalClause),
    ) &&
    !/\b(?:source|citation|according to|https?:\/\/|\[[^\]]+\]\([^)]+\))\b/i.test(
      reply,
    )
  ) {
    issues.push({
      kind: 'evidence_missing',
      severity: 'repair',
      intentId:
        packet.intents.find((intent) =>
          /\b(?:cite|citation|source|sources)\b/i.test(intent.originalClause),
        )?.intentId || null,
      detail:
        'The request asked for attributable evidence, but none is present.',
    });
  }
  if (
    packet.commitments.length > 0 &&
    !packet.intents.some((intent) =>
      /\b(?:goal|commit|follow|continue|status|progress)\b/i.test(
        intent.originalClause,
      ),
    ) &&
    !/\b(?:goal|commit|follow|continue|status|progress|still)\b/i.test(reply)
  ) {
    issues.push({
      kind: 'follow_through_missing',
      severity: 'repair',
      intentId: null,
      detail:
        'Reply ignores active follow-through context that affects the plan.',
    });
  }
  if (SECRET_PATTERN.test(reply)) {
    issues.push({
      kind: 'privacy_violation',
      severity: 'block',
      intentId: null,
      detail: 'Reply contains secret-shaped material.',
    });
  }
  const repeatedLines = reply
    .split(/\n+/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length >= 12);
  if (new Set(repeatedLines).size < repeatedLines.length) {
    issues.push({
      kind: 'unnecessary_repetition',
      severity: 'repair',
      intentId: null,
      detail: 'Reply repeats the same substantive line.',
    });
  }
  const coverage =
    packet.intents.length === 0 ? 1 : covered.length / packet.intents.length;
  const targetPreservation =
    packet.intents.length === 0 ? 1 : preserved.length / packet.intents.length;
  const truthfulness = issues.some(
    (issue) => issue.kind === 'unsupported_completion',
  )
    ? 0
    : 1;
  const approvalCorrectness = issues.some(
    (issue) => issue.kind === 'approval_boundary',
  )
    ? 0
    : 1;
  const continuity = issues.some(
    (issue) => issue.kind === 'follow_through_missing',
  )
    ? 0
    : 1;
  const repetition = issues.some(
    (issue) => issue.kind === 'unnecessary_repetition',
  )
    ? 0
    : 1;
  const calibration = issues.some((issue) =>
    ['contradiction_undisclosed', 'stale_memory_misuse'].includes(issue.kind),
  )
    ? 0
    : 1;
  const partialFailureHonesty = issues.some(
    (issue) => issue.kind === 'partial_failure_hidden',
  )
    ? 0
    : 1;
  const evidenceCoverage = issues.some(
    (issue) => issue.kind === 'evidence_missing',
  )
    ? 0
    : 1;
  const score = Math.round(
    100 *
      (0.25 * coverage +
        0.15 * targetPreservation +
        0.2 * truthfulness +
        0.15 * approvalCorrectness +
        0.08 * continuity +
        0.02 * repetition +
        0.08 * calibration +
        0.04 * partialFailureHonesty +
        0.03 * evidenceCoverage),
  );
  const status = issues.some((issue) => issue.severity === 'block')
    ? 'block'
    : issues.length > 0
      ? 'repair'
      : 'pass';
  return {
    status,
    score,
    coveredIntentIds: covered.map((intent) => intent.intentId),
    missedIntentIds: packet.intents
      .filter((intent) => !covered.includes(intent))
      .map((intent) => intent.intentId),
    preservedTargetIds: preserved.map((intent) => intent.intentId),
    issues,
    metrics: {
      intentCoverage: clamp01(coverage),
      targetPreservation: clamp01(targetPreservation),
      truthfulness,
      approvalCorrectness,
      continuity,
      repetition,
      calibration,
      partialFailureHonesty,
      evidenceCoverage,
    },
    invariantResults: {
      noExecutionAuthority: packet.executionAuthority === false,
      noPrivacyViolation: !issues.some(
        (issue) => issue.kind === 'privacy_violation',
      ),
      noUnsupportedCompletion: !issues.some(
        (issue) => issue.kind === 'unsupported_completion',
      ),
      allOriginalClausesRetained: packet.intents.every(
        (intent) => intent.originalClause.length > 0,
      ),
    },
    evaluatedChars: reply.length,
  };
}

function neutralizeUnsupportedCompletion(text: string): string {
  return text
    .replace(
      /\bI(?:'ve| have)?\s+(sent|scheduled|booked|created|added|moved|rescheduled|cancelled|canceled|deleted|updated|fixed|implemented|committed|pushed|deployed|restarted|purchased|ordered)\b/gi,
      'I do not yet have verified evidence that I $1',
    )
    .replace(
      /\b(?:done|completed successfully|all set)\b/gi,
      'not yet verified complete',
    );
}

/** At most one text-only repair. This function cannot invoke a tool. */
export function repairGroundedResponse(
  packet: GroundedDeliberationPacket,
  replyText: string,
  evaluation = evaluateGroundedResponse(packet, replyText),
): GroundedResponseRepairResult {
  if (evaluation.status === 'pass')
    return {
      text: replyText,
      applied: false,
      attempts: 0,
      reason: 'pass',
      evaluation,
    };
  if (evaluation.issues.some((issue) => issue.kind === 'privacy_violation')) {
    const safeSubject = packet.intents
      .flatMap((intent) => intent.keywords)
      .filter(
        (word) =>
          !/^(?:api|key|password|secret|token|credential|abc\d*)$/i.test(word),
      )
      .slice(0, 4)
      .join(' ');
    const text =
      packet.recommendedPosture === 'stop_safely'
        ? 'I will not post the secret credential publicly. I stopped and have not taken any external action.'
        : `I removed sensitive credential material from the draft. I have not yet provided a safe answer${safeSubject ? ` about ${safeSubject}` : ''}, and I have not taken any external action.`;
    return {
      text,
      applied: true,
      attempts: 1,
      reason: 'privacy_safe_fallback',
      evaluation: evaluateGroundedResponse(packet, text),
    };
  }
  let text = neutralizeUnsupportedCompletion(replyText).trim();
  const additions: string[] = [];
  const missing = packet.intents.filter((intent) =>
    evaluation.missedIntentIds.includes(intent.intentId),
  );
  for (const intent of missing)
    additions.push(
      `I have not yet addressed ${intent.target}; ${intent.normalizedObjective}`,
    );
  const targetMissing = packet.intents.filter((intent) =>
    evaluation.issues.some(
      (issue) =>
        issue.kind === 'target_missing' && issue.intentId === intent.intentId,
    ),
  );
  for (const intent of targetMissing)
    additions.push(
      `For ${intent.target}, I have not yet established a complete grounded answer.`,
    );
  if (evaluation.issues.some((issue) => issue.kind === 'approval_boundary'))
    additions.push(
      `I need your explicit approval for the exact external change before it can run; this response does not grant or consume that approval.`,
    );
  if (
    evaluation.issues.some(
      (issue) => issue.kind === 'contradiction_undisclosed',
    )
  )
    additions.push(
      `The available context is uncertain or contradictory, so I am not treating it as verified fact.`,
    );
  if (
    evaluation.issues.some((issue) => issue.kind === 'partial_failure_hidden')
  )
    additions.push(
      `A blocker remains: ${packet.blockers.join('; ')}. I cannot describe the overall request as complete.`,
    );
  if (
    evaluation.issues.some((issue) => issue.kind === 'follow_through_missing')
  )
    additions.push(
      `I am preserving the active follow-through context: ${packet.commitments.join('; ')}.`,
    );
  if (
    evaluation.issues.some((issue) => issue.kind === 'unnecessary_repetition')
  ) {
    const seen = new Set<string>();
    text = text
      .split(/\n+/)
      .filter((line) => {
        const key = line.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('\n');
  }
  if (additions.length > 0)
    text = [text, ...unique(additions)].filter(Boolean).join('\n\n');
  const repaired = evaluateGroundedResponse(packet, text);
  if (repaired.status === 'block') {
    text = `I cannot safely claim completion from the available evidence. ${packet.responseContract.nextUserDecision || 'I need the missing verification or clarification before proceeding.'}`;
    return {
      text,
      applied: true,
      attempts: 1,
      reason: 'authority_safe_fallback',
      evaluation: evaluateGroundedResponse(packet, text),
    };
  }
  return {
    text,
    applied: text !== replyText,
    attempts: 1,
    reason: evaluation.issues.map((issue) => issue.kind).join(','),
    evaluation: repaired,
  };
}

export function formatGroundedDeliberationGuidance(
  packet: GroundedDeliberationPacket,
): string {
  const lines = [
    `Grounded advisory packet ${packet.packetId} (${packet.mode}; no execution authority).`,
    `Posture: ${packet.recommendedPosture}. Address ${packet.intents.length} intent(s) in order.`,
    ...packet.intents.map(
      (intent) =>
        `${intent.ordinal + 1}. ${intent.normalizedObjective} [target=${intent.target}; ${intent.mutability}; route=${intent.supportedRoute || 'unsupported'}]`,
    ),
    ...(packet.contradictions.length
      ? [`Disclose contradictions: ${packet.contradictions.join('; ')}`]
      : []),
    ...(packet.unknowns.length
      ? [`Disclose uncertainty: ${packet.unknowns.join('; ')}`]
      : []),
    ...(packet.responseContract.approvalBoundaries.length
      ? [
          `Approval boundaries: ${packet.responseContract.approvalBoundaries.join('; ')}`,
        ]
      : []),
    `Prohibited claims: ${packet.responseContract.prohibitedClaims.join('; ')}`,
  ];
  return bounded(lines.join('\n'), GROUNDED_RESPONSE_MAX_GUIDANCE_CHARS);
}

export function groundedResponseDiagnostics(
  packet: GroundedDeliberationPacket,
  evaluation?: GroundedResponseEvaluation | null,
): Record<string, unknown> {
  return {
    version: packet.version,
    packetId: packet.packetId,
    turnId: packet.turnId,
    mode: packet.mode,
    executionAuthority: packet.executionAuthority,
    believedIntents: packet.intents.map((intent) => ({
      ordinal: intent.ordinal,
      objective: intent.normalizedObjective,
      target: intent.target,
      actionClass: intent.actionClass,
      mutability: intent.mutability,
      route: intent.supportedRoute,
    })),
    evidenceRefs: packet.selectedEvidence.map((item) => ({
      ref: item.ref,
      source: item.source,
      epistemicStatus: item.epistemicStatus,
      mayStateAsFact: item.mayStateAsFact,
    })),
    excludedEvidence: packet.excludedEvidence,
    commitments: packet.commitments,
    contradictions: packet.contradictions,
    unknowns: packet.unknowns,
    blockers: packet.blockers,
    posture: packet.recommendedPosture,
    prohibitedClaims: packet.responseContract.prohibitedClaims,
    budgets: packet.budgets,
    evaluation: evaluation
      ? {
          status: evaluation.status,
          score: evaluation.score,
          issues: evaluation.issues,
          metrics: evaluation.metrics,
          invariants: evaluation.invariantResults,
        }
      : null,
  };
}
