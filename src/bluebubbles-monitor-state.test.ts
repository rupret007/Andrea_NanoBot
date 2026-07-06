import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  createDefaultBlueBubblesMonitorState,
  readBlueBubblesMonitorState,
  reconcileBlueBubblesWebhookCatchUp,
  writeBlueBubblesMonitorState,
} from './bluebubbles-monitor-state.js';

describe('BlueBubbles monitor state', () => {
  it('clears stale missed-inbound detection after webhook freshness catches up', () => {
    const reconciled = reconcileBlueBubblesWebhookCatchUp({
      ...createDefaultBlueBubblesMonitorState('2026-04-08T12:00:00.000Z'),
      detectionState: 'suspected_missed_inbound',
      detectionDetail:
        'BlueBubbles server saw newer chat activity than Andrea on the webhook side.',
      detectionNextAction: 'Check the webhook target.',
      mostRecentServerSeenAt: '2026-04-08T11:56:30.000Z',
      mostRecentServerSeenChatJid: 'bb:iMessage;-;+14695550123',
      mostRecentWebhookObservedAt: '2026-04-08T11:58:00.000Z',
      mostRecentWebhookObservedChatJid: 'bb:iMessage;-;+14695550123',
      recentEvidence: [
        {
          kind: 'missed_inbound',
          chatJid: 'bb:iMessage;-;+14695550123',
          signature: 'bb:missed-msg-1',
          observedAt: '2026-04-08T11:56:30.000Z',
        },
      ],
    });

    expect(reconciled.detectionState).toBe('healthy');
    expect(reconciled.detectionDetail).toBeNull();
    expect(reconciled.recentEvidence).toEqual([]);
  });

  it('persists state under data/runtime with a POSIX-safe path', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bb-monitor-state-'),
    );
    try {
      writeBlueBubblesMonitorState(
        {
          ...createDefaultBlueBubblesMonitorState('2026-04-08T12:00:00.000Z'),
          activeBaseUrl: 'http://127.0.0.1:1234',
        },
        projectRoot,
      );

      const expectedPath = path.join(
        projectRoot,
        'data',
        'runtime',
        'bluebubbles-monitor-state.json',
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(readBlueBubblesMonitorState(projectRoot).activeBaseUrl).toBe(
        'http://127.0.0.1:1234',
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('migrates legacy backslash-named state files on read and write', () => {
    if (process.platform === 'win32') {
      // On Windows the legacy path and the fixed path resolve to the same file.
      return;
    }
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bb-monitor-legacy-'),
    );
    try {
      const runtimeStateDir = path.join(projectRoot, 'data', 'runtime');
      fs.mkdirSync(runtimeStateDir, { recursive: true });
      // Pre-fix builds wrote to a file literally named
      // "runtime\bluebubbles-monitor-state.json" inside data/.
      const legacyPath = `${runtimeStateDir}\\bluebubbles-monitor-state.json`;
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          ...createDefaultBlueBubblesMonitorState('2026-04-08T12:00:00.000Z'),
          activeBaseUrl: 'http://127.0.0.1:1234',
        }),
      );

      const migrated = readBlueBubblesMonitorState(projectRoot);
      expect(migrated.activeBaseUrl).toBe('http://127.0.0.1:1234');

      writeBlueBubblesMonitorState(migrated, projectRoot);
      expect(
        fs.existsSync(
          path.join(runtimeStateDir, 'bluebubbles-monitor-state.json'),
        ),
      ).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
