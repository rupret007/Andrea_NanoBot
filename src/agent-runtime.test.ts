import { describe, expect, it } from 'vitest';

import {
  canRouteToCloud,
  classifyRuntimeRoute,
  selectPreferredRuntime,
  shouldReuseExistingThread,
} from './agent-runtime.js';

describe('agent-runtime', () => {
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
});
