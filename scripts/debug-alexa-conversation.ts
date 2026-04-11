import fs from 'fs';

import {
  createAlexaSkill,
  getAlexaStatus,
  type AlexaConfig,
} from '../src/alexa.js';
import { buildAlexaUtteranceReviewDigest } from '../src/pilot-mode.js';
import {
  getAlexaPrincipalKey,
  seedConfiguredAlexaLinkedAccount,
} from '../src/alexa-identity.js';
import { loadAlexaConversationState } from '../src/alexa-conversation.js';
import { _initTestDatabase, initDatabase, setRegisteredGroup } from '../src/db.js';
import { getAlexaLastSignedRequestStatePath } from '../src/host-control.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';
import type { RequestEnvelope, ResponseEnvelope } from 'ask-sdk-model';

function parseArgs(argv: string[]): {
  review: boolean;
} {
  return {
    review: argv.includes('--review'),
  };
}

function buildConfig(): AlexaConfig {
  return {
    skillId: 'amzn1.ask.skill.debug',
    host: '127.0.0.1',
    port: 4300,
    path: '/alexa',
    healthPath: '/alexa/health',
    verifySignature: false,
    requireAccountLinking: true,
    allowedUserIds: [],
    targetGroupFolder: undefined,
  };
}

function buildBaseEnvelope(): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: false,
      sessionId: 'SessionId.debug',
      application: {
        applicationId: 'amzn1.ask.skill.debug',
      },
      user: {
        userId: 'amzn1.ask.account.debug-user',
        accessToken: 'debug-linked-token',
      },
    },
    context: {
      System: {
        application: {
          applicationId: 'amzn1.ask.skill.debug',
        },
        user: {
          userId: 'amzn1.ask.account.debug-user',
          accessToken: 'debug-linked-token',
        },
        person: {
          personId: 'amzn1.ask.person.debug-person',
          accessToken: 'debug-linked-token',
        },
        device: {
          deviceId: 'debug-device',
          supportedInterfaces: {},
        },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'debug-api-token',
      },
    },
    request: {
      requestId: 'EdwRequestId.debug-launch',
      locale: 'en-US',
      timestamp: '2026-04-05T08:00:00Z',
      type: 'LaunchRequest',
    },
  } as unknown as RequestEnvelope;
}

function buildIntentEnvelope(
  intentName: string,
  slots: Record<string, string> = {},
): RequestEnvelope {
  return {
    ...buildBaseEnvelope(),
    request: {
      requestId: `EdwRequestId.${intentName}`,
      locale: 'en-US',
      timestamp: '2026-04-05T08:00:00Z',
      type: 'IntentRequest',
      intent: {
        name: intentName,
        confirmationStatus: 'NONE',
        slots: Object.fromEntries(
          Object.entries(slots).map(([name, value]) => [
            name,
            {
              name,
              value,
              confirmationStatus: 'NONE',
            },
          ]),
        ),
      },
    },
  } as unknown as RequestEnvelope;
}

