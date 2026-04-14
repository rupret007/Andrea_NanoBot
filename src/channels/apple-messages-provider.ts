import type {
  AppleMessagesProviderName,
  BlueBubblesChatRef,
  BlueBubblesConfig,
  BlueBubblesContactRef,
  NewMessage,
  SendMessageResult,
} from '../types.js';

export interface AppleMessagesProbeResult {
  provider: AppleMessagesProviderName;
  status: 'not_configured' | 'reachable' | 'auth_failed' | 'unreachable';
  detail: string;
  activeEndpoint: string | null;
  candidateResults: Record<string, string>;
}

export interface AppleMessagesReadinessResult {
  provider: AppleMessagesProviderName;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  privateApiAvailable: boolean | null;
  sendMethod: string;
}

export interface AppleMessagesSendRequest {
  chatGuid: string;
  text: string;
  replyToGuid?: string;
}

export interface AppleMessagesRecentActivityRow {
  chatJid: string;
  message: NewMessage;
  chat: BlueBubblesChatRef;
  contact: BlueBubblesContactRef;
}

export interface AppleMessagesProvider {
  readonly name: AppleMessagesProviderName;
  probe(config: BlueBubblesConfig): Promise<AppleMessagesProbeResult>;
  inspectRecentActivity(
    config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
    limit?: number,
  ): Promise<AppleMessagesRecentActivityRow[]>;
  sendText(
    config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
    request: AppleMessagesSendRequest & { sendMethod: string },
  ): Promise<SendMessageResult>;
  describeReadiness(
    config: Pick<
      BlueBubblesConfig,
      | 'enabled'
      | 'baseUrl'
      | 'password'
      | 'host'
      | 'port'
      | 'webhookPath'
      | 'webhookSecret'
      | 'webhookPublicBaseUrl'
    >,
  ): Promise<AppleMessagesReadinessResult>;
}
