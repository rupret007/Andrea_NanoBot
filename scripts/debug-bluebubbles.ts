import http from 'http';

import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { matchAssistantCapabilityRequest } from '../src/assistant-capability-router.js';
import {
  BlueBubblesChannel,
  buildBlueBubblesWebhookUrl,
  redactBlueBubblesWebhookUrl,
  resolveBlueBubblesConfig,
} from '../src/channels/bluebubbles.js';
import {
  normalizeBlueBubblesCompanionPrompt,
  resolveMostRecentBlueBubblesCompanionChat,
} from '../src/bluebubbles-companion.js';
import { resolveCompanionConversationBinding } from '../src/companion-conversation-binding.js';
import { deliverCompanionHandoff } from '../src/cross-channel-handoffs.js';
import {
  _initTestDatabase,
  getAllChats,
  initDatabase,
  listRecentMessagesForChat,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from '../src/db.js';
import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';
import { saveKnowledgeSource } from '../src/knowledge-library.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function startBlueBubblesApiStub() {
  const sentMessages: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 200, message: 'Ping received!', data: 'pong' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
    sentMessages.push({
      url: req.url || '',
      body,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: {
          guid: `server-msg-${sentMessages.length}`,
        },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve BlueBubbles stub address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sentMessages,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function runLiveMode(): Promise<void> {
  initDatabase();
  const config = resolveBlueBubblesConfig();
  const truth = buildFieldTrialOperatorTruth();
  const chats = getAllChats().filter((chat) => chat.jid.startsWith('bb:')).slice(0, 5);
  const recentChat = resolveMostRecentBlueBubblesCompanionChat({
    groupFolder: config.groupFolder || 'main',
    maxAgeHours: 12,
  });

  printBlock('BLUEBUBBLES LIVE CONFIG', [
    `enabled: ${config.enabled}`,
    `base_url: ${config.baseUrl || 'missing'}`,
    `public_webhook_url: ${
      config.enabled
        ? redactBlueBubblesWebhookUrl(buildBlueBubblesWebhookUrl(config))
        : 'missing'
    }`,
    `listener: ${config.host}:${config.port}${config.webhookPath}`,
    `chat_scope: ${config.chatScope}`,
    `reply_gate: mention_required`,
    `send_enabled: ${config.sendEnabled}`,
  ]);

  printBlock('BLUEBUBBLES LIVE PROOF', [
    `proof: ${truth.bluebubbles.proofState}`,
    `detail: ${truth.bluebubbles.detail}`,
    `blocker: ${truth.bluebubbles.blocker || 'none'}`,
    `next_action: ${truth.bluebubbles.nextAction || 'none'}`,
    `transport: ${truth.bluebubbles.transportState}`,
    `transport_detail: ${truth.bluebubbles.transportDetail}`,
    `webhook_registration: ${truth.bluebubbles.webhookRegistrationState}`,
    `webhook_registration_detail: ${truth.bluebubbles.webhookRegistrationDetail}`,
    `most_recent_chat: ${truth.bluebubbles.mostRecentEngagedChatJid}`,
    `most_recent_engaged_at: ${truth.bluebubbles.mostRecentEngagedAt}`,
    `last_inbound: ${truth.bluebubbles.lastInboundObservedAt}`,
    `last_inbound_chat: ${truth.bluebubbles.lastInboundChatJid}`,
    `last_inbound_self_authored: ${truth.bluebubbles.lastInboundWasSelfAuthored}`,
    `last_outbound: ${truth.bluebubbles.lastOutboundResult}`,
      `last_outbound_target_kind: ${truth.bluebubbles.lastOutboundTargetKind}`,
      `last_outbound_target: ${truth.bluebubbles.lastOutboundTarget}`,
      `last_send_error: ${truth.bluebubbles.lastSendErrorDetail}`,
      `send_method: ${truth.bluebubbles.sendMethod}`,
      `private_api_available: ${truth.bluebubbles.privateApiAvailable}`,
      `last_metadata_hydration: ${truth.bluebubbles.lastMetadataHydrationSource}`,
      `attempted_target_sequence: ${truth.bluebubbles.attemptedTargetSequence}`,
  ]);

  printBlock(
    'BLUEBUBBLES LIVE CHATS',
    chats.length > 0
      ? chats.map((chat) => {
          const latest = listRecentMessagesForChat(chat.jid, 1)[0];
          return `${chat.jid} | name=${chat.name} | is_group=${chat.is_group} | last_message=${latest?.timestamp || chat.last_message_time}`;
        })
      : ['none'],
  );

  printBlock('BLUEBUBBLES LIVE TARGET', [
    `recent_target: ${recentChat?.chatJid || 'none'}`,
    `recent_target_at: ${recentChat?.engagedAt || 'none'}`,
  ]);
}

async function main(): Promise<void> {
  if (process.argv.includes('--live')) {
    await runLiveMode();
    return;
  }

  _initTestDatabase();

  setRegisteredGroup('tg:main', {
    name: 'Main',
    folder: 'main',
    trigger: '@Andrea',
    added_at: '2026-04-06T12:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
  });
  saveKnowledgeSource({
    groupFolder: 'main',
    title: 'Candace Dinner Note',
    shortSummary: 'Pickup works better after rehearsal tonight.',
    content:
      'Candace still needs a dinner answer tonight, and pickup works better after rehearsal because it keeps the handoff simpler.',
    sourceType: 'manual_reference',
    tags: ['candace', 'dinner'],
    now: new Date('2026-04-06T12:01:00.000Z'),
  });

  const blueApi = await startBlueBubblesApiStub();
  const telegramMessages: Array<{ chatJid: string; text: string }> = [];
  const healthSnapshots: string[] = [];
  const inboundMessages: Array<{ chatJid: string; content: string }> = [];

  const channel = new BlueBubblesChannel(
    {
      enabled: true,
      baseUrl: blueApi.baseUrl,
      password: 'debug-secret',
      host: '127.0.0.1',
      port: 0,
      groupFolder: 'main',
      webhookPublicBaseUrl: null,
      chatScope: 'allowlist',
      allowedChatGuids: ['chat-proof'],
      allowedChatGuid: 'chat-proof',
      webhookPath: '/bluebubbles/webhook',
      webhookSecret: 'hook-proof',
      sendEnabled: true,
    },
    {
      onChatMetadata: async (chatJid, timestamp, name, channelName, isGroup) => {
        storeChatMetadata(chatJid, timestamp, name, channelName, isGroup);
      },
      onMessage: async (chatJid, message) => {
        storeMessage(message);
        inboundMessages.push({ chatJid, content: message.content });

        const binding = resolveCompanionConversationBinding(
          chatJid,
          {
            'tg:main': {
              name: 'Main',
              folder: 'main',
              trigger: '@Andrea',
              added_at: '2026-04-06T12:00:00.000Z',
              requiresTrigger: false,
              isMain: true,
            },
          },
          {
            bluebubbles: {
              enabled: true,
              chatScope: 'allowlist',
              allowedChatGuids: ['chat-proof'],
              allowedChatGuid: 'chat-proof',
              groupFolder: 'main',
            },
          },
        );
        if (!binding) {
          throw new Error('Missing BlueBubbles companion binding');
        }

        const promptText = normalizeBlueBubblesCompanionPrompt(message.content);
        const match = matchAssistantCapabilityRequest(promptText);
        if (!match) {
          await channel.sendMessage(chatJid, "I'm here. Ask me naturally and I'll keep going.");
          return;
        }
        const result = await executeAssistantCapability({
          capabilityId: match.capabilityId,
          context: {
            channel: 'bluebubbles',
            groupFolder: binding.group.folder,
            chatJid,
            now: new Date('2026-04-06T12:05:00.000Z'),
          },
          input: {
            text: promptText,
            canonicalText: match.canonicalText,
          },
        });
        await channel.sendMessage(chatJid, result.replyText || 'Okay.');

        if (
          /telegram/i.test(message.content) &&
          result.continuationCandidate?.handoffPayload
        ) {
          await deliverCompanionHandoff(
            {
              groupFolder: binding.group.folder,
              originChannel: 'bluebubbles',
              targetChannel: 'telegram',
              capabilityId: result.capabilityId,
              voiceSummary:
                result.continuationCandidate.voiceSummary ||
                result.replyText ||
                'Andrea follow-up',
              payload: result.continuationCandidate.handoffPayload,
              knowledgeSourceIds: result.continuationCandidate.knowledgeSourceIds,
              followupSuggestions:
                result.continuationCandidate.followupSuggestions,
            },
            {
              resolveTelegramMainChat: (groupFolder) =>
                groupFolder === 'main' ? { chatJid: 'tg:main' } : undefined,
              sendTelegramMessage: async (chatJid, text) => {
                telegramMessages.push({ chatJid, text });
                return {
                  platformMessageId: `tg-msg-${telegramMessages.length}`,
                };
              },
            },
          );
        }
      },
      registeredGroups: () => ({
        'tg:main': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andrea',
          added_at: '2026-04-06T12:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
      onHealthUpdate: (snapshot) => {
        healthSnapshots.push(
          `${snapshot.state}:${snapshot.detail || 'none'}:${snapshot.lastError || 'none'}`,
        );
      },
    },
  );

  try {
    await channel.connect();
    const webhookUrl = channel.getWebhookUrl();
    const firstPayload = {
      type: 'new-message',
      data: {
        chatGuid: 'chat-proof',
        chat: {
          guid: 'chat-proof',
          displayName: 'Andrea BlueBubbles Proof',
          participants: [{ address: '+15550001111' }],
        },
        message: {
          guid: 'msg-proof-1',
          text: '@Andrea what am I forgetting?',
          senderName: 'Rupret',
          handle: {
            address: '+15550001111',
            displayName: 'Rupret',
          },
          dateCreated: '2026-04-06T12:05:00.000Z',
        },
      },
    };
    const secondPayload = {
      type: 'new-message',
      data: {
        chatGuid: 'chat-proof',
        chat: {
          guid: 'chat-proof',
          displayName: 'Andrea BlueBubbles Proof',
          participants: [{ address: '+15550001111' }],
        },
        message: {
          guid: 'msg-proof-2',
          text: '@Andrea what do my saved notes say about Candace dinner timing? Send me the fuller version on Telegram.',
          senderName: 'Rupret',
          handle: {
            address: '+15550001111',
            displayName: 'Rupret',
          },
          dateCreated: '2026-04-06T12:06:00.000Z',
        },
      },
    };

    const firstResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firstPayload),
    });
    const secondResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secondPayload),
    });

    const binding = resolveCompanionConversationBinding(
      'bb:chat-proof',
      {
        'tg:main': {
          name: 'Main',
          folder: 'main',
          trigger: '@Andrea',
          added_at: '2026-04-06T12:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      },
      {
        bluebubbles: {
          enabled: true,
          chatScope: 'allowlist',
          allowedChatGuids: ['chat-proof'],
          allowedChatGuid: 'chat-proof',
          groupFolder: 'main',
        },
      },
    );

    printBlock('BLUEBUBBLES TRANSPORT', [
      `webhook_url: ${webhookUrl}`,
      `listener_connected: ${channel.isConnected()}`,
      `first_webhook_status: ${firstResponse.status}`,
      `second_webhook_status: ${secondResponse.status}`,
      `linked_chat: ${channel.getLinkedChatJid() || 'missing'}`,
    ]);

    printBlock('COMPANION ROUTING', [
      `binding_found: ${Boolean(binding)}`,
      `binding_folder: ${binding?.group.folder || 'missing'}`,
      `binding_synthetic: ${binding?.synthetic ?? false}`,
      `inbound_messages: ${inboundMessages.map((entry) => entry.content).join(' | ')}`,
    ]);

    printBlock('BLUEBUBBLES REPLIES', [
      `reply_count: ${blueApi.sentMessages.length}`,
      `reply_one: ${String(blueApi.sentMessages[0]?.body.text || 'missing')}`,
      `reply_two: ${String(blueApi.sentMessages[1]?.body.text || 'missing')}`,
    ]);

    printBlock('TELEGRAM HANDOFF', [
      `handoff_count: ${telegramMessages.length}`,
      `handoff_target: ${telegramMessages[0]?.chatJid || 'missing'}`,
      `handoff_text: ${telegramMessages[0]?.text || 'missing'}`,
    ]);

    printBlock('HEALTH SNAPSHOT', [
      `latest: ${healthSnapshots.at(-1) || 'missing'}`,
    ]);
  } finally {
    await channel.disconnect();
    await blueApi.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `debug-bluebubbles failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
