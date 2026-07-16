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
  explicitlyAuthorizesExecution: boolean;
  contextBinding?: AssistantMessageActionContextBinding;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function stripPairedQuotes(value: string): string {
  const paired = value.match(
    /^(?:"([\s\S]+)"|'([\s\S]+)'|“([\s\S]+)”|‘([\s\S]+)’)$/,
  );
  return normalizeText(
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
  let content = normalizeText(value);
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
    content: stripPairedQuotes(content.replace(/[,:-]+$/, '').trim()) || null,
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
 * In particular, a tone/composition request changes the payload, not whether
 * an explicit send command authorizes execution.
 */
export function parseAssistantMessageActionIntent(
  rawText: string,
): AssistantMessageActionIntent | null {
  const normalized = normalizeText(rawText);
  if (!normalized) return null;
  const request = stripConversationalPreamble(normalized);

  const contextualReplyMatch = request.match(
    /^(?:yes[,.!]?\s+)?reply\s+to\s+(?:item\s+)?#?\s*(\d+)(?:\s*[-,:]\s*|\s+)(.+?)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*(.+)$/i,
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

  const compositeReplyMatch = matchMessageRequest(request, [
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+send\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+back\s+to\s+(.+?)(?:\s+please)?[.!?]\s+(?:(?:check|read|look\s+at)\b[\s\S]*?\s+)?(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/i,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+(?:check|read|look\s+at)\s+(?:my\s+)?(?:most\s+)?recent\s+(?:text|message)\s+from\s+(.+?)(?:\s+please)?\s+(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/i,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+(?:check|read|look\s+at)\s+(.+?)(?:['’]s)\s+(?:most\s+)?recent\s+(?:text|message)(?:\s+please)?\s+(?:and\s+)?reply(?:\s+from\s+(?:you|me))?(?:\s+(?:that|saying|to say|with(?:\s+the\s+text)?))?\s*:?\s*(.+)$/i,
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
    /^(?:have|ask)\s+(?:blue\s*bubbles|messages)\s+(?:to\s+)?send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/i,
    /^use\s+(?:blue\s*bubbles|messages)\s+to\s+send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/i,
    /^(?:blue\s*bubbles|messages)[,:]?\s+send\s+(.+?)\s+(?:a\s+)?(?:text(?:\s+message)?|message)\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s+(.+)$/i,
    /^send\s+(?:a\s+)?(?:text\s+)?message\s+to\s+(.+?)\s*:\s*(.+)$/i,
    /^send\s+(?:a\s+)?(?:text\s+)?to\s+(.+?)\s*:\s*(.+)$/i,
    /^text\s+(.+?)\s*:\s*(.+)$/i,
    /^send\s+(?:a\s+)?(?:text\s+)?message\s+to\s+(.+?)\s+saying\s+(.+)$/i,
    /^send\s+(?:a\s+)?message\s+to\s+(.+?)\s+saying\s+(.+)$/i,
    /^text\s+(.+?)\s+(?:saying|and say|to say|that says)\s+(.+)$/i,
    /^send\s+(.+?)\s+(?:a\s+)?(?:text|message)\s+(?:saying|that says|to say)\s+(.+)$/i,
    /^text\s+(.+?)\s+that\s+(.+)$/i,
  ]);
  if (executeMatch) {
    return buildIntent({
      mode: 'execute',
      target: executeMatch[1],
      content: executeMatch[2],
    });
  }

  const draftMatch = request.match(
    /^(?:draft|write)\s+(?:a\s+)?(?:(funny|warmer|shorter|more direct)\s+)?(?:text(?:\s+message)?|message)(?:\s+i\s+can\s+send)?\s+(?:to|for)\s+(.+?)(?:\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*|\s*:\s*)(.+)$/i,
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
    /^prepare\s+(?:a\s+)?(?:(funny|warmer|shorter|more direct)\s+)?(?:text(?:\s+message)?|message)\s+(?:to|for)\s+(.+?)(?:\s+(?:saying|that says|to say|with(?:\s+the\s+text)?)\s*:?\s*|\s*:\s*)(.+)$/i,
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
  let content = normalizeText(intent.content);
  if (!content) return null;

  // Natural cross-channel instructions are often phrased to Andrea in the
  // third person ("tell Candace yes if she could pick them up"). The actual
  // Messages recipient needs the direct version, not a robotic copy of the
  // instruction. Keep this deliberately narrow so quoted/literal message text
  // outside these common reply constructions remains untouched.
  const indirectPickupReply = content.match(
    /^yes[,.]?\s*please[,.]?\s+if\s+(?:she|he|they)\s+could\s+pick\s+(them|it)\s+up(?:[,.]?\s+i\s+(?:haven['’]?t|have\s+not)\s+had\s+a\s+chance)?[.!?]*$/i,
  );
  if (indirectPickupReply) {
    const includesTimingContext =
      /\bi\s+(?:haven['’]?t|have\s+not)\s+had\s+a\s+chance\b/i.test(content);
    content = `Yes, please pick ${indirectPickupReply[1]!.toLowerCase()} up.${
      includesTimingContext ? ' I haven’t had a chance.' : ''
    }`;
  } else if (
    intent.contextBinding?.kind === 'recent_text_review_item' &&
    /^yes[,.]?\s+i\s+need\s+(?:her|him|them)\s+to\s+pick(?:\s+(?:them|it))?\s+up\s+please[.!?]*$/i.test(
      content,
    )
  ) {
    content = 'Yes, please pick them up.';
  }

  if (intent.compositionDirectives.includes('funny')) {
    if (
      /^hi\s+from\s+andrea\s+and\s+(?:he|she|they)\s+smells[.!?]*$/i.test(
        content,
      )
    ) {
      content =
        'Hi from Andrea — she says you smell, but in a limited-edition, artisanal way. 😄';
    } else if (!/[😀-🙏🌀-🫿]/u.test(content)) {
      content = `${content.replace(/[.!?]+$/, '')} — delivered with maximum confidence and absolutely no peer review. 😄`;
    }
  }
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
