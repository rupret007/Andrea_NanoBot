import fs from 'fs';

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
  loadAlexaConversationState,
  saveAlexaConversationState,
} from './alexa-conversation.js';
import {
  AlexaTargetGroupMissingError,
  runAlexaAssistantTurn,
} from './alexa-bridge.js';
import {
  buildDailyCompanionResponse,
  type DailyCompanionResponse,
} from './daily-companion.js';
import {
  getAlexaPrincipalKey,
  seedConfiguredAlexaLinkedAccount,
} from './alexa-identity.js';
import {
  _initTestDatabase,
  getAllTasks,
  listKnowledgeSourcesForGroup,
  setRegisteredGroup,
} from './db.js';
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

vi.mock('./daily-companion.js', () => ({
  buildDailyCompanionResponse: vi.fn(),
}));

const mockedRunAlexaAssistantTurn = vi.mocked(runAlexaAssistantTurn);
const mockedBuildDailyCompanionResponse = vi.mocked(buildDailyCompanionResponse);
const ALEXA_LAST_SIGNED_REQUEST_STATE_SUFFIX = process.env.VITEST_WORKER_ID
  ? `-${process.env.VITEST_WORKER_ID}`
  : '';
const ALEXA_LAST_SIGNED_REQUEST_STATE_PATH =
  `C:/Users/rupret/Desktop/Andrea_NanoBot/data/runtime/alexa-last-signed-request${ALEXA_LAST_SIGNED_REQUEST_STATE_SUFFIX}.json`;

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

function buildCompanionResponse(
  reply: string,
  overrides: Partial<DailyCompanionResponse> = {},
): DailyCompanionResponse {
  const channel = overrides.channel ?? 'alexa';
  const mode = overrides.mode ?? 'morning_brief';
  const subjectKind = overrides.context?.subjectKind ?? 'day_brief';
  const supportedFollowups =
    overrides.context?.supportedFollowups ?? [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'risk_check',
      'switch_person',
      'memory_control',
      'send_details',
      'save_to_library',
      'track_thread',
      'create_reminder',
      'save_for_later',
      'draft_follow_up',
    ];

  return {
    reply,
    mode,
    channel,
    leadReason: overrides.leadReason ?? 'calendar',
    signalsUsed: overrides.signalsUsed ?? ['calendar'],
    signalsOmitted: overrides.signalsOmitted ?? [],
    householdSignals: overrides.householdSignals ?? [],
    recommendationKind: overrides.recommendationKind ?? 'none',
    grounded: overrides.grounded ?? null,
    context: {
      version: 1,
      mode,
      channel,
      generatedAt: '2026-04-03T08:00:00.000Z',
      summaryText:
        overrides.context?.summaryText ?? 'today and what matters most',
      shortText: overrides.context?.shortText ?? reply,
      extendedText: overrides.context?.extendedText ?? reply,
      leadReason: overrides.context?.leadReason ?? 'calendar',
      signalsUsed: overrides.context?.signalsUsed ?? ['calendar'],
      signalsOmitted: overrides.context?.signalsOmitted ?? [],
      householdSignals: overrides.context?.householdSignals ?? [],
      recommendationKind:
        overrides.context?.recommendationKind ??
        overrides.recommendationKind ??
        'none',
      recommendationText: overrides.context?.recommendationText ?? null,
      subjectKind,
      supportedFollowups,
      subjectData: overrides.context?.subjectData ?? {},
      toneProfile: overrides.context?.toneProfile ?? 'balanced',
      extraDetails:
        overrides.context?.extraDetails ?? ['A little more context.'],
      memoryLines: overrides.context?.memoryLines ?? [],
      usedThreadIds: overrides.context?.usedThreadIds ?? [],
      usedThreadTitles: overrides.context?.usedThreadTitles ?? [],
      usedThreadReasons: overrides.context?.usedThreadReasons ?? [],
      threadSummaryLines: overrides.context?.threadSummaryLines ?? [],
      comparisonKeys: overrides.context?.comparisonKeys ?? {
        nextEvent: null,
        nextReminder: null,
        recommendation: null,
        household: null,
        focus: null,
        thread: null,
      },
    },
  };
}

