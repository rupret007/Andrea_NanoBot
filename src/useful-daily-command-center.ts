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

function firstReadyFollowthrough(
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
    null
  );
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
  const selected = firstReadyFollowthrough(followthrough.items);
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
      selected
        ? `${selected.title}: approve local tracking with \`approve the safest one ${selected.suggestedTiming}\`.`
        : '',
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
  const followthroughLines = uniqueLines(
    followthrough.items
      .filter((item) => item.approvalReadiness === 'ready')
      .map(
        (item) =>
          `#${item.rank} ${item.title}: ${item.safeNextAction} Try \`remind me about #${item.rank} ${item.suggestedTiming}\`.`,
      ),
    2,
  );
  const canWaitLines = uniqueLines(canWait.map(formatInsight), 1);

  const systemTruth = [
    `Context graph: ${Math.round(graph.readinessScore * 100)}% ready.`,
    `Follow-through: ${followthroughLines.length} safe approval candidate${followthroughLines.length === 1 ? '' : 's'} visible.`,
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
