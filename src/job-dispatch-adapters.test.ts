import { describe, expect, it } from 'vitest';

import { formatUnverifiedCursorProviderOutput } from './job-dispatch-adapters.js';

describe('job dispatch adapter claim boundaries', () => {
  it('labels Cursor provider summaries and URLs as unverified output', () => {
    const output = formatUnverifiedCursorProviderOutput({
      summary: 'Everything passed and was deployed.',
      targetUrl: 'https://cursor.example.invalid/agent/fixture',
      targetPrUrl: 'https://github.example.invalid/pull/1',
    });

    expect(output).toContain('untrusted until independently verified');
    expect(output).toContain('provider-reported PR URL');
    expect(output).toContain('does not prove local file changes, tests');
    expect(output).toContain('deployment, or goal completion');
  });

  it('does not invent provider output when no report exists', () => {
    expect(
      formatUnverifiedCursorProviderOutput({
        summary: null,
        targetUrl: null,
        targetPrUrl: null,
      }),
    ).toBeNull();
  });
});
