import {
  buildPersonalContextGraph,
  redactPersonalContextText,
  type PersonalContextGraphInsight,
} from './personal-context-graph.js';
import {
  buildFollowThroughReview,
  type FollowThroughReviewItem,
} from './follow-through-activation.js';

export interface UsefulDailyCommandCenterResult {
  replyText: string;
  selectedFollowthrough?: FollowThroughReviewItem | null;
  reviewSeedJson: string;
  counts: {
    needsReply: number;
    readyFollowthrough: number;
    canWait: number;
  };
}

function sanitizeLine(value: string): string {
  return redactPersonalContextText(value)
    .replace(/\bthey said\s+"[^"]*"/gi, 'there is recent message context')
    .replace(/\s+/g, ' ')
    .trim();
}

function safestFollowthrough(
  items: FollowThroughReviewItem[],
): FollowThroughReviewItem | null {
  return (
    items.find(
      (item) =>
        item.approvalReadiness === 'ready' &&
        !item.riskFlags.includes('assistant_inferred_link') &&
        !item.riskFlags.includes('group_chat_confirm_audience'),
    ) ||
    items.find((item) => item.approvalReadiness === 'ready') ||
    items.find((item) => item.approvalReadiness === 'confirm_first') ||
    items.find((item) => item.approvalReadiness === 'watch_only') ||
    null
  );
}

function followthroughDecisionLine(item: FollowThroughReviewItem): string {
  const title = sanitizeLine(item.title);
  if (item.approvalReadiness === 'ready') {
    return `${title}: approve local tracking with \`approve the safest one ${item.suggestedTiming}\`. Safe fallback: \`why this one\` or \`defer it\`.`;
  }
  if (item.approvalReadiness === 'confirm_first') {
    return `${title}: confirm the exact thread or audience before tracking. Try \`why this one\` first.`;
  }
  return `${title}: worth watching, but not ready to activate. Try \`why this one\` or \`dismiss it\`.`;
}

function formatInsight(insight: PersonalContextGraphInsight): string {
  const title = sanitizeLine(insight.title || 'Open item');
  const action = sanitizeLine(insight.nextAction || insight.reason);
  return `${title}: ${action}`;
}

function uniqueLines(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const normalized = sanitizeLine(line);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function buildUsefulDailyCommandCenter(params: {
  groupFolder: string;
  now?: Date;
}): UsefulDailyCommandCenterResult {
  const graph = buildPersonalContextGraph({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const followthrough = buildFollowThroughReview({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  const selected = safestFollowthrough(followthrough.items);
  const needsReply = graph.rankedInsights.filter(
    (insight) => insight.kind === 'needs_reply',
  );
  const canWait = graph.rankedInsights.filter(
    (insight) => insight.kind === 'can_wait',
  );
  const slipping = graph.rankedInsights.filter(
    (insight) => insight.kind === 'slipping' || insight.kind === 'prepare',
  );
  const activeFollowthrough = slipping.find((insight) =>
    insight.riskFlags.some((flag) =>
      ['followthrough_approved', 'followthrough_deferred'].includes(flag),
    ),
  );

  const doFirstLines = uniqueLines(
    [
      activeFollowthrough ? formatInsight(activeFollowthrough) : '',
      selected ? followthroughDecisionLine(selected) : '',
      ...slipping.map(formatInsight),
      ...needsReply.map(formatInsight),
    ],
    1,
  );
  const needsReplyLines = uniqueLines(
    needsReply.map((insight) => {
      const cautious = insight.riskFlags.some((flag) =>
        ['assistant_inferred_link', 'group_chat_confirm_audience'].includes(
          flag,
        ),
      );
      return `${insight.title}: ${
        cautious
          ? 'review before drafting because the thread or audience needs confirmation'
          : insight.nextAction
      }.`;
    }),
    1,
  );
  const followthroughLines = selected
    ? uniqueLines(
        [`#${selected.rank} ${followthroughDecisionLine(selected)}`],
        1,
      )
    : [];
  const canWaitLines = uniqueLines(canWait.map(formatInsight), 1);

  const systemTruth = [
    `Context graph: ${Math.round(graph.readinessScore * 100)}% ready.`,
    `Follow-through: ${selected ? 'one safest candidate visible' : 'no safe approval candidate visible'}.`,
    'Safety: I will not send messages or change calendars from this review.',
  ].join(' ');

  const lines = ['Daily command center'];
  lines.push('', 'Do first');
  lines.push(
    ...(doFirstLines.length ? doFirstLines : ['Nothing urgent stands out.']),
  );
  lines.push('', 'Needs reply');
  lines.push(
    ...(needsReplyLines.length
      ? needsReplyLines
      : ['No reply-needed thread is clear enough to surface right now.']),
  );
  lines.push('', 'Follow-through to approve');
  lines.push(
    ...(followthroughLines.length
      ? followthroughLines
      : ['No safe local follow-through approval is ready right now.']),
  );
  lines.push('', 'Can wait');
  lines.push(
    ...(canWaitLines.length
      ? canWaitLines
      : ['Nothing obvious needs to be pushed aside.']),
  );
  lines.push('', 'System truth');
  lines.push(systemTruth);

  return {
    replyText: lines.join('\n'),
    selectedFollowthrough: selected,
    reviewSeedJson: followthrough.reviewSeedJson,
    counts: {
      needsReply: needsReply.length,
      readyFollowthrough: followthrough.items.filter(
        (item) => item.approvalReadiness === 'ready',
      ).length,
      canWait: canWait.length,
    },
  };
}
