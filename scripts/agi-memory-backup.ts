import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface MemoryStorePaths {
  vector: string;
  graph: string;
  episodic: string;
}

export interface BackupManifestEntry {
  store: keyof MemoryStorePaths;
  sourcePath: string;
  backupFile: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  entries: BackupManifestEntry[];
}

export interface ValidationResult {
  ok: boolean;
  checked: number;
  errors: string[];
}

const MANIFEST_FILE = "memory-backup-manifest.json";

export async function backupMemoryStores(paths: MemoryStorePaths, backupDir: string): Promise<BackupManifest> {
  await mkdir(backupDir, { recursive: true });
  const entries: BackupManifestEntry[] = [];

  for (const store of storeKeys()) {
    const sourcePath = paths[store];
    if (!(await exists(sourcePath))) continue;
    const backupFile = `${store}-${basename(sourcePath)}`;
    const backupPath = join(backupDir, backupFile);
    await copyFile(sourcePath, backupPath);
    entries.push({
      store,
      sourcePath,
      backupFile,
      bytes: (await stat(backupPath)).size,
      sha256: await sha256File(backupPath),
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries,
  };
  await writeFile(join(backupDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

export async function restoreMemoryStores(backupDir: string, targetPaths?: Partial<MemoryStorePaths>): Promise<BackupManifest> {
  const manifest = await readManifest(backupDir);
  for (const entry of manifest.entries) {
    const targetPath = targetPaths?.[entry.store] ?? entry.sourcePath;
    const backupPath = join(backupDir, entry.backupFile);
    const actualHash = await sha256File(backupPath);
    if (actualHash !== entry.sha256) {
      throw new Error(`Backup checksum mismatch for ${entry.store}: expected ${entry.sha256}, got ${actualHash}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.restore.tmp`;
    await copyFile(backupPath, tmp);
    await rename(tmp, targetPath);
  }
  return manifest;
}

export async function validateMemoryRestore(paths: MemoryStorePaths, backupDir: string): Promise<ValidationResult> {
  const manifest = await readManifest(backupDir);
  const errors: string[] = [];
  let checked = 0;
  for (const missing of missingRequiredStores(manifest)) {
    errors.push(`${missing} missing from backup manifest`);
  }

  for (const entry of manifest.entries) {
    checked += 1;
    const restoredPath = paths[entry.store];
    if (!(await exists(restoredPath))) {
      errors.push(`${entry.store} missing at ${restoredPath}`);
      continue;
    }
    const [restoredHash, restoredStat] = await Promise.all([sha256File(restoredPath), stat(restoredPath)]);
    if (restoredHash !== entry.sha256) {
      errors.push(`${entry.store} checksum mismatch: expected ${entry.sha256}, got ${restoredHash}`);
    }
    if (restoredStat.size !== entry.bytes) {
      errors.push(`${entry.store} size mismatch: expected ${entry.bytes}, got ${restoredStat.size}`);
    }
  }

  return { ok: errors.length === 0, checked, errors };
}

export async function validateBackup(backupDir: string): Promise<ValidationResult> {
  const manifest = await readManifest(backupDir);
  const errors: string[] = [];
  let checked = 0;
  for (const missing of missingRequiredStores(manifest)) {
    errors.push(`${missing} missing from backup manifest`);
  }

  for (const entry of manifest.entries) {
    checked += 1;
    const backupPath = join(backupDir, entry.backupFile);
    if (!(await exists(backupPath))) {
      errors.push(`${entry.store} backup missing at ${backupPath}`);
      continue;
    }
    const [actualHash, actualStat] = await Promise.all([sha256File(backupPath), stat(backupPath)]);
    if (actualHash !== entry.sha256) errors.push(`${entry.store} backup checksum mismatch`);
    if (actualStat.size !== entry.bytes) errors.push(`${entry.store} backup size mismatch`);
  }

  return { ok: errors.length === 0, checked, errors };
}

async function readManifest(backupDir: string): Promise<BackupManifest> {
  const raw = await readFile(join(backupDir, MANIFEST_FILE), "utf8");
  const parsed = JSON.parse(raw) as BackupManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid memory backup manifest at ${join(backupDir, MANIFEST_FILE)}`);
  }
  return parsed;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function storeKeys(): Array<keyof MemoryStorePaths> {
  return ["vector", "graph", "episodic"];
}

function missingRequiredStores(manifest: BackupManifest): Array<keyof MemoryStorePaths> {
  const present = new Set(manifest.entries.map((entry) => entry.store));
  return storeKeys().filter((store) => !present.has(store));
}

async function main(): Promise<void> {
  const [command, backupDir, vector, graph, episodic] = process.argv.slice(2);
  if (!command || !backupDir || !vector || !graph || !episodic) {
    console.error(
      "Usage: tsx scripts/agi-memory-backup.ts <backup|restore|validate> <backupDir> <vectorPath> <graphPath> <episodicPath>",
    );
    process.exitCode = 2;
    return;
  }
  const paths = { vector, graph, episodic };
  if (command === "backup") {
    console.log(JSON.stringify(await backupMemoryStores(paths, backupDir)));
  } else if (command === "restore") {
    console.log(JSON.stringify(await restoreMemoryStores(backupDir, paths)));
  } else if (command === "validate") {
    const result = await validateMemoryRestore(paths, backupDir);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
