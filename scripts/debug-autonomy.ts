import { initDatabase, listActionPreflights } from '../src/db.js';
import {
  classifyOperationAutonomy,
  formatAutonomyPolicyReport,
} from '../src/autonomy-governor.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const subjectIndex = args.indexOf('--classify');
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;

if (subject) {
  const decision = classifyOperationAutonomy({ operationSummary: subject });
  console.log(
    json
      ? JSON.stringify(decision, null, 2)
      : `L${decision.level} (${decision.levelLabel}) — ${decision.rationale}`,
  );
} else {
  const recent = listActionPreflights({ limit: 10 });
  if (json) {
    console.log(
      JSON.stringify(
        { policy: formatAutonomyPolicyReport(), recentPreflights: recent },
        null,
        2,
      ),
    );
  } else {
    console.log(formatAutonomyPolicyReport());
    if (recent.length) {
      console.log('');
      console.log('Recent preflight classifications:');
      for (const preflight of recent) {
        console.log(
          `- L${preflight.autonomyLevel} ${preflight.verdict}: ${preflight.actionSummary}`,
        );
      }
    }
  }
}