function seedLinkedAccount(groupFolder = 'main') {
  return seedConfiguredAlexaLinkedAccount({
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
    try {
      fs.unlinkSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH);
    } catch {}
    _initTestDatabase();
    mockedRunAlexaAssistantTurn.mockReset();
    mockedBuildDailyCompanionResponse.mockReset();
    mockedBuildDailyCompanionResponse.mockImplementation(async (message, deps) =>
      buildCompanionResponse(`Local companion: ${message}`, {
        channel: deps.channel,
      }),
    );
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

    expect(extractSpeechText(response)).toContain(
      `This is ${ASSISTANT_NAME}.`,
    );
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

  it('routes MyDayIntent through the local daily companion with linked group context', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Today is light. You have one afternoon meeting.'),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('MyDayIntent'));

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'what should I know about today',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('Today is light');
  });

  it('routes WhatMattersMostTodayIntent as measured Alexa companion guidance', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('The main thing today is your afternoon review.', {
        mode: 'open_guidance',
      }),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('WhatMattersMostTodayIntent'),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'what matters most today',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('main thing today');
  });

  it('routes FamilyUpcomingIntent with household-aware companion context', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse(
        'The family main thing is Travis has an early game this weekend.',
        {
          mode: 'household_guidance',
          context: {
            ...buildCompanionResponse('x').context,
            subjectKind: 'household',
            subjectData: { householdFocus: true, activePeople: ['Candace'] },
          },
        },
      ),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('FamilyUpcomingIntent'));

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'what does the family have going on',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('family main thing');
  });

  it('handles save-to-thread follow-ups locally without the assistant bridge', async () => {
    const linked = seedLinkedAccount('main');
    saveAlexaConversationState(
      getAlexaPrincipalKey({
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
      }),
      linked!.accessTokenHash,
      'main',
      {
        flowKey: 'my_day',
        subjectKind: 'day_brief',
        subjectData: {
          dailyCompanionContextJson: JSON.stringify(
            buildCompanionResponse('Candace still needs a dinner answer.', {
              mode: 'household_guidance',
              context: {
                ...buildCompanionResponse('x').context,
                usedThreadIds: [],
                usedThreadTitles: [],
                usedThreadReasons: [],
                threadSummaryLines: [],
              },
            }).context,
          ),
        },
        summaryText: 'Candace still needs a dinner answer.',
        supportedFollowups: ['anything_else', 'memory_control', 'save_that'],
        styleHints: { responseSource: 'local_companion' },
      },
    );

    mockedBuildDailyCompanionResponse.mockResolvedValue(null);

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'save that under the family thread',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('saved that under Family');
  });

  it('routes AnythingImportantIntent as risk-aware guidance', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse(
        'Nothing urgent. The main thing is the late client call.',
        {
          mode: 'open_guidance',
        },
      ),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AnythingImportantIntent'),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'anything I should know',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('Nothing urgent');
  });

  it('routes WhatAmIForgettingIntent as loose-end guidance', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse(
        'The most likely thing you are forgetting is the follow-up note for tonight.',
        {
          mode: 'open_guidance',
        },
      ),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('WhatAmIForgettingIntent'),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'what am I forgetting',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('most likely thing');
  });

  it('routes CandaceUpcomingIntent through the thread-aware companion lane', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse(
        'With Candace, the main thing is dinner plans and what you still need to confirm.',
        {
          mode: 'household_guidance',
          context: {
            ...buildCompanionResponse('x').context,
            subjectKind: 'person',
            subjectData: { personName: 'Candace', activePeople: ['Candace'] },
            usedThreadIds: ['thread-candace'],
            usedThreadTitles: ['Candace'],
            usedThreadReasons: ['it is an active household thread'],
            threadSummaryLines: ['Dinner plans still need an answer.'],
          },
        },
      ),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('CandaceUpcomingIntent'),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'what do Candace and I have coming up',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('With Candace');
  });

  it('routes EveningResetIntent through the companion guidance lane', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse(
        'Tonight looks manageable. The main thing is to send that follow-up before you leave.',
        {
          mode: 'evening_reset',
        },
      ),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('EveningResetIntent'));

    expect(mockedBuildDailyCompanionResponse).toHaveBeenCalledWith(
      'give me an evening reset',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('Tonight looks manageable');
  });

  it('supports follow-up turns like anything else using short-lived Alexa context', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'Tomorrow is light. You have one lunch and a late call.',
          {
            mode: 'open_guidance',
            context: {
              ...buildCompanionResponse('x').context,
              summaryText: 'tomorrow and what it looks like',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        buildCompanionResponse('You also have a free stretch in the afternoon.', {
          mode: 'open_guidance',
        }),
      );

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('TomorrowCalendarIntent'));
    const response = await skill.invoke(buildIntentEnvelope('AnythingElseIntent'));

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'anything else',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
        priorContext: expect.objectContaining({
          summaryText: 'tomorrow and what it looks like',
        }),
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('free stretch');
  });

  it('maps conversational follow-ups like say more onto the current Alexa context', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'Today is light. The main thing is your afternoon review.',
        ),
      )
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'The review is the part that needs prep, because the agenda still looks thin.',
        ),
      );

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('MyDayIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'say more',
      }),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'say more',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
        priorContext: expect.objectContaining({
          summaryText: 'today and what matters most',
        }),
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('agenda still looks thin');
  });

  it('maps conversational follow-ups like make that shorter onto the current Alexa context', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'Your next step is to review the agenda for that meeting.',
        ),
      )
      .mockResolvedValueOnce(buildCompanionResponse('Review the agenda first.'));

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('WhatNextIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'make that shorter',
      }),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'make that shorter',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('Review the agenda first');
  });

  it('maps action-guidance follow-ups onto the active Alexa context', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse('The main thing is your late client call.', {
          mode: 'open_guidance',
        }),
      )
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'I would send the short client update now so it is off your plate.',
          {
            mode: 'open_guidance',
          },
        ),
      );

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('AnythingImportantIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'what should I do about that',
      }),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'what should I do about that',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('client update now');
  });

  it('maps person follow-ups like what about Travis onto the current Alexa context', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'The family main thing is Candace has dinner plans and Travis has a game.',
          {
            mode: 'household_guidance',
            context: {
              ...buildCompanionResponse('x').context,
              subjectKind: 'household',
              subjectData: { householdFocus: true, activePeople: ['Candace', 'Travis'] },
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'For Travis, the main thing is the early game this weekend.',
          {
            mode: 'household_guidance',
            context: {
              ...buildCompanionResponse('x').context,
              subjectKind: 'person',
              subjectData: { personName: 'Travis', activePeople: ['Travis'] },
            },
          },
        ),
      );

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('FamilyUpcomingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'what about Travis',
      }),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'what about Travis',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
      }),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
    expect(extractSpeechText(response)).toContain('For Travis');
  });

  it('handles memory-control voice turns without routing them through the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('MemoryControlIntent', {
        memoryCommand: 'be a little more direct',
      }),
    );

    expect(extractSpeechText(response)).toContain('more direct');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('treats bare directness follow-ups as local Alexa restyling when a companion answer is active', async () => {
    mockedBuildDailyCompanionResponse
      .mockResolvedValueOnce(
        buildCompanionResponse(
          'The main thing is to review the agenda before the call, then send the short update.',
          {
            mode: 'open_guidance',
            context: {
              ...buildCompanionResponse('x').context,
              summaryText: 'review the agenda before the call',
              recommendationText:
                'Review the agenda, then send the short update.',
              usedThreadIds: ['thread-client-call'],
              usedThreadTitles: ['Client call'],
              threadSummaryLines: [
                'Client call prep still needs a quick review.',
              ],
              shortText: 'Review the agenda, then send the short update.',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        buildCompanionResponse('Review the agenda, then send the short update.', {
          mode: 'open_guidance',
          context: {
            ...buildCompanionResponse('x').context,
            summaryText: 'review the agenda before the call',
            recommendationText: null,
            supportedFollowups: ['memory_control'],
            usedThreadIds: [],
            usedThreadTitles: [],
            threadSummaryLines: [],
            shortText: 'Review the agenda, then send the short update.',
          },
        }),
      );

    const skill = createAlexaSkill(buildConfig());
    await skill.invoke(buildIntentEnvelope('WhatNextIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('MemoryControlIntent', {
        memoryCommand: 'a little more direct',
      }),
    );

    expect(mockedBuildDailyCompanionResponse).toHaveBeenLastCalledWith(
      'be a little more direct',
      expect.objectContaining({
        channel: 'alexa',
        groupFolder: 'main',
        priorContext: expect.objectContaining({
          summaryText: 'review the agenda before the call',
        }),
      }),
    );
    expect(extractSpeechText(response)).toContain(
      'Review the agenda, then send the short update.',
    );
    const linked = seedLinkedAccount('main');
    const savedState = loadAlexaConversationState(
      getAlexaPrincipalKey({
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
      }),
      linked!.accessTokenHash,
    );
    expect(savedState?.styleHints.responseStyle).toBe('short_direct');
    expect(savedState?.subjectData.lastRecommendation).toBe(
      'Review the agenda, then send the short update.',
    );
    expect(savedState?.subjectData.threadTitle).toBe('Client call');
    expect(savedState?.supportedFollowups).toEqual(
      expect.arrayContaining(['anything_else', 'say_more', 'memory_control']),
    );
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
    const response = await skill.invoke(
      buildIntentEnvelope('DraftFollowUpIntent', {
        meetingReference: 'the review',
      }),
    );

    expect(extractSpeechText(response)).toContain('workspace is not ready');
  });

  it('sanitizes bridge failures into a safe Alexa response', async () => {
    mockedRunAlexaAssistantTurn.mockRejectedValue(
      new Error('OPENAI_API_KEY=sk-test-secret'),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('DraftFollowUpIntent', {
        meetingReference: 'the review',
      }),
    );

    expect(extractSpeechText(response)).toContain("couldn't get the deeper read");
    expect(extractSpeechText(response)).not.toContain('sk-test-secret');
  });

  it('responds gracefully to fallback without invoking the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.FallbackIntent'),
    );

    expect(extractSpeechText(response)).toContain(`This is ${ASSISTANT_NAME}.`);
    expect(extractSpeechText(response)).toContain('did not quite catch that');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('uses thread-aware fallback suggestions when recent Alexa context is about Candace', async () => {
    const linked = seedLinkedAccount('main');
    saveAlexaConversationState(
      getAlexaPrincipalKey({
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
      }),
      linked!.accessTokenHash,
      'main',
      {
        flowKey: 'candace_upcoming',
        subjectKind: 'person',
        subjectData: {
          personName: 'Candace',
          activePeople: ['Candace'],
          fallbackCount: 0,
        },
        summaryText: 'shared plans with Candace',
        supportedFollowups: ['anything_else', 'switch_person'],
        styleHints: {
          channelMode: 'alexa_companion',
          prioritizationLens: 'family',
          responseSource: 'local_companion',
        },
      },
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.FallbackIntent'),
    );

    expect(extractSpeechText(response)).toContain(
      "what's still open with Candace",
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('narrows repeated fallback guidance instead of repeating the full command list', async () => {
    const skill = createAlexaSkill(buildConfig());

    await skill.invoke(buildIntentEnvelope('AMAZON.FallbackIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.FallbackIntent'),
    );

    expect(extractSpeechText(response)).toContain('still not quite getting it');
    expect(extractSpeechText(response)).toContain('what am I forgetting');
    expect(extractSpeechText(response)).not.toContain(
      "what's still open with Candace, or what should I remember tonight",
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('uses a contextual fallback clarifier after a successful local companion turn', async () => {
    const linked = seedLinkedAccount('main');
    saveAlexaConversationState(
      getAlexaPrincipalKey({
        userId: 'amzn1.ask.account.test-user',
        personId: 'amzn1.ask.person.test-person',
      }),
      linked!.accessTokenHash,
      'main',
      {
        flowKey: 'evening_reset',
        subjectKind: 'day_brief',
        subjectData: {
          fallbackCount: 0,
          lastAnswerSummary:
            'Tonight looks fairly clear, so this is mostly about closing the right loop.',
          pendingActionText:
            'Close the loop with Candace before the evening gets away from you.',
          conversationFocus: 'tonight',
        },
        summaryText:
          'Tonight looks fairly clear, so this is mostly about closing the right loop.',
        supportedFollowups: [
          'anything_else',
          'say_more',
          'save_that',
          'memory_control',
        ],
        styleHints: {
          channelMode: 'alexa_companion',
          guidanceGoal: 'evening_reset',
          prioritizationLens: 'evening',
          responseSource: 'local_companion',
          responseStyle: 'short_direct',
        },
      },
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('AMAZON.FallbackIntent'),
    );

    expect(extractSpeechText(response)).toContain('I am still on tonight.');
    expect(extractSpeechText(response)).toContain('say more');
    expect(extractSpeechText(response)).toContain('ask why I said that');
    expect(extractSpeechText(response)).not.toContain('what am I forgetting');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('uses the broader Alexa bridge path for conversational turns that are not local companion asks', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValueOnce(null);
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'You could send Candace a short note now so it is off your plate.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'help me figure out what to text Candace about dinner',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining(
          'Stay in the same Andrea Alexa conversation.',
        ),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('send Candace a short note');
  });

  it('hands daily companion detail over to Telegram from an Alexa follow-up', async () => {
    const sendTelegramMessage = vi.fn(async () => ({
      platformMessageId: 'tg-msg-1',
    }));
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Candace still needs a dinner answer.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Candace still needs a dinner answer.',
          extendedText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          usedThreadIds: ['thread-candace'],
          usedThreadTitles: ['Candace'],
        },
      }),
    );

    const skill = createAlexaSkill(buildConfig(), {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      sendTelegramMessage,
    });

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'send me the details',
      }),
    );

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('pickup works better after rehearsal'),
    );
    expect(extractSpeechText(response)).toContain('sent the details to Telegram');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('saves the prior Alexa answer to the library from a follow-up turn', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Candace still needs a dinner answer.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Candace still needs a dinner answer.',
          extendedText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
        },
      }),
    );

    const skill = createAlexaSkill(buildConfig());

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'save that in my library',
      }),
    );

    expect(extractSpeechText(response)).toContain('Saved');
    expect(listKnowledgeSourcesForGroup('main')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'generated_note',
        }),
      ]),
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('creates a reminder from a voice follow-up when timing is explicit', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Do not forget the band thing.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Do not forget the band thing.',
          extendedText:
            'Do not forget the band thing before tonight so you can lock the details in.',
        },
      }),
    );

    const skill = createAlexaSkill(buildConfig(), {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'tg-msg-2' })),
    });

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'turn that into a reminder tonight',
      }),
    );

    expect(extractSpeechText(response)).toContain('remind you');
    expect(getAllTasks().some((task) => task.prompt.includes('band thing'))).toBe(
      true,
    );
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('routes save-for-later follow-ups through the shared continuation path', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Candace still needs a dinner answer.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Candace still needs a dinner answer.',
          extendedText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
        },
      }),
    );
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'I saved that as follow-through for later.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'save that for later',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining(
          'Save this for later as personal follow-through',
        ),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain(
      'I saved that as follow-through for later',
    );
  });

  it('drafts from the current Alexa context without restarting from a blank prompt', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Candace still needs a dinner answer.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Candace still needs a dinner answer.',
          extendedText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          usedThreadIds: ['thread-candace'],
          usedThreadTitles: ['Candace'],
        },
      }),
    );
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'You could send Candace a short note saying pickup after rehearsal works best tonight.',
      route: 'protected_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig(), {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'tg-msg-3' })),
    });

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'draft that for me',
      }),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: expect.stringContaining('Draft a short follow-up for Candace'),
      }),
      expect.any(Object),
    );
    expect(extractSpeechText(response)).toContain('send Candace a short note');
  });

  it('keeps track of the active thread for tonight without using the bridge', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Candace still needs a dinner answer.', {
        context: {
          ...buildCompanionResponse('x').context,
          summaryText: 'Candace still needs a dinner answer.',
          extendedText:
            'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          usedThreadIds: ['thread-candace'],
          usedThreadTitles: ['Candace'],
        },
      }),
    );

    const skill = createAlexaSkill(buildConfig());

    await skill.invoke(buildIntentEnvelope('WhatAmIForgettingIntent'));
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'keep track of that for tonight',
      }),
    );

    expect(extractSpeechText(response)).toContain('evening reset');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });

  it('keeps work-cockpit style requests out of the broad Alexa conversation path', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValueOnce(null);

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('ConversationalFollowupIntent', {
        followupText: 'check runtime job status',
      }),
    );

    expect(extractSpeechText(response)).toContain('use Telegram');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });
});

