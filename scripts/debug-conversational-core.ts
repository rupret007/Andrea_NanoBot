import {
  buildDirectAssistantRuntimeFailureReply,
  maybeBuildDirectQuickReply,
} from '../src/direct-quick-reply.js';
import { matchAssistantCapabilityRequest } from '../src/assistant-capability-router.js';
import { runResearchOrchestrator } from '../src/research-orchestrator.js';
import { _initTestDatabase } from '../src/db.js';

const runtimeBanner =
  'Andrea cannot run that assistant turn right now because the runtime failed during startup or execution. Andrea retried once and the runtime still failed. An operator should re-run setup verify and inspect execution readiness logs.';

async function main(): Promise<void> {
  _initTestDatabase();

  const now = new Date('2026-04-06T22:18:10.000Z');
  const directPrompts = [
    "What's up?",
    "How's it going?",
    'Can you help me?',
    'What time is it in Australia?',
  ];

  console.log('Andrea conversational core proof');
  console.log(`Fixed now: ${now.toISOString()}`);
  console.log('');

  for (const prompt of directPrompts) {
    const messages = [{ content: prompt }];
    const quickReply = maybeBuildDirectQuickReply(messages, now);
    const telegramFallback = buildDirectAssistantRuntimeFailureReply(
      messages,
      runtimeBanner,
      now,
      'telegram',
    );
    const bluebubblesFallback = buildDirectAssistantRuntimeFailureReply(
      messages,
      runtimeBanner,
      now,
      'bluebubbles',
    );

    console.log(`Prompt: ${prompt}`);
    console.log(`Local quick reply: ${quickReply ?? '(none)'}`);
    console.log(`Telegram degraded reply: ${telegramFallback}`);
    console.log(`BlueBubbles degraded reply: ${bluebubblesFallback}`);
    console.log('');
  }

  const factoidPrompt = "What is Jar Jar Binks' species?";
  const capability = matchAssistantCapabilityRequest(factoidPrompt);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;

  process.env.OPENAI_API_KEY = ' ';
  process.env.OPENAI_BASE_URL = previousBaseUrl || '';

  try {
    const researchResult = await runResearchOrchestrator({
      query: factoidPrompt,
      channel: 'telegram',
      now,
    });

    console.log(`Prompt: ${factoidPrompt}`);
    console.log(`Matched capability: ${capability?.capabilityId ?? '(none)'}`);
    console.log(`Research summary: ${researchResult.summaryText ?? '(none)'}`);
    console.log(`Why this route: ${researchResult.routeExplanation}`);
    console.log('');
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }

    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  }
}

void main();
