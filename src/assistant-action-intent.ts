export type AssistantRequestedActionMode =
  | 'execute'
  | 'draft'
  | 'prepare'
  | 'recommend'
  | 'inform';

export type MessageCompositionDirective =
  | 'funny'
  | 'warmer'
  | 'shorter'
  | 'more_direct';

export type AssistantMessageActionContextBinding =
  | {
      kind: 'recent_text_review_item';
      itemNumber: number;
    }
  | {
      kind: 'recent_recipient_thread';
    };

export interface AssistantMessageActionIntent {
  kind: 'message_send';
  mode: AssistantRequestedActionMode;
  capabilityId: 'messages.send.bluebubbles';
  providerId: 'bluebubbles';
  targetLabel: string | null;
  content: string | null;
  compositionDirectives: MessageCompositionDirective[];
  /** Requested execution semantics for routing; never provider-send approval. */
  explicitlyAuthorizesExecution: boolean;
  contextBinding?: AssistantMessageActionContextBinding;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function preserveMessageText(value: string | null | undefined): string {
  return (value || '').replace(/\r\n?/g, '\n').trim();
}

function stripPairedQuotes(value: string): string {
  const paired = value.match(
    /^(?:"([\s\S]+)"|'([\s\S]+)'|“([\s\S]+)”|‘([\s\S]+)’)$/,
  );
  return preserveMessageText(
    paired?.[1] || paired?.[2] || paired?.[3] || paired?.[4] || value,
  );
}

function normalizeTargetLabel(value: string | undefined): string | null {
  const target = normalizeText(value)
    .replace(/[,:-]+$/, '')
    .trim();
  return target || null;
}

function extractCompositionDirectives(value: string): {
  content: string | null;
  directives: MessageCompositionDirective[];
} {
  let content = preserveMessageText(value);
  const directives: MessageCompositionDirective[] = [];
  const trailingDirective = content.match(
    /(?:,\s*)?(?:and\s+)?(?:please\s+)?make\s+(?:it|that|the message)\s+(funny|warmer|shorter|more direct)[.!?]*$/i,
  );
  const trailingStyle = trailingDirective?.[1]?.toLowerCase();
  if (trailingDirective?.index != null && trailingStyle) {
    content = content.slice(0, trailingDirective.index).trim();
    directives.push(
      trailingStyle === 'more direct'
        ? 'more_direct'
        : (trailingStyle as Exclude<
            MessageCompositionDirective,
            'more_direct'
          >),
    );
  }
  const inStyle = content.match(
    /(?:,\s*)?(?:and\s+)?(?:write|say)\s+(?:it|that)\s+in\s+a\s+(funny|warmer|shorter|more direct)\s+(?:way|tone)[.!?]*$/i,
  );
  if (inStyle?.index != null && inStyle[1]) {
    content = content.slice(0, inStyle.index).trim();
    const style = inStyle[1].toLowerCase();
    directives.push(
      style === 'more direct'
        ? 'more_direct'
        : (style as Exclude<MessageCompositionDirective, 'more_direct'>),
    );
  }
  return {
    content: stripPairedQuotes(content.trim()) || null,
    directives: [...new Set(directives)],
  };
}

function buildIntent(params: {
  mode: AssistantRequestedActionMode;
  target?: string;
  content?: string;
  prefixDirective?: MessageCompositionDirective;
  contextBinding?: AssistantMessageActionContextBinding;
}): AssistantMessageActionIntent {
  const extracted = extractCompositionDirectives(params.content || '');
  const compositionDirectives = [
    ...(params.prefixDirective ? [params.prefixDirective] : []),
    ...extracted.directives,
  ];
  const intent: AssistantMessageActionIntent = {
    kind: 'message_send',
    mode: params.mode,
    capabilityId: 'messages.send.bluebubbles',
    providerId: 'bluebubbles',
    targetLabel: normalizeTargetLabel(params.target),
    content: extracted.content,
    compositionDirectives: [...new Set(compositionDirectives)],
    explicitlyAuthorizesExecution: params.mode === 'execute',
  };
  if (params.contextBinding) intent.contextBinding = params.contextBinding;
  return intent;
}

function matchMessageRequest(
  request: string,
  patterns: RegExp[],
): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = request.match(pattern);
    if (match) return match;
  }
  return null;
}

function stripConversationalPreamble(value: string): string {
  return value
    .replace(/^(?:hi|hey|hello)(?:\s+there)?[,!.]?\s+/i, '')
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\b[\s,:-]*/i, '')
    .replace(/^please\b[\s,:-]*/i, '')
    .trim();
}