function extractSpeechText(responseEnvelope: ResponseEnvelope): string {
  const outputSpeech = responseEnvelope.response?.outputSpeech;
  const ssml =
    outputSpeech && 'ssml' in outputSpeech ? outputSpeech.ssml || '' : '';
  return ssml.replace(/<\/?speak>/g, '').trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.review) {
    initDatabase();
    const review = buildAlexaUtteranceReviewDigest();
    const lines = [
      '*Alexa Utterance Review*',
      `- Signals tracked: ${review.totalSignals}`,
      `- Repeated patterns: ${review.repeatedPatterns.length}`,
      `- Fallback misses: ${review.fallbackMisses.length}`,
      `- Clarifier recoveries: ${review.clarifierRecoveries.length}`,
      `- Carrier-phrase gaps: ${review.carrierPhraseGaps.length}`,
      `- Handoff-required patterns: ${review.handoffRequired.length}`,
      `- No-context references: ${review.noContextReferences.length}`,
      `- Follow-up binding failures: ${review.followupBindingFailures.length}`,
      `- Communication should-route misses: ${review.communicationShouldRoute.length}`,
      `- Planning should-route misses: ${review.planningShouldRoute.length}`,
      `- Voice-shape repetition: ${review.voiceShapeRepetition.length}`,
      '',
      '*Top Patterns*',
      ...(review.groupedPatterns.length > 0
        ? review.groupedPatterns.slice(0, 10).flatMap((item) => [
            `- ${item.utterance} / family=${item.family} / route=${item.routeOutcome} / blocker=${item.blockerClass} / attempts=${item.attempts} / latest=${item.latestAt}`,
            `  suggestion: ${item.operatorHint}`,
          ])
        : ['- none']),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const signedRequestStatePath = getAlexaLastSignedRequestStatePath();
  const previousSignedRequestState = fs.existsSync(signedRequestStatePath)
    ? fs.readFileSync(signedRequestStatePath, 'utf8')
    : null;

  try {
    _initTestDatabase();
    setRegisteredGroup('tg:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-05T08:00:00Z',
      requiresTrigger: false,
      isMain: true,
    });
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'save this under the Candace thread',
      replyText: 'Dinner plans tonight still need a clean answer.',
      now: new Date('2026-04-05T08:00:00Z'),
    });

    const linked = seedConfiguredAlexaLinkedAccount({
      ALEXA_LINKED_ACCOUNT_TOKEN: 'debug-linked-token',
      ALEXA_LINKED_ACCOUNT_NAME: 'Andrea Alexa',
      ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: 'main',
      ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID: 'amzn1.ask.account.debug-user',
      ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID: 'amzn1.ask.person.debug-person',
    });

    const principalKey = getAlexaPrincipalKey({
      userId: 'amzn1.ask.account.debug-user',
      personId: 'amzn1.ask.person.debug-person',
    });

    const skill = createAlexaSkill(buildConfig(), {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
    });
    const turns: Array<{
      label: string;
      envelope: RequestEnvelope;
    }> = [
      {
        label: 'Launch',
        envelope: buildBaseEnvelope(),
      },
      {
        label: 'No-context reference',
        envelope: buildIntentEnvelope('ConversationControlIntent', {
          controlText: 'what about that',
        }),
      },
      {
        label: 'Guidance',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'am i forgetting',
        }),
      },
      {
        label: 'Calendar tomorrow',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          calendarReadText: 'tomorrow',
        }),
      },
      {
        label: 'Calendar afternoon',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          calendarReadText: 'this afternoon',
        }),
      },
      {
        label: 'What can you do',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'what can you do',
        }),
      },
      {
        label: 'Next on my calendar',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'next on my calendar',
        }),
      },
      {
        label: 'First meeting tomorrow',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'first meeting tomorrow',
        }),
      },
      {
        label: 'Anything else',
        envelope: buildIntentEnvelope('ConversationControlIntent'),
      },
      {
        label: 'Save that',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          item: 'that',
        }),
      },
      {
        label: 'Remind me later',
        envelope: buildIntentEnvelope('ConversationalFollowupIntent', {
          followupText: 'remind me later',
        }),
      },
      {
        label: 'Candace follow-up',
        envelope: buildIntentEnvelope('PeopleHouseholdIntent', {
          subject: 'Candace',
        }),
      },
      {
        label: 'Communication gap',
        envelope: buildIntentEnvelope('OpenAskIntent', {
          query: 'what should i say back',
        }),
      },
      {
        label: 'Owed replies',
        envelope: buildIntentEnvelope('OpenAskIntent', {
          query: 'what do i owe people',
        }),
      },
      {
        label: 'Planning gap',
        envelope: buildIntentEnvelope('PlanningOrientationIntent', {
          topic: 'tonight',
        }),
      },
      {
        label: 'Calendar create',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          calendarCreateText: 'dinner with Candace tomorrow at 6:30 PM',
        }),
      },
      {
        label: 'Calendar move',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          calendarMoveText: 'dinner to 7',
        }),
      },
      {
        label: 'Calendar cancel',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          calendarCancelText: 'dinner tomorrow',
        }),
      },
      {
        label: 'Reminder create',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          reminderText: '4 to text Candace',
        }),
      },
      {
        label: 'Reminder follow-up',
        envelope: buildIntentEnvelope('SaveRemindHandoffIntent', {
          item: 'that tonight',
        }),
      },
      {
        label: 'Tonight',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'should i remember tonight',
        }),
      },
      {
        label: "What's up",
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'up',
        }),
      },
      {
        label: 'What time is it',
        envelope: buildIntentEnvelope('CompanionGuidanceIntent', {
          guidanceText: 'time is it',
        }),
      },
      {
        label: 'Directness',
        envelope: buildIntentEnvelope('ConversationControlIntent', {
          controlText: 'a little more direct',
        }),
      },
      {
        label: 'Open ask',
        envelope: buildIntentEnvelope('OpenAskIntent', {
          query: 'meal delivery and grocery delivery for a busy week',
        }),
      },
      {
        label: 'Decision help',
        envelope: buildIntentEnvelope('OpenAskIntent', {
          query: 'what should i know before deciding',
        }),
      },
    ];

    for (const turn of turns) {
      const response = await skill.invoke(turn.envelope);
      const status = getAlexaStatus(buildConfig(), true, 4300);
      const state = linked
        ? loadAlexaConversationState(principalKey, linked.accessTokenHash)
        : undefined;
      const dailyContextRaw =
        state?.subjectData.dailyCompanionContextJson?.trim();
      const dailyContext = dailyContextRaw
        ? (JSON.parse(dailyContextRaw) as {
            mode?: string;
            leadReason?: string;
            usedThreadTitles?: string[];
          })
        : undefined;

      process.stdout.write(`TURN: ${turn.label}\n`);
      process.stdout.write(`SPEECH: ${extractSpeechText(response)}\n`);
      process.stdout.write(
        `SIGNED: ${status.lastSignedRequestType || 'unknown'} / ${
          status.lastSignedIntent || 'none'
        } / ${status.lastSignedResponseSource || 'unknown'}\n`,
      );
      process.stdout.write(
        `STATE: ${state?.subjectKind || 'none'} / ${state?.summaryText || 'none'}\n`,
      );
      process.stdout.write(
        `FRAME: family=${state?.subjectData.lastIntentFamily || 'none'} / route=${
          state?.subjectData.lastRouteOutcome || 'none'
        } / subject=${state?.subjectData.activeSubjectLabel || 'none'} / utterance=${
          state?.subjectData.lastUserUtterance || 'none'
        }\n`,
      );
      process.stdout.write(
        `COMPANION: ${dailyContext?.mode || 'none'} / ${
          dailyContext?.leadReason || 'none'
        } / ${(dailyContext?.usedThreadTitles || []).join(', ') || 'none'}\n\n`,
      );
    }
  } finally {
    if (previousSignedRequestState == null) {
      fs.rmSync(signedRequestStatePath, { force: true });
    } else {
      fs.writeFileSync(signedRequestStatePath, previousSignedRequestState, 'utf8');
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(
      `debug-alexa-conversation failed: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
