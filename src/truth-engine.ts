import { createHash } from 'node:crypto';

import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import { buildLogicKernelReport } from './logic-kernel.js';
import { redactCouncilText } from './council-safety.js';
import {
  listTruthAnswerAudits,
  listTruthClaims,
  listTruthContradictionChecks,
  listTruthEvidenceSupport,
  listTruthRewriteDirectives,
  listTruthSourceCoverage,
  upsertTruthAnswerAudit,
  upsertTruthClaim,
  upsertTruthContradictionCheck,
  upsertTruthEvidenceSupport,
  upsertTruthRewriteDirective,
  upsertTruthSourceCoverage,
} from './db.js';
import type {
  AgentOSReport,
  LogicEvidenceFreshness,
  LogicKernelReport,
  LogicReconciliationReport,
  TruthAnswerAudit,
  TruthCalibrationVerdict,
  TruthClaim,
  TruthClaimKind,
  TruthContradictionCheck,
  TruthEngineReport,
  TruthEvidenceSupport,
  TruthRewriteDirective,
  TruthSourceCoverage,
  TruthSupportGrade,
  TruthVerdict,
} from './types.js';

export interface RunTruthEngineInput {
  text: string;
  turnId?: string | null;
  channel?: string | null;
  taskFamily?: string | null;
  subject?: string | null;
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  blockerClass?: string | null;
  logicReport?: LogicKernelReport | null;
  logicReconciliation?: LogicReconciliationReport | null;
  agentOSReport?: AgentOSReport | null;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  generatedAt?: string;
  persist?: boolean;
}

interface EvidenceCandidate {
  evidenceId: string;
  evidenceKind: TruthEvidenceSupport['evidenceKind'];
  summary: string;
  freshness: LogicEvidenceFreshness | 'unknown';
  strength: number;
  sourceClass: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(value ?? null);
    return redactCouncilText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            summary: json.slice(0, limit - 80),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
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
  return safeJson({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    rawToolOutputStored: false,
    secretsRedacted: true,
  });
}

function privacyReport(): TruthVerdict['privacy'] {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\p{L}\p{N}\s:+_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): Set<string> {
  const ignored = new Set([
    'the',
    'and',
    'but',
    'that',
    'this',
    'with',
    'from',
    'your',
    'have',
    'has',
    'are',
    'was',
    'were',
    'will',
    'can',
    'for',
    'not',
    'need',
    'needs',
    'right',
    'now',
    'current',
    'currently',
  ]);
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  );
}

function overlapScore(a: string, b: string): number {
  const aTokens = tokens(a);
  const bTokens = tokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(aTokens.size, bTokens.size);
}

function textShape(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  const words = trimmed.split(/\s+/).length;
  const hasQuestion = /\?|\b(what|when|why|how|should|can|do)\b/i.test(trimmed);
  const hasApproval =
    /\b(send|sent|delete|deleted|create|created|commit|push|change|changed)\b/i.test(
      trimmed,
    );
  return `${words}_words:${hasQuestion ? 'question' : 'statement'}:${hasApproval ? 'approval_adjacent' : 'read_only'}`;
}

function summarizeClaimText(input: {
  text: string;
  channel?: string | null;
  taskFamily?: string | null;
}): string {
  if (input.channel === 'bluebubbles' || input.taskFamily === 'communication') {
    return `Communication answer claim withheld; shape=${textShape(input.text)}.`;
  }
  return redactCouncilText(input.text.replace(/\s+/g, ' ').trim(), 360);
}

