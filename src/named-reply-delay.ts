import { createHash } from 'node:crypto';

import type { PlannedReminder } from './local-reminder.js';

export type NamedReplyDelayTiming =
  | { kind: 'delay'; minutes: number }
  | { kind: 'invalid_delay' };

// An optional "about"/"around"/"roughly"/"~" hedge and a trailing "or so" are
// accepted and ignored: the delay still resolves to one exact bounded instant
// rather than silently dropping the reminder on a casual phone phrasing.
const DELAY_PATTERN =
  /^remind me(?:(?: to (?:reply|answer))|(?: about (?:that|this|it)))? in (?:(?:about|around|roughly|approximately|approx\.?) |~ ?)?(half an|a couple(?: of)?|an?|[+-]?\d+(?:\.\d+)?|Infinity|NaN) (minutes?|mins?|hours?|hrs?)( and a half)?(?: or so)?[.!?]?$/i;

/** Only a standalone timing choice may inherit the offered reply target. */
export function parseNamedReplyDelayTiming(
  text: string,
): NamedReplyDelayTiming | null {
  const match = text.replace(/\s+/g, ' ').trim().match(DELAY_PATTERN);
  if (!match) return null;
  const quantity = match[1].toLowerCase();
  const perUnit = /^h/i.test(match[2]) ? 60 : 1;
  const trailingHalf = Boolean(match[3]);
  let minutes: number;
  // Whether the pre-half amount is a whole number of hours, so a trailing
  // "and a half" can add exactly 30 minutes without inventing a fraction.
  let wholeHourBase = false;
  if (quantity === 'a' || quantity === 'an') {
    minutes = perUnit;
    wholeHourBase = perUnit === 60;
  } else if (quantity === 'a couple' || quantity === 'a couple of') {
    // "a couple" is a whole count of two in a text; "a few" stays ambiguous.
    minutes = 2 * perUnit;
    wholeHourBase = perUnit === 60;
  } else if (quantity === 'half an') {
    // Only a half hour maps to a whole minute count; "half a minute" is not offered.
    if (perUnit !== 60) return { kind: 'invalid_delay' };
    minutes = 30;
  } else if (/^\d+$/.test(quantity)) {
    minutes = Number(quantity) * perUnit;
    wholeHourBase = perUnit === 60;
  } else {
    return { kind: 'invalid_delay' };
  }
  if (trailingHalf) {
    // "an hour and a half" is an unambiguous 90 minutes; only a whole hour
    // count takes the extra half. "half an hour and a half" does not.
    if (!wholeHourBase) return { kind: 'invalid_delay' };
    minutes += 30;
  }
  if (minutes < 1 || minutes > 1440) {
    return { kind: 'invalid_delay' };
  }
  return { kind: 'delay', minutes };
}

/**
 * Elapsed time starts at the durable live-ingress receipt, not at processing
 * time. A delayed retry cannot move the due instant or manufacture a new task.
 */
export function planNamedReplyDelayReminder(input: {
  timing: NamedReplyDelayTiming;
  receivedAt: string | null;
  now: Date;
  reminderBody: string;
  groupFolder: string;
  chatJid: string;
  timeZone: string;
  channel: 'telegram' | 'bluebubbles';
  inboundId: string;
}): PlannedReminder | null {
  const receivedMs = Date.parse(input.receivedAt || '');
  const nowMs = input.now.getTime();
  const reminderBody = input.reminderBody.replace(/\s+/g, ' ').trim();
  const timeZone = input.timeZone.trim();
  if (
    input.timing.kind !== 'delay' ||
    !Number.isInteger(input.timing.minutes) ||
    input.timing.minutes < 1 ||
    input.timing.minutes > 1440 ||
    !Number.isFinite(receivedMs) ||
    new Date(receivedMs).toISOString() !== input.receivedAt ||
    !Number.isFinite(nowMs) ||
    receivedMs > nowMs ||
    !reminderBody ||
    !input.groupFolder.trim() ||
    !input.chatJid.trim() ||
    !input.inboundId.trim() ||
    !timeZone
  ) {
    return null;
  }
  const dueMs = receivedMs + input.timing.minutes * 60_000;
  if (dueMs <= nowMs || !Number.isFinite(new Date(dueMs).getTime())) {
    return null;
  }
  const scheduledAt = new Date(dueMs);
  let dateLabel: string;
  try {
    dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(scheduledAt);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const scheduleValue = scheduledAt.toISOString();
  const operation = createHash('sha256')
    .update(
      JSON.stringify([
        'andrea.named-reply-delay.v1',
        input.channel,
        input.groupFolder,
        input.chatJid,
        input.inboundId,
        reminderBody.toLowerCase(),
        scheduleValue,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return {
    confirmation: `Okay. I'll remind you on ${dateLabel} (${timeZone}) to ${reminderBody}.`,
    task: {
      id: `reminder-${operation}`,
      group_folder: input.groupFolder,
      chat_jid: input.chatJid,
      prompt: `Send a concise reminder telling the user to ${reminderBody}.`,
      script: null,
      schedule_type: 'once',
      schedule_value: scheduleValue,
      context_mode: 'isolated',
      next_run: scheduleValue,
      status: 'active',
      created_at: input.now.toISOString(),
    },
  };
}
