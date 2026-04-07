import { initDatabase } from '../src/db.js';
import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';
import { buildPilotReviewSnapshot } from '../src/pilot-mode.js';

function formatRecentEvents(): string[] {
  const review = buildPilotReviewSnapshot();
  if (review.recentEvents.length === 0) {
    return ['- none yet'];
  }
  return review.recentEvents.slice(0, 12).map((event) => {
    const completedAt = event.completedAt || 'in_progress';
    const blocker =
      event.blockerClass && event.blockerClass !== 'none'
        ? ` / blocker=${event.blockerClass}`
        : '';
    return `- ${event.journeyId} [${event.channel}] ${event.outcome} at ${completedAt}${blocker} :: ${event.summaryText}`;
  });
}

function formatOpenIssues(): string[] {
  const review = buildPilotReviewSnapshot();
  if (review.openIssues.length === 0) {
    return ['- none'];
  }
  return review.openIssues.slice(0, 12).map((issue) => {
    const linkedJourney = issue.journeyEventId ? ` / journey=${issue.journeyEventId}` : '';
    return `- ${issue.issueKind} [${issue.channel}] ${issue.createdAt}${linkedJourney} :: ${issue.summaryText}`;
  });
}

async function main(): Promise<void> {
  initDatabase();
  const truth = buildFieldTrialOperatorTruth();
  const review = buildPilotReviewSnapshot();
  const lines = [
    '*Pilot Review*',
    `- Logging enabled: ${review.loggingEnabled ? 'yes' : 'no'}`,
    `- Open pilot issues: ${review.openIssueCount}`,
    ...(review.latestOpenIssue
      ? [`- Latest pilot issue: ${review.latestOpenIssue.summaryText}`]
      : []),
    '',
    '*Pilot Readiness*',
    `- Telegram: ${truth.telegram.proofState}`,
    `- Alexa: ${truth.alexa.proofState}`,
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
    '*Journey Truth*',
    `- ordinary_chat: ${truth.journeys.ordinary_chat.proofState}`,
    `- daily_guidance: ${truth.journeys.daily_guidance.proofState}`,
    `- candace_followthrough: ${truth.journeys.candace_followthrough.proofState}`,
    `- mission_planning: ${truth.journeys.mission_planning.proofState}`,
    `- work_cockpit: ${truth.journeys.work_cockpit.proofState}`,
    `- cross_channel_handoff: ${truth.journeys.cross_channel_handoff.proofState}`,
    `- alexa_orientation: ${truth.journeys.alexa_orientation.proofState}`,
    '',
    '*Recent Flagship Journey Outcomes*',
    ...formatRecentEvents(),
    '',
    '*Open Pilot Issues*',
    ...formatOpenIssues(),
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
