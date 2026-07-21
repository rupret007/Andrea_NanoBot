import { _closeDatabase, initDatabase } from '../src/db.js';
import { adaptiveGroundedIntelligenceDiagnostics } from '../src/adaptive-grounded-intelligence.js';
import {
  listAdaptiveLearningEvents,
  loadAdaptiveCognitiveEpisode,
  loadAdaptiveLearningCandidates,
  reviewAdaptiveLearningCandidateDurably,
} from '../src/adaptive-grounded-intelligence-durable-adapter.js';

/**
 * Bounded local diagnostics by default. The only write path is an explicit
 * owner review with candidate ID, decision, reviewer, confirmation flag, and
 * note. It cannot approve or execute any external action.
 */
const args = process.argv.slice(2);

function value(flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function statusCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of loadAdaptiveLearningCandidates({ limit: 500 })) {
    counts[candidate.status] = (counts[candidate.status] || 0) + 1;
  }
  return counts;
}

function main(): void {
  initDatabase();
  try {
    const candidateId = value('--candidate');
    const review = value('--review');
    if (review) {
      if (!candidateId) throw new Error('--candidate <id> is required.');
      if (!['accept', 'reject', 'supersede', 'rollback'].includes(review)) {
        throw new Error(
          '--review must be accept, reject, supersede, or rollback.',
        );
      }
      if (!args.includes('--explicit-owner-review')) {
        throw new Error(
          '--explicit-owner-review is required; diagnostics never infer acceptance.',
        );
      }
      const reviewer = value('--reviewer');
      const note = value('--note');
      if (!reviewer || !note) {
        throw new Error('--reviewer <id> and --note <text> are required.');
      }
      const reviewed = reviewAdaptiveLearningCandidateDurably({
        candidateId,
        decision: review as 'accept' | 'reject' | 'supersede' | 'rollback',
        reviewerId: reviewer,
        explicitOwnerDecision: true,
        note,
        now: new Date().toISOString(),
        replacementCandidateId: value('--replacement'),
      });
      if (!reviewed) throw new Error('Adaptive learning candidate not found.');
      console.log(
        JSON.stringify(
          {
            reviewed: {
              candidateId: reviewed.candidateId,
              status: reviewed.status,
              scopeKey: reviewed.scopeKey,
              ownerReview: reviewed.ownerReview,
              executionAuthority: reviewed.executionAuthority,
            },
            externalActionPerformed: false,
            assistiveModeChanged: false,
          },
          null,
          2,
        ),
      );
      return;
    }

    const turnId = value('--turn');
    const episodeId = value('--episode');
    const episode = loadAdaptiveCognitiveEpisode({ turnId, episodeId });
    const candidates = candidateId
      ? loadAdaptiveLearningCandidates({ limit: 500 }).filter(
          (item) => item.candidateId === candidateId,
        )
      : episode
        ? loadAdaptiveLearningCandidates({
            scopeKey: episode.scopeKey,
            limit: 500,
          })
        : loadAdaptiveLearningCandidates({ limit: 50 });
    if (!episode) {
      console.log(
        JSON.stringify(
          {
            episode: null,
            learningCounts: statusCounts(),
            candidates: candidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              kind: candidate.kind,
              status: candidate.status,
              subject: candidate.subject,
              recurrenceCount: candidate.recurrenceCount,
              confidence: candidate.confidence,
              readyReason: candidate.blockedPromotionReasons.length
                ? `blocked: ${candidate.blockedPromotionReasons.join(', ')}`
                : candidate.status,
              affectedModules: candidate.affectedModules,
              appliedCount: candidate.appliedCount,
              ownerReviewMandatory: candidate.ownerReviewMandatory,
              executionAuthority: candidate.executionAuthority,
            })),
            readOnly: true,
            rawPrivateContentIncluded: false,
          },
          null,
          2,
        ),
      );
      return;
    }
    const events = listAdaptiveLearningEvents({
      episodeId: episode.episodeId,
      limit: 500,
    });
    console.log(
      JSON.stringify(
        {
          ...adaptiveGroundedIntelligenceDiagnostics({
            episode,
            candidates,
            events,
          }),
          readOnly: true,
          rawPrivateContentIncluded: false,
        },
        null,
        2,
      ),
    );
  } finally {
    _closeDatabase();
  }
}

main();
