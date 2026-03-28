import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

function detectPythonCommand(): { command: string; args: string[] } {
  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'python', args: [] },
          { command: 'py', args: ['-3'] },
          { command: 'python3', args: [] },
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] },
        ];

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, '--version'],
      {
        stdio: 'ignore',
      },
    );
    if (probe.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    'No usable Python interpreter was found for the claw skill test',
  );
}

function writeRuntimeStub(binDir: string): void {
  if (process.platform === 'win32') {
    for (const runtimeName of ['docker.cmd', 'podman.cmd']) {
      const runtimePath = path.join(binDir, runtimeName);
      fs.writeFileSync(
        runtimePath,
        [
          '@echo off',
          'more >NUL',
          'echo ---NANOCLAW_OUTPUT_START---',
          'echo {"status":"success","result":"4","newSessionId":"sess-1"}',
          'echo ---NANOCLAW_OUTPUT_END---',
          'powershell -NoProfile -Command "Start-Sleep -Seconds 30"',
          '',
        ].join('\r\n'),
      );
    }
    return;
  }

  const runtimeBody = `#!/bin/sh
cat >/dev/null
printf '%s\n' '---NANOCLAW_OUTPUT_START---' '{"status":"success","result":"4","newSessionId":"sess-1"}' '---NANOCLAW_OUTPUT_END---'
sleep 30
`;

  for (const runtimeName of ['docker', 'podman']) {
    const runtimePath = path.join(binDir, runtimeName);
    fs.writeFileSync(runtimePath, runtimeBody);
    fs.chmodSync(runtimePath, 0o755);
  }
}

describe('claw skill script', () => {
  it(
    'exits zero after successful structured output even if the runtime is terminated',
    { timeout: 20000 },
    () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'claw-skill-test-'),
      );
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      writeRuntimeStub(binDir);

      const python = detectPythonCommand();
      const result = spawnSync(
        python.command,
        [
          ...python.args,
          '.claude/skills/claw/scripts/claw',
          '-j',
          'tg:123',
          'What is 2+2?',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            NANOCLAW_DIR: tempDir,
            PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
          },
          timeout: 15000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toContain('4');
      expect(result.stderr).toContain('[session: sess-1]');
    },
  );
});