function classifyClaimKind(text: string): TruthClaimKind {
  const lower = text.toLowerCase();
  if (
    /^(?:here|this|that)\s+(?:is|are)\b.*\b(plan|summary|answer|draft|reply)\b/.test(
      lower,
    )
  ) {
    return 'unknown';
  }
  if (
    /\b(sent|deleted|created|changed|committed|pushed|scheduled)\b/.test(lower)
  ) {
    return 'approval_action';
  }
  if (
    /\b(calendar|meeting|event|free|available|busy|tomorrow|today)\b/.test(
      lower,
    )
  ) {
    return 'calendar_certainty';
  }
  if (
    /\b(provider|openai|gemini|anthropic|claude|minimax|brave|healthy|quota|participated)\b/.test(
      lower,
    )
  ) {
    return 'provider_participation';
  }
  if (
    /\b(bluebubbles|alexa|telegram|proof|live[_ -]?proven|webhook)\b/.test(
      lower,
    )
  ) {
    return 'integration_proof';
  }
  if (/\b(remember|memory|profile|preference|learned)\b/.test(lower)) {
    return 'memory_fact';
  }
  if (/\b(source|research|citation|according|evidence|latest)\b/.test(lower)) {
    return 'research_claim';
  }
  if (
    /\b(is|are|has|have|shows|means|because|requires|blocked|working)\b/.test(
      lower,
    )
  ) {
    return 'answer_claim';
  }
  return 'unknown';
}

function splitClaimSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const factual = sentences.filter(
    (sentence) => classifyClaimKind(sentence) !== 'unknown',
  );
  return factual.slice(0, 8);
}

function evidenceIdsFromLogicClaim(
  claim: LogicKernelReport['claims'][number],
): string[] {
  return Array.from(
    new Set([
      claim.claimId,
      ...parseJsonArray(claim.evidenceIdsJson),
      ...(claim.sourceEpisodeId ? [claim.sourceEpisodeId] : []),
      ...(claim.sourceRunId ? [claim.sourceRunId] : []),
    ]),
  ).slice(0, 20);
}

function collectEvidenceCandidates(
  input: RunTruthEngineInput,
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  const logicReport = input.logicReport;
  if (logicReport) {
    for (const claim of logicReport.claims) {
      const evidenceIds = evidenceIdsFromLogicClaim(claim);
      candidates.push({
        evidenceId: claim.claimId,
        evidenceKind: 'logic_claim',
        summary: `${claim.predicate}: ${claim.objectSummary}`,
        freshness: claim.status === 'stale' ? 'stale' : 'recent',
        strength: claim.confidence,
        sourceClass: claim.claimKind,
      });
      for (const evidenceId of evidenceIds) {
        candidates.push({
          evidenceId,
          evidenceKind: 'logic_evidence',
          summary: `${claim.predicate}: ${claim.objectSummary}`,
          freshness: claim.status === 'stale' ? 'stale' : 'recent',
          strength: claim.confidence,
          sourceClass: claim.claimKind,
        });
      }
    }
    for (const link of logicReport.evidenceLinks) {
      candidates.push({
        evidenceId: link.evidenceId,
        evidenceKind: 'logic_evidence',
        summary: link.summary,
        freshness: link.freshness,
        strength: link.strength,
        sourceClass: link.evidenceKind,
      });
    }
  }
  if (input.agentOSReport?.latestEpisode) {
    const episode = input.agentOSReport.latestEpisode;
    const staleEpisode =
      episode.status === 'abandoned' ||
      episode.status === 'interrupted' ||
      episode.status === 'blocked';
    candidates.push({
      evidenceId: episode.episodeId,
      evidenceKind: 'agent_os_episode',
      summary: episode.goalSummary,
      freshness: staleEpisode ? 'stale' : 'recent',
      strength: 0.74,
      sourceClass: 'agent_os_episode',
    });
  }
  const councilEvidence =
    input.providerCouncil?.structuredVerdict?.evidenceIds || [];
  for (const evidenceId of councilEvidence) {
    candidates.push({
      evidenceId,
      evidenceKind: 'council_evidence',
      summary: 'Council structured verdict evidence ID.',
      freshness: 'recent',
      strength: input.providerCouncil?.structuredVerdict?.confidence || 0.58,
      sourceClass: 'council',
    });
  }
  if (input.providerCouncil?.structuredVerdict?.providerParticipation) {
    candidates.push({
      evidenceId: hashId(
        'truth:provider_participation',
        JSON.stringify(
          input.providerCouncil.structuredVerdict.providerParticipation,
        ),
      ),
      evidenceKind: 'provider_health',
      summary: 'Council provider participation metadata is available.',
      freshness: 'recent',
      strength: 0.7,
      sourceClass: 'provider_health',
    });
  }
  return candidates;
}

