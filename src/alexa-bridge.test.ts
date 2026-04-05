import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
    },
  };
});

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeCursorAgentsSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeOpenClawSkillsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  isLogLevelEnabled: vi.fn(() => false),
  logger: {
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  AlexaTargetGroupMissingError,
  type AlexaBridgeDeps,
  resolveAlexaBridgeTarget,
  runAlexaAssistantTurn,
  type AlexaPrincipal,
} from './alexa-bridge.js';
import { _initTestDatabase } from './db.js';

function buildDeps() {
  return {
    getAllRegisteredGroups: vi.fn<
      () => Record<
        string,
        {
          name: string;
          folder: string;
          trigger: string;
          added_at: string;
          requiresTrigger: boolean;
          isMain: boolean;
        }
      >
    >(() => ({
      'tg:123': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andrea',
        added_at: '2026-03-29T08:00:00Z',
        requiresTrigger: false,
        isMain: true,
      },
    })),
    getAllChats: vi.fn(() => []),
    getAllTasks: vi.fn(() => []),
    listAllEnabledCommunitySkills: vi.fn(() => []),
    listAllCursorAgents: vi.fn(() => []),
    listCursorAgentArtifacts: vi.fn(() => []),
    setRegisteredGroup: vi.fn(),
    getSession: vi.fn(() => 'session-1'),
    setSession: vi.fn(),
    deleteSession: vi.fn(),
    getAgentThread: vi.fn(() => undefined),
    getAllAgentThreads: vi.fn(() => ({})),
    setAgentThread: vi.fn(),
    deleteAgentThread: vi.fn(),
    storeChatMetadata: vi.fn(),
    storeMessage: vi.fn(),
    runContainerAgent: vi.fn(),
  } satisfies AlexaBridgeDeps;
}

const principal: AlexaPrincipal = {
  userId: 'amzn1.ask.account.test-user',
};

beforeEach(() => {
  _initTestDatabase();
});

describe('resolveAlexaBridgeTarget', () => {
  it('defaults to the main group when one already exists', () => {
    const target = resolveAlexaBridgeTarget(
      principal,
      {},
      {
        'tg:123': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andrea',
          added_at: '2026-03-29T08:00:00Z',
          requiresTrigger: false,
          isMain: true,
        },
      },
    );

    expect(target.group.folder).toBe('main');
    expect(target.chatJid).toContain('alexa:main:');
    expect(target.shouldPersistGroup).toBe(false);
  });

  it('creates an isolated Alexa workspace when no main group exists', () => {
    const target = resolveAlexaBridgeTarget(principal, {}, {});

    expect(target.group.folder).toMatch(/^alexa_[a-f0-9]{12}$/);
    expect(target.chatJid).toMatch(/^alexa:[a-f0-9]{12}$/);
    expect(target.shouldPersistGroup).toBe(true);
  });

  it('requires an existing target group when linked Alexa identity points at one', () => {
    expect(() =>
      resolveAlexaBridgeTarget(
        principal,
        {
          targetGroupFolder: 'main',
          requireExistingTargetGroup: true,
        },
        {},
      ),
    ).toThrowError(new AlexaTargetGroupMissingError('main'));
  });
});

describe('runAlexaAssistantTurn', () => {
  it('stores the voice turn, preserves the session, and returns stripped output', async () => {
    const deps = buildDeps();
    deps.runContainerAgent.mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: '<internal>plan</internal>Hello from Andrea',
          newSessionId: 'session-2',
        });
        return {
          status: 'success',
          result: '<internal>plan</internal>Hello from Andrea',
          newSessionId: 'session-2',
        };
      },
    );

    const result = await runAlexaAssistantTurn(
      {
        utterance: 'research standing desks',
        principal,
      },
      {
        assistantName: 'Andrea',
      },
      deps,
    );

    expect(result.text).toBe('Hello from Andrea');
    expect(result.groupFolder).toBe('main');
    expect(deps.setSession).toHaveBeenCalledWith('main', 'session-2');
    expect(deps.storeMessage).toHaveBeenCalledTimes(2);
    expect(deps.runContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'main' }),
      expect.objectContaining({
        sessionId: 'session-1',
        chatJid: expect.stringContaining('alexa:main:'),
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('input'),
      '',
    );
  });

  it('persists a new isolated Alexa workspace when no shared target exists', async () => {
    const deps = buildDeps();
    deps.getAllRegisteredGroups.mockReturnValue({});
    deps.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'Hello',
      newSessionId: 'session-3',
    });

    const result = await runAlexaAssistantTurn(
      {
        utterance: 'set a reminder for tomorrow',
        principal,
      },
      {
        assistantName: 'Andrea',
      },
      deps,
    );

    expect(result.groupFolder).toMatch(/^alexa_[a-f0-9]{12}$/);
    expect(deps.setRegisteredGroup).toHaveBeenCalledTimes(1);
  });

  it('returns a safe helper failure message when the runtime throws', async () => {
    const deps = buildDeps();
    deps.runContainerAgent.mockRejectedValue(
      new Error('401 unauthorized OPENAI_API_KEY=sk-secret'),
    );

    const result = await runAlexaAssistantTurn(
      {
        utterance: 'do the thing',
        principal,
      },
      {
        assistantName: 'Andrea',
      },
      deps,
    );

    expect(result.text).toContain(
      'external integration credentials were rejected',
    );
    expect(result.text).not.toContain('sk-secret');
  });

  it('clears stale Alexa session state and retries once when the thread is gone', async () => {
    const deps = buildDeps();
    deps.runContainerAgent
      .mockResolvedValueOnce({
        status: 'error',
        error: 'No conversation found with session ID dead-session',
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: 'Fresh answer after resetting the stale session.',
        newSessionId: 'session-2',
      });

    const result = await runAlexaAssistantTurn(
      {
        utterance: 'what is my day',
        principal,
      },
      {
        assistantName: 'Andrea',
      },
      deps,
    );

    expect(deps.deleteSession).toHaveBeenCalledWith('main');
    expect(deps.deleteAgentThread).toHaveBeenCalledWith('main');
    expect(deps.runContainerAgent).toHaveBeenCalledTimes(2);
    expect(deps.setSession).toHaveBeenCalledWith('main', 'session-2');
    expect(result.text).toContain('Fresh answer after resetting the stale session.');
  });
});
