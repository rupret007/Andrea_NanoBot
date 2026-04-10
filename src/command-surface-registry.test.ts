import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMMAND_SURFACE_REGISTRY,
  INTERNAL_BUTTON_COMMAND_SURFACES,
  OPERATOR_SLASH_COMMAND_SURFACES,
  PUBLIC_TELEGRAM_COMMAND_SURFACES,
  getTelegramBotMenuCommands,
} from './command-surface-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

describe('command surface registry', () => {
  it('keeps the public Telegram command set small and menu-derived', () => {
    expect(PUBLIC_TELEGRAM_COMMAND_SURFACES.map((entry) => entry.preferredAlias)).toEqual([
      '/start',
      '/help',
      '/commands',
      '/features',
      '/ping',
      '/chatid',
      '/registermain',
      '/cursor_status',
    ]);

    expect(getTelegramBotMenuCommands()).toEqual(
      PUBLIC_TELEGRAM_COMMAND_SURFACES.map((entry) => ({
        command: entry.preferredAlias.replace(/^\//, ''),
        description: entry.menuDescription ?? entry.summary,
      })),
    );
  });

  it('represents every taught operator command family in the registry', () => {
    const preferredAliases = new Set(
      OPERATOR_SLASH_COMMAND_SURFACES.map((entry) => entry.preferredAlias),
    );

    expect(preferredAliases).toEqual(
      new Set([
        '/remote-control',
        '/remote-control-end',
        '/cursor',
        '/cursor-models',
        '/cursor-test',
        '/cursor-jobs',
        '/cursor-create',
        '/cursor-sync',
        '/cursor-select',
        '/cursor-ui',
        '/cursor-stop',
        '/cursor-followup',
        '/cursor-terminal',
        '/cursor-terminal-help',
        '/cursor-terminal-status',
        '/cursor-terminal-log',
        '/cursor-terminal-stop',
        '/cursor-conversation',
        '/cursor-results',
        '/cursor-download',
        '/runtime-status',
        '/runtime-jobs',
        '/runtime-create',
        '/runtime-job',
        '/runtime-followup',
        '/runtime-stop',
        '/runtime-logs',
        '/debug-status',
        '/debug-level',
        '/debug-reset',
        '/debug-logs',
        '/alexa-status',
        '/amazon-status',
        '/amazon-search',
        '/purchase-request',
        '/purchase-requests',
        '/purchase-approve',
        '/purchase-cancel',
      ]),
    );

    expect(
      OPERATOR_SLASH_COMMAND_SURFACES.filter(
        (entry) => entry.truthClass === 'disabled',
      ).map((entry) => entry.preferredAlias),
    ).toEqual(['/remote-control', '/remote-control-end']);
  });

  it('tracks hidden button-backing families separately from public slash help', () => {
    expect(
      INTERNAL_BUTTON_COMMAND_SURFACES.map((entry) => entry.preferredAlias),
    ).toEqual([
      '/cursor-ui *',
      '/bundle-*',
      '/runtime-* card actions',
      'review controls',
    ]);

    expect(
      COMMAND_SURFACE_REGISTRY.some(
        (entry) =>
          entry.preferredAlias === '/cursor-ui *' &&
          entry.audience === 'internal',
      ),
    ).toBe(true);
  });
});

describe('command surface docs', () => {
  it('links the formal command reference from the main docs', () => {
    const readme = readDoc('README.md');
    const docsIndex = readDoc('docs', 'README.md');
    const adminGuide = readDoc('docs', 'ADMIN_GUIDE.md');

    expect(readme).toContain('docs/COMMAND_SURFACE_REFERENCE.md');
    expect(docsIndex).toContain('COMMAND_SURFACE_REFERENCE.md');
    expect(adminGuide).toContain('COMMAND_SURFACE_REFERENCE.md');
  });

  it('keeps public-facing command docs free of operator-only command leakage', () => {
    const publicGuide = readDoc('docs', 'CHANNEL_COMMANDS_AND_ONBOARDING.md');

    expect(publicGuide).toContain('/cursor_status');
    expect(publicGuide).not.toContain('/alexa-status');
    expect(publicGuide).not.toContain('/debug-status');
    expect(publicGuide).not.toContain('/amazon-search');
    expect(publicGuide).not.toContain('/cursor-ui');
    expect(publicGuide).not.toContain('/bundle-toggle');
  });

  it('keeps host-proof docs status-led for Alexa and BlueBubbles', () => {
    const alexaGuide = readDoc('docs', 'ALEXA_VOICE_INTEGRATION.md');
    const bluebubblesGuide = readDoc('docs', 'BLUEBUBBLES_CHANNEL_PREP.md');
    const docsIndex = readDoc('docs', 'README.md');
    const runbook = readDoc('docs', 'TESTING_AND_RELEASE_RUNBOOK.md');

    expect(alexaGuide).toContain('near_live_only');
    expect(alexaGuide).toContain('services:status');
    expect(alexaGuide).not.toContain('Alexa is now live-proven on this host');

    expect(bluebubblesGuide).toContain('live_proven');
    expect(bluebubblesGuide).toContain('degraded_but_usable');
    expect(docsIndex).toContain('BlueBubbles is status-led on this host: it is now `live_proven`');
    expect(runbook).toContain(
      'Alexa listener, OAuth, public ingress, and pinned Node 22 are healthy; Alexa is status-led on this host and should return to `live_proven` only after a fresh handled Andrea custom-skill proof is recorded again',
    );
    expect(runbook).toContain(
      'after restart, operator surfaces may credit that Alexa proof either from the persisted handled signed-request markers',
    );
  });

  it('documents hidden backing commands in the operator reference', () => {
    const commandReference = readDoc('docs', 'COMMAND_SURFACE_REFERENCE.md');

    expect(commandReference).toContain('/cursor-ui *');
    expect(commandReference).toContain('/bundle-*');
    expect(commandReference).toContain('/remote-control');
    expect(commandReference).toContain('internal');
    expect(commandReference).toContain('operator-only');
  });
});
