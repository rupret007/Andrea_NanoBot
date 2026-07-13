import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const image =
  process.env.ANDREA_CONTAINER_CANARY_IMAGE || 'nanoclaw-agent:canary';
const temporaryBase = path.join(repoRoot, 'data', 'runtime');
fs.mkdirSync(temporaryBase, { recursive: true });
const temporaryRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(temporaryBase, 'container-mount-canary-')),
);

function writeReadableFile(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
}

function addBindMount(args, source, destination, readonly = false) {
  args.push(
    '--mount',
    [
      'type=bind',
      `src=${source}`,
      `dst=${destination}`,
      readonly ? 'readonly' : null,
    ]
      .filter(Boolean)
      .join(','),
  );
}

function runContainer(baseArgs, shellScript, phase) {
  const result = spawnSync('docker', [...baseArgs, image, '-ec', shellScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Container mount ${phase} failed (${result.status ?? 'no status'}).\n${result.stdout}${result.stderr}`,
  );
}

try {
  const sessionDir = path.join(temporaryRoot, 'session', '.claude');
  const groupDir = path.join(temporaryRoot, 'group-workspace');
  const controlsDir = path.join(temporaryRoot, 'trusted-controls');
  const skillsDir = path.join(controlsDir, 'skills');
  const pluginsDir = path.join(controlsDir, 'plugins');
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o777 });
  fs.chmodSync(sessionDir, 0o777);
  fs.mkdirSync(groupDir, { recursive: true, mode: 0o777 });
  fs.chmodSync(groupDir, 0o777);
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(pluginsDir, { recursive: true, mode: 0o755 });

  // Nested bind mount targets exist in the writable parent, but the trusted
  // overlays must prevent the container from mutating these backing entries.
  writeReadableFile(
    path.join(sessionDir, 'settings.json'),
    'session placeholder\n',
  );
  writeReadableFile(
    path.join(sessionDir, 'CLAUDE.md'),
    'session placeholder\n',
  );
  fs.mkdirSync(path.join(sessionDir, 'skills'), { mode: 0o777 });
  fs.mkdirSync(path.join(sessionDir, 'plugins'), { mode: 0o777 });
  writeReadableFile(path.join(groupDir, 'CLAUDE.md'), 'group placeholder\n');

  const settingsFile = path.join(controlsDir, 'settings.json');
  const guidanceFile = path.join(controlsDir, 'CLAUDE.md');
  const groupGuidanceFile = path.join(controlsDir, 'group-CLAUDE.md');
  const skillMarker = path.join(skillsDir, 'SKILL.md');
  const pluginMarker = path.join(pluginsDir, 'plugin.json');
  writeReadableFile(settingsFile, '{"managed":true}\n');
  writeReadableFile(guidanceFile, '# Managed guidance\n');
  writeReadableFile(groupGuidanceFile, '# Managed group guidance\n');
  writeReadableFile(skillMarker, '# Managed skill\n');
  writeReadableFile(pluginMarker, '{"managed":true}\n');

  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--entrypoint',
    '/bin/sh',
  ];
  addBindMount(dockerArgs, sessionDir, '/home/node/.claude');
  addBindMount(dockerArgs, groupDir, '/workspace/group');
  addBindMount(
    dockerArgs,
    settingsFile,
    '/home/node/.claude/settings.json',
    true,
  );
  addBindMount(dockerArgs, guidanceFile, '/home/node/.claude/CLAUDE.md', true);
  addBindMount(dockerArgs, skillsDir, '/home/node/.claude/skills', true);
  addBindMount(dockerArgs, pluginsDir, '/home/node/.claude/plugins', true);
  addBindMount(
    dockerArgs,
    groupGuidanceFile,
    '/workspace/group/CLAUDE.md',
    true,
  );
  addBindMount(
    dockerArgs,
    path.join(repoRoot, 'container', 'agent-runner', 'src'),
    '/app/src',
    true,
  );
  runContainer(
    dockerArgs,
    String.raw`
      test "$(id -u)" != "0"
      test -r /home/node/.claude/settings.json
      test -r /home/node/.claude/CLAUDE.md
      test -r /home/node/.claude/skills/SKILL.md
      test -r /home/node/.claude/plugins/plugin.json
      test -r /workspace/group/CLAUDE.md
      rm -rf /tmp/runner-canary-dist
      cd /app
      ./node_modules/.bin/tsc --outDir /tmp/runner-canary-dist
      test -r /tmp/runner-canary-dist/index.js
      cd /workspace/group
      printf 'session-ok\n' > /home/node/.claude/session-proof
      printf 'group-ok\n' > /workspace/group/group-session-proof
      if printf 'blocked\n' > /home/node/.claude/settings.json 2>/dev/null; then exit 20; fi
      if printf 'blocked\n' > /home/node/.claude/CLAUDE.md 2>/dev/null; then exit 21; fi
      if touch /home/node/.claude/skills/write-proof 2>/dev/null; then exit 22; fi
      if touch /home/node/.claude/plugins/write-proof 2>/dev/null; then exit 23; fi
      if touch /app/src/write-proof 2>/dev/null; then exit 24; fi
      if printf 'blocked\n' > /workspace/group/CLAUDE.md 2>/dev/null; then exit 25; fi
    `,
    'write-isolation phase',
  );
  runContainer(
    dockerArgs,
    String.raw`
      test "$(cat /home/node/.claude/session-proof)" = "session-ok"
      test "$(cat /workspace/group/group-session-proof)" = "group-ok"
      printf 'session-ok-2\n' > /home/node/.claude/session-proof-2
    `,
    'restart-persistence phase',
  );
  assert.equal(
    fs.readFileSync(path.join(sessionDir, 'session-proof'), 'utf8'),
    'session-ok\n',
  );
  assert.equal(
    fs.readFileSync(path.join(sessionDir, 'session-proof-2'), 'utf8'),
    'session-ok-2\n',
  );
  assert.equal(
    fs.readFileSync(path.join(groupDir, 'group-session-proof'), 'utf8'),
    'group-ok\n',
  );
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"managed":true}\n');
  assert.equal(fs.readFileSync(guidanceFile, 'utf8'), '# Managed guidance\n');
  assert.equal(
    fs.readFileSync(groupGuidanceFile, 'utf8'),
    '# Managed group guidance\n',
  );
  assert.equal(fs.readFileSync(skillMarker, 'utf8'), '# Managed skill\n');
  assert.equal(fs.readFileSync(pluginMarker, 'utf8'), '{"managed":true}\n');
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'container', 'agent-runner', 'src', 'write-proof'),
    ),
    false,
  );
  console.log('Container mount canary passed.');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
