import assert from 'node:assert/strict';

import {
  buildLiveProofGauntletReport,
  proofStateToGauntletStatus,
} from '../src/live-proof-gauntlet.js';

function surface(
  proofState:
    | 'live_proven'
    | 'near_live_only'
    | 'externally_blocked'
    | 'degraded_but_usable'
    | 'not_intended_for_trial',
  blockerOwner: 'none' | 'repo_side' | 'external',
  nextAction: string,
  blocker = '',
) {
  return {
    proofState,
    blocker,
    blockerOwner,
    nextAction,
    detail: `${proofState} detail`,
  };
}

const fakeTruth: any = {
  telegram: surface(
    'externally_blocked',
    'external',
    'Configure Telegram user-session credentials.',
    'Telegram user-session credentials are missing.',
  ),
  journeys: {
    ordinary_chat: surface('near_live_only', 'none', 'Send hi in Telegram.'),
  },
  alexa: {
    ...surface(
      'near_live_only',
      'external',
      'Use Alexa app/device for a signed IntentRequest.',
      'No handled signed Alexa IntentRequest is recorded.',
    ),
    lastHandledProofAt: 'none',
    lastSignedRequestAt: 'none',
    proofFreshness: 'none',
  },
  bluebubbles: {
    ...surface(
      'degraded_but_usable',
      'external',
      'Complete same-thread message-action proof.',
      'Same-thread message-action proof missing.',
    ),
    messageActionProofState: 'none',
    messageActionProofAt: 'none',
    messageActionProofChatJid: 'bb:iMessage;-;+14695550123',
  },
  googleCalendar: surface('live_proven', 'none', 'No action needed.'),
  research: surface(
    'externally_blocked',
    'external',
    'Wait for Brave quota recovery.',
    'Provider quota blocked.',
  ),
  imageGeneration: surface('live_proven', 'none', 'No action needed.'),
};

const report = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: {
    TELEGRAM_USER_API_ID: '',
    TELEGRAM_USER_API_HASH: '',
  },
  truth: fakeTruth,
});

const byName = new Map(report.entries.map((entry) => [entry.proofName, entry]));
assert.equal(
  byName.get('Telegram user-session proof')?.status,
  'missing_config',
);
assert.equal(
  byName.get('Telegram user-session proof')?.repoWorkRequired,
  false,
);
assert.equal(
  byName.get('Alexa signed IntentRequest proof')?.status,
  'externally_blocked',
);
assert.equal(
  byName.get('BlueBubbles same-thread message-action proof')?.status,
  'near_live_only',
);
assert.equal(
  byName.get('Google Calendar live write proof')?.status,
  'live_proven',
);
assert.equal(
  byName.get('Research/provider proof')?.status,
  'externally_blocked',
);
assert.ok(report.proofDebtCount >= 4);
assert.equal(report.optionalProofDebtCount, 1);
assert.equal(report.dailyCoreLiveProvenCount, 2);
assert.equal(report.dailyCoreProofDebtCount, 4);
assert.equal(report.repoWorkRequiredCount, 0);
assert.match(report.nextAction, /Telegram user-session/);

const liveTelegramBotMissingUserSession = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: {
    TELEGRAM_USER_API_ID: '',
    TELEGRAM_USER_API_HASH: '',
  },
  truth: {
    ...fakeTruth,
    telegram: surface('live_proven', 'none', 'No action needed.'),
    journeys: {
      ordinary_chat: surface('near_live_only', 'none', 'Send hi in Telegram.'),
    },
  },
});
const liveTelegramBotEntries = new Map(
  liveTelegramBotMissingUserSession.entries.map((entry) => [
    entry.proofName,
    entry,
  ]),
);
assert.equal(
  liveTelegramBotEntries.get('Telegram user-session proof')?.status,
  'missing_config',
);
assert.equal(
  liveTelegramBotEntries.get('Telegram bot proof')?.status,
  'live_proven',
);
assert.equal(
  liveTelegramBotEntries.get('Telegram bot proof')?.repoWorkRequired,
  false,
);

const staleBlueBubbles = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: {
    TELEGRAM_USER_API_ID: 'configured',
    TELEGRAM_USER_API_HASH: 'configured',
  },
  truth: {
    ...fakeTruth,
    telegram: surface('live_proven', 'none', 'No action needed.'),
    bluebubbles: {
      ...fakeTruth.bluebubbles,
      messageActionProofState: 'stale',
      messageActionProofAt: '2026-06-01T00:00:00.000Z',
    },
  },
});
assert.equal(
  staleBlueBubbles.entries.find((entry) =>
    entry.proofName.startsWith('BlueBubbles'),
  )?.status,
  'stale',
);

assert.equal(proofStateToGauntletStatus('live_proven'), 'live_proven');
assert.equal(
  proofStateToGauntletStatus('externally_blocked', 'external'),
  'externally_blocked',
);

assert.doesNotMatch(
  JSON.stringify(report),
  /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output|\+14695550123|bb:iMessage/i,
);

console.log('proof gauntlet tests passed');
