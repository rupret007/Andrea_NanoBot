import {
  beginLogicKernelRun,
  buildLogicReconciliationReport,
  buildLogicKernelReport,
  formatLogicReconciliationReport,
  formatLogicKernelReport,
} from '../src/logic-kernel.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const seed = args.includes('--seed');
const reconcile = args.includes('--reconcile');
const subjectIndex = args.indexOf('--subject');
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const episodeIndex = args.indexOf('--episode');
const episodeId = episodeIndex >= 0 ? args[episodeIndex + 1] || null : null;
const generatedAt = new Date().toISOString();

if (reconcile) {
  const report = buildLogicReconciliationReport({
    subject,
    episodeId,
    generatedAt,
  });
  const output = {
    generatedAt,
    status: report.ok ? 'pass' : 'warn',
    subject: report.subject,
    beliefStatus: report.beliefState?.status || 'none',
    confidence: report.confidence,
    activeClaims: report.activeClaims.length,
    staleClaims: report.staleClaims.length,
    transitions: report.transitions.length,
    unresolvedContradictions: report.unresolvedContradictions.length,
    freshness: report.freshness,
    nextAction: report.nextAction,
    privacy: report.privacy,
  };
  console.log(json ? JSON.stringify(output, null, 2) : formatLogicReconciliationReport(report));
  process.exit(0);
}

if (seed) {
  const result = beginLogicKernelRun({
    subject:
      subject ||
      'Inspect Andrea belief state, uncertainty, contradictions, and the most useful next action.',
    episodeId,
    generatedAt,
  });
  const output = {
    generatedAt,
    status: result.report.ok ? 'pass' : 'warn',
    subject: result.report.subject,
    beliefStatus: result.beliefState.status,
    decision: result.decision.status,
    confidence: result.decision.confidence,
    claims: result.report.claims.length,
    contradictions: result.report.contradictions.length,
    missingPremises: result.report.missingPremises.length,
    selectedNextAction: result.report.selectedNextAction,
    privacy: result.report.privacy,
  };
  console.log(json ? JSON.stringify(output, null, 2) : formatLogicKernelReport(result.report));
  process.exit(0);
}

const report = buildLogicKernelReport({ subject, episodeId, generatedAt });
console.log(json ? JSON.stringify(report, null, 2) : formatLogicKernelReport(report));
