import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgiDoctor } from "../scripts/agi-doctor.js";

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AGI doctor", () => {
  it("detects missing model providers and missing Telegram canary config", async () => {
    const stateDir = await tempDir();
    const report = await runAgiDoctor({
      ANDREA_STATE_DIR: stateDir,
      ANDREA_USE_AGI: "1",
    });

    expect(report.ok).toBe(false);
    expect(check(report, "model_providers")?.status).toBe("fail");
    expect(check(report, "telegram_canary")?.status).toBe("fail");
  });

  it("detects a bad state dir", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "occupied\n", "utf8");

    const report = await runAgiDoctor({
      ANDREA_STATE_DIR: filePath,
      ANTHROPIC_API_KEY: "sk-ant-test",
      TELEGRAM_BOT_TOKEN: "test-token",
      ANDREA_USE_AGI: "1",
    });

    expect(report.ok).toBe(false);
    expect(check(report, "state_dir")?.status).toBe("fail");
  });

  it("detects an invalid audit chain", async () => {
    const stateDir = await tempDir();
    const auditPath = join(stateDir, "audit", "audit.jsonl");
    await mkdir(join(stateDir, "audit"), { recursive: true });
    await writeFile(auditPath, "{\"kind\":\"tampered\",\"hash\":\"wrong\"}\n", "utf8");

    const report = await runAgiDoctor({
      ANDREA_STATE_DIR: stateDir,
      ANTHROPIC_API_KEY: "sk-ant-test",
      TELEGRAM_BOT_TOKEN: "test-token",
      ANDREA_USE_AGI: "1",
    });

    expect(report.ok).toBe(false);
    expect(check(report, "audit_chain")?.status).toBe("fail");
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agi-doctor-"));
  dirs.push(dir);
  return dir;
}

function check(report: Awaited<ReturnType<typeof runAgiDoctor>>, name: string) {
  return report.checks.find((item) => item.name === name);
}
