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
  const nodeCommand = process.execPath;

  const runNodeScript = (
    label: string,
    scriptPath: string,
    extraArgs: string[] = [],
  ): Step => ({
    name: label,
    command: nodeCommand,
    args: [scriptPath, ...extraArgs],
  });

  const baseSteps: Step[] = [
    runNodeScript('format-check', './node_modules/prettier/bin/prettier.cjs', [
      '--check',
      'src/**/*.ts',
    ]),
    runNodeScript('typecheck', './node_modules/typescript/bin/tsc', [
      '--noEmit',
    ]),
    runNodeScript('lint', './node_modules/eslint/bin/eslint.js', ['src/']),
    runNodeScript('unit-tests', './node_modules/vitest/vitest.mjs', ['run']),
    runNodeScript('build', './node_modules/typescript/bin/tsc'),
  ];

  if (includeLiveVerify) {
    baseSteps.push({
      name: 'live-verify',
      command: nodeCommand,
      args: [
        './node_modules/tsx/dist/cli.mjs',
        './setup/index.ts',
        '--step',
        'verify',
      ],
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