function isBlueBubblesCapabilityQuestion(value: string): boolean {
  return [
    /^(?:can|does)\s+(?:blue\s*bubbles|messages)\s+send\s+(?:a\s+)?(?:texts?|messages?|text\s+messages?)(?:\s+(?:for\s+me|on\s+my\s+behalf))?\s*[?]$/i,
    /^(?:(?:you\s+)?(?:can(?:not|['’]t)?|could(?:not|['’]t)?|will|would)|(?:can(?:not|['’]t)?|could(?:not|['’]t)?|will|would)\s+you)\s+send\s+(?:a\s+)?(?:texts?|messages?|text\s+messages?)\s+(?:on|through|using|via)\s+(?:blue\s*bubbles|messages)(?:\s+(?:for\s+me|on\s+my\s+behalf))?\s*[?]$/i,
  ].some((pattern) => pattern.test(value));
}

/**
 * Normalizes user wording into action semantics before route selection.
 * A send verb records requested execution semantics for protected routing; it
 * does not by itself authorize provider dispatch. The outbound boundary stages
 * the exact recipient/body, and a separate fresh approval authorizes sending.
 */
export function parseAssistantMessageActionIntent(
  rawText: string,
): AssistantMessageActionIntent | null {
  const normalized = normalizeText(rawText);
  if (!normalized) return null;
  const request = stripConversationalPreamble(preserveMessageText(rawText));

  const itemOnlyReplyMatch = request.match(
    /^(?:yes[,.!]?\s+)?reply\s+to\s+(?:item\s+)?#?\s*(\d+)\s*(?:(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*|:\s*)(.+)$/is,
  );
  if (itemOnlyReplyMatch) {
    const itemNumber = Number.parseInt(itemOnlyReplyMatch[1] || '', 10);
    if (Number.isSafeInteger(itemNumber) && itemNumber > 0) {
      return buildIntent({
        mode: 'execute',
        content: itemOnlyReplyMatch[2],
        contextBinding: {
          kind: 'recent_text_review_item',
          itemNumber,
        },
      });
    }
  }

  const contextualReplyMatch = request.match(
    /^(?:yes[,.!]?\s+)?reply\s+to\s+(?:item\s+)?#?\s*(\d+)(?:\s*[-,:]\s*|\s+)(.+?)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*(.+)$/is,
  );
  if (contextualReplyMatch) {
    const itemNumber = Number.parseInt(contextualReplyMatch[1] || '', 10);
    if (Number.isSafeInteger(itemNumber) && itemNumber > 0) {
      return buildIntent({
        mode: 'execute',
        target: contextualReplyMatch[2],
        content: contextualReplyMatch[3],
        contextBinding: {
          kind: 'recent_text_review_item',
          itemNumber,
        },
      });
    }
  }

  const contextualReplyColonMatch = request.match(
    /^(?:yes[,.!]?\s+)?reply\s+to\s+(?:item\s+)?#?\s*(\d+)\s+([^:]+?)\s*:\s*(.+)$/is,
  );
  if (contextualReplyColonMatch) {
    const itemNumber = Number.parseInt(contextualReplyColonMatch[1] || '', 10);
    if (Number.isSafeInteger(itemNumber) && itemNumber > 0) {
      return buildIntent({
        mode: 'execute',
        target: contextualReplyColonMatch[2],
        content: contextualReplyColonMatch[3],
        contextBinding: {
          kind: 'recent_text_review_item',
          itemNumber,
        },
      });
    }
  }

  const compositeReplyMatch = matchMessageRequest(request, [
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+send\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+back\s+to\s+(.+?)(?:\s+please)?[.!?]\s+(?:(?:check|read|look\s+at)\b[\s\S]*?\s+)?(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/is,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+(?:check|read|look\s+at)\s+(?:my\s+)?(?:most\s+)?recent\s+(?:text|message)\s+from\s+(.+?)(?:\s+please)?\s+(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/is,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+(?:check|read|look\s+at)\s+(.+?)(?:['’]s)\s+(?:most\s+)?recent\s+(?:text|message)(?:\s+please)?\s+(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/is,
  ]);
  if (compositeReplyMatch) {
    return buildIntent({
      mode: 'execute',
      target: compositeReplyMatch[1],
      content: compositeReplyMatch[2],
      contextBinding: { kind: 'recent_recipient_thread' },
    });
  }

  const executeMatch = matchMessageRequest(request, [
    /^(?:have|ask)\s+(?:blue\s*bubbles|messages)\s+(?:to\s+)?send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/is,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/is,
    /^(?:blue\s*bubbles|messages)[,:]?\s+send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/is,
    /^send\s+(?:a\s+)?(?:text\s+)?message\s+to\s+(.+?)\s*:\s*(.+)$/is,
    /^send\s+(?:a\s+)?(?:text\s+)?to\s+(.+?)\s*:\s*(.+)$/is,
    /^text\s+(.+?)\s*:\s*(.+)$/is,
    /^send\s+(?:a\s+)?(?:text\s+)?message\s+to\s+(.+?)\s+saying\s+(.+)$/is,
    /^send\s+(?:a\s+)?message\s+to\s+(.+?)\s+saying\s+(.+)$/is,
    /^text\s+(.+?)\s+(?:saying|and say|to say|that says)\s+(.+)$/is,
    /^send\s+(.+?)\s+(?:a\s+)?(?:text|message)\s+(?:saying|that says|to say)\s+(.+)$/is,
    /^text\s+(.+?)\s+that\s+(.+)$/is,
  ]);
  if (executeMatch) {
    return buildIntent({
      mode: 'execute',
      target: executeMatch[1],
      content: executeMatch[2],
    });
  }

  const draftMatch = request.match(
    /^(?:draft|write)\s+(?:a\s+)?(?:(funny|warmer|shorter|more direct)\s+)?(?:text(?:\s+message)?|message)(?:\s+i\s+can\s+send)?\s+(?:to|for)\s+(.+?)(?:\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*|\s*:\s*)(.+)$/is,
  );
  if (draftMatch) {
    return buildIntent({
      mode: 'draft',
      target: draftMatch[2],
      content: draftMatch[3],
      prefixDirective:
        draftMatch[1]?.toLowerCase() === 'more direct'
          ? 'more_direct'
          : (draftMatch[1]?.toLowerCase() as
              | Exclude<MessageCompositionDirective, 'more_direct'>
              | undefined),
    });
  }

  const prepareMatch = request.match(
    /^prepare\s+(?:a\s+)?(?:(funny|warmer|shorter|more direct)\s+)?(?:text(?:\s+message)?|message)\s+(?:to|for)\s+(.+?)(?:\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*|\s*:\s*)(.+)$/is,
  );
  if (prepareMatch) {
    return buildIntent({
      mode: 'prepare',
      target: prepareMatch[2],
      content: prepareMatch[3],
      prefixDirective:
        prepareMatch[1]?.toLowerCase() === 'more direct'
          ? 'more_direct'
          : (prepareMatch[1]?.toLowerCase() as
              | Exclude<MessageCompositionDirective, 'more_direct'>
              | undefined),
    });
  }

  const recommendMatch = request.match(
    /^what\s+should\s+i\s+(?:text|message|say\s+to)\s+(.+?)(?:\s+(?:about|saying)\s+(.+))?[?]$/i,
  );
  if (recommendMatch) {
    return buildIntent({
      mode: 'recommend',
      target: recommendMatch[1],
      content: recommendMatch[2],
    });
  }

  if (isBlueBubblesCapabilityQuestion(normalized)) {
    return buildIntent({ mode: 'inform' });
  }

  return null;
}

export function composeAssistantMessageContent(
  intent: Pick<
    AssistantMessageActionIntent,
    'content' | 'compositionDirectives' | 'contextBinding'
  >,
): string | null {
  let content = preserveMessageText(intent.content);
  if (!content) return null;

  // There is no safe generic deterministic "funny" rewrite. In particular,
  // do not append canned prose that the owner did not supply and that may be
  // unrelated to the recipient or conversation. The directive remains on the
  // intent so the outbound boundary can keep the request review-staged; until
  // a real authoring result is available, the card shows the owner's literal
  // body instead of inventing recipient-facing text.
  if (intent.compositionDirectives.includes('warmer')) {
    content = /^(?:hi|hey|hello)\b/i.test(content)
      ? content
      : `Hey, ${content}`;
  }
  if (intent.compositionDirectives.includes('shorter')) {
    content = content.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0]?.trim() || content;
    content = content.slice(0, 160).trim();
  }
  if (intent.compositionDirectives.includes('more_direct')) {
    content = content
      .replace(/\bjust wanted to\b/gi, 'want to')
      .replace(/\bi was wondering if\b/gi, 'can you')
      .replace(/\bmaybe\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return content;
}
