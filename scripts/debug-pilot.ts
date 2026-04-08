import { initDatabase } from '../src/db.js';
import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';
import {
  buildPilotReviewDigest,
  FLAGSHIP_PILOT_JOURNEYS,
} from '../src/pilot-mode.js';
import type { FieldTrialSurfaceTruth } from '../src/field-trial-readiness.js';
import type { PilotJourneyId } from '../src/types.js';

const JOURNEY_LABELS: Record<PilotJourneyId, string> = {
  ordinary_chat: 'ordinary_chat',
  daily_guidance: 'daily_guidance',
  candace_followthrough: 'candace_followthrough',
  mission_planning: 'mission_planning',
  work_cockpit: 'work_cockpit',
  cross_channel_handoff: 'cross_channel_handoff',
  alexa_orientation: 'alexa_orientation',
};

function formatTimestamp(value: string | null | undefined): string {
  return value || 'none';
}

function formatJourneyHealthLines(
  truth: ReturnType<typeof buildFieldTrialOperatorTruth>,
  review: ReturnType<typeof buildPilotReviewDigest>,
): string[] {
  return FLAGSHIP_PILOT_JOURNEYS.flatMap((journeyId) => {
    const digest = review.journeyDigests[journeyId];
    const journeyTruth = truth.journeys[journeyId];
    const lines = [
      `- ${JOURNEY_LABELS[journeyId]}: ${journeyTruth.proofState} / 24h=${digest.usage24h} / 7d=${digest.usage7d} / last_success=${formatTimestamp(digest.latestSuccessAt)} / freshness=${digest.proofFreshness}`,
    ];
    if (digest.latestUsableAt && digest.latestUsableAt !== digest.latestSuccessAt) {
      lines.push(`  latest usable fallback: ${digest.latestUsableAt}`);
    }
    if (digest.latestProblemEvent) {
      lines.push(
        `  latest problem: ${digest.latestProblemEvent.outcome} / owner=${digest.latestProblemEvent.blockerOwner} / blocker=${digest.latestProblemEvent.blockerClass || 'none'} / at=${formatTimestamp(digest.latestProblemEvent.completedAt || digest.latestProblemEvent.startedAt)}`,
      );
    }
    if (journeyTruth.blocker) {
      lines.push(`  blocker: ${journeyTruth.blocker}`);
    }
    if (journeyTruth.nextAction) {
      lines.push(`  next step: ${journeyTruth.nextAction}`);
    }
    return lines;
  });
}

function collectAttentionItems(
  truth: ReturnType<typeof buildFieldTrialOperatorTruth>,
): {
  repoSide: string[];
  external: string[];
  proofGaps: string[];
} {
  const repoSide: string[] = [];
  const external: string[] = [];
  const proofGaps: string[] = [];
  const push = (label: string, state: FieldTrialSurfaceTruth): void => {
    if (
      state.proofState === 'live_proven' ||
      state.proofState === 'not_intended_for_trial'
    ) {
      return;
    }
    const line = `- ${label}: ${state.blocker || state.detail}${state.nextAction ? ` Next: ${state.nextAction}` : ''}`;
    if (state.blockerOwner === 'repo_side' || state.proofState === 'degraded_but_usable') {
      repoSide.push(line);
      return;
    }
    if (state.blockerOwner === 'external') {
      external.push(line);
      return;
    }
    proofGaps.push(line);
  };

  push('ordinary_chat', truth.journeys.ordinary_chat);
  push('daily_guidance', truth.journeys.daily_guidance);
  push('candace_followthrough', truth.journeys.candace_followthrough);
  push('mission_planning', truth.journeys.mission_planning);
  push('work_cockpit', truth.journeys.work_cockpit);
  push('cross_channel_handoff', truth.journeys.cross_channel_handoff);
  push('Telegram', truth.telegram);
  push('Alexa', truth.alexa);
  push('BlueBubbles', truth.bluebubbles);
  push('Research', truth.research);
  push('Image generation', truth.imageGeneration);

  return { repoSide, external, proofGaps };
}