function supportGradeFor(
  claimText: string,
  evidence: EvidenceCandidate[],
): {
  grade: TruthSupportGrade;
  evidence: EvidenceCandidate[];
  confidence: number;
} {
  const matches = evidence
    .map((candidate) => ({
      candidate,
      score: Math.max(
        overlapScore(claimText, candidate.summary),
        overlapScore(claimText, candidate.evidenceId),
      ),
    }))
    .filter((match) => match.score >= 0.16)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (
    matches.some(
      (match) =>
        match.candidate.freshness === 'stale' ||
        match.candidate.freshness === 'expired',
    )
  ) {
    return {
      grade: 'stale',
      evidence: matches.map((match) => match.candidate),
      confidence: 0.48,
    };
  }
  const strong = matches.filter((match) => match.score >= 0.38);
  if (strong.length > 0) {
    return {
      grade: 'supported',
      evidence: strong.map((match) => match.candidate),
      confidence: clamp01(0.72 + strong[0].candidate.strength * 0.18),
    };
  }
  if (matches.length > 0) {
    return {
      grade: 'partial',
      evidence: matches.map((match) => match.candidate),
      confidence: 0.58,
    };
  }
  return { grade: 'unsupported', evidence: [], confidence: 0.34 };
}

function hasApprovalOverreach(text: string): boolean {
  return /\b(done|sent|deleted|created|changed|committed|pushed|scheduled|booked)\b/i.test(
    text,
  );
}

function hasCalendarOvercertainty(text: string): boolean {
  return /\b(?:calendar is clear|your calendar is clear|nothing is on your calendar|you have nothing on your calendar|you have no events|you have no meetings|you're free|you are free|you look free|wide open)\b/i.test(
    text,
  );
}

function hasProviderFakeParticipation(
  input: RunTruthEngineInput,
  claimText: string,
): boolean {
  if (
    !/\b(openai|gemini|anthropic|claude|minimax|brave|providers?|models?)\b/i.test(
      claimText,
    )
  ) {
    return false;
  }
  if (
    !/\bchecked|used|participated|verified|all models|all providers|healthy\b/i.test(
      claimText,
    )
  ) {
    return false;
  }
  const participation =
    input.providerCouncil?.structuredVerdict?.providerParticipation;
  if (!participation) return true;
  const usable =
    participation.roles?.filter((role) => role.action !== 'skipped').length ||
    input.providerCouncil?.structuredVerdict?.usableMemberCount ||
    0;
  const blocked =
    participation.roles?.filter((role) => role.action === 'skipped').length ||
    input.providerCouncil?.structuredVerdict?.blockedMemberCount ||
    0;
  return (
    /\ball (?:models|providers)\b/i.test(claimText) && blocked > 0 && usable < 4
  );
}

function buildClaim(input: {
  auditId: string;
  sentence: string;
  channel?: string | null;
  taskFamily?: string | null;
  now: string;
  evidence: EvidenceCandidate[];
  engineInput: RunTruthEngineInput;
}): TruthClaim {
  const kind = classifyClaimKind(input.sentence);
  const support = supportGradeFor(input.sentence, input.evidence);
  const riskFlags = [
    ...(kind === 'approval_action' && hasApprovalOverreach(input.sentence)
      ? ['approval_action_claim']
      : []),
    ...(kind === 'calendar_certainty' &&
    hasCalendarOvercertainty(input.sentence)
      ? ['calendar_overcertainty']
      : []),
    ...(hasProviderFakeParticipation(input.engineInput, input.sentence)
      ? ['fake_provider_participation']
      : []),
  ];
  const grade: TruthSupportGrade = riskFlags.includes(
    'fake_provider_participation',
  )
    ? 'unsupported'
    : support.grade;
  const claimText = summarizeClaimText({
    text: input.sentence,
    channel: input.channel,
    taskFamily: input.taskFamily,
  });
  return {
    claimId: hashId('truth:claim', `${input.auditId}|${input.sentence}`),
    auditId: input.auditId,
    createdAt: input.now,
    claimText,
    normalizedText: normalizeText(claimText),
    claimKind: kind,
    confidence: riskFlags.length
      ? Math.min(0.52, support.confidence)
      : support.confidence,
    supportGrade: grade,
    evidenceIdsJson: safeJson(
      support.evidence.map((candidate) => candidate.evidenceId),
      2400,
    ),
    riskFlagsJson: safeJson(riskFlags, 1200),
    privacyJson: privacyJson(),
  };
}

