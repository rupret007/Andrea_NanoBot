import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupMemoryStores,
  restoreMemoryStores,
  validateBackup,
  validateMemoryRestore,
  type MemoryStorePaths,
} from "../scripts/agi-memory-backup.js";
import { checkRestore } from "../scripts/agi-memory-restore-check.js";
import { AuditLog } from "../src/safety/audit-log.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-memory-backup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("memory backup and restore validation", () => {
  it("backs up existing memory stores, restores them, and validates checksums", async () => {
    const source = pathsIn(join(dir, "source"));
    const restored = pathsIn(join(dir, "restored"));
    const backupDir = join(dir, "backup");
    await seedMemoryStores(source);

    const manifest = await backupMemoryStores(source, backupDir);
    await restoreMemoryStores(backupDir, restored);
    const validation = await validateMemoryRestore(restored, backupDir);

    expect(manifest.entries.map((entry) => entry.store).sort()).toEqual(["episodic", "graph", "vector"]);
    expect(validation).toEqual({ ok: true, checked: 3, errors: [] });
    await expect(readFile(restored.vector, "utf8")).resolves.toBe(await readFile(source.vector, "utf8"));
    await expect(validateBackup(backupDir)).resolves.toEqual({ ok: true, checked: 3, errors: [] });
  });

  it("detects restored store tampering", async () => {
    const source = pathsIn(join(dir, "source"));
    const restored = pathsIn(join(dir, "restored"));
    const backupDir = join(dir, "backup");
    await seedMemoryStores(source);

    await backupMemoryStores(source, backupDir);
    await restoreMemoryStores(backupDir, restored);
    await writeFile(restored.episodic, `{"tampered":true}\n`, "utf8");

    const validation = await validateMemoryRestore(restored, backupDir);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/episodic checksum mismatch/);
  });

  it("does not validate incomplete memory backups as successful", async () => {
    const source = pathsIn(join(dir, "source"));
    const backupDir = join(dir, "backup");
    await mkdir(dirname(source.vector), { recursive: true });
    await writeFile(
      source.vector,
      JSON.stringify({ __vectorStoreHeader: true, embedModelId: "hash-fallback-v1", embedDim: 64, version: 1 }) + "\n",
      "utf8",
    );

    await backupMemoryStores(source, backupDir);
    const validation = await validateBackup(backupDir);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/graph missing from backup manifest/);
    expect(validation.errors.join("\n")).toMatch(/episodic missing from backup manifest/);
  });

  it("restore check probes memory without deleting mismatched vector headers", async () => {
    const state = join(dir, "state");
    const paths = {
      vector: join(state, "memory", "vectors.jsonl"),
      graph: join(state, "memory", "graph.json"),
      episodic: join(state, "memory", "episodes.jsonl"),
    };
    const backupDir = join(dir, "backup");
    await seedMemoryStores(paths);
    await backupMemoryStores(paths, backupDir);
    await new AuditLog(join(state, "audit", "audit.jsonl")).write({
      scope: "test",
      kind: "seed",
    });

    const result = await checkRestore(backupDir, state);

    expect(result.ok).toBe(true);
    await expect(readFile(paths.vector, "utf8")).resolves.toContain('"embedDim":64');
  });
});

function pathsIn(root: string): MemoryStorePaths {
  return {
    vector: join(root, "vectors.jsonl"),
    graph: join(root, "graph.json"),
    episodic: join(root, "episodes.jsonl"),
  };
}

async function seedMemoryStores(paths: MemoryStorePaths): Promise<void> {
  await Promise.all(Object.values(paths).map((path) => mkdir(dirname(path), { recursive: true })));
  await writeFile(
    paths.vector,
    [
      JSON.stringify({ __vectorStoreHeader: true, embedModelId: "hash-fallback-v1", embedDim: 64, version: 1 }),
      JSON.stringify({ id: "m1", kind: "semantic", content: "memory", scope: "global", importance: 0.5 }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(paths.graph, JSON.stringify({ nodes: [], edges: [] }, null, 2), "utf8");
  await writeFile(
    paths.episodic,
    JSON.stringify({ id: "e1", scope: "test", actor: "user", content: "hello", at: 1 }) + "\n",
    "utf8",
  );
}
