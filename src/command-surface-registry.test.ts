import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildTelegramFeatureLines,
  buildTelegramHelpLines,
  buildTelegramWelcomeLines,
  COMMAND_SURFACE_REGISTRY,
  EVERYDAY_JOB_SPECS,
  INTERNAL_BUTTON_COMMAND_SURFACES,
  OPERATOR_SLASH_COMMAND_SURFACES,
  PRACTICAL_COMMAND_INVENTORY,
  PUBLIC_TELEGRAM_COMMAND_SURFACES,
  getEverydayJobSpecs,
  getPracticalDiscoverySpotlights,
  getTelegramBotGroupMenuCommands,
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

    expect(getTelegramBotGroupMenuCommands()).toEqual([
      {
        command: 'help',
        description: 'How Andrea works here',
      },
      {
        command: 'commands',
        description: 'Setup and status commands',
      },
      {
        command: 'features',
        description: 'What Andrea is best at',
      },
      {
        command: 'ping',
        description: 'Check if Andrea is online',
      },
    ]);
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

  it('keeps a practical public command inventory without leading with person-specific prompts', () => {
    expect(PRACTICAL_COMMAND_INVENTORY).toHaveLength(80);
    expect(getEverydayJobSpecs({ jobTier: 'flagship' })).toHaveLength(10);
    expect(
      EVERYDAY_JOB_SPECS.find((job) => job.jobId === 'planning_horizon')
        ?.promptVariants,
    ).toContain('help me plan meals this week');
    expect(
      PRACTICAL_COMMAND_INVENTORY.some(
        (entry) => entry.prompt === 'what do we need from the store',
      ),
    ).toBe(true);

    const alexaSpotlights = getPracticalDiscoverySpotlights('alexa').map(
      (entry) => entry.prompt,
    );
    expect(alexaSpotlights).toEqual([
      "what's on my calendar tomorrow",
      'remind me to take my pills at 9',
      'what should I say back',
      'help me plan tonight',
      'what am I forgetting',
    ]);
    const telegramSpotlights = getPracticalDiscoverySpotlights('telegram').map(
      (entry) => entry.prompt,
    );
    expect(telegramSpotlights).toEqual([
      "what's on my calendar tomorrow",
      'remind me to take my pills at 9',
      'what bills do I need to pay this week',
      'what should I say back',
      'help me plan meals this week',
    ]);
    expect(alexaSpotlights.join(' ')).not.toContain('Candace');
    expect(alexaSpotlights.join(' ')).not.toContain('save that');
    expect(telegramSpotlights.join(' ')).not.toContain('Candace');
  });

  it('keeps public Telegram discovery focused on practical jobs first', () => {
    const welcome = buildTelegramWelcomeLines('Andrea').join('\n');
    const help = buildTelegramHelpLines('Andrea').join('\n');
    const features = buildTelegramFeatureLines('Andrea').join('\n');

    expect(welcome).toContain("what's on my calendar tomorrow");
    expect(welcome).toContain('remind me to take my pills at 9');
    expect(welcome).toContain('what bills do I need to pay this week');
    expect(welcome).not.toContain('Candace');

    expect(help).toContain('scheduling');
    expect(help).toContain('reply help');
    expect(help).toContain('bill follow-through');
    expect(help).not.toContain('missions and chief-of-staff');

    expect(features).toContain('calendar');
    expect(features).toContain('planning');
    expect(features).toContain('quick reply help');
    expect(features).toContain('pills');
    expect(features).not.toContain('life threads and follow-through');
  });

  it('keeps discovery truth classes aligned with the current host story', () => {
    const truthById = new Map(
      COMMAND_SURFACE_REGISTRY.map((entry) => [entry.id, entry.truthClass] as const),
    );

    expect(truthById.get('alexa_voice_surface')).toBe('live_proven');
    expect(truthById.get('bluebubbles_bounded_surface')).toBe('live_proven');
    expect(truthById.get('planning_and_next_steps')).toBe('near_live_only');
    expect(truthById.get('communication_and_reply_help')).toBe('live_proven');
    expect(truthById.get('compare_explain_and_saved_context')).toBe(
      'degraded_but_usable',
    );
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
    expect(publicGuide).toContain("What's on my calendar tomorrow?");
    expect(publicGuide).toContain('Remind me to take my pills at 9');
    expect(publicGuide).toContain('Help me plan tonight');
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

    expect(alexaGuide).toContain('core_ready_with_manual_surface_sync');
    expect(alexaGuide).toContain('alexa-model-sync mark-synced');
    expect(alexaGuide).toContain('services:status');
    expect(alexaGuide).not.toContain('Alexa is now live-proven on this host');

    expect(bluebubblesGuide).toContain('externally_blocked');
    expect(bluebubblesGuide).toContain('transport_unreachable');
    expect(docsIndex).toContain('core_ready_with_manual_surface_sync');
    expect(docsIndex).toContain('Telegram stays the dependable main messaging surface');
    expect(runbook).toContain(
      'setup -- --step verify` now follows **pass core, warn extras**',
    );
    expect(runbook).toContain('debug:openbubbles-feasibility');
    expect(runbook).toContain(
      'if you changed `docs/alexa/interaction-model.en-US.json`, finish the console import/build and then run `npm run setup -- --step alexa-model-sync mark-synced`',
    );
  });

  it('documents hidden backing commands in the operator reference', () => {
    const commandReference = readDoc('docs', 'COMMAND_SURFACE_REFERENCE.md');

    expect(commandReference).toContain('/cursor-ui *');
    expect(commandReference).toContain('/bundle-*');
    expect(commandReference).toContain('/remote-control');
    expect(commandReference).toContain('internal');
    expect(commandReference).toContain('operator-only');
    expect(commandReference).toContain('Calendar and schedule');
    expect(commandReference).toContain('Communication and reply help');
  });

  it('keeps the command reference truth labels aligned with current host status', () => {
    const commandReference = readDoc('docs', 'COMMAND_SURFACE_REFERENCE.md');

    expect(commandReference).toContain(
      'Surface-shape and access overlays still appear in this reference too:',
    );
    expect(commandReference).toContain(
      '| Planning and next steps | Telegram, Alexa | `near_live_only` |',
    );
    expect(commandReference).toContain(
      '| Communication and reply help | Telegram, Alexa, BlueBubbles | `live_proven` |',
    );
    expect(commandReference).toContain(
      '| Compare, explain, and saved context | Telegram, Alexa | `degraded_but_usable` |',
    );
    expect(commandReference).toContain(
      'daily guidance still needs one fresh Telegram proof turn',
    );
  });
});
