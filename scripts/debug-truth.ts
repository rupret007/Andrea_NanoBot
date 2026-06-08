import {
  buildTruthEngineReport,
  formatTruthEngineReport,
  runTruthEngine,
} from '../src/truth-engine.js';
import { buildLogicKernelReport } from '../src/logic-kernel.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const subjectIndex = args.indexOf('--subject');
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const answerIndex = args.indexOf('--answer');
const answer = answerIndex >= 0 ? args[answerIndex + 1] || null : null;
const auditIndex = args.indexOf('--audit');
const auditId = auditIndex >= 0 ? args[auditIndex + 1] || null : null;
const generatedAt = new Date().toISOString();

if (answer) {
  const logicReport = buildLogicKernelReport({
    subject: subject || 'Truth Engine debug answer support check',
    generatedAt,
  });
  const verdict = runTruthEngine({
    text: answer,
    subject: logicReport.subject,
    logicReport,
    generatedAt,
  });
  const output = {
    generatedAt,
    status: verdict.calibration.status,
    supportGrade: verdict.calibration.supportGrade,
    confidence: verdict.calibration.confidence,
    flags: verdict.calibration.flags,
    claims: verdict.claims.length,
    unsupportedClaims: verdict.claims.filter(
      (claim) => claim.supportGrade === 'unsupported',
    ).length,
    evidenceSupports: verdict.evidenceSupports.length,
    coverage: verdict.sourceCoverage.coverageGrade,
    directive: verdict.rewriteDirectives[0]?.directive || 'none',
    nextAction: verdict.bestNextAction,
    privacy: verdict.privacy,
  };
  console.log(json ? JSON.stringify(output, null, 2) : formatTruthEngineReport({
    generatedAt,
    ok: verdict.calibration.status !== 'block',
    latestAudit: verdict.audit,
    claims: verdict.claims,
    evidenceSupports: verdict.evidenceSupports,
    contradictionChecks: verdict.contradictionChecks,
    rewriteDirectives: verdict.rewriteDirectives,
    sourceCoverage: [verdict.sourceCoverage],
    nextAction: verdict.bestNextAction,
    privacy: verdict.privacy,
  }));
  process.exit(0);
}

const report = buildTruthEngineReport({ subject, auditId, generatedAt });
console.log(json ? JSON.stringify(report, null, 2) : formatTruthEngineReport(report));
