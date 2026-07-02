export interface VisionInput {
  feature: Readonly<{
    enabled: boolean;
    mode: 'disabled' | 'shadow' | 'live';
    flag: 'ANDREA_VISION_INPUT_ENABLED';
    provider?: string;
    safetyProfile?: 'observe_only' | 'operator_approved' | 'autonomous';
    metadata?: Readonly<Record<string, string>>;
  }>;
  source: 'camera' | 'screen' | 'image_file' | 'image_url';
  capturedAt: string;
  mimeType: string;
  data:
    | { kind: 'bytes'; value: Uint8Array }
    | { kind: 'base64'; value: string }
    | { kind: 'url'; value: string };
  context?: string;
}

export interface VoiceInput {
  feature: Readonly<{
    enabled: boolean;
    mode: 'disabled' | 'shadow' | 'live';
    flag: 'ANDREA_VOICE_INPUT_ENABLED';
    provider?: string;
    safetyProfile?: 'observe_only' | 'operator_approved' | 'autonomous';
    metadata?: Readonly<Record<string, string>>;
  }>;
  source: 'microphone' | 'call' | 'voice_note' | 'audio_file';
  capturedAt: string;
  mimeType: string;
  audio:
    | { kind: 'bytes'; value: Uint8Array }
    | { kind: 'base64'; value: string }
    | { kind: 'url'; value: string };
  locale?: string;
  transcriptHint?: string;
}

export interface ComputerUseAdapter {
  feature: Readonly<{
    enabled: boolean;
    mode: 'disabled' | 'shadow' | 'live';
    flag: 'ANDREA_COMPUTER_USE_ENABLED';
    provider?: string;
    safetyProfile: 'observe_only' | 'operator_approved';
    metadata?: Readonly<Record<string, string>>;
  }>;
  describe(): Promise<{
    id: string;
    displayName: string;
    capabilities: ReadonlyArray<'observe' | 'click' | 'type' | 'hotkey'>;
  }>;
  observe(): Promise<VisionInput>;
  requestAction(action: {
    kind: 'click' | 'type' | 'hotkey';
    rationale: string;
    target?: string;
    text?: string;
    keys?: ReadonlyArray<string>;
  }): Promise<{
    accepted: boolean;
    approvalRequired: boolean;
    reason?: string;
  }>;
}

export interface CodeSandboxAdapter {
  feature: Readonly<{
    enabled: boolean;
    mode: 'disabled' | 'shadow' | 'live';
    flag: 'ANDREA_CODE_SANDBOX_ENABLED';
    provider?: string;
    safetyProfile: 'observe_only' | 'operator_approved';
    metadata?: Readonly<Record<string, string>>;
  }>;
  describe(): Promise<{
    id: string;
    displayName: string;
    runtimes: ReadonlyArray<'node' | 'python' | 'shell'>;
  }>;
  run(input: {
    runtime: 'node' | 'python' | 'shell';
    code: string;
    timeoutMs?: number;
    env?: Readonly<Record<string, string>>;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
}
