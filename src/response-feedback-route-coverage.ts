export interface ResponseFeedbackRouteCoverageInput {
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  originalUserText?: string | null;
}

export interface ResponseFeedbackRouteRegressionCoverage {
  coverageKey: string;
  summary: string;
  evidenceCommand: string;
}

function normalizedRouteText(
  record: ResponseFeedbackRouteCoverageInput,
): string {
  return [
    record.routeKey,
    record.capabilityId,
    record.handlerKind,
    record.responseSource,
    record.originalUserText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function getResponseFeedbackRouteRegressionCoverage(
  record: ResponseFeedbackRouteCoverageInput,
): ResponseFeedbackRouteRegressionCoverage | null {
  const routeText = normalizedRouteText(record);
  if (
    /\b(?:what|which)\s+(?:llms?|language models?|ai models?|models?)\s+(?:do you (?:have|use|have access to)|can you use|are (?:available|configured))\b|\bwhat model(?:s)? (?:are you using|do you run|powers? you)\b|\bwhat are you running on\b|\b(?:what|which) (?:is )?(?:the )?(?:chinese|china-based) (?:llm|model)\b/.test(
      routeText,
    )
  ) {
    return {
      coverageKey: 'assistant.model_inventory.runtime_truth',
      summary:
        'Model-identity asks are covered by deterministic runtime inventory, provider-health, default-versus-council wording, and main-chat quick-route regression tests.',
      evidenceCommand:
        'npm run test -- src/model-self-knowledge.test.ts src/direct-quick-reply.test.ts src/main-chat-routing.test.ts',
    };
  }
  if (
    routeText.includes('media.analyze') ||
    /\[(?:photo|video)\]|\b(?:image|photo|picture|screenshot|video) (?:attached|attachment|i sent)\b/.test(
      routeText,
    )
  ) {
    return {
      coverageKey: 'media.inbound.current_attachment_analysis',
      summary:
        'Inbound image/video turns are covered by current-turn attachment routing, exact attachment selection, cached-byte vision inputs, bounded OpenClaw media grounding, and honest provider/cache blockers.',
      evidenceCommand:
        'npm run test -- src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/media-analysis.test.ts src/channels/telegram.test.ts src/openclaw-connector.test.ts',
    };
  }
  if (
    routeText.includes('communication.summarize_thread') &&
    /\b(?:blue ?bubbles|texts?|messages?)\b.*\b(?:48 hours|past 48|last 48|today)\b/.test(
      routeText,
    )
  ) {
    return {
      coverageKey: 'communication.all_synced_messages.bounded_history',
      summary:
        'Broad BlueBubbles text-review asks are covered by exact 48-hour routing, bounded all-synced history hydration, current-window filtering, and honest empty-history behavior.',
      evidenceCommand:
        'npm run test -- src/thread-summary-routing.test.ts src/assistant-capabilities.test.ts src/channels/bluebubbles.test.ts src/recent-text-review.test.ts src/helper-boundary.test.ts',
    };
  }
  if (
    /\b(show\s*times?|showtimes?|showings?|screenings?|movie times?|amc|fandango|regal|cinemark)\b/.test(
      routeText,
    )
  ) {
    return {
      coverageKey: 'research.showtime.live_lookup_routing',
      summary:
        'Movie showtime asks are covered by live-lookup classification, shared research routing, Brave query enrichment, and MiniMax synthesis regression tests.',
      evidenceCommand:
        'npm run test -- src/conversational-core.test.ts src/assistant-capability-router.test.ts src/research-orchestrator.test.ts src/assistant-capabilities.test.ts src/helper-boundary.test.ts',
    };
  }
  if (
    routeText.includes('calendar_local_fast_path') ||
    routeText.includes('calendar.local_lookup') ||
    /\b(?:agenda|calendar)\b/.test(routeText)
  ) {
    return {
      coverageKey: 'calendar.local_lookup.telegram_agenda',
      summary:
        'Calendar agenda asks are covered by local calendar lookup regression tests.',
      evidenceCommand:
        'npm run test -- src/calendar-assistant.test.ts src/turn-agent-harness.test.ts',
    };
  }
  if (
    routeText.includes('research.topic') ||
    routeText.includes('research_local') ||
    /\bweather\b/.test(routeText)
  ) {
    return {
      coverageKey: 'research.local.no_provider_boilerplate',
      summary:
        'Routine local research/weather replies are covered by no-provider-boilerplate regression tests.',
      evidenceCommand:
        'npm run test -- src/assistant-capabilities.test.ts src/turn-agent-harness.test.ts',
    };
  }
  if (
    routeText.includes('daily.command_center') ||
    /\b(?:what should i do today|what needs me|what is slipping|what's slipping)\b/.test(
      routeText,
    )
  ) {
    return {
      coverageKey: 'daily.command_center.usefulness',
      summary:
        'Daily command-center routing and concise usefulness are covered by focused daily tests.',
      evidenceCommand:
        'npm run test -- src/useful-daily-command-center.test.ts src/assistant-capability-router.test.ts',
    };
  }
  return null;
}
