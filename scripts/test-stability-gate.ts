import { spawnSync } from 'child_process';

type Step = {
  name: string;
  command: string;
  args: string[];
};

function runStep(step: Step): void {
  const pretty = `${step.command} ${step.args.join(' ')}`.trim();
  console.log(`\n[stability] START ${step.name}: ${pretty}`);

  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.error) {
    throw new Error(
      `[stability] ${step.name} failed after ${durationSeconds}s: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `[stability] ${step.name} exited with code ${result.status} after ${durationSeconds}s`,
    );
  }

  console.log(`[stability] PASS ${step.name} (${durationSeconds}s)`);
}

function resolveSteps(includeLiveVerify: boolean): Step[] {
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const runNode22 = (
    label: string,
    scriptPath: string,
    extraArgs: string[] = [],
  ): Step => ({
    name: label,
    command: npxCommand,
    args: ['-y', '-p', 'node@22', 'node', scriptPath, ...extraArgs],
  });

  const baseSteps: Step[] = [
    runNode22('format-check', './node_modules/prettier/bin/prettier.cjs', [
      '--check',
      'src/**/*.ts',
    ]),
    runNode22('typecheck', './node_modules/typescript/bin/tsc', ['--noEmit']),
    runNode22('lint', './node_modules/eslint/bin/eslint.js', ['src/']),
    runNode22('unit-tests', './node_modules/vitest/vitest.mjs', ['run']),
    runNode22('build', './node_modules/typescript/bin/tsc'),
  ];

  if (includeLiveVerify) {
    baseSteps.push({
      name: 'live-verify',
      command: npmCommand,
      args: ['run', 'setup', '--', '--step', 'verify'],
    });
  }

  return baseSteps;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const includeLiveVerify = args.has('--with-live-verify');
  const rounds = 3;
  const steps = resolveSteps(includeLiveVerify);

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n[stability] ===== ROUND ${round}/${rounds} =====`);
    for (const step of steps) {
      runStep({ ...step, name: `round-${round}:${step.name}` });
    }
    console.log(`[stability] ROUND ${round}/${rounds} PASSED`);
  }

  console.log(`\n[stability] COMPLETE: ${rounds}/${rounds} successful rounds`);
}

main();
