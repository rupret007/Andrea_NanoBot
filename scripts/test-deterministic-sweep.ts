import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';

interface PackageJson {
  scripts?: Record<string, string>;
}

interface TestScript {
  name: string;
  command: string;
}

interface ExcludedTestScript extends TestScript {
  reason: string;
}

interface TestResult {
  name: string;
  ok: boolean;
  durationSeconds: number;
}

const args = new Set(process.argv.slice(2));
const listOnly = args.has('--list');
const verbose = args.has('--verbose');
const bail = args.has('--bail');

const packageJsonPath = fileURLToPath(
  new URL('../package.json', import.meta.url),
);
const repoRoot = dirname(packageJsonPath);
const packageJson = JSON.parse(
  readFileSync(packageJsonPath, 'utf8'),
) as PackageJson;

const duplicateOrInteractive = new Map<string, string>([
  ['test:watch', 'interactive watch mode'],
  ['test:major', 'aggregate gate; run separately when needed'],
  ['test:major:ci', 'aggregate CI gate; run separately when needed'],
  ['test:agent-runner', 'container package gate; run separately'],
  ['test:agi', 'AGI Vitest suite; run separately'],
  ['test:deterministic:sweep', 'this runner'],
]);

const credentialedCouncilTiers = new Set([
  'test:council:small',
  'test:council:medium',
  'test:council:large',
  'test:council:xl',
  'test:council:ladder',
  'test:council:ultrathink',
]);

function exclusionReason(name: string, command: string): string | null {
  const duplicate = duplicateOrInteractive.get(name);
  if (duplicate) return duplicate;
  if (credentialedCouncilTiers.has(name)) return 'cloud-provider council tier';
  if (name.endsWith(':live') || command.includes('--live')) return 'live gate';
  if (command.includes('--with-live-verify')) return 'live verification gate';
  if (name.endsWith(':baseline') || command.includes('--baseline')) {
    return 'baseline writer';
  }
  return null;
}

function formatDuration(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function tailLines(value: string, count = 80): string {
  return value.split('\n').slice(-count).join('\n').trim();
}

function isNetworkGuardPreloadArgument(argument: string): boolean {
  const normalized = argument.replace(/\\/g, '/');
  return (
    normalized.startsWith('--import=') &&
    normalized.endsWith('/scripts/test-network-guard.mjs')
  );
}

function deterministicCommandArgs(script: TestScript): string[] {
  if (
    !script.command.startsWith('node ') ||
    /[\r\n;&|<>`$'"\\]/.test(script.command)
  ) {
    throw new Error(
      `Deterministic script ${script.name} must be a plain argv-safe Node command.`,
    );
  }
  const tokens = script.command.trim().split(/\s+/);
  if (tokens[0] !== 'node' || tokens.length < 2) {
    throw new Error(
      `Deterministic script ${script.name} has no executable Node target.`,
    );
  }
  // buildHermeticTestEnv installs the portable file: preload through
  // NODE_OPTIONS. Remove every command-local copy so the guarded child imports
  // it exactly once; direct npm invocation retains its own explicit guard.
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (isNetworkGuardPreloadArgument(tokens[index]!)) tokens.splice(index, 1);
  }
  if (
    tokens[1] === 'scripts/run-with-pinned-node.mjs' &&
    tokens[2] === './node_modules/tsx/dist/cli.mjs' &&
    tokens.length >= 4
  ) {
    // The tsx CLI re-spawns Node with its own loader flags. Launch TypeScript
    // through Node's registered tsx import instead so the guarded process
    // never needs to delegate control to another loader-bearing child.
    return ['--import=tsx', ...tokens.slice(3)];
  }
  if (
    tokens[1] === 'scripts/run-with-pinned-node.mjs' &&
    tokens[2] === '--import=tsx' &&
    tokens.length >= 4
  ) {
    // This is the equivalent pinned launcher used by certification scripts.
    // The sweep already runs on the pinned executable, so unwrap exactly this
    // trusted form. Otherwise the guard-preloaded wrapper would try to spawn a
    // second Node process with a loader flag, which the guard correctly denies.
    return tokens.slice(2);
  }
  return tokens.slice(1);
}

const selected: TestScript[] = [];
const excluded: ExcludedTestScript[] = [];

for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (!name.startsWith('test:')) continue;
  const reason = exclusionReason(name, command);
  if (reason) excluded.push({ name, command, reason });
  else selected.push({ name, command });
}

for (const name of ['certify:commitment-intelligence']) {
  const command = packageJson.scripts?.[name];
  if (!command) {
    throw new Error(
      `Missing required deterministic certification script ${name}.`,
    );
  }
  selected.push({ name, command });
}

if (listOnly) {
  console.log('Selected deterministic test scripts:');
  for (const script of selected) console.log(`- ${script.name}`);
  console.log('');
  console.log('Excluded test scripts:');
  for (const script of excluded) {
    console.log(`- ${script.name}: ${script.reason}`);
  }
  process.exit(0);
}

console.log(
  `Running ${selected.length} deterministic test scripts (${excluded.length} excluded).`,
);
console.log('Use --list to inspect the exact include/exclude set.');

const started = performance.now();
const results: TestResult[] = [];

for (const script of selected) {
  const scriptStarted = performance.now();
  const result = spawnSync(process.execPath, deterministicCommandArgs(script), {
    cwd: repoRoot,
    encoding: 'utf8',
    env: buildHermeticTestEnv({
      ...process.env,
      CI: process.env.CI || '1',
    }),
    maxBuffer: 30 * 1024 * 1024,
  });
  const durationSeconds = (performance.now() - scriptStarted) / 1000;
  const ok = result.status === 0;
  results.push({ name: script.name, ok, durationSeconds });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${script.name} ${formatDuration(durationSeconds)}`,
  );

  if (verbose || !ok) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (output) {
      console.log(`--- ${script.name} output ---`);
      console.log(verbose ? output : tailLines(output));
      console.log(`--- end ${script.name} output ---`);
    }
  }

  if (!ok && bail) break;
}

const failed = results.filter((result) => !result.ok);
const durationSeconds = (performance.now() - started) / 1000;

console.log(
  `Deterministic sweep summary: ${results.length - failed.length}/${results.length} passed in ${formatDuration(durationSeconds)}.`,
);

if (failed.length > 0) {
  console.error(
    `Failed scripts: ${failed.map((result) => result.name).join(', ')}`,
  );
  process.exit(1);
}