describe('startAlexaServer', () => {
  let runtime: Awaited<ReturnType<typeof startAlexaServer>> = null;

  beforeEach(() => {
    _initTestDatabase();
    mockedRunAlexaAssistantTurn.mockReset();
    mockedBuildDailyCompanionResponse.mockReset();
    mockedBuildDailyCompanionResponse.mockImplementation(async (message, deps) =>
      buildCompanionResponse(`Local companion: ${message}`, {
        channel: deps.channel,
      }),
    );
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
    try {
      fs.unlinkSync(ALEXA_LAST_SIGNED_REQUEST_STATE_PATH);
    } catch {}
  });

  it('serves a health endpoint and handles unsigned local requests when verification is disabled', async () => {
    mockedBuildDailyCompanionResponse.mockResolvedValue(
      buildCompanionResponse('Tomorrow has one timed event.', {
        mode: 'open_guidance',
      }),
    );

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
    expect(extractSpeechText(payload)).toContain('Tomorrow has one timed event');
    const updatedStatus = runtime!.getStatus();
    expect(updatedStatus.lastSignedRequestType).toBe('IntentRequest');
    expect(updatedStatus.lastSignedIntent).toBe('TomorrowCalendarIntent');
    expect(updatedStatus.lastSignedGroupFolder).toBe('main');
    expect(updatedStatus.lastSignedResponseSource).toBe('local_companion');
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
    const disabled = formatAlexaStatusMessage({ enabled: false, running: false });
    expect(disabled).toContain('Status: disabled');
    expect(disabled).toContain('configure the skill ID');
    expect(disabled).not.toContain('serenades');
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
        lastSignedRequestAt: '2026-04-05T06:00:00.000Z',
        lastSignedRequestType: 'IntentRequest',
        lastSignedIntent: 'WhatAmIForgettingIntent',
        lastSignedGroupFolder: 'main',
        lastSignedResponseSource: 'local_companion',
      }),
    ).toContain('Status: listening');
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
        lastSignedRequestAt: '2026-04-05T06:00:00.000Z',
        lastSignedRequestType: 'IntentRequest',
        lastSignedIntent: 'WhatAmIForgettingIntent',
        lastSignedGroupFolder: 'main',
        lastSignedResponseSource: 'local_companion',
      }),
    ).toContain('Last signed response source: local_companion');
  });
});
