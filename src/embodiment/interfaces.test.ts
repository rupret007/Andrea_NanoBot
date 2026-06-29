import { describe, expect, it } from 'vitest';

import type {
  CodeSandboxAdapter,
  ComputerUseAdapter,
  VisionInput,
  VoiceInput,
} from './interfaces.js';

describe('embodiment interfaces', () => {
  it('keeps sensory inputs gated by explicit feature config', () => {
    const visionInput = {
      feature: {
        enabled: false,
        mode: 'disabled',
        flag: 'ANDREA_VISION_INPUT_ENABLED',
        safetyProfile: 'observe_only',
      },
      source: 'screen',
      capturedAt: '2026-06-29T12:00:00.000Z',
      mimeType: 'image/png',
      data: { kind: 'url', value: 'file:///tmp/screen.png' },
    } satisfies VisionInput;

    const voiceInput = {
      feature: {
        enabled: false,
        mode: 'disabled',
        flag: 'ANDREA_VOICE_INPUT_ENABLED',
        safetyProfile: 'observe_only',
      },
      source: 'microphone',
      capturedAt: '2026-06-29T12:00:00.000Z',
      mimeType: 'audio/wav',
      audio: { kind: 'base64', value: 'dGVzdA==' },
      locale: 'en-US',
    } satisfies VoiceInput;

    expect(visionInput.feature.enabled).toBe(false);
    expect(voiceInput.feature.enabled).toBe(false);
  });

  it('keeps action adapters gated and approval-oriented', async () => {
    const computerUseAdapter = {
      feature: {
        enabled: false,
        mode: 'disabled',
        flag: 'ANDREA_COMPUTER_USE_ENABLED',
        safetyProfile: 'operator_approved',
      },
      async describe() {
        return {
          id: 'stub-computer-use',
          displayName: 'Stub computer use',
          capabilities: ['observe'] as const,
        };
      },
      async observe() {
        return {
          feature: {
            enabled: false,
            mode: 'disabled',
            flag: 'ANDREA_VISION_INPUT_ENABLED',
            safetyProfile: 'observe_only',
          },
          source: 'screen',
          capturedAt: '2026-06-29T12:00:00.000Z',
          mimeType: 'image/png',
          data: { kind: 'url', value: 'file:///tmp/screen.png' },
        } satisfies VisionInput;
      },
      async requestAction(_action: {
        kind: 'click' | 'type' | 'hotkey';
        rationale: string;
        target?: string;
        text?: string;
        keys?: ReadonlyArray<string>;
      }) {
        return {
          accepted: false,
          approvalRequired: true,
          reason: 'No implementation is wired.',
        };
      },
    } satisfies ComputerUseAdapter;

    const codeSandboxAdapter = {
      feature: {
        enabled: false,
        mode: 'disabled',
        flag: 'ANDREA_CODE_SANDBOX_ENABLED',
        safetyProfile: 'operator_approved',
      },
      async describe() {
        return {
          id: 'stub-code-sandbox',
          displayName: 'Stub code sandbox',
          runtimes: ['node'] as const,
        };
      },
      async run() {
        return {
          exitCode: null,
          stdout: '',
          stderr: 'No implementation is wired.',
          timedOut: false,
        };
      },
    } satisfies CodeSandboxAdapter;

    await expect(
      computerUseAdapter.requestAction({ kind: 'click', rationale: 'test' }),
    ).resolves.toMatchObject({ accepted: false, approvalRequired: true });
    await expect(codeSandboxAdapter.describe()).resolves.toMatchObject({
      runtimes: ['node'],
    });
  });
});
