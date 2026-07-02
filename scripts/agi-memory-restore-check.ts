import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  validateBackup,
  validateMemoryRestore,
  type MemoryStorePaths,
} from "./agi-memory-backup.js";
import { AuditLog } from "../src/safety/index.js";

export interface RestoreCheckResult {
  ok: boolean;
  memoryBackup: Awaited<ReturnType<typeof validateBackup>>;
  restoredMemory?: Awaited<ReturnType<typeof validateMemoryRestore>>;
  auditChain?: Awaited<ReturnType<AuditLog["verifyChain"]>>;
  recallOk?: boolean;
  errors: string[];
}

export async function checkRestore(
  backupDir: string,
  stateDir = join(homedir(), ".andrea"),
): Promise<RestoreCheckResult> {
  const paths = memoryPaths(stateDir);
  const errors: string[] = [];

  const memoryBackup = await validateBackup(backupDir);
  if (!memoryBackup.ok) errors.push(...memoryBackup.errors);

  let restoredMemory: RestoreCheckResult["restoredMemory"];
  try {
    restoredMemory = await validateMemoryRestore(paths, backupDir);
    if (!restoredMemory.ok) errors.push(...restoredMemory.errors);
  } catch (err) {
    errors.push(
      `restored memory validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let auditChain: RestoreCheckResult["auditChain"];
  try {
    auditChain = await new AuditLog(join(stateDir, "audit", "audit.jsonl")).verifyChain();
    if (!auditChain.ok) {
      errors.push(`audit chain invalid: ${auditChain.reason ?? "unknown"}`);
    }
  } catch (err) {
    errors.push(`audit validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let recallOk = false;
  try {
    const probe = await probeRestoredMemory(paths);
    recallOk = probe.ok;
    if (!probe.ok) errors.push(probe.error);
  } catch (err) {
    errors.push(`memory recall probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: errors.length === 0,
    memoryBackup,
    restoredMemory,
    auditChain,
    recallOk,
    errors,
  };
}

async function probeRestoredMemory(paths: MemoryStorePaths): Promise<{ ok: true } | { ok: false; error: string }> {
  const vectorRecords = await countVectorRecords(paths.vector);
  const episodicRecords = await countJsonlRecords(paths.episodic);
  const graphRecords = await countGraphRecords(paths.graph);
  const total = vectorRecords + episodicRecords + graphRecords;
  if (total <= 0) {
    return { ok: false, error: "memory recall probe found no restored memory records" };
  }
  return { ok: true };
}

async function countVectorRecords(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed.__vectorStoreHeader !== true;
      } catch {
        return false;
      }
    }).length;
}

async function countJsonlRecords(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

async function countGraphRecords(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] };
  return (Array.isArray(parsed.nodes) ? parsed.nodes.length : 0) +
    (Array.isArray(parsed.edges) ? parsed.edges.length : 0);
}

function memoryPaths(stateDir: string): MemoryStorePaths {
  return {
    vector: join(stateDir, "memory", "vectors.jsonl"),
    graph: join(stateDir, "memory", "graph.json"),
    episodic: join(stateDir, "memory", "episodes.jsonl"),
  };
}

async function main(): Promise<void> {
  const [backupDir, stateDirArg] = process.argv.slice(2);
  if (!backupDir) {
    console.error("Usage: tsx scripts/agi-memory-restore-check.ts <backupDir> [stateDir]");
    process.exitCode = 2;
    return;
  }
  const result = await checkRestore(
    resolve(backupDir),
    stateDirArg ? resolve(stateDirArg) : undefined,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
