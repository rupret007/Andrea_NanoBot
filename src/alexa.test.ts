import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RequestEnvelope, type ResponseEnvelope } from 'ask-sdk-model';

import {
  createAlexaSkill,
  formatAlexaStatusMessage,
  normalizeAlexaSpeech,
  resolveAlexaConfig,
  startAlexaServer,
  type AlexaConfig,
} from './alexa.js';
import { runAlexaAssistantTurn } from './alexa-bridge.js';

vi.mock('./alexa-bridge.js', () => ({
  runAlexaAssistantTurn: vi.fn(),
}));

const mockedRunAlexaAssistantTurn = vi.mocked(runAlexaAssistantTurn);

function buildBaseEnvelope() {
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
      },
    },
    context: {
      System: {
        application: {
          applicationId: 'amzn1.ask.skill.test',
        },
        user: {
          userId: 'amzn1.ask.account.test-user',
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
      timestamp: '2026-03-29T08:00:00Z',
      type: 'LaunchRequest',
    },
  } as unknown as RequestEnvelope;
}

function buildIntentEnvelope(utterance: string) {
  return {
    ...buildBaseEnvelope(),
    request: {
      requestId: 'EdwRequestId.234',
      locale: 'en-US',
      timestamp: '2026-03-29T08:00:00Z',
      type: 'IntentRequest',
      intent: {
        name: 'AskAndreaIntent',
        confirmationStatus: 'NONE',
        slots: {
          utterance: {
            name: 'utterance',
            value: utterance,
            confirmationStatus: 'NONE',
          },
        },
      },
    },
  } as unknown as RequestEnvelope;
}

function buildUnsupportedIntentEnvelope() {
  return {
    ...buildBaseEnvelope(),
    request: {
      requestId: 'EdwRequestId.999',
      locale: 'en-US',
      timestamp: '2026-03-29T08:00:00Z',
      type: 'IntentRequest',
      intent: {
        name: 'UnsupportedIntent',
        confirmationStatus: 'NONE',
        slots: {},
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
    requireAccountLinking: false,
    allowedUserIds: [],
    targetGroupFolder: undefined,
    ...overrides,
  };
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

describe('normalizeAlexaSpeech', () => {
  it('strips internal tags, markdown, and raw links from speech', () => {
    expect(
      normalizeAlexaSpeech(
        '<internal>quiet orchestration</internal>Here is **Andrea** with `code` and https://example.com',
      ),
    ).toBe('Here is Andrea with code and');
  });
});

describe('createAlexaSkill', () => {
  beforeEach(() => {
    mockedRunAlexaAssistantTurn.mockReset();
  });

  it('responds to launch requests with a friendly welcome', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildBaseEnvelope());

    expect(extractSpeechText(response)).toContain('Andrea is here');
  });

  it('requests account linking when configured and missing', async () => {
    const skill = createAlexaSkill(
      buildConfig({ requireAccountLinking: true }),
    );
    const envelope = buildBaseEnvelope();
    delete envelope.context!.System.user!.accessToken;

    const response = await skill.invoke(envelope);

    expect(extractSpeechText(response)).toContain('needs account linking');
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

  it('routes AskAndreaIntent through the bridge and normalizes speech output', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: '<internal>planner</internal>Andrea found **three** strong options at https://example.com',
      route: 'direct_assistant',
      chatJid: 'alexa:main:abc',
      groupFolder: 'main',
    });

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(
      buildIntentEnvelope('research espresso machines'),
    );

    expect(mockedRunAlexaAssistantTurn).toHaveBeenCalledWith(
      {
        utterance: 'research espresso machines',
        principal: expect.objectContaining({
          userId: 'amzn1.ask.account.test-user',
        }),
      },
      {
        assistantName: 'Andrea',
        targetGroupFolder: undefined,
      },
    );
    expect(extractSpeechText(response)).toContain(
      'Andrea found three strong options',
    );
    expect(extractSpeechText(response)).not.toContain('https://');
  });

  it('sanitizes bridge failures into a safe Alexa response', async () => {
    mockedRunAlexaAssistantTurn.mockRejectedValue(
      new Error('OPENAI_API_KEY=sk-test-secret'),
    );

    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildIntentEnvelope('help'));

    expect(extractSpeechText(response)).toContain('voice-service snag');
    expect(extractSpeechText(response)).not.toContain('sk-test-secret');
  });

  it('responds gracefully to unsupported intents without invoking the bridge', async () => {
    const skill = createAlexaSkill(buildConfig());
    const response = await skill.invoke(buildUnsupportedIntentEnvelope());

    expect(extractSpeechText(response)).toContain('can help with research');
    expect(mockedRunAlexaAssistantTurn).not.toHaveBeenCalled();
  });
});

describe('startAlexaServer', () => {
  let runtime: Awaited<ReturnType<typeof startAlexaServer>> = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  });

  it('serves a health endpoint and handles unsigned local requests when verification is disabled', async () => {
    mockedRunAlexaAssistantTurn.mockResolvedValue({
      text: 'Andrea heard you loud and clear.',
      route: 'direct_assistant',
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
        body: JSON.stringify(buildIntentEnvelope('research office chairs')),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ResponseEnvelope;
    expect(extractSpeechText(payload)).toContain(
      'Andrea heard you loud and clear',
    );
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
        requireAccountLinking: false,
        allowedUserIdsCount: 1,
        targetGroupFolder: 'main',
      }),
    ).toContain('Status: listening');
  });
});
