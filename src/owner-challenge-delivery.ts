/** Exact Andrea-stored draft presented to Jeff through Bob's trusted front
 * door. The bearer API must never expose the challenge or deliver it itself. */
export interface OwnerChallengeSummary {
  readonly bridgeDraftId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly expiresAt: number;
  readonly actor: string;
  readonly conversationId: string;
  readonly chatGuid: string;
  readonly addresses: readonly string[];
  readonly text: string;
}

/** Host-only out-of-band integration seam. A future implementation must deliver
 * the secret and exact summary only to Jeff, independently of bearer callers,
 * and resolve only after successful delivery. No messaging adapter ships here. */
export interface OwnerChallengeDelivery {
  deliver(challenge: string, summary: OwnerChallengeSummary): Promise<void>;
}

/** Default deny: private bridge configuration alone cannot enable approval. */
export class DisabledOwnerChallengeDelivery implements OwnerChallengeDelivery {
  async deliver(
    _challenge: string,
    _summary: OwnerChallengeSummary,
  ): Promise<void> {
    throw new Error('Owner challenge delivery is disabled.');
  }
}
