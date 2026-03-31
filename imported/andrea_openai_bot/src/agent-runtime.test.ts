import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canRouteToCloud,
  classifyRuntimeRoute,
  getAgentRuntimeStatusSnapshot,
  selectPreferredRuntime,
  shouldReuseExistingThread,
} from './agent-runtime.js';

describe('agent-runtime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps code-plane work local', () => {
    expect(
      classifyRuntimeRoute(
        { route: 'code_plane' },
        'Implement the failing repo fix',
      ),
    ).toBe('local_required');
  });

  it('allows direct assistant work to fall back to cloud', () => {
    expect(
      classifyRuntimeRoute(
        { route: 'direct_assistant' },
        'Summarize this article for me',
      ),
    ).toBe('cloud_allowed');
    expect(canRouteToCloud('cloud_allowed')).toBe(true);
  });

  it('honors explicit cloud-preferred markers', () => {
    expect(
      classifyRuntimeRoute(
        { route: 'direct_assistant' },
        '[runtime:cloud] Research current launch news',
      ),
    ).toBe('cloud_preferred');
  });

  it('reuses an existing matching runtime thread when allowed', () => {
    const thread = {
      group_folder: 'main',
      runtime: 'openai_cloud' as const,
      thread_id: 'resp_123',
      last_response_id: 'resp_123',
      updated_at: '2026-03-30T00:00:00.000Z',
    };

    const preferred = selectPreferredRuntime(thread, 'cloud_allowed');
    expect(preferred).toBe('openai_cloud');
    expect(shouldReuseExistingThread(thread, preferred)).toBe(true);
  });

  it('reports conditional readiness honestly when credentials are missing', () => {
    const snapshot = getAgentRuntimeStatusSnapshot({
      activeThreads: {},
      activeJobs: 0,
      containerRuntimeName: 'podman',
      containerRuntimeStatus: 'running',
    });

    expect(snapshot.codexLocalEnabled).toBe(true);
    expect(typeof snapshot.hostCodexAuthPresent).toBe('boolean');
    expect(typeof snapshot.codexLocalReady).toBe('boolean');
    expect(typeof snapshot.openAiCloudReady).toBe('boolean');
  });

  it('does not claim openai_cloud readiness without OPENAI_API_KEY', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'legacy-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'legacy-token');

    const snapshot = getAgentRuntimeStatusSnapshot({
      activeThreads: {},
      activeJobs: 0,
      containerRuntimeName: 'podman',
      containerRuntimeStatus: 'running',
    });

    expect(snapshot.openAiApiKeyPresent).toBe(false);
    expect(snapshot.openAiCloudReady).toBe(false);
  });
});