function buildEvidenceSupports(
  auditId: string,
  claim: TruthClaim,
  candidates: EvidenceCandidate[],
): TruthEvidenceSupport[] {
  const candidateIds = new Set(parseJsonArray(claim.evidenceIdsJson));
  return candidates
    .filter((candidate) => candidateIds.has(candidate.evidenceId))
    .slice(0, 8)
    .map((candidate) => ({
      supportId: hashId(
        'truth:support',
        `${auditId}|${claim.claimId}|${candidate.evidenceId}`,
      ),
      auditId,
      claimId: claim.claimId,
      evidenceId: candidate.evidenceId,
      evidenceKind: candidate.evidenceKind,
      support:
        candidate.freshness === 'stale' || candidate.freshness === 'expired'
          ? 'stale'
          : 'supports',
      strength: clamp01(candidate.strength),
      freshness: candidate.freshness,
      summary: redactCouncilText(candidate.summary, 640),
      privacyJson: privacyJson(),
    }));
}

function contradictionCheckFor(input: {
  auditId: string;
  claim: TruthClaim;
  logicReport?: LogicKernelReport | null;
  reconciliation?: LogicReconciliationReport | null;
}): TruthContradictionCheck {
  const direct = input.logicReport?.contradictions || [];
  const unresolved = input.reconciliation?.unresolvedContradictions || [];
  const contradictionIds = Array.from(
    new Set([
      ...direct.map((item) => item.contradictionId),
      ...unresolved.map((item) => item.contradictionId),
    ]),
  );
  const high = [...direct, ...unresolved].some(
    (item) => item.severity === 'high',
  );
  const certainLanguage =
    /\b(definitely|certainly|no doubt|guaranteed|for sure)\b/i.test(
      input.claim.claimText,
    );
  const status: TruthContradictionCheck['status'] =
    contradictionIds.length === 0
      ? 'none'
      : certainLanguage
        ? 'open'
        : 'uncertain';
  return {
    checkId: hashId(
      'truth:contradiction',
      `${input.auditId}|${input.claim.claimId}`,
    ),
    auditId: input.auditId,
    claimId: input.claim.claimId,
    status,
    severity:
      high || status === 'open'
        ? 'high'
        : contradictionIds.length
          ? 'medium'
          : 'low',
    contradictionIdsJson: safeJson(contradictionIds, 2400),
    summary:
      status === 'none'
        ? 'No active logic contradiction matched this claim.'
        : 'Logic metadata has active or unresolved contradiction IDs; certainty must be lowered.',
    privacyJson: privacyJson(),
  };
}

