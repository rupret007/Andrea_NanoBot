import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsSubsystem, type SkillExecutorModel } from "../src/skills/index.js";
import { parseSkillFile } from "../src/skills/parser.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-skills-"));
});

describe("skill parser workflow headings", () => {
  it("extracts steps from upstream-style workflow section names", () => {
    const skill = parseSkillFile({
      raw: [
        "---",
        "name: gated-workflow",
        "description: test",
        "---",
        "",
        "## The Gated Workflow",
        "### 1. Plan",
        "Write the plan.",
        "### 2. Verify Gate",
        "Prove the result.",
      ].join("\n"),
      sourceId: "test",
      sourcePath: "skills/gated-workflow/SKILL.md",
    });

    expect(skill.steps.map((step) => step.title)).toEqual(["Plan", "Verify Gate"]);
    expect(skill.steps[1].verification).toBe(true);
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SkillsSubsystem built-in fallbacks", () => {
  it("resolves every lifecycle slash command without a synced skill cache", async () => {
    const skills = await SkillsSubsystem.create({
      cacheDir: dir,
      manifest: [],
      autoSync: false,
    });

    for (const command of [
      "/spec",
      "/plan",
      "/build",
      "/test",
      "/review",
      "/ship",
      "/code-simplify",
      "/ask-tech",
    ]) {
      const resolved = skills.resolveSlashCommand(`${command} wire the AGI runtime`);
      expect(resolved?.skill.sourceId).toBe("andrea/builtin-skills");
      expect(resolved?.goal).toBe("wire the AGI runtime");
    }
  });

  it("executes built-in slash-command skills with citations", async () => {
    const skills = await SkillsSubsystem.create({
      cacheDir: dir,
      manifest: [],
      autoSync: false,
    });
    const command = skills.resolveSlashCommand("/review check the integration");
    expect(command).toBeDefined();

    const model: SkillExecutorModel = {
      primary: "primary",
      small: "small",
      complete: async (params) => {
        if (params.model === "small") {
          return {
            text: JSON.stringify({
              satisfied: true,
              evidence: "file/line finding included",
              reason: "",
            }),
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
          };
        }
        return {
          text: "Concrete review output.",
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        };
      },
    };

    const result = await skills.execute({
      skill: command!.skill,
      goal: command!.goal,
      scope: "test",
      model,
    });

    expect(result.outcome).toBe("completed");
    expect(result.answer).toContain("Concrete review output");
    expect(result.citations).toEqual([
      {
        sourceId: "andrea/builtin-skills",
        sourcePath: "builtin/code-review-and-quality/SKILL.md",
        upstreamUrl: undefined,
      },
    ]);
  });

  it("loads existing cached skills when autosync is disabled", async () => {
    const skillDir = join(dir, "addyosmani__agent-skills", "skills", "spec-driven-development");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: spec-driven-development",
        "description: Cached spec workflow.",
        "tags: [spec]",
        "---",
        "",
        "## Process",
        "### 1. Cached Step",
        "Use cached workflow content.",
      ].join("\n"),
      "utf8",
    );

    const skills = await SkillsSubsystem.create({
      cacheDir: dir,
      autoSync: false,
    });

    const resolved = skills.resolveSlashCommand("/spec cached request");
    expect(resolved?.skill.sourceId).toBe("addyosmani/agent-skills");
    expect(resolved?.skill.description).toBe("Cached spec workflow.");
  });
});
