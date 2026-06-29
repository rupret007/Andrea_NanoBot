import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AuditLog } from "../src/safety/index.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  stateDir: string;
  checks: DoctorCheck[];
}

const INTEGRATION_REQUIREMENTS: Record<string, readonly string[]> = {
  notion: ["NOTION_TOKEN"],
  linear: ["LINEAR_API_KEY"],
  github: ["GITHUB_TOKEN"],
  spotify: ["SPOTIFY_ACCESS_TOKEN"],
  homeassistant: ["HASS_URL", "HASS_TOKEN"],
  drive: ["GOOGLE_OAUTH_TOKEN"],
  web: ["EXA_API_KEY", "BRAVE_API_KEY"],
};

export async function runAgiDoctor(
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorReport> {
  const stateDir = expandHome(env.ANDREA_STATE_DIR ?? "~/.andrea");
  const checks: DoctorCheck[] = [];
  checks.push(await checkStateDir(stateDir));
  checks.push(checkModelProviders(env));
  checks.push(checkModelSelection(env));
  checks.push(checkTelegramCanary(env));
  checks.push(...checkIntegrations(env));
  checks.push(await checkAuditChain(join(stateDir, "audit", "audit.jsonl")));
  return {
    ok: !checks.some((check) => check.status === "fail"),
    stateDir,
    checks,
  };
}

function checkModelProviders(env: Record<string, string | undefined>): DoctorCheck {
  const providers = [
    env.ANTHROPIC_API_KEY ? "anthropic" : "",
    env.OPENAI_API_KEY ? "openai" : "",
    env.OLLAMA_BASE_URL ? "ollama" : "",
  ].filter(Boolean);
  if (providers.length) {
    return { name: "model_providers", status: "ok", detail: providers.join(",") };
  }
  return {
    name: "model_providers",
    status: "fail",
    detail:
      "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL/local Ollama before enabling AGI.",
  };
}

function checkModelSelection(env: Record<string, string | undefined>): DoctorCheck {
  const primary = env.ANDREA_PRIMARY_MODEL ?? "claude-sonnet-4-6";
  const small = env.ANDREA_SMALL_MODEL ?? "claude-haiku-4-5-20251001";
  return {
    name: "model_selection",
    status: "ok",
    detail: `primary=${primary} small=${small}`,
  };
}

async function checkStateDir(stateDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(stateDir, { recursive: true });
    const probe = join(stateDir, `.doctor-${process.pid}-${Date.now()}`);
    await writeFile(probe, "ok\n", "utf8");
    await rm(probe, { force: true });
    return { name: "state_dir", status: "ok", detail: `${stateDir} writable` };
  } catch (err) {
    return {
      name: "state_dir",
      status: "fail",
      detail: `${stateDir} is not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkTelegramCanary(env: Record<string, string | undefined>): DoctorCheck {
  if (!truthy(env.ANDREA_USE_AGI)) {
    return { name: "telegram_canary", status: "warn", detail: "ANDREA_USE_AGI is disabled." };
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    return {
      name: "telegram_canary",
      status: "ok",
      detail: "ANDREA_USE_AGI=1 and TELEGRAM_BOT_TOKEN is configured.",
    };
  }
  return {
    name: "telegram_canary",
    status: "fail",
    detail: "ANDREA_USE_AGI=1 but TELEGRAM_BOT_TOKEN is missing.",
  };
}

function checkIntegrations(env: Record<string, string | undefined>): DoctorCheck[] {
  return Object.entries(INTEGRATION_REQUIREMENTS).map(([id, keys]) => {
    const configured = keys.filter((key) => Boolean(env[key]));
    if (configured.length === 0) {
      return {
        name: `integration:${id}`,
        status: "warn" as const,
        detail: "disabled; no credentials configured",
      };
    }
    const complete =
      id === "web"
        ? Boolean(env.EXA_API_KEY || env.BRAVE_API_KEY)
        : keys.every((key) => Boolean(env[key]));
    return complete
      ? {
          name: `integration:${id}`,
          status: "ok" as const,
          detail: `configured keys=${configured.join(",")}`,
        }
      : {
          name: `integration:${id}`,
          status: "fail" as const,
          detail: `partial credentials; missing ${keys.filter((key) => !env[key]).join(",")}`,
        };
  });
}

async function checkAuditChain(auditPath: string): Promise<DoctorCheck> {
  try {
    await access(auditPath);
  } catch {
    try {
      await mkdir(dirname(auditPath), { recursive: true });
    } catch {
      // State-dir check reports write failures.
    }
    return { name: "audit_chain", status: "warn", detail: `${auditPath} does not exist yet` };
  }
  try {
    const s = await stat(auditPath);
    if (s.size === 0) return { name: "audit_chain", status: "ok", detail: "empty audit log" };
    const result = await new AuditLog(auditPath).verifyChain();
    return result.ok
      ? { name: "audit_chain", status: "ok", detail: "hash chain verified" }
      : {
          name: "audit_chain",
          status: "fail",
          detail: `line ${result.brokenAtLine ?? "?"}: ${result.reason ?? "unknown chain failure"}`,
        };
  } catch (err) {
    return {
      name: "audit_chain",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes((v ?? "").toLowerCase());
}

function printReport(report: DoctorReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`AGI doctor stateDir=${report.stateDir}`);
  for (const check of report.checks) {
    console.log(`${check.status}: ${check.name} - ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const report = await runAgiDoctor();
  printReport(report, json);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
