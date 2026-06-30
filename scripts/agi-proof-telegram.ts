import { pathToFileURL } from 'node:url';

import { readEnvFile } from '../src/env.js';

const ENV_KEYS = [
  'ANDREA_USE_AGI',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_API_ID',
  'TELEGRAM_USER_API_HASH',
  'TELEGRAM_CANARY_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OLLAMA_BASE_URL',
];

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function present(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function redactedState(value: string | undefined): 'present' | 'missing' {
  return present(value) ? 'present' : 'missing';
}

async function main(): Promise<void> {
  const envFile = readEnvFile(ENV_KEYS);
  const env = { ...envFile, ...process.env };
  const agiEnabled = ['1', 'true', 'yes'].includes(
    String(env.ANDREA_USE_AGI || '').toLowerCase(),
  );
  const botReady = present(env.TELEGRAM_BOT_TOKEN);
  const userProofReady =
    present(env.TELEGRAM_USER_API_ID) && present(env.TELEGRAM_USER_API_HASH);
  const providerReady =
    present(env.ANTHROPIC_API_KEY) ||
    present(env.OPENAI_API_KEY) ||
    present(env.OLLAMA_BASE_URL);
  const blockers = [
    agiEnabled ? '' : 'Set ANDREA_USE_AGI=1 for Telegram AGI canary routing.',
    botReady ? '' : 'Set TELEGRAM_BOT_TOKEN for bot-channel proof.',
    userProofReady
      ? ''
      : 'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH for user-session roundtrip proof.',
    providerReady
      ? ''
      : 'Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL before a real AGI answer proof.',
  ].filter(Boolean);
  const result = {
    generatedAt: new Date().toISOString(),
    ok: blockers.length === 0,
    liveProven: false,
    state: blockers.length === 0 ? 'ready_for_manual_roundtrip' : 'blocked',
    config: {
      ANDREA_USE_AGI: agiEnabled ? 'enabled' : 'disabled',
      TELEGRAM_BOT_TOKEN: redactedState(env.TELEGRAM_BOT_TOKEN),
      TELEGRAM_USER_API_ID: redactedState(env.TELEGRAM_USER_API_ID),
      TELEGRAM_USER_API_HASH: redactedState(env.TELEGRAM_USER_API_HASH),
      TELEGRAM_CANARY_CHAT_ID: redactedState(env.TELEGRAM_CANARY_CHAT_ID),
      modelProvider: providerReady ? 'present' : 'missing',
    },
    blockers,
    manualProof: [
      'Start the Andrea service on this host.',
      'Send one direct Telegram prompt and verify AskResult.liveProofTags includes telegram_canary.',
      'Send one memory-backed prompt and verify a runId plus truth audit are present.',
      'Send one confirm-required prompt and verify approval is scoped to the same chat.',
      'Rerun npm run agi:readiness -- --write after proof.',
    ],
    note:
      'This command checks readiness for a Telegram AGI proof. It does not fake or mark a live roundtrip as proven.',
  };

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ result }, null, 2));
  } else {
    console.log(`Telegram AGI proof: ${result.state}`);
    for (const blocker of blockers) console.log(`- ${blocker}`);
    if (!blockers.length) {
      console.log('- Ready for manual Telegram roundtrip proof.');
    }
  }

  if (hasFlag('--fail-on-blocker') && blockers.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
