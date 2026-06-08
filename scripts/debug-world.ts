import {
  buildWorldModelReport,
  buildWorldModelStoredReport,
  formatWorldModelReport,
} from '../src/world-model.js';
import { initDatabase } from '../src/db.js';
import { buildIntegrationDoctorReport } from '../src/integration-doctor.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const staleOnly = args.includes('--stale');
const verifySafe = args.includes('--verify-safe');
const snapshotIndex = args.indexOf('--snapshot');
const snapshotId = snapshotIndex >= 0 ? args[snapshotIndex + 1] || null : null;
const subjectIndex = args.indexOf('--subject');
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const generatedAt = new Date().toISOString();

const liveProviders = verifySafe
  ? await collectProviderHealthSnapshotsWithLiveProbe(generatedAt)
  : null;
const report = snapshotId
  ? buildWorldModelStoredReport({ generatedAt, snapshotId })
  : buildWorldModelReport({
      generatedAt,
      subject,
      verifySafe,
      providers: liveProviders || undefined,
      integrationReport: liveProviders
        ? buildIntegrationDoctorReport({
            now: new Date(generatedAt),
            providers: liveProviders,
          })
        : undefined,
    });

if (staleOnly) {
  const stale = {
    generatedAt,
    snapshotId: report.snapshot.snapshotId,
    status: report.snapshot.status,
    confidence: report.snapshot.confidence,
    staleEvidence: report.evidenceRefs.filter(
      (ref) => ref.freshness === 'stale' || ref.freshness === 'expired',
    ),
    proofDebt: report.proofDebt,
    verificationNeeds: report.verificationNeeds,
    nextAction: report.nextAction,
    privacy: report.privacy,
  };
  console.log(json ? JSON.stringify(stale, null, 2) : formatWorldModelReport(report));
  process.exit(0);
}

if (verifySafe) {
  const safe = {
    generatedAt,
    snapshotId: report.snapshot.snapshotId,
    status: report.snapshot.status,
    confidence: report.snapshot.confidence,
    safeVerificationRan: report.safeVerificationRan,
    runnableReadOnly: report.verificationNeeds.filter(
      (need) => need.status === 'runnable_read_only',
    ),
    manualProof: report.verificationNeeds.filter(
      (need) => need.status === 'manual_proof',
    ),
    nextAction: report.nextAction,
    privacy: report.privacy,
  };
  console.log(json ? JSON.stringify(safe, null, 2) : formatWorldModelReport(report));
  process.exit(0);
}

console.log(json ? JSON.stringify(report, null, 2) : formatWorldModelReport(report));
