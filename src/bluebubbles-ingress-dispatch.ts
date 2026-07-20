import { createHash } from 'node:crypto';

export interface BlueBubblesIngressDispatchIdentity {
  sourceChatJid: string;
  sourceMessageId: string;
  sourceReceivedAt: string;
  targetChatJid: string;
  slot: string;
}

function requireIdentityPart(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\u0000')) {
    throw new Error(
      `BlueBubbles ingress dispatch ${field} must be a non-empty bounded identity.`,
    );
  }
  if (normalized.length > 2_048) {
    throw new Error(
      `BlueBubbles ingress dispatch ${field} exceeds the identity limit.`,
    );
  }
  return normalized;
}

/**
 * Build one provider request identity from immutable ingress coordinates.
 * Pause generations and processing clocks are deliberately excluded: a
 * stop/resume or crash recovery must never mint a second provider identity
 * for the same owner turn.
 */
export function buildBlueBubblesIngressDispatchIdempotencyKey(
  identity: BlueBubblesIngressDispatchIdentity,
): string {
  const sourceChatJid = requireIdentityPart(
    identity.sourceChatJid,
    'sourceChatJid',
  );
  const sourceMessageId = requireIdentityPart(
    identity.sourceMessageId,
    'sourceMessageId',
  );
  const sourceReceivedAt = requireIdentityPart(
    identity.sourceReceivedAt,
    'sourceReceivedAt',
  );
  if (!Number.isFinite(Date.parse(sourceReceivedAt))) {
    throw new Error(
      'BlueBubbles ingress dispatch sourceReceivedAt must be a valid immutable receipt timestamp.',
    );
  }
  const targetChatJid = requireIdentityPart(
    identity.targetChatJid,
    'targetChatJid',
  );
  const slot = requireIdentityPart(identity.slot, 'slot');
  const digest = createHash('sha256')
    .update('andrea-bluebubbles-ingress-dispatch-v1\u0000', 'utf8')
    .update(sourceChatJid, 'utf8')
    .update('\u0000', 'utf8')
    .update(sourceMessageId, 'utf8')
    .update('\u0000', 'utf8')
    .update(new Date(sourceReceivedAt).toISOString(), 'utf8')
    .update('\u0000', 'utf8')
    .update(targetChatJid, 'utf8')
    .update('\u0000', 'utf8')
    .update(slot, 'utf8')
    .digest('hex');
  return `andrea-bb-ingress-v1-${digest}`;
}

export function buildIngressBoundCompanionHandoffId(
  identity: Omit<BlueBubblesIngressDispatchIdentity, 'slot'>,
): string {
  return buildBlueBubblesIngressDispatchIdempotencyKey({
    ...identity,
    slot: 'companion_handoff',
  });
}
