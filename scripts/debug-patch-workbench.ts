import fs from 'node:fs';
import path from 'node:path';

import { initDatabase } from '../src/db.js';
import {
  buildPatchWorkbenchReport,
  executeApprovedDetachedRepairCandidate,
  formatPatchWorkbenchReport,
  type DetachedRepairVerificationCommand,
  type PatchWorkbenchMode,
} from '../src/patch-workbench.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist') || args.includes('--dry-run');
const executeApprovedDiff = args.includes('--execute-approved-diff');
const mode: PatchWorkbenchMode = args.includes('--apply-low-risk')
  ? 'apply_low_risk'
  : args.includes('--prepare-workspace')
    ? 'prepare_workspace'
    : 'dry_run';

function readFlag(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function readRepeatedFlag(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value && !value.startsWith('--')) values.push(value);
  }
  return values;
}

function parseVerificationCommand(
  value: string,
): DetachedRepairVerificationCommand {
  const parts = value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    throw new Error(`Invalid empty --verify value.`);
  }
  const [command, ...commandArgs] = parts;
  return {
    command: command!,
    args: commandArgs,
  };
}

function formatExecutionReport(
  report: ReturnType<typeof executeApprovedDetachedRepairCandidate>,
): string {
  const result = report.result;
  const lines = [
    '*Approved Detached Repair Execution*',
    `Generated: ${report.generatedAt}`,
    `Status: ${result.status}`,
    `Branch: ${result.branchName}`,
    `Base: ${result.baseRef}`,
    `Commit: ${result.commitHash || 'none'}`,
    `Workspace: ${result.workspacePath}`,
    `Rollback applied: ${result.rollbackApplied ? 'yes' : 'no'}`,
    `Persisted: ${report.persisted ? 'yes' : 'no'}`,
    `Files: ${result.filesChanged.length ? result.filesChanged.join(', ') : 'none'}`,
    `Changed lines: ${result.changedLines}`,
    `Reason: ${result.reason}`,
    '',
    '*Verification*',
  ];
  if (!result.verificationResults.length) {
    lines.push('- none');
  } else {
    for (const verification of result.verificationResults) {
      lines.push(
        `- ${verification.ok ? 'pass' : 'fail'}: ${verification.label}`,
      );
    }
  }
  lines.push('', `Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, provider debates, raw tool output, or secrets.',
  );
  return lines.join('\n');
}

function runApprovedDiffExecution(): void {
  const diffFile = readFlag('--diff-file');
  const branchName = readFlag('--branch');
  const baseRef = readFlag('--base-ref') || 'HEAD';
  const commitMessage =
    readFlag('--commit-message') || 'Apply approved detached repair candidate';
  const operatorLabel = readFlag('--label') || 'Approved detached repair';
  const keepWorkspace = args.includes('--keep-workspace');
  const approved = args.includes('--approved');
  const verificationCommands = readRepeatedFlag('--verify').map(
    parseVerificationCommand,
  );

  if (!approved) {
    throw new Error(
      'Refusing to execute: pass --approved with --execute-approved-diff after human approval.',
    );
  }
  if (!diffFile) {
    throw new Error('Missing required --diff-file <path>.');
  }
  if (!branchName) {
    throw new Error('Missing required --branch <codex/improvement/...>.');
  }
  const resolvedDiffFile = path.resolve(process.cwd(), diffFile);
  if (!fs.existsSync(resolvedDiffFile)) {
    throw new Error(`Diff file does not exist: ${resolvedDiffFile}`);
  }
  const diffText = fs.readFileSync(resolvedDiffFile, 'utf8');
  const report = executeApprovedDetachedRepairCandidate({
    repoRoot: process.cwd(),
    branchName,
    baseRef,
    diffText,
    verificationCommands,
    commitMessage,
    approved,
    keepWorkspace,
    persist: !noPersist,
    operatorLabel,
  });

  console.log(
    json ? JSON.stringify(report, null, 2) : formatExecutionReport(report),
  );
  if (report.result.status !== 'committed') {
    process.exitCode = 1;
  }
}

if (executeApprovedDiff) {
  runApprovedDiffExecution();
} else {
  const report = buildPatchWorkbenchReport({
    mode,
    persist: !noPersist,
  });

  console.log(
    json ? JSON.stringify(report, null, 2) : formatPatchWorkbenchReport(report),
  );
}
