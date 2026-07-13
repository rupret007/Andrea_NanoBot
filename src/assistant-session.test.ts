import { describe, expect, it } from 'vitest';

import {
  getAssistantCapabilityLane,
  getSuppressedDeadSessionRuntimeEvidence,
  getAssistantSessionHomeFlavor,
  getAssistantSessionStorageKey,
  isDeadAssistantSessionErrorText,
} from './assistant-session.js';

describe('getAssistantSessionStorageKey', () => {
  it('isolates direct assistant sessions', () => {
    expect(getAssistantSessionStorageKey('main', 'direct_assistant')).toBe(
      'main::direct_assistant',
    );
  });

  it('uses a protected session for protected assistant work', () => {
    expect(getAssistantSessionStorageKey('main', 'protected_assistant')).toBe(
      'main::protected',
    );
  });

  it('isolates protected, control, and execution sessions', () => {
    expect(getAssistantSessionStorageKey('main', 'control_plane')).toBe(
      'main::control',
    );
    expect(getAssistantSessionStorageKey('main', 'advanced_helper')).toBe(
      'main::execution',
    );
    expect(getAssistantSessionStorageKey('main', 'code_plane')).toBe(
      'main::execution',
    );
    expect(getAssistantSessionStorageKey('main')).toBe(
      'main::direct_assistant',
    );
  });

  it('maps storage and mounted homes to the same four trust lanes', () => {
    expect(getAssistantSessionHomeFlavor('direct_assistant')).toBe(
      'direct-assistant',
    );
    expect(getAssistantSessionHomeFlavor('protected_assistant')).toBe(
      'protected',
    );
    expect(getAssistantSessionHomeFlavor('control_plane')).toBe('control');
    expect(getAssistantSessionHomeFlavor('advanced_helper')).toBe('execution');
    expect(getAssistantSessionHomeFlavor('code_plane')).toBe('execution');
    expect(getAssistantCapabilityLane(undefined)).toBe('direct-assistant');
  });
});

describe('isDeadAssistantSessionErrorText', () => {
  it('detects stale session text from assistant runtimes', () => {
    expect(
      isDeadAssistantSessionErrorText(
        'No conversation found with session ID: dead-session-123',
      ),
    ).toBe(true);
  });

  it('ignores ordinary assistant output', () => {
    expect(
      isDeadAssistantSessionErrorText(
        'Andrea: I drafted a reply you can send when you are ready.',
      ),
    ).toBe(false);
  });

  it('preserves receipts attached to suppressed stale-session output', () => {
    const receipt = { evidenceId: 'stale-attempt-receipt' };
    expect(
      getSuppressedDeadSessionRuntimeEvidence({
        result: 'No conversation found with session ID: dead-session-123',
        runtimeToolEvidence: receipt,
      }),
    ).toBe(receipt);
    expect(
      getSuppressedDeadSessionRuntimeEvidence({
        result: 'Fresh answer.',
        runtimeToolEvidence: receipt,
      }),
    ).toBeNull();
    expect(
      getSuppressedDeadSessionRuntimeEvidence({
        result: null,
        error: 'No conversation found with session ID dead-session-456',
        runtimeToolEvidence: receipt,
      }),
    ).toBe(receipt);
    expect(
      getSuppressedDeadSessionRuntimeEvidence(
        {
          result: 'No conversation found with session ID: dead-session-123',
          runtimeToolEvidence: { evidenceId: 'composite:a-and-b' },
        },
        { streamedEvidenceForwarded: true },
      ),
    ).toBeNull();
  });
});
