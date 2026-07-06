import crypto from 'crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCognitiveEpisodes,
  pruneCognitiveEpisodes,
  upsertCognitiveEpisode,
  upsertStrategyLearningSignal,
  upsertWorkingMemoryFrame,
} from './db.js';
import type {
  CognitiveEpisodeRecord,
  ControlPlaneChannel,
  ReasoningMode,
  StrategyLearningSignal,
  WorkingMemoryFrame,
} from './types.js';

// ---------------------------------------------------------------------------
// v32 Reflective Episodic Memory
//
// Compact, redacted episode summaries — never raw transcripts. Episodes feed
// working memory, confidence calibration, the action lifecycle, and
// self-improvement hypotheses. Retention is bounded and enforced.
// ---------------------------------------------------------------------------

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  retentionEnforced: true,
});

const SENSITIVE_HINT_RE =
  /\b(health|medical|therapy|password|ssn|bank|salary|diagnos|medication|divorce|legal)\b/i;

const REASONING_MODES = new Set<ReasoningMode>([
  'fast_direct',
  'clarify_first',
  'retrieve_grounded',
  'plan_stepwise',
  'compare_counterfactuals',
  'verify_then_act',
  'deliberate_with_critic',
  'defer_or_handoff',
]);

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function sanitizeEpisodeText(
  value: string | null | undefined,
  limit: number,
): string | null {
  const redacted = redactCouncilText(value ?? '', limit).trim();
  return redacted || null;
}

function normalizeReasoningMode(value: string): ReasoningMode {
  return REASONING_MODES.has(value as ReasoningMode)
    ? (value as ReasoningMode)
    : 'retrieve_grounded';
}

export interface RecordCognitiveEpisodeInput {
  askSummary: string;
  channel: ControlPlaneChannel;
  reasoningMode: string;
  selectedContextSummary?: string;
  result: CognitiveEpisodeRecord['result'];
  goalId?: string | null;
  actionId?: string | null;
  userCorrection?: string | null;
  confidence?: number;
  lesson?: string;
  followUpNeeded?: string | null;
  sensitivity?: CognitiveEpisodeRecord['sensitivity'];
  retentionPolicy?: CognitiveEpisodeRecord['retentionPolicy'];
  now?: string;
  persist?: boolean;
}

export function recordCognitiveEpisode(
  input: RecordCognitiveEpisodeInput,
): CognitiveEpisodeRecord {
  const createdAt = nowIso(input.now);
  const askSummary = (input.askSummary || 'unknown ask')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const sanitizedAskSummary = sanitizeEpisodeText(askSummary, 240);
  const sanitizedCorrection = sanitizeEpisodeText(input.userCorrection, 240);
  const correctionSensitive =
    !!sanitizedCorrection && SENSITIVE_HINT_RE.test(sanitizedCorrection);
  const sensitivity =
    input.sensitivity ??
    (SENSITIVE_HINT_RE.test(askSummary) || correctionSensitive
      ? 'sensitive'
      : 'normal');
  const normalizedReasoningMode = normalizeReasoningMode(input.reasoningMode);
  const retentionPolicy =
    input.retentionPolicy ??
    (sensitivity === 'sensitive' || correctionSensitive
      ? 'short_7d'
      : 'standard_90d');
  const record: CognitiveEpisodeRecord = {
    episodeId: hashId('episode', `${askSummary}|${input.channel}|${createdAt}`),
    createdAt,
    askSummary:
      sensitivity === 'sensitive'
        ? '[sensitive topic redacted]'
        : (sanitizedAskSummary ?? 'unknown ask'),
    channel: input.channel,
    goalId: input.goalId ?? null,
    reasoningMode: normalizedReasoningMode,
    selectedContextSummary: (
      sanitizeEpisodeText(input.selectedContextSummary, 400) ?? 'not recorded'
    ).slice(0, 400),
    actionId: input.actionId ?? null,
    result: input.result,
    userCorrection: correctionSensitive
      ? '[sensitive correction redacted]'
      : sanitizedCorrection,
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
    lesson:
      sanitizeEpisodeText(input.lesson, 400) ?? 'No explicit lesson recorded.',
    followUpNeeded: sanitizeEpisodeText(input.followUpNeeded, 240),
    sensitivity,
    retentionPolicy,
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertCognitiveEpisode(record);
    // Corrections are first-class learning signals. Strategy signals are
    // anchored to a working-memory frame, so the episode registers a minimal
    // metadata-only frame as its anchor.
    if (record.userCorrection) {
      const frameExpiry = new Date(
        new Date(createdAt).getTime() + 24 * 60 * 60 * 1000,
      ).toISOString();
      const anchorFrame: WorkingMemoryFrame = {
        frameId: record.episodeId,
        createdAt,
        updatedAt: createdAt,
        channel: record.channel,
        groupFolder: null,
        chatJid: null,
        threadId: null,
        requestSummary: record.askSummary,
        currentAskSummary: record.askSummary,
        activeGoalId: record.goalId ?? null,
        activeObjectSummary: 'episode correction anchor',
        itemIdsJson: '[]',
        selectedItemIdsJson: '[]',
        ignoredItemIdsJson: '[]',
        recommendedReasoningMode: normalizedReasoningMode,
        confidence: record.confidence,
        expiresAt: frameExpiry,
        staleAfter: frameExpiry,
        privacyJson: PRIVACY_JSON,
      };
      upsertWorkingMemoryFrame(anchorFrame);
      const signal: StrategyLearningSignal = {
        signalId: hashId('strategy', `${record.episodeId}|correction`),
        frameId: record.episodeId,
        createdAt,
        requestFamily: 'other',
        selectedMode: normalizedReasoningMode,
        routeKey: null,
        toolId: null,
        confidence: record.confidence,
        warningKindsJson: JSON.stringify(['user_correction']),
        userResponse: 'corrected',
        outcome: record.result === 'failed' ? 'fail' : 'warn',
        fallbackUsed: false,
        strategyAdjustment: `User corrected: ${record.userCorrection}`,
        improvementHint:
          'Downweight the corrected preference and prefer the corrected behavior next time.',
        privacyJson: PRIVACY_JSON,
      };
      upsertStrategyLearningSignal(signal);
    }
  }
  return record;
}