function sourceCoverageFor(input: {
  auditId: string;
  now: string;
  claims: TruthClaim[];
  supports: TruthEvidenceSupport[];
  engineInput: RunTruthEngineInput;
}): TruthSourceCoverage {
  const sourceIds = Array.from(
    new Set(input.supports.map((support) => support.evidenceId)),
  ).slice(0, 80);
  const staleSourceIds = input.supports
    .filter(
      (support) =>
        support.freshness === 'stale' || support.freshness === 'expired',
    )
    .map((support) => support.evidenceId);
  const taskFamily = input.engineInput.taskFamily || 'unknown';
  const missing: string[] = [];
  if (
    taskFamily === 'calendar' &&
    !sourceIds.some((id) => /calendar|event|agent_os|logic/i.test(id))
  ) {
    missing.push('fresh_calendar_read');
  }
  if (
    taskFamily === 'research' &&
    !sourceIds.some((id) => /source|brave|council|logic/i.test(id))
  ) {
    missing.push('source_attribution');
  }
  if (input.claims.some((claim) => claim.supportGrade === 'unsupported')) {
    missing.push('claim_support');
  }
  const coverageGrade: TruthSourceCoverage['coverageGrade'] =
    sourceIds.length >= 4 && missing.length === 0
      ? 'strong'
      : sourceIds.length >= 1 && missing.length <= 1
        ? 'partial'
        : sourceIds.length >= 1
          ? 'weak'
          : 'none';
  return {
    sourceCoverageId: hashId('truth:coverage', input.auditId),
    auditId: input.auditId,
    createdAt: input.now,
    coverageGrade,
    sourceIdsJson: safeJson(sourceIds, 3200),
    staleSourceIdsJson: safeJson(staleSourceIds, 2400),
    missingSourceClassesJson: safeJson(Array.from(new Set(missing)), 2400),
    providerParticipationJson: safeJson(
      input.engineInput.providerCouncil?.structuredVerdict
        ?.providerParticipation || {},
      2400,
    ),
    integrationProofJson: safeJson(
      {
        blockerClass: input.engineInput.blockerClass || null,
        responseSource: input.engineInput.responseSource || null,
        taskFamily,
      },
      2400,
    ),
    privacyJson: privacyJson(),
  };
}

function aggregateSupportGrade(claims: TruthClaim[]): TruthSupportGrade {
  if (claims.some((claim) => claim.supportGrade === 'contradicted'))
    return 'contradicted';
  if (claims.some((claim) => claim.supportGrade === 'unsupported'))
    return 'unsupported';
  if (claims.some((claim) => claim.supportGrade === 'stale')) return 'stale';
  if (claims.some((claim) => claim.supportGrade === 'partial'))
    return 'partial';
  return 'supported';
}

