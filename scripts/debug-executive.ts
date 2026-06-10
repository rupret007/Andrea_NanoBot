import { initDatabase } from '../src/db.js';
import {
  buildStoredCognitiveExecutiveReport,
  formatCognitiveExecutiveReport,
} from '../src/cognitive-executive.js';
import {
  buildToolReliabilityDoctorReport,
  formatToolReliabilityReport,
  refreshToolReliabilityFromCurrentTruth,
} from '../src/tool-reliability.js';
import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from '../src/autonomous-improvement-lab.js';
import {
  buildRealityGroundingReport,
  formatRealityGroundingReport,
} from '../src/reality-grounding.js';
import {
  buildHierarchicalPlannerReport,
  formatGoalPlannerReport,
} from '../src/goal-planner.js';
import {
  buildMetacognitionDoctorReport,
  formatMetacognitionReport,
} from '../src/metacognition.js';

async function main(): Promise<void> {
  initDatabase();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  if (refresh) {
    await refreshToolReliabilityFromCurrentTruth();
  }
  const executive = buildStoredCognitiveExecutiveReport();
  const reliability = buildToolReliabilityDoctorReport();
  const improvement = buildAutonomousImprovementLabReport();
  const reality = buildRealityGroundingReport({
    requestText: 'executive route reality summary',
    channel: 'operator',
    persist: false,
  });
  const planner = buildHierarchicalPlannerReport({
    requestText: 'executive goal and planning summary',
    persist: false,
  });
  const metacognition = buildMetacognitionDoctorReport({
    requestText: 'executive route and confidence summary',
    channel: 'operator',
    persist: false,
  });
  if (json) {
    console.log(
      JSON.stringify(
        { executive, planner, metacognition, reliability, improvement, reality },
        null,
        2,
      ),
    );
    return;
  }
  console.log(formatCognitiveExecutiveReport(executive));
  console.log('');
  console.log(formatGoalPlannerReport(planner));
  console.log('');
  console.log(formatMetacognitionReport(metacognition));
  console.log('');
  console.log(formatRealityGroundingReport(reality));
  console.log('');
  console.log(formatToolReliabilityReport(reliability));
  console.log('');
  console.log(formatAutonomousImprovementLabReport(improvement));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