export function applyEpisodeRetention(params: { now?: string } = {}): number {
  if (!isDatabaseInitialized()) return 0;
  return pruneCognitiveEpisodes({ now: params.now });
}

export interface EpisodeMemoryReport {
  generatedAt: string;
  totalRecent: number;
  corrections: number;
  failures: number;
  followUpsNeeded: number;
  recentLessons: string[];
}

export function buildEpisodeMemoryReport(
  params: { now?: string } = {},
): EpisodeMemoryReport {
  const generatedAt = nowIso(params.now);
  const episodes = isDatabaseInitialized()
    ? listCognitiveEpisodes({ limit: 50 })
    : [];
  return {
    generatedAt,
    totalRecent: episodes.length,
    corrections: episodes.filter((episode) => episode.userCorrection).length,
    failures: episodes.filter((episode) => episode.result === 'failed').length,
    followUpsNeeded: episodes.filter((episode) => episode.followUpNeeded)
      .length,
    recentLessons: episodes
      .filter(
        (episode) =>
          episode.lesson && episode.lesson !== 'No explicit lesson recorded.',
      )
      .slice(0, 5)
      .map((episode) => episode.lesson),
  };
}

export function formatEpisodeMemoryReport(
  report: EpisodeMemoryReport = buildEpisodeMemoryReport(),
): string {
  const lines: string[] = ['*Reflective Episodic Memory*'];
  lines.push(
    `Recent episodes: ${report.totalRecent} (corrections ${report.corrections}, failures ${report.failures}, follow-ups ${report.followUpsNeeded})`,
  );
  if (report.recentLessons.length) {
    lines.push('Recent lessons:');
    for (const lesson of report.recentLessons) {
      lines.push(`- ${lesson}`);
    }
  } else {
    lines.push('No explicit lessons recorded recently.');
  }
  lines.push(
    'Retention: sensitive episodes kept 7 days, standard 90 days, pinned kept until unpinned. Raw transcripts are never stored.',
  );
  return lines.join('\n');
}

export function isEpisodeNaturalRequest(text: string): boolean {
  return /\b(what did you learn|what have you learned|what happened last time|recent lessons|remember (when|what)|what do you remember)\b/i.test(
    text || '',
  );
}

export function formatEpisodeNaturalResponse(_text: string): string {
  const report = buildEpisodeMemoryReport();
  if (!report.totalRecent) {
    return 'I have no recorded episodes yet, so nothing learned to report. As we work together I will keep compact, redacted summaries of what worked and what you corrected.';
  }
  const lines: string[] = [];
  lines.push(
    `From my last ${report.totalRecent} episodes: you corrected me ${report.corrections} time(s) and ${report.failures} attempt(s) failed.`,
  );
  if (report.recentLessons.length) {
    lines.push('What I took away:');
    for (const lesson of report.recentLessons.slice(0, 3)) {
      lines.push(`- ${lesson}`);
    }
  }
  return lines.join('\n');
}
