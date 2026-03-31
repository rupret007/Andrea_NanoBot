export interface DirectAssistantRecoveryRetryPlan {
  sessionId: string | undefined;
  resumeAt: string | undefined;
  startsFreshSession: boolean;
}

export function planDirectAssistantRecoveryRetry(
  sessionId: string | undefined,
): DirectAssistantRecoveryRetryPlan {
  if (sessionId) {
    return {
      sessionId: undefined,
      resumeAt: undefined,
      startsFreshSession: true,
    };
  }

  return {
    sessionId: undefined,
    resumeAt: undefined,
    startsFreshSession: false,
  };
}
