import { spawnSync } from 'child_process';

type Step = {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
};

function runStep(step: Step): void {
  const pretty = `${step.command} ${step.args.join(' ')}`.trim();
  console.log(`\n[major-test] START ${step.name}: ${pretty}`);

  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.error) {
    throw new Error(
      `[major-test] ${step.name} failed after ${durationSeconds}s: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `[major-test] ${step.name} exited with code ${result.status} after ${durationSeconds}s`,
    );
  }

  console.log(`[major-test] PASS ${step.name} (${durationSeconds}s)`);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const skipLiveVerify = args.has('--skip-live-verify');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const steps: Step[] = [
    {
      name: 'format-check',
      command: npmCommand,
      args: ['run', 'format:check'],
      enabled: true,
    },
    {
      name: 'typecheck',
      command: npmCommand,
      args: ['run', 'typecheck'],
      enabled: true,
    },
    {
      name: 'lint',
      command: npmCommand,
      args: ['run', 'lint'],
      enabled: true,
    },
    {
      name: 'unit-tests',
      command: npmCommand,
      args: ['run', 'test'],
      enabled: true,
    },
    {
      name: 'build',
      command: npmCommand,
      args: ['run', 'build'],
      enabled: true,
    },
    {
      name: 'live-verify',
      command: npmCommand,
      args: ['run', 'setup', '--', '--step', 'verify'],
      enabled: !skipLiveVerify,
    },
  ];

  for (const step of steps) {
    if (!step.enabled) {
      console.log(`\n[major-test] SKIP ${step.name}`);
      continue;
    }
    runStep(step);
  }

  console.log('\n[major-test] COMPLETE');
}

main();
