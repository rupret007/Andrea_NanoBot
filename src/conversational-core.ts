export type ConversationalChannel = 'telegram' | 'alexa' | 'bluebubbles';

export type ConversationalTurnClass =
  | 'greeting_or_vibe_check'
  | 'lightweight_companion'
  | 'personal_guidance'
  | 'simple_factoid'
  | 'source_grounded_question'
  | 'work_or_operator'
  | 'degraded_followup';

export type DegradedResponseKind =
  | 'assistant_runtime_unavailable'
  | 'research_unavailable'
  | 'image_generation_unavailable'
  | 'auth_or_linking_required'
  | 'stale_context'
  | 'unsupported_channel_capability';

export type CalendarCompanionFailureAction =
  | 'create_event'
  | 'confirm_reminder';

export type CalendarCompanionFailureKind =
  | 'temporary_unavailable'
  | 'calendar_access_unavailable'
  | 'calendar_auth_unavailable';

export type CalendarCompanionSuccessAction =
  | 'create_event'
  | 'update_event';

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function buildChannelVariant(
  channel: ConversationalChannel,
  variants: {
    telegram: string;
    alexa?: string;
    bluebubbles?: string;
  },
): string {
  if (channel === 'alexa') {
    return variants.alexa || variants.telegram;
  }
  if (channel === 'bluebubbles') {
    return variants.bluebubbles || variants.telegram;
  }
  return variants.telegram;
}

