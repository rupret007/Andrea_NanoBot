import {
  buildDirectAssistantRuntimeFailureReply,
  maybeBuildDirectQuickReply,
} from '../src/direct-quick-reply.js';

const runtimeBanner =
  'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution. Andrea retried once and the runtime still failed. An operator should re-run setup verify and inspect execution readiness logs.';

const now = new Date('2026-04-06T22:18:10.000Z');

const prompts = [
  "Hey how's it going?",
  'Can you use cursor and codex?',
  'What time is it in Australia?',
  'Can you help me compare three backup vendors for next month?',
];

console.log('Andrea direct runtime shield proof');
console.log(`Fixed now: ${now.toISOString()}`);
console.log('');

let leakedBanner = false;

for (const prompt of prompts) {
  const messages = [{ content: prompt }];
  const quickReply = maybeBuildDirectQuickReply(messages, now);
  const shieldedReply = buildDirectAssistantRuntimeFailureReply(
    messages,
    runtimeBanner,
    now,
  );
  const leaked = shieldedReply.includes(
    'runtime failed during startup or execution',
  );
  leakedBanner ||= leaked;

  console.log(`Prompt: ${prompt}`);
  console.log(`Quick/local: ${quickReply ?? '(none)'}`);
  console.log(`Runtime-shield reply: ${shieldedReply}`);
  console.log(`Leaked runtime banner: ${leaked ? 'YES' : 'no'}`);
  console.log('');
}

if (leakedBanner) {
  throw new Error('Direct runtime shield leaked the operator-grade banner.');
}

console.log('Result: ordinary direct turns stay on a user-safe local/recovery reply.');
