import type { ChannelHealthSnapshot } from './types.js';

export interface ChannelHealthAlertAssessment {
  actionable: boolean;
  fingerprint: string | null;
  likelyCause: string;
  nextAction: string;
}

export interface ChannelHealthAlertDecision {
  event: 'none' | 'fault' | 'recovered';
  assessment: ChannelHealthAlertAssessment;
}

const BLUEBUBBLES_FAULT_GUIDANCE: Record<
  string,
  { likelyCause: string; nextAction: string }
> = {
  configuration_invalid: {
    likelyCause: 'BlueBubbles configuration is incomplete or invalid',
    nextAction:
      'Review the BlueBubbles configuration, then rerun debug:bluebubbles.',
  },
  transport_auth_failed: {
    likelyCause: "BlueBubbles rejected Andrea's configured credentials",
    nextAction:
      'Verify the BlueBubbles password on this host, then rerun debug:bluebubbles.',
  },
  transport_unreachable: {
    likelyCause: 'The BlueBubbles server cannot be reached from this host',
    nextAction:
      'Confirm the Mac BlueBubbles server is online and reachable, then rerun debug:bluebubbles.',
  },
  webhook_auth_failed: {
    likelyCause: 'BlueBubbles rejected webhook inspection credentials',
    nextAction:
      'Verify the BlueBubbles password and webhook settings, then rerun debug:bluebubbles.',
  },
  webhook_missing: {
    likelyCause: 'The required inbound BlueBubbles webhook is not registered',
    nextAction:
      'Repair the inbound webhook registration, then rerun debug:bluebubbles.',
  },
  webhook_unreachable: {
    likelyCause: 'Andrea could not verify the inbound BlueBubbles webhook',
    nextAction:
      'Confirm BlueBubbles is reachable and repair webhook registration, then rerun debug:bluebubbles.',
  },
  receipt_inbox_unavailable: {
    likelyCause: 'The enabled outbound delivery receipt service is unavailable',
    nextAction:
      'Restore the BlueBubbles receipt inbox service before retrying outbound messages.',
  },
  listener_error: {
    likelyCause: 'The local BlueBubbles webhook listener failed',
    nextAction:
      'Inspect the Andrea host logs and listener port, then rerun debug:bluebubbles.',
  },
  webhook_secret_mismatch: {
    likelyCause: 'An inbound BlueBubbles webhook used the wrong secret',
    nextAction:
      'Verify the registered webhook URL and secret, then rerun debug:bluebubbles.',
  },
  inbound_processing_failed: {
    likelyCause:
      'Andrea could not durably process an inbound BlueBubbles message',
    nextAction:
      'Inspect the BlueBubbles ingress and receipt-inbox logs, then rerun debug:bluebubbles.',
  },
  outbound_delivery_failed: {
    likelyCause: 'An enabled BlueBubbles outbound delivery failed',
    nextAction:
      'Inspect the BlueBubbles send target and transport, then rerun debug:bluebubbles.',
  },
};

export function assessChannelHealthAlert(
  snapshot: ChannelHealthSnapshot,
): ChannelHealthAlertAssessment {
  const actionable =
    snapshot.alertDisposition != null
      ? snapshot.alertDisposition === 'action_required'
      : snapshot.state !== 'ready';
  const faultCode = actionable ? snapshot.faultCode || snapshot.state : null;
  const blueBubblesGuidance =
    snapshot.name === 'bluebubbles' && snapshot.faultCode
      ? BLUEBUBBLES_FAULT_GUIDANCE[snapshot.faultCode]
      : undefined;
  const likelyCause =
    blueBubblesGuidance?.likelyCause ||
    (snapshot.lastError
      ? 'channel transport error'
      : 'channel health transition');
  const nextAction =
    blueBubblesGuidance?.nextAction ||
    (snapshot.name === 'bluebubbles'
      ? 'Confirm the Mac BlueBubbles server is online and reachable, then rerun debug:bluebubbles.'
      : snapshot.name === 'telegram'
        ? 'Regenerate or replace the Telegram bot token, then restart services.'
        : 'Review channel configuration and rerun debug:status.');
  return {
    actionable,
    fingerprint: faultCode ? `${snapshot.name}:${faultCode}` : null,
    likelyCause,
    nextAction,
  };
}

export function decideChannelHealthAlert(
  snapshot: ChannelHealthSnapshot,
  previousFaultFingerprint: string | null,
): ChannelHealthAlertDecision {
  const assessment = assessChannelHealthAlert(snapshot);
  if (!assessment.actionable || !assessment.fingerprint) {
    return {
      event:
        previousFaultFingerprint && snapshot.operatingMode !== 'disabled'
          ? 'recovered'
          : 'none',
      assessment,
    };
  }
  return {
    event:
      previousFaultFingerprint === assessment.fingerprint ? 'none' : 'fault',
    assessment,
  };
}
