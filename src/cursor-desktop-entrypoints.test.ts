import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectCursorDesktopEntrypoints } from './cursor-desktop-entrypoints.js';

const roots: string[] = [];

function executable(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-entrypoint-'));
  roots.push(root);
  const target = path.join(root, name);
  fs.writeFileSync(target, '# fixture\n', { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('inspectCursorDesktopEntrypoints', () => {
  it('does not equate a regular Cursor launcher with a standalone agent', () => {
    const cursor = executable('cursor');
    const result = inspectCursorDesktopEntrypoints({
      PATH: path.dirname(cursor),
      CURSOR_DESKTOP_CLI_PATH: cursor,
    });
    expect(result.desktopCliPath).toBe(fs.realpathSync(cursor));
    expect(result.agentCliPath).toBeNull();
    expect(result.agentExecutionStatus).toBe('not_installed');
    expect(result.detail).toMatch(/may auto-install software/);
  });

  it('recognizes only a separately installed executable as an agent candidate', () => {
    const agent = executable('cursor-agent');
    const result = inspectCursorDesktopEntrypoints({
      PATH: '',
      CURSOR_DESKTOP_AGENT_CLI_PATH: agent,
    });
    expect(result.agentCliPath).toBe(fs.realpathSync(agent));
    expect(result.agentExecutionStatus).toBe('installed_needs_auth_proof');
    expect(result.detail).toMatch(/still require proof/);
  });
});
