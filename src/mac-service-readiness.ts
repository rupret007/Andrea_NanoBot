import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

export interface MacServiceReadinessSnapshot {
  ready: boolean;
  reasons: string[];
  bootId: string | null;
  pid: number | null;
  expectedCommit: string;
  activeCommit: string | null;
  buildCommit: string | null;
}

export interface InspectMacServiceReadinessInput {
  projectRoot: string;
  previousBootId?: string | null;
  expectedCommit: string;
  processExists?: (pid: number) => boolean;
}

export interface WaitForMacServiceReadinessInput extends InspectMacServiceReadinessInput {
  timeoutMs?: number;
  pollMs?: number;
}

function readJson(filePath: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function stringField(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integerField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readPidFile(filePath: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function inspectMacServiceReadiness(
  input: InspectMacServiceReadinessInput,
): MacServiceReadinessSnapshot {
  const runtimeDir = path.join(input.projectRoot, 'data', 'runtime');
  const readyState = readJson(path.join(runtimeDir, 'nanoclaw-ready.json'));
  const healthState = readJson(path.join(runtimeDir, 'assistant-health.json'));
  const auditState = readJson(path.join(runtimeDir, 'runtime-audit.json'));
  const pidFile = readPidFile(
    path.join(input.projectRoot, 'data', 'run', 'mac-mini-service.pid'),
  );
  const bootId = stringField(readyState, 'bootId');
  const readyPid = integerField(readyState, 'pid');
  const healthBootId = stringField(healthState, 'bootId');
  const healthPid = integerField(healthState, 'pid');
  const activeCommit = stringField(auditState, 'activeGitCommit');
  const buildCommit = stringField(auditState, 'activeBuildGitCommit');
  const processExists = input.processExists ?? defaultProcessExists;
  const reasons: string[] = [];

  if (!bootId) reasons.push('ready_marker_missing');
  if (input.previousBootId && bootId === input.previousBootId) {
    reasons.push('new_boot_not_observed');
  }
  if (!readyPid) reasons.push('ready_pid_missing');
  if (!pidFile) reasons.push('pid_file_missing');
  if (readyPid && pidFile && readyPid !== pidFile) {
    reasons.push('ready_pid_mismatch');
  }
  if (bootId && healthBootId !== bootId) {
    reasons.push('health_boot_mismatch');
  }
  if (readyPid && healthPid !== readyPid) {
    reasons.push('health_pid_mismatch');
  }
  if (readyPid && !processExists(readyPid)) {
    reasons.push('ready_process_not_running');
  }
  if (activeCommit !== input.expectedCommit) {
    reasons.push('serving_commit_mismatch');
  }
  if (buildCommit !== input.expectedCommit) {
    reasons.push('build_commit_mismatch');
  }
  if (auditState?.activeBuildProvenanceState !== 'verified') {
    reasons.push('build_provenance_unverified');
  }
  if (auditState?.activeBuildArtifactVerified !== true) {
    reasons.push('build_artifact_unverified');
  }
  return {
    ready: reasons.length === 0,
    reasons,
    bootId,
    pid: readyPid,
    expectedCommit: input.expectedCommit,
    activeCommit,
    buildCommit,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMacServiceReadiness(
  input: WaitForMacServiceReadinessInput,
): Promise<MacServiceReadinessSnapshot> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollMs = input.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let snapshot = inspectMacServiceReadiness(input);
  while (!snapshot.ready && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    snapshot = inspectMacServiceReadiness(input);
  }
  if (!snapshot.ready) {
    throw new Error(
      `mac_service_readiness_timeout ${JSON.stringify(snapshot)}`,
    );
  }
  return snapshot;
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

async function main(): Promise<void> {
  const projectRoot = optionValue('--project-root');
  const expectedCommit = optionValue('--expected-commit');
  if (!projectRoot || !expectedCommit) {
    throw new Error(
      'Usage: mac-service-readiness --project-root <path> --expected-commit <sha> [--previous-boot-id <id>] [--timeout-seconds <n>]',
    );
  }
  const timeoutSeconds = Number.parseInt(
    optionValue('--timeout-seconds') || '120',
    10,
  );
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be a positive integer');
  }
  const snapshot = await waitForMacServiceReadiness({
    projectRoot,
    expectedCommit,
    previousBootId: optionValue('--previous-boot-id'),
    timeoutMs: timeoutSeconds * 1_000,
  });
  console.log(
    `ready boot_id=${snapshot.bootId} pid=${snapshot.pid} commit=${snapshot.activeCommit}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