function rewriteFor(input: {
  text: string;
  claims: TruthClaim[];
  checks: TruthContradictionCheck[];
  coverage: TruthSourceCoverage;
  logicReport?: LogicKernelReport | null;
  taskFamily?: string | null;
}): {
  text: string;
  directive: TruthRewriteDirective['directive'];
  reason: string;
  nextAction: string;
  status: TruthCalibrationVerdict['status'];
} {
  const claimRiskFlags = input.claims.flatMap((claim) =>
    parseJsonArray(claim.riskFlagsJson),
  );
  if (
    /sk-|AIza|Bearer\s+|chain-of-thought|raw private body|raw message body/i.test(
      input.text,
    )
  ) {
    return {
      text: 'I need to answer without exposing private material.',
      directive: 'block',
      reason: 'Privacy leakage detected in draft answer.',
      nextAction: 'Regenerate with metadata-only evidence.',
      status: 'block',
    };
  }
  if (claimRiskFlags.includes('approval_action_claim')) {
    return {
      text: input.text.replace(
        /\b(done|sent|deleted|created|changed|committed|pushed|scheduled|booked)\b/gi,
        'staged for approval',
      ),
      directive: 'stage_approval',
      reason:
        'Draft claimed an approval-gated action was completed without proof.',
      nextAction:
        'Stage the action for explicit approval or cite the completed proof.',
      status: 'block',
    };
  }
  if (claimRiskFlags.includes('fake_provider_participation')) {
    return {
      text: `I cannot say every provider participated from the current proof. ${input.text}`,
      directive: 'caveat',
      reason:
        'Provider participation claim exceeded available provider metadata.',
      nextAction: 'Report degraded provider participation honestly.',
      status: 'warn',
    };
  }
  if (claimRiskFlags.includes('calendar_overcertainty')) {
    return {
      text: input.text
        .replace(
          /\b(?:your calendar is clear|nothing is on your calendar|you have nothing on your calendar|you're wide open|you are wide open)\b/gi,
          "I don't see anything in the calendar evidence I checked",
        )
        .replace(
          /\b(?:you're free|you are free|you look free)\b/gi,
          "I don't see anything",
        ),
      directive: 'caveat',
      reason:
        'Calendar answer used high-certainty wording without fresh proof.',
      nextAction:
        'Use fresh calendar read proof before stating availability strongly.',
      status: 'warn',
    };
  }
  if (input.checks.some((check) => check.status === 'open')) {
    return {
      text: input.text.replace(
        /\b(definitely|certainly|no doubt|guaranteed|for sure)\b/gi,
        'based on the current evidence',
      ),
      directive: 'caveat',
      reason: 'Draft used certainty while unresolved contradictions exist.',
      nextAction: 'Name uncertainty or gather fresher evidence.',
      status: 'warn',
    };
  }
  if (input.claims.some((claim) => claim.supportGrade === 'unsupported')) {
    const question = input.logicReport?.missingPremises[0]?.question;
    if (question && input.text.includes(question)) {
      return {
        text: input.text,
        directive: 'none',
        reason: 'Missing premise is already visible in the draft answer.',
        nextAction: question,
        status: 'warn',
      };
    }
    return {
      text: question
        ? `${input.text}\n\nBefore I treat that as certain: ${question}`
        : `I only have partial support for that. ${input.text}`,
      directive: question ? 'clarify' : 'caveat',
      reason: 'At least one answer claim lacks a matching evidence ID.',
      nextAction:
        question || 'Gather one more evidence source before stronger wording.',
      status: question ? 'clarify' : 'warn',
    };
  }
  if (input.claims.length > 0 && input.coverage.coverageGrade === 'none') {
    return {
      text: `I do not have enough current evidence to state that confidently. ${input.text}`,
      directive: 'caveat',
      reason: 'No source coverage was available for the answer.',
      nextAction:
        'Run a read-only evidence check or ask one clarifying question.',
      status: 'warn',
    };
  }
  return {
    text: input.text,
    directive: 'none',
    reason: 'Truth Engine found answer wording aligned with current evidence.',
    nextAction:
      input.logicReport?.selectedNextAction ||
      'Answer directly with the best next action.',
    status: 'pass',
  };
}

function persistTruth(input: TruthVerdict): void {
  try {
    upsertTruthAnswerAudit(input.audit);
    for (const claim of input.claims) upsertTruthClaim(claim);
    for (const support of input.evidenceSupports)
      upsertTruthEvidenceSupport(support);
    for (const check of input.contradictionChecks)
      upsertTruthContradictionCheck(check);
    for (const directive of input.rewriteDirectives) {
      upsertTruthRewriteDirective(directive);
    }
    upsertTruthSourceCoverage(input.sourceCoverage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/reading 'prepare'|reading "prepare"|database is not initialized/i.test(
        message,
      )
    ) {
      throw error;
    }
  }
}

export function runTruthEngine(input: RunTruthEngineInput): TruthVerdict {
  const generatedAt = input.generatedAt || nowIso();
  const subject = redactCouncilText(
    input.subject ||
      input.logicReport?.subject ||
      input.agentOSReport?.latestEpisode?.goalSummary ||
      'Andrea answer truth audit',
    320,
  );
  const auditId = hashId(
    'truth:audit',
    `${input.turnId || subject}|${generatedAt}|${normalizeText(input.text).slice(0, 160)}`,
  );
  const evidenceCandidates = collectEvidenceCandidates(input);
  const sentences = splitClaimSentences(input.text);
  const claims = sentences.map((sentence) =>
    buildClaim({
      auditId,
      sentence,
      channel: input.channel,
      taskFamily: input.taskFamily,
      now: generatedAt,
      evidence: evidenceCandidates,
      engineInput: input,
    }),
  );
  const evidenceSupports = claims.flatMap((claim) =>
    buildEvidenceSupports(auditId, claim, evidenceCandidates),
  );
  const contradictionChecks = claims.map((claim) =>
    contradictionCheckFor({
      auditId,
      claim,
      logicReport: input.logicReport,
      reconciliation: input.logicReconciliation,
    }),
  );
  const sourceCoverage = sourceCoverageFor({
    auditId,
    now: generatedAt,
    claims,
    supports: evidenceSupports,
    engineInput: input,
  });
  const rewrite = rewriteFor({
    text: input.text,
    claims,
    checks: contradictionChecks,
    coverage: sourceCoverage,
    logicReport: input.logicReport,
    taskFamily: input.taskFamily,
  });
  const rewriteDirective: TruthRewriteDirective = {
    directiveId: hashId(
      'truth:rewrite',
      `${auditId}|${rewrite.directive}|${rewrite.reason}`,
    ),
    auditId,
    createdAt: generatedAt,
    directive: rewrite.directive,
    reason: redactCouncilText(rewrite.reason, 640),
    suggestedText:
      rewrite.text !== input.text
        ? redactCouncilText(
            `${textShape(rewrite.text)}; rewritten by Truth Engine.`,
            640,
          )
        : null,
    nextAction: redactCouncilText(rewrite.nextAction, 640),
    privacyJson: privacyJson(),
  };
  const supportGrade = aggregateSupportGrade(claims);
  const riskFlags = Array.from(
    new Set([
      ...claims.flatMap((claim) => parseJsonArray(claim.riskFlagsJson)),
      ...(claims.length > 0 && sourceCoverage.coverageGrade === 'none'
        ? ['no_source_coverage']
        : []),
      ...contradictionChecks
        .filter((check) => check.status === 'open')
        .map(() => 'open_contradiction'),
    ]),
  );
  const unsupportedClaimIds = claims
    .filter((claim) => claim.supportGrade === 'unsupported')
    .map((claim) => claim.claimId);
  const confidence = clamp01(
    (claims.length
      ? claims.reduce((sum, claim) => sum + claim.confidence, 0) / claims.length
      : 0.5) -
      unsupportedClaimIds.length * 0.12 -
      riskFlags.length * 0.08,
  );
  const calibration: TruthCalibrationVerdict = {
    status: rewrite.status,
    supportGrade,
    confidence,
    clarificationNeeded: rewrite.directive === 'clarify',
    approvalBlocked: rewrite.directive === 'stage_approval',
    flags: riskFlags.length ? riskFlags : ['truth_supported'],
    summary:
      rewrite.status === 'pass'
        ? 'Truth Engine found the answer calibrated to current evidence.'
        : `Truth Engine applied ${rewrite.directive}: ${rewrite.reason}`,
  };
  const audit: TruthAnswerAudit = {
    auditId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    turnId: input.turnId || null,
    channel: input.channel || null,
    taskFamily: input.taskFamily || null,
    subject,
    status: calibration.status,
    confidence,
    supportGrade,
    claimIdsJson: safeJson(
      claims.map((claim) => claim.claimId),
      2400,
    ),
    unsupportedClaimIdsJson: safeJson(unsupportedClaimIds, 2400),
    contradictionCheckIdsJson: safeJson(
      contradictionChecks.map((check) => check.checkId),
      2400,
    ),
    rewriteDirectiveIdsJson: safeJson([rewriteDirective.directiveId], 1200),
    evidenceIdsJson: safeJson(
      Array.from(
        new Set(evidenceSupports.map((support) => support.evidenceId)),
      ),
      3200,
    ),
    riskFlagsJson: safeJson(riskFlags, 2400),
    verdictSummary: redactCouncilText(calibration.summary, 640),
    rewrittenTextSummary: redactCouncilText(
      `${textShape(rewrite.text)}; raw answer text not stored.`,
      640,
    ),
    bestNextAction: redactCouncilText(rewrite.nextAction, 640),
    privacyJson: privacyJson(),
  };
  const verdict: TruthVerdict = {
    generatedAt,
    audit,
    claims,
    evidenceSupports,
    contradictionChecks,
    rewriteDirectives: [rewriteDirective],
    sourceCoverage,
    calibration,
    rewrittenText: rewrite.text,
    bestNextAction: rewrite.nextAction,
    summary: calibration.summary,
    privacy: privacyReport(),
  };
  if (input.persist !== false) persistTruth(verdict);
  return verdict;
}

export function buildTruthEngineReport(
  params: {
    subject?: string | null;
    auditId?: string | null;
    generatedAt?: string;
  } = {},
): TruthEngineReport {
  const generatedAt = params.generatedAt || nowIso();
  const audits = listTruthAnswerAudits({
    subject: params.subject || undefined,
    limit: 20,
  });
  const latestAudit =
    (params.auditId
      ? audits.find((audit) => audit.auditId === params.auditId)
      : audits[0]) || null;
  if (!latestAudit) {
    const logicReport = buildLogicKernelReport({
      subject: params.subject || undefined,
      generatedAt,
    });
    const seeded = runTruthEngine({
      text: 'Current answer support depends on the Logic Kernel report and may need one more evidence source.',
      subject: logicReport.subject,
      logicReport,
      generatedAt,
    });
    return {
      generatedAt,
      ok: seeded.calibration.status !== 'block',
      latestAudit: seeded.audit,
      claims: seeded.claims,
      evidenceSupports: seeded.evidenceSupports,
      contradictionChecks: seeded.contradictionChecks,
      rewriteDirectives: seeded.rewriteDirectives,
      sourceCoverage: [seeded.sourceCoverage],
      nextAction: seeded.bestNextAction,
      privacy: seeded.privacy,
    };
  }
  const claims = listTruthClaims({ auditId: latestAudit.auditId, limit: 100 });
  return {
    generatedAt,
    ok: latestAudit.status !== 'block',
    latestAudit,
    claims,
    evidenceSupports: listTruthEvidenceSupport({
      auditId: latestAudit.auditId,
      limit: 100,
    }),
    contradictionChecks: listTruthContradictionChecks({
      auditId: latestAudit.auditId,
      limit: 100,
    }),
    rewriteDirectives: listTruthRewriteDirectives({
      auditId: latestAudit.auditId,
      limit: 50,
    }),
    sourceCoverage: listTruthSourceCoverage({
      auditId: latestAudit.auditId,
      limit: 10,
    }),
    nextAction: latestAudit.bestNextAction,
    privacy: privacyReport(),
  };
}

export function formatTruthEngineReport(report: TruthEngineReport): string {
  const audit = report.latestAudit;
  if (!audit) {
    return 'Truth Engine\n\nNo answer audit exists yet.\n\nPrivacy: metadata-only.';
  }
  const unsupported = report.claims.filter(
    (claim) => claim.supportGrade === 'unsupported',
  );
  const coverage = report.sourceCoverage[0];
  return redactCouncilText(
    [
      'Truth Engine',
      '',
      `Status: ${audit.status}`,
      `Confidence: ${audit.confidence.toFixed(2)}`,
      `Support: ${audit.supportGrade}`,
      `Claims: ${report.claims.length} (${unsupported.length} unsupported)`,
      `Coverage: ${coverage?.coverageGrade || 'unknown'}`,
      `Next: ${audit.bestNextAction}`,
      '',
      'Recent Claim Checks',
      ...report.claims
        .slice(0, 5)
        .map(
          (claim) =>
            `- ${claim.claimKind}: ${claim.supportGrade} (${claim.confidence.toFixed(2)})`,
        ),
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    4000,
  );
}

export function buildTruthStatusText(): string {
  return formatTruthEngineReport(buildTruthEngineReport());
}

export function isTruthNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'why is that true?' ||
    normalized === 'why is that true' ||
    normalized === 'what supports that?' ||
    normalized === 'what supports that' ||
    normalized === 'what could be wrong?' ||
    normalized === 'what could be wrong' ||
    normalized === 'how certain are you?' ||
    normalized === 'how certain are you'
  );
}
