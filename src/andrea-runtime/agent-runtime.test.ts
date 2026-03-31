import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./codex-home.js', () => ({
  hasHostCodexAuthMaterial: vi.fn(() => false),
}));

import { readEnvFile } from '../env.js';
import { getAgentRuntimeStatusSnapshot } from './agent-runtime.js';
import { hasHostCodexAuthMaterial } from './codex-home.js';

describe('getAgentRuntimeStatusSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(hasHostCodexAuthMaterial).mockReturnValue(false);
  });

  it('uses env file OpenAI values when process env is intentionally empty', () => {
    vi.mocked(readEnvFile).mockReturnValue({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://gateway.example.com',
    });

    const snapshot = getAgentRuntimeStatusSnapshot({
      activeThreads: {},
      activeJobs: 0,
      containerRuntimeName: 'podman',
      containerRuntimeStatus: 'running',
    });

    expect(snapshot.openAiApiKeyPresent).toBe(true);
    expect(snapshot.openAiCloudReady).toBe(true);
    expect(snapshot.openAiBaseUrl).toBe('https://gateway.example.com');
  });
});
