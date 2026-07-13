import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ContainerIpcContext {
  inputDir: string;
  runId: string;
  authToken: string;
}

export interface AuthenticatedContainerIpcMessage {
  version: 1;
  type: 'message';
  provenance: 'host';
  runId: string;
  messageId: string;
  text: string;
  signature: string;
}

function messagePayload(
  runId: string,
  messageId: string,
  text: string,
): string {
  return `1\nmessage\nhost\n${runId}\n${messageId}\n${text}`;
}

export function signContainerIpcMessage(
  params: {
    runId: string;
    messageId: string;
    text: string;
  },
  authToken: string,
): AuthenticatedContainerIpcMessage {
  const signature = createHmac('sha256', authToken)
    .update(messagePayload(params.runId, params.messageId, params.text))
    .digest('base64url');
  return {
    version: 1,
    type: 'message',
    provenance: 'host',
    runId: params.runId,
    messageId: params.messageId,
    text: params.text,
    signature,
  };
}

export function verifyContainerIpcMessage(
  candidate: unknown,
  expectedRunId: string,
  authToken: string,
): candidate is AuthenticatedContainerIpcMessage {
  if (!candidate || typeof candidate !== 'object') return false;
  const message = candidate as Record<string, unknown>;
  if (
    message.version !== 1 ||
    message.type !== 'message' ||
    message.provenance !== 'host' ||
    message.runId !== expectedRunId ||
    typeof message.messageId !== 'string' ||
    message.messageId.length < 8 ||
    message.messageId.length > 128 ||
    typeof message.text !== 'string' ||
    message.text.length === 0 ||
    typeof message.signature !== 'string'
  ) {
    return false;
  }
  const expected = createHmac('sha256', authToken)
    .update(messagePayload(expectedRunId, message.messageId, message.text))
    .digest();
  if (!/^[A-Za-z0-9_-]{43}$/.test(message.signature)) return false;
  const supplied = Buffer.from(message.signature, 'base64url');
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
