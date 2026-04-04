import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RequestEnvelope, type ResponseEnvelope } from 'ask-sdk-model';

import {
  createAlexaSkill,
  formatAlexaStatusMessage,
  normalizeAlexaSpeech,
  resolveAlexaConfig,
  shapeAlexaSpeech,
  startAlexaServer,
  type AlexaConfig,
} from './alexa.js';
import {
  AlexaTargetGroupMissingError,
  runAlexaAssistantTurn,
} from './alexa-bridge.js';
import { seedConfiguredAlexaLinkedAccount } from './alexa-identity.js';
import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { ASSISTANT_NAME } from './config.js';

vi.mock('./alexa-bridge.js', async () => {
  const actual =
    await vi.importActual<typeof import('./alexa-bridge.js')>(
      './alexa-bridge.js',
    );
  return {
    ...actual,
    runAlexaAssistantTurn: vi.fn(),
  };
});

const mockedRunAlexaAssistantTurn = vi.mocked(runAlexaAssistantTurn);

function buildBaseEnvelope(): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'SessionId.123',
      application: {
        applicationId: 'amzn1.ask.skill.test',
      },
      user: {
        userId: 'amzn1.ask.account.test-user',
        accessToken: 'linked-secret-token',
      },
    },
    context: {
      System: {
        application: {
          applicationId: 'amzn1.ask.skill.test',
        },
        user: {
          userId: 'amzn1.ask.account.test-user',
          accessToken: 'linked-secret-token',
        },
        person: {
          personId: 'amzn1.ask.person.test-person',
          accessToken: 'linked-secret-token',
        },
        device: {
          deviceId: 'device-1',
          supportedInterfaces: {},
        },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'api-access-token',
      },
    },
    request: {
      requestId: 'EdwRequestId.123',
      locale: 'en-US',
      timestamp: '2026-04-03T08:00:00Z',
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
      timestamp: '2026-04-03T08:00:00Z',
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

function buildConfig(overrides: Partial<AlexaConfig> = {}): AlexaConfig {
  return {
    skillId: 'amzn1.ask.skill.test',
    host: '127.0.0.1',
    port: 0,
    path: '/alexa',
    healthPath: '/alexa/health',
    verifySignature: false,
    requireAccountLinking: true,
    allowedUserIds: [],
    targetGroupFolder: undefined,
    ...overrides,
  };
}

function seedLinkedAccount(groupFolder = 'main') {
  seedConfiguredAlexaLinkedAccount({
    ALEXA_LINKED_ACCOUNT_TOKEN: 'linked-secret-token',
    ALEXA_LINKED_ACCOUNT_NAME: 'Andrea Alexa',
    ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: groupFolder,
    ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID: 'amzn1.ask.account.test-user',
    ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID: 'amzn1.ask.person.test-person',
  });
}

describe('resolveAlexaConfig', () => {
  it('returns null when Alexa is not configured', () => {
    expect(resolveAlexaConfig({})).toBeNull();
  });

  it('parses Alexa env configuration and validates target folder', () => {
    const config = resolveAlexaConfig({
      ALEXA_SKILL_ID: 'amzn1.ask.skill.test',
      ALEXA_HOST: '0.0.0.0',
      ALEXA_PORT: '4310',
      ALEXA_PATH: 'voice/andrea',
      ALEXA_VERIFY_SIGNATURE: 'false',
      ALEXA_REQUIRE_ACCOUNT_LINKING: 'true',
      ALEXA_ALLOWED_USER_IDS: 'user-one, user-two ',
      ALEXA_TARGET_GROUP_FOLDER: 'main',
    });

    expect(config).toMatchObject({
      skillId: 'amzn1.ask.skill.test',
      host: '0.0.0.0',
      port: 4310,
      path: '/voice/andrea',
      healthPath: '/voice/andrea/health',
      verifySignature: false,
      requireAccountLinking: true,
      allowedUserIds: ['user-one', 'user-two'],
      targetGroupFolder: 'main',
    });
  });
});

describe('Alexa speech shaping', () => {
  it('strips internal tags, markdown, and raw links from speech', () => {
    expect(
      normalizeAlexaSpeech(
        '<internal>quiet orchestration</internal>Here is **Andrea** with `code` and https://example.com',
      ),
    ).toBe('Here is Andrea with code and');
  });

  it('keeps spoken output short and sentence-bounded', () => {
    const shaped = shapeAlexaSpeech(
      'First sentence. Second sentence. Third sentence. Fourth sentence.',
    );
    expect(shaped).toBe('First sentence. Second sentence. Third sentence.');
  });
});

describe('createAlexaSkill', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockedRunAlexaAssistantTurn.mockReset();
    setRegisteredGroup('tg:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-03T08:00:00Z',
      requiresTrigger: false,
      isMain: true,
    });
    seedLinkedAccount('main');
  });

  it('responds to launch requests with the bounded personal-assistant welcome', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildBaseEnvelope());

    expect(extractSpeechText(response)).toContain(`${ASSISTANT_NAME} is ready`);
  });

  it('returns a link-account response for personal intents with no token', async () => {
    const skill = createAlexaSkill(buildConfig());
    const envelope = buildIntentEnvelope('MyDayIntent');
    delete envelope.context!.System.user!.accessToken;
    delete envelope.context!.System.person!.accessToken;
    delete envelope.session!.user!.accessToken;

    const response = await skill.invoke(envelope);

    expect(extractSpeechText(response)).toContain('needs account linking');
    expect(response.response?.card?.type).toBe('LinkAccount');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('returns a link-account response for unknown linked tokens', async () => {
    const skill = createAlexaSkill(buildConfig());
    const envelope = buildIntentEnvelope('MyDayIntent');
    envelope.context!.System.user!.accessToken = 'unknown-token';
    envelope.context!.System.person!.accessToken = 'unknown-token';
    envelope.session!.user!.accessToken = 'unknown-token';

    const response = await skill.invoke(envelope);

    expect(extractSpeechText(response)).toContain('does not recognize');
    expect(response.response?.card?.type).toBe('LinkAccount');
  });

  it('blocks users outside the Alexa allowlist', async () => {
    const skill = createAlexaSkill(
      buildConfig({ allowedUserIds: ['amzn1.ask.account.allowed'] }),
    );
    const response = await skill.invoke(buildBaseEnvelope());

    expect(extractSpeechText(response)).toContain('not authorized');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('routes MyDayIntent through the bridge with linked group context', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Today is light. You have one afternoon meeting.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('MyDayIntent'));

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('practical morning brief'),
        principal: expect.objectContaining({
          userId: 'amzn1.ask.account.test-user',
          displayName: 'Andrea Alexa',
        }),
        promptContext: expect.objectContaining({
          conversationSubjectKind: 'day_brief',
          conversationSummary: 'today and what matters most',
        }),
      }),
      expect.objectContaining({
        assistantName: ASSISTANT_NAME,
        targetGroupFolder: 'main',
        requireExistingTargetGroup: true,
      }),
    );
    expect(extractSpeechText(response)).toContain('Today is light');
  });

  it('routes WhatMattersMostTodayIntent as measured Alexa companion guidance', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'The main thing today is your afternoon review.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('WhatMattersMostTodayIntent'),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('What matters most today'),
        promptContext: expect.objectContaining({
          conversationSummary: 'what matters most today',
          conversationSubjectKind: 'day_brief',
          channelMode: 'alexa_companion',
          guidanceGoal: 'what_matters_most',
          initiativeLevel: 'measured',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('main thing today');
  });

  it('routes FamilyUpcomingIntent with household-aware companion context', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'The family main thing is Travis has an early game this weekend.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('FamilyUpcomingIntent'));

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('What does the family have going on'),
        promptContext: expect.objectContaining({
          conversationSummary:
            'family plans, household logistics, and what the family needs',
          conversationSubjectKind: 'household',
          guidanceGoal: 'family_guidance',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('family main thing');
  });

  it('routes AnythingImportantIntent as risk-aware guidance', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Nothing urgent. The main thing is the late client call.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AnythingImportantIntent'),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('Anything I should know'),
        promptContext: expect.objectContaining({
          guidanceGoal: 'anything_important',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('Nothing urgent');
  });

  it('routes WhatAmIForgettingIntent as loose-end guidance', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'The most likely thing you are forgetting is the follow-up note for tonight.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('WhatAmIForgettingIntent'),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('What am I forgetting'),
        promptContext: expect.objectContaining({
          guidanceGoal: 'what_am_i_forgetting',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('most likely thing');
  });

  it('routes EveningResetIntent through the companion guidance lane', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Tonight looks manageable. The main thing is to send that follow-up before you leave.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('EveningResetIntent'));

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('Give me an evening reset'),
        promptContext: expect.objectContaining({
          guidanceGoal: 'evening_reset',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('Tonight looks manageable');
  });

  it('supports follow-up turns like anything else using short-lived Alexa context', async () => {
    mockedRunAlexaAssistantTurn
      .mockResolvedValueOnce({
        text: 'Tomorrow is light. You have one lunch and a late call.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      })
      .mockResolvedValueOnce({
        text: 'You also have a free stretch in the afternoon.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      });

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('TomorrowCalendarIntent'));
    const response = await skill.invoke(buildIntentEnvelope('AnythingElseIntent'));

    expect(mockedRunAlexaAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('Continue this Alexa conversation'),
        promptContext: expect.objectContaining({
          conversationSummary: 'tomorrow and what it looks like',
        }),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('free stretch');
  });

  it('maps conversational follow-ups like say more onto the current Alexa context', async () => {
    mockedRunAlexaAssistantTurn
      .mockResolvedValueOnce({
        text: 'Today is light. The main thing is your afternoon review.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      })
      .mockResolvedValueOnce({
        text: 'The review is the part that needs prep, because the agenda still looks thin.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      });

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('MyDayIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'say more',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('say a little more'),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('agenda still looks thin');
  });

  it('maps conversational follow-ups like make that shorter onto the current Alexa context', async () => {
    mockedRunAlexaAssistantTurn
      .mockResolvedValueOnce({
        text: 'Your next step is to review the agenda for that meeting.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      })
      .mockResolvedValueOnce({
        text: 'Review the agenda first.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      });

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('WhatNextIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'make that shorter',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('Say the last answer again, but shorter'),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('Review the agenda first');
  });

  it('maps action-guidance follow-ups onto the active Alexa context', async () => {
    mockedRunAlexaAssistantTurn
      .mockResolvedValueOnce({
        text: 'The main thing is your late client call.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      })
      .mockResolvedValueOnce({
        text: 'I would send the short client update now so it is off your plate.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      });

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('AnythingImportantIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'what should I do about that',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('most useful thing to do about that next'),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('client update now');
  });

  it('maps person follow-ups like what about Travis onto the current Alexa context', async () => {
    mockedRunAlexaAssistantTurn
      .mockResolvedValueOnce({
        text: 'The family main thing is Candace has dinner plans and Travis has a game.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      })
      .mockResolvedValueOnce({
        text: 'For Travis, the main thing is the early game this weekend.',
        route: 'protected_assistant',
        chatJid: 'alexa:main:abc',
        groupFolder: 'main',
      });

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('FamilyUpcomingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'what about Travis',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('shift the focus to Travis'),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('For Travis');
  });

  it('handles memory-control voice turns without routing them through the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('MemoryControlIntent', {
        memoryCommand: 'be more direct',
      }),
    );

    expect(extractSpeechText(response)).toContain('shorter and more direct');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('explains personalization briefly without routing explainability through the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('MemoryControlIntent', {
        memoryCommand: 'why did you say that',
      }),
    );

    expect(extractSpeechText(response)).toContain('current schedule');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('asks for reminder lead time before running the reminder action', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('RemindBeforeNextMeetingIntent'),
    );

    expect(extractSpeechText(response)).toContain(
      'How long before your next meeting',
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('confirms and then saves the reminder when the user answers yes', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'I saved that reminder.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const confirm = await skill.invoke(
      buildIntentEnvelope('RemindBeforeNextMeetingIntent', {
        leadTime: '30 minutes',
      }),
    );
    expect(extractSpeechText(confirm)).toContain('30 minutes');

    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.YesIntent'),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining(
          'Set a reminder 30 minutes before my next meeting',
        ),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('I saved that reminder');
  });

  it('asks what to save when SaveForLaterIntent only has a bare reference', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('SaveForLaterIntent', {
        captureText: 'that',
      }),
    );

    expect(extractSpeechText(response)).toContain('save for later');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('asks which meeting when follow-up target is missing', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('DraftFollowUpIntent'),
    );

    expect(extractSpeechText(response)).toContain('Which meeting do you mean');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('renders a safe setup message when the linked group is missing', async () => {
    mockedRunAlexaAssistantTurn.mockRejectedValue(
      new AlexaTargetGroupMissingError('main'),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('MyDayIntent'));

    expect(extractSpeechText(response)).toContain('workspace is not ready');
  });

  it('sanitizes bridge failures into a safe Alexa response', async () => {
    mockedRunAlexaAssistantTurn.mockRejectedValue(
      new Error('OPENAI_API_KEY=sk-test-secret'),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('MyDayIntent'));

    expect(extractSpeechText(response)).toContain('voice-service snag');
    expect(extractSpeechText(response)).not.toContain('sk-test-secret');
  });

  it('responds gracefully to fallback without invoking the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.FallbackIntent'),
    );

    expect(extractSpeechText(response)).toContain('works best with short');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });
});

describe('startAlexaServer', () => {
  let runtime: Awaited<ReturnType<typeof startAlexaServer>> = null;

  beforeEach(() => {
    _initTestDatabase();
    mockedRunAlexaAssistantTurn.mockReset();
    setRegisteredGroup('tg:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-03T08:00:00Z',
      requiresTrigger: false,
      isMain: true,
    });
    seedLinkedAccount('main');
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  });

  it('serves a health endpoint and handles unsigned local requests when verification is disabled', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Tomorrow has one timed event.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    runtime = await startAlexaServer(buildConfig());
    expect(runtime).not.toBeNull();

    const status = runtime!.getStatus();
    const health = await fetch(
      `http://127.0.0.1:${status.port}${status.healthPath}`,
    );
    expect(health.status).toBe(200);

    const response = await fetch(
      `http://127.0.0.1:${status.port}${status.path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildIntentEnvelope('TomorrowCalendarIntent')),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ResponseEnvelope;
    expect(extractSpeechText(payload)).toContain(
      'Tomorrow has one timed event',
    );
  });

  it('rejects requests with the wrong Alexa skill/application identity', async () => {
    runtime = await startAlexaServer(buildConfig());
    const status = runtime!.getStatus();
    const envelope = buildIntentEnvelope('MyDayIntent');
    envelope.context!.System.application!.applicationId =
      'amzn1.ask.skill.wrong';
    envelope.session!.application!.applicationId = 'amzn1.ask.skill.wrong';

    const response = await fetch(
      `http://127.0.0.1:${status.port}${status.path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      },
    );

    expect(response.status).toBe(400);
  });
});

describe('formatAlexaStatusMessage', () => {
  it('renders both disabled and enabled status states clearly', () => {
    expect(
      formatAlexaStatusMessage({ enabled: false, running: false }),
    ).toContain('Status: disabled');
    expect(
      formatAlexaStatusMessage({
        enabled: true,
        running: true,
        host: '127.0.0.1',
        port: 4300,
        path: '/alexa',
        healthPath: '/alexa/health',
        verifySignature: true,
        requireAccountLinking: true,
        allowedUserIdsCount: 1,
      }),
    ).toContain('Status: listening');
  });
});
