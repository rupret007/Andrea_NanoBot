import {
  createAlexaSkill,
  getAlexaStatus,
  type AlexaConfig,
} from '../src/alexa.js';
import {
  getAlexaPrincipalKey,
  seedConfiguredAlexaLinkedAccount,
} from '../src/alexa-identity.js';
import { loadAlexaConversationState } from '../src/alexa-conversation.js';
import { _initTestDatabase, setRegisteredGroup } from '../src/db.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';
import type { RequestEnvelope, ResponseEnvelope } from 'ask-sdk-model';

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

  const skill = createAlexaSkill(buildConfig());
  const turns: Array<{
    label: string;
    envelope: RequestEnvelope;
  }> = [
    {
      label: 'Launch',
      envelope: buildBaseEnvelope(),
    },
    {
      label: 'Forgetting',
      envelope: buildIntentEnvelope('WhatAmIForgettingIntent'),
    },
    {
      label: 'Anything else',
      envelope: buildIntentEnvelope('AnythingElseIntent'),
    },
    {
      label: 'Candace follow-up',
      envelope: buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'what about Candace',
      }),
    },
    {
      label: 'Tonight',
      envelope: buildIntentEnvelope('EveningResetIntent'),
    },
    {
      label: 'Directness',
      envelope: buildIntentEnvelope('MemoryControlIntent', {
        memoryCommand: 'a little more direct',
      }),
    },
  ];

  for (const turn of turns) {
    const response = await skill.invoke(turn.envelope);
    const status = getAlexaStatus(buildConfig(), true, 4300);
    const state = linked
      ? loadAlexaConversationState(principalKey, linked.accessTokenHash)
      : undefined;
    const dailyContextRaw = state?.subjectData.dailyCompanionContextJson?.trim();
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
      `COMPANION: ${dailyContext?.mode || 'none'} / ${
        dailyContext?.leadReason || 'none'
      } / ${(dailyContext?.usedThreadTitles || []).join(', ') || 'none'}\n\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `debug-alexa-conversation failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