function isLocalUtilityPrompt(normalized: string): boolean {
  if (
    /^(?:what('?s| is) )?the meaning of life\b/.test(normalized) ||
    /^(?:what are you (?:best|good) at|are you funny|do you have a personality|who are you|what can you do|what commands do you have|what are your commands)\b/.test(
      normalized,
    ) ||
    /^(?:ping)\b/.test(normalized) ||
    /\b(help me|can you help me|help with)\b.*\bproject work\b/.test(
      normalized,
    ) ||
    /^can you check https?:\/\/\S+/.test(normalized) ||
    /^check https?:\/\/\S+/.test(normalized) ||
    /^(?:do you know what('?s| is) what|what('?s| is) what)\b/.test(
      normalized,
    ) ||
    /^(?:what time is it|what('?s| is) the time|time)(?: right now)?\b/.test(
      normalized,
    ) ||
    /\btime in\b/.test(normalized) ||
    /^(?:what is|what'?s|whats|calculate|compute|solve|math|quick math|can you do)\s+[0-9(]/.test(
      normalized,
    ) ||
    /^[0-9+\-*/().\s=,?]+$/.test(normalized)
  ) {
    return true;
  }

  return false;
}

function hasExplicitPersonalContext(normalized: string): boolean {
  return /\b(using my context|my context|candace|family|household|calendar|reminder|thread|tonight|today|tomorrow|home)\b/.test(
    normalized,
  );
}

export function classifyConversationalTurn(text: string): ConversationalTurnClass {
  const normalized = normalizeText(text);

  if (!normalized) {
    return 'greeting_or_vibe_check';
  }

  if (
    normalized.startsWith('/') ||
    /\b(cursor|codex|repo|repository|branch|commit|pull request|pr\b|logs?|runtime|shell|container|operator|status|setup verify)\b/.test(
      normalized,
    )
  ) {
    return 'work_or_operator';
  }

  if (
    /^(?:what happened|what went wrong|did that fail|can you still help|are you broken|why did that fail|why didn't that work|why did that not work)\b/.test(
      normalized,
    )
  ) {
    return 'degraded_followup';
  }

  if (
    /^(?:hi|hello|hey|good morning|good afternoon|good evening)(?:[!., ]+| there| andrea)*$/.test(
      normalized,
    ) ||
    /^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)[!., ]+)?(?:(?:how(?:'s|s| is) it going)|(?:how are you))(?: (?:this|your)? ?(?:morning|afternoon|evening|today))?[?.! ]*$/.test(
      normalized,
    ) ||
    /^(?:(?:hi|hello|hey)[!., ]+)?(?:what('?s| is) up|sup)\b/.test(
      normalized,
    ) ||
    /^(?:you there|are you there|still there|what are you doing)\b/.test(
      normalized,
    ) ||
    /^can you help me[?.! ]*$/.test(normalized) ||
    /^(?:thanks|thank you|thx|ok|okay|kk|yes|yep|yup|sure|sounds good|that works|go ahead|please do)\b/.test(
      normalized,
    )
  ) {
    return 'greeting_or_vibe_check';
  }

  if (
    /^(?:what should i do next|what('?s| is) next|what should i do now|anything i should know|anything important|what am i forgetting|what exactly am i forgetting|what am i missing|what am i overlooking|what loose ends do i have|what should i remember tonight|what matters today|what matters most today|what should i know about today|give me my day|give me an evening reset)\b/.test(
      normalized,
    )
  ) {
    return 'lightweight_companion';
  }

  if (
    /\b(candace|family|household|at home|home|thread|life thread)\b/.test(
      normalized,
    ) &&
    /\b(what|anything|should|remember|follow up|open|talk|plan|missing|owe)\b/.test(
      normalized,
    )
  ) {
    return 'personal_guidance';
  }

  if (
    /^(?:research|look into|compare|summari[sz]e|explain the tradeoffs|what('?s| is) the best choice|what should i know before deciding|what are the pros and cons)\b/.test(
      normalized,
    ) ||
    (/\b(compare|tradeoffs?|pros and cons|best choice|look into|research)\b/.test(
      normalized,
    ) &&
      !hasExplicitPersonalContext(normalized)) ||
    /\b(saved notes?|saved material|saved sources?|my library|my notes|what did i save|what have i saved|use only my saved material|combine my notes with outside research)\b/.test(
      normalized,
    ) ||
    (/^what should i know about\b/.test(normalized) &&
      !hasExplicitPersonalContext(normalized))
  ) {
    return 'source_grounded_question';
  }

  if (
    !isLocalUtilityPrompt(normalized) &&
    !hasExplicitPersonalContext(normalized) &&
    /^(?:what('?s| is)|who('?s| is)|where('?s| is)|when('?s| is)|why('?s| is)|how (?:does|do|did|can)|tell me about|explain)\b/.test(
      normalized,
    )
  ) {
    return 'simple_factoid';
  }

  return 'lightweight_companion';
}

export function isResearchEligibleConversationalPrompt(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const turnClass = classifyConversationalTurn(normalized);
  return (
    turnClass === 'simple_factoid' || turnClass === 'source_grounded_question'
  );
}

export function buildGracefulDegradedReply(params: {
  kind: DegradedResponseKind;
  channel: ConversationalChannel;
  text?: string;
  hasGroundedAlternative?: boolean;
  targetChannel?: 'telegram' | 'bluebubbles';
}): string {
  const channel = params.channel;
  const turnClass = classifyConversationalTurn(params.text || '');

  if (params.kind === 'assistant_runtime_unavailable') {
    if (turnClass === 'greeting_or_vibe_check') {
      return buildChannelVariant(channel, {
        telegram:
          "I'm here. The deeper side is being finicky right now, but I can still help with something simple.",
        alexa:
          "I'm here. The deeper side is being finicky, but I can still help with something simple.",
        bluebubbles:
          "I'm here. The deeper side is being finicky, so keep me to something simple for the moment.",
      });
    }

    if (
      turnClass === 'simple_factoid' ||
      turnClass === 'source_grounded_question'
    ) {
      return buildChannelVariant(channel, {
        telegram:
          "I can't check that live right now. If you want, ask it a little more narrowly and I'll keep it grounded.",
        alexa:
          "I can't check that live right now. Ask it a little more narrowly and I'll keep it grounded.",
        bluebubbles:
          "I can't check that live right now. If you want, narrow it a little and I'll keep it grounded.",
      });
    }

    return buildChannelVariant(channel, {
      telegram:
        "I'm here, but I couldn't get the deeper read just now. Try that again in one short sentence and I'll keep it simple.",
      alexa:
        "I'm here, but I couldn't get the deeper read just now. Try that again in one short sentence.",
      bluebubbles:
        "I'm here, but I couldn't get the deeper read just now. One short sentence will work best.",
    });
  }

  if (params.kind === 'research_unavailable') {
    if (params.hasGroundedAlternative) {
      return buildChannelVariant(channel, {
        telegram:
          "I can't check that live right now. I can still use your saved material or help narrow the question.",
        alexa:
          "I can't check that live right now. I can still use saved material or help narrow it.",
        bluebubbles:
          "I can't check that live right now. I can still use saved material or help narrow it.",
      });
    }

    return buildChannelVariant(channel, {
      telegram:
        "I can't check that live right now. If you want, narrow the question and I'll keep the answer grounded.",
      alexa:
        "I can't check that live right now. Narrow the question and I'll keep it grounded.",
      bluebubbles:
        "I can't check that live right now. Narrow it a little and I'll keep it grounded.",
    });
  }

  if (params.kind === 'image_generation_unavailable') {
    return buildChannelVariant(channel, {
      telegram:
        "I can't generate that image right now. I can still help refine the prompt or plan the shot.",
      alexa:
        "I can't generate that image right now. I can still help refine the prompt.",
      bluebubbles:
        "I can't generate that image right now. I can still help refine the prompt.",
    });
  }

  if (params.kind === 'auth_or_linking_required') {
    return buildChannelVariant(channel, {
      telegram:
        "I need the account linked before I can do that here. Once that's linked, I can pick it back up.",
      alexa:
        "I need the account linked before I can do that here.",
      bluebubbles:
        "I need the account linked before I can do that here.",
    });
  }

  if (params.kind === 'stale_context') {
    return buildChannelVariant(channel, {
      telegram:
        "I lost the thread on that. Give me one short line of context and I'll pick it back up.",
      alexa:
        "I lost the thread on that. Give me one short line of context.",
      bluebubbles:
        "I lost the thread on that. One short line of context will get me back in.",
    });
  }

  return buildChannelVariant(channel, {
    telegram: params.targetChannel
      ? `I can't do that cleanly from here. If you want, I can send it to ${params.targetChannel === 'telegram' ? 'Telegram' : 'Messages'}.`
      : "I can't do that cleanly from this channel.",
    alexa: params.targetChannel
      ? `I can't do that from here, but I can send it to ${params.targetChannel === 'telegram' ? 'Telegram' : 'Messages'}.`
      : "I can't do that from this channel.",
    bluebubbles: params.targetChannel
      ? `I can't do that from here, but I can send it to ${params.targetChannel === 'telegram' ? 'Telegram' : 'Messages'}.`
      : "I can't do that from this channel.",
  });
}

export function buildCalendarCompanionFailureReply(params: {
  channel: ConversationalChannel;
  action: CalendarCompanionFailureAction;
  kind: CalendarCompanionFailureKind;
}): string {
  if (params.kind === 'temporary_unavailable') {
    return buildChannelVariant(params.channel, {
      telegram:
        params.action === 'create_event'
          ? "I couldn't add that right this second. If you want, I can save that for later or remind Jeff instead."
          : "I couldn't line that reminder up right this second. If you want, I can save that for later or help you remind Jeff instead.",
      alexa:
        params.action === 'create_event'
          ? "I couldn't add that right this second. I can save that for later or remind Jeff instead."
          : "I couldn't line that reminder up right this second. I can save that for later or help you remind Jeff instead.",
      bluebubbles:
        params.action === 'create_event'
          ? "I couldn't add that right this second. If you want, I can save that for later or remind Jeff instead."
          : "I couldn't line that reminder up right this second. If you want, I can save that for later or help you remind Jeff instead.",
    });
  }

  if (params.kind === 'calendar_auth_unavailable') {
    return buildChannelVariant(params.channel, {
      telegram:
        params.action === 'create_event'
          ? "I don't have the calendar connected right now. I can still save that for later or remind Jeff instead."
          : "I don't have the calendar connected right now. I can still save that for later or help you remind Jeff instead.",
      alexa:
        params.action === 'create_event'
          ? "I don't have the calendar connected right now. I can save that for later or remind Jeff instead."
          : "I don't have the calendar connected right now. I can save that for later or help you remind Jeff instead.",
      bluebubbles:
        params.action === 'create_event'
          ? "I don't have the calendar connected right now. I can still save that for later or remind Jeff instead."
          : "I don't have the calendar connected right now. I can still save that for later or help you remind Jeff instead.",
    });
  }

  return buildChannelVariant(params.channel, {
    telegram:
      params.action === 'create_event'
        ? "I can't reach the calendar right now. I can still save that for later or remind Jeff instead."
        : "I can't reach the calendar details I need right now. I can still save that for later or help you remind Jeff instead.",
    alexa:
      params.action === 'create_event'
        ? "I can't reach the calendar right now. I can save that for later or remind Jeff instead."
        : "I can't reach the calendar details I need right now. I can save that for later or help you remind Jeff instead.",
    bluebubbles:
      params.action === 'create_event'
        ? "I can't reach the calendar right now. I can still save that for later or remind Jeff instead."
        : "I can't reach the calendar details I need right now. I can still save that for later or help you remind Jeff instead.",
  });
}

function formatCalendarReference(calendarName: string): string {
  const trimmed = calendarName.trim();
  if (!trimmed) {
    return 'the calendar';
  }
  if (/calendar/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(family|home|work|personal)$/i.test(trimmed)) {
    return `the ${trimmed} calendar`;
  }
  if (/^[A-Z][a-z]+$/.test(trimmed)) {
    return `${trimmed}${trimmed.endsWith('s') ? "'" : "'s"} calendar`;
  }
  return `the ${trimmed} calendar`;
}

function formatCalendarWhen(input: {
  startIso: string;
  endIso: string;
  allDay: boolean;
  timeZone: string;
}): string {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const dayLabel = dateFormatter.format(new Date(input.startIso));
  if (input.allDay) {
    return `for ${dayLabel}`;
  }

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `for ${dayLabel} from ${timeFormatter.format(
    new Date(input.startIso),
  )} to ${timeFormatter.format(new Date(input.endIso))}`;
}

export function buildCalendarCompanionEventReply(input: {
  action: CalendarCompanionSuccessAction;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  timeZone: string;
  calendarName: string;
  htmlLink?: string | null;
}): string {
  const calendarReference = formatCalendarReference(input.calendarName);
  const whenText = formatCalendarWhen(input);
  const base =
    input.action === 'create_event'
      ? `Got it - I added "${input.title}" to ${calendarReference} ${whenText}.`
      : `Done - I updated "${input.title}" on ${calendarReference} ${whenText}.`;

  return input.htmlLink
    ? `${base}\n\nOpen in Google Calendar: ${input.htmlLink}`
    : base;
}

export function buildCalendarCompanionReminderReply(input: {
  title: string;
  offsetLabel: string;
  remindAtIso: string;
  allDay: boolean;
  timeZone: string;
}): string {
  const reminderFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const reminderText =
    input.allDay && input.offsetLabel !== 'the night before'
      ? `about ${input.title}`
      : `${input.offsetLabel} ${input.title}`;
  return `Done - I'll remind you ${reminderText} at ${reminderFormatter.format(
    new Date(input.remindAtIso),
  )}.`;
}
