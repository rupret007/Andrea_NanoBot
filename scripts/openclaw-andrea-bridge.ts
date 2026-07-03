import { execFileSync } from 'node:child_process';

import {
  ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS,
  ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
  buildAndreaBlueBubblesMcpConfig,
  buildAndreaBlueBubblesMcpSetConfig,
  formatOpenClawAndreaBridgeDebugStatusLines,
  getOpenClawAndreaBridgeStatusSummaryWithHealth,
} from '../src/openclaw-andrea-bridge.js';
import {
  parseOpenClawJsonOutput,
  redactOpenClawText,
  resolveOpenClawConfig,
} from '../src/openclaw-connector.js';

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  tsx scripts/openclaw-andrea-bridge.ts status [--json] [--repo-root <path>]',
      '  tsx scripts/openclaw-andrea-bridge.ts install [--json] [--repo-root <path>]',
      '  tsx scripts/openclaw-andrea-bridge.ts probe [--json]',
    ].join('\n'),
  );
}

function readArg(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function buildOpenClawChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_GATEWAY_URL;
  return env;
}

function runOpenClaw(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 30000,
    env: buildOpenClawChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commandErrorDetail(err: unknown): string {
  const record =
    err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'OpenClaw bridge command failed.';
  return redactOpenClawText(stderr || stdout || message);
}

function sanitizeJsonValue(value: unknown): unknown {
  const redacted = redactOpenClawText(JSON.stringify(value), 20000);
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    return redacted;
  }
}

async function printStatus(params: {
  json: boolean;
  repoRoot: string;
}): Promise<void> {
  const status = await getOpenClawAndreaBridgeStatusSummaryWithHealth({
    repoRoot: params.repoRoot,
  });
  if (params.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(formatOpenClawAndreaBridgeDebugStatusLines(status).join('\n'));
  if (!status.controlEnv.configured) {
    console.log('Required local .env values:');
    for (const value of status.controlEnv.requiredValues) {
      console.log(`- ${value}`);
    }
  }
}

async function installBridge(params: {
  json: boolean;
  repoRoot: string;
}): Promise<void> {
  const openClaw = resolveOpenClawConfig();
  const config = buildAndreaBlueBubblesMcpConfig(params.repoRoot);
  const setConfig = buildAndreaBlueBubblesMcpSetConfig(config);

  runOpenClaw(openClaw.cli, [
    'mcp',
    'set',
    ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
    JSON.stringify(setConfig),
  ]);
  runOpenClaw(openClaw.cli, [
    'mcp',
    'tools',
    ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
    '--include',
    config.include.join(','),
    '--exclude',
    config.exclude.join(','),
  ]);
  runOpenClaw(openClaw.cli, ['mcp', 'reload']);

  await printStatus(params);
}

function probeBridge(params: { json: boolean }): void {
  const openClaw = resolveOpenClawConfig();
  const stdout = runOpenClaw(openClaw.cli, [
    'mcp',
    'probe',
    ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
    '--json',
  ]);
  const parsed = parseOpenClawJsonOutput(stdout);
  const raw = JSON.stringify(parsed);
  const toolCount = ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.filter((toolName) =>
    raw.includes(toolName),
  ).length;
  const directSendExposed = raw.includes('bluebubbles_send');
  const ok =
    toolCount === ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.length &&
    !directSendExposed;

  if (params.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          serverName: ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
          requiredToolCount: ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.length,
          matchedRequiredToolCount: toolCount,
          directSendExposed,
          result: sanitizeJsonValue(parsed),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    [
      `OpenClaw Andrea bridge probe: ${ok ? 'ok' : 'degraded'} (${ANDREA_BLUEBUBBLES_MCP_SERVER_NAME})`,
      `Required tool mentions: ${toolCount}/${ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.length}`,
      `Direct send exposed: ${directSendExposed ? 'yes' : 'no'}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  const json = args.includes('--json');
  const repoRoot = readArg(args, '--repo-root') || process.cwd();

  try {
    switch (command.toLowerCase()) {
      case 'status':
        await printStatus({ json, repoRoot });
        return;
      case 'install':
        await installBridge({ json, repoRoot });
        return;
      case 'probe':
        probeBridge({ json });
        return;
      default:
        printUsage();
        process.exit(command ? 1 : 0);
    }
  } catch (err) {
    const detail = commandErrorDetail(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: detail }, null, 2));
    } else {
      console.error(detail);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    redactOpenClawText(err instanceof Error ? err.message : String(err)),
  );
  process.exit(1);
});