function formatProblemEvents(
  review: ReturnType<typeof buildPilotReviewDigest>,
): string[] {
  if (review.recentProblemEvents.length === 0) {
    return ['- none'];
  }
  return review.recentProblemEvents.slice(0, 8).map((event) => {
    const completedAt = event.completedAt || event.startedAt || 'in_progress';
    return `- ${event.journeyId} [${event.channel}] ${event.outcome} / owner=${event.blockerOwner} / blocker=${event.blockerClass || 'none'} at ${completedAt} :: ${event.summaryText}`;
  });
}

function formatOpenIssues(review: ReturnType<typeof buildPilotReviewDigest>): string[] {
  if (review.openIssues.length === 0) {
    return ['- none'];
  }
  return review.openIssues.slice(0, 8).map((issue) => {
    const linkedJourney = issue.journeyEventId ? ` / journey=${issue.journeyEventId}` : '';
    const blocker =
      issue.blockerClass && issue.blockerClass !== 'none'
        ? ` / blocker=${issue.blockerClass}`
        : '';
    return `- ${issue.issueKind} [${issue.channel}] ${issue.createdAt}${linkedJourney}${blocker} :: ${issue.summaryText}`;
  });
}

async function main(): Promise<void> {
  initDatabase();
  const truth = buildFieldTrialOperatorTruth();
  const review = buildPilotReviewDigest();
  const attention = collectAttentionItems(truth);
  const lines = [
    '*Pilot Review*',
    `- Logging enabled: ${review.loggingEnabled ? 'yes' : 'no'}`,
    `- Open pilot issues: ${review.openIssueCount}`,
    `- Flagship usage last 24h: ${review.totalUsage24h}`,
    `- Flagship usage last 7d: ${review.totalUsage7d}`,
    ...(review.latestOpenIssue
      ? [`- Latest pilot issue: ${review.latestOpenIssue.summaryText}`]
      : []),
    '',
    '*Pilot Readiness*',
    `- Telegram: ${truth.telegram.proofState}`,
    `- Alexa: ${truth.alexa.proofState}`,
    `  kind=${truth.alexa.proofKind} / freshness=${truth.alexa.proofFreshness} / age=${truth.alexa.proofAgeLabel}`,
    `  last=${truth.alexa.lastSignedRequestType} / intent=${truth.alexa.lastSignedIntent} / source=${truth.alexa.lastSignedResponseSource}`,
    `  utterance=${truth.alexa.recommendedUtterance}`,
    `  confirm=${truth.alexa.confirmCommand}`,
    ...(truth.alexa.blocker ? [`  blocker=${truth.alexa.blocker}`] : []),
    `- BlueBubbles: ${truth.bluebubbles.proofState}`,
    `- Work cockpit: ${truth.workCockpit.proofState}`,
    `- Life threads: ${truth.lifeThreads.proofState}`,
    `- Communication companion: ${truth.communicationCompanion.proofState}`,
    `- Chief-of-staff / missions: ${truth.chiefOfStaffMissions.proofState}`,
    `- Knowledge library: ${truth.knowledgeLibrary.proofState}`,
    `- Research: ${truth.research.proofState}`,
    `- Image generation: ${truth.imageGeneration.proofState}`,
    `- Host health: ${truth.hostHealth.proofState}`,
    '',
    '*Journey Health*',
    ...formatJourneyHealthLines(truth, review),
    '',
    '*Needs Attention Next*',
    '- Repo-side or degraded-but-usable:',
    ...(attention.repoSide.length > 0 ? attention.repoSide : ['- none']),
    '- External blockers:',
    ...(attention.external.length > 0 ? attention.external : ['- none']),
    '- Fresh proof gaps:',
    ...(attention.proofGaps.length > 0 ? attention.proofGaps : ['- none']),
    '',
    '*Recent Flagged Outcomes*',
    ...formatProblemEvents(review),
    '',
    '*Open Pilot Issues*',
    ...formatOpenIssues(review),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `debug-pilot failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
