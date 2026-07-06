import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import {
  getResponseFeedbackRouteRegressionCoverage,
  type ResponseFeedbackRouteRegressionCoverage,
} from '../src/response-feedback-route-coverage.js';

interface Args {
  chatJid: string;
  limit: number;
  json: boolean;
  previews: boolean;
  resolveCovered: boolean;
}

interface FeedbackRow {
  feedback_id: string;
  created_at: string;
  route_key: string | null;
  capability_id: string | null;
  handler_kind: string | null;
  response_source: string | null;
  blocker_class: string | null;
  status: string;
  classification: string;
  user_message_id: string | null;
  user_len: number;
  reply_len: number;
  user_preview: string;
  reply_preview: string;
  linked_refs_json: string;
  operator_note: string | null;
}

interface RuntimeJobRow {
  created_at: string;
  updated_at: string;
  status: string;
  selected_runtime: string | null;
  prompt_len: number;
  output_len: number | null;
  error_text: string | null;
}

function parseArgs(argv: string[]): Args {
  let chatJid = 'tg:8004355504';
  let limit = 12;
  let json = false;
  let previews = false;
  let resolveCovered = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--previews' || arg === '--show-text') {
      previews = true;
    } else if (arg === '--resolve-covered') {
      resolveCovered = true;
    } else if (arg === '--chat') {
      chatJid = argv[index + 1] || chatJid;
      index += 1;
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, 50);
      }
      index += 1;
    }
  }

  return { chatJid, limit, json, previews, resolveCovered };
}

function redactPreview(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .replace(/\b(?:tg|bb):[^\s]+/g, '[chat]')
    .replace(/\s+/g, ' ')
    .trim();
}

function msBetween(start: string, end: string): number | null {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function nearestJob(
  feedback: FeedbackRow,
  jobs: RuntimeJobRow[],
): RuntimeJobRow | null {
  const feedbackMs = new Date(feedback.created_at).getTime();
  if (!Number.isFinite(feedbackMs)) return null;
  return (
    jobs
      .map((job) => ({
        job,
        distance: Math.abs(new Date(job.created_at).getTime() - feedbackMs),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => left.distance - right.distance)[0]?.job || null
  );
}

function parseLinkedRefs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveCoveredFeedbackMetadata(params: {
  db: Database.Database;
  row: FeedbackRow;
  coverage: ResponseFeedbackRouteRegressionCoverage;
}): { resolved: boolean; status: string; reason: string } {
  if (
    !['captured', 'awaiting_confirmation', 'failed', 'blocked_external'].includes(
      params.row.status,
    )
  ) {
    return {
      resolved: false,
      status: params.row.status,
      reason: `Feedback status ${params.row.status} is not eligible for metadata-only route resolution.`,
    };
  }
  const resolvedAt = new Date().toISOString();
  const linkedRefs = {
    ...parseLinkedRefs(params.row.linked_refs_json),
    feedbackRouteCoverageKey: params.coverage.coverageKey,
    feedbackRouteCoverageSummary: params.coverage.summary,
    feedbackRouteCoverageCommand: params.coverage.evidenceCommand,
    feedbackRouteCoverageResolvedAt: resolvedAt,
  };
  params.db
    .prepare(
      `
        UPDATE response_feedback
        SET
          status = 'resolved_locally',
          updated_at = ?,
          linked_refs_json = ?,
          operator_note = ?
        WHERE feedback_id = ?
      `,
    )
    .run(
      resolvedAt,
      JSON.stringify(linkedRefs),
      `${params.coverage.summary} Metadata-only resolution; no live action was executed.`,
      params.row.feedback_id,
    );
  return {
    resolved: true,
    status: 'resolved_locally',
    reason: 'Feedback row marked resolved using local route regression coverage.',
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(path.join(STORE_DIR, 'messages.db'), {
    readonly: !args.resolveCovered,
    fileMustExist: true,
  });

  const feedback = db
    .prepare(
      `
        SELECT
          feedback_id,
          created_at,
          route_key,
          capability_id,
          handler_kind,
          response_source,
          blocker_class,
          status,
          classification,
          user_message_id,
          length(original_user_text) AS user_len,
          length(assistant_reply_text) AS reply_len,
          replace(substr(original_user_text, 1, 160), char(10), ' / ') AS user_preview,
          replace(substr(assistant_reply_text, 1, 200), char(10), ' / ') AS reply_preview,
          linked_refs_json,
          operator_note
        FROM response_feedback
        WHERE chat_jid = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(args.chatJid, args.limit) as FeedbackRow[];

  const jobs = db
    .prepare(
      `
        SELECT
          created_at,
          updated_at,
          status,
          selected_runtime,
          length(prompt_preview) AS prompt_len,
          length(latest_output_text) AS output_len,
          error_text
        FROM runtime_backend_jobs
        WHERE chat_jid = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(args.chatJid, Math.max(args.limit * 2, 20)) as RuntimeJobRow[];

  const turns = feedback.map((item) => {
    const job = nearestJob(item, jobs);
    const runtimeFailed = Boolean(job?.error_text || job?.status === 'failed');
    const feedbackRepairOpen = [
      'awaiting_confirmation',
      'blocked_external',
      'failed',
      'running',
    ].includes(item.status);
    const coverage = getResponseFeedbackRouteRegressionCoverage({
      routeKey: item.route_key,
      capabilityId: item.capability_id,
      handlerKind: item.handler_kind,
      responseSource: item.response_source,
      originalUserText: item.user_preview,
    });
    const resolution =
      args.resolveCovered && coverage
        ? resolveCoveredFeedbackMetadata({ db, row: item, coverage })
        : null;
    return {
      at: item.created_at,
      route: item.route_key || 'unknown',
      capability: item.capability_id || 'none',
      handler: item.handler_kind || 'none',
      source: item.response_source || 'none',
      feedbackStatus: item.status,
      feedbackClassification: item.classification,
      feedbackRepairOpen,
      routeRegressionCoverage: coverage
        ? {
            coverageKey: coverage.coverageKey,
            summary: coverage.summary,
          }
        : null,
      metadataResolution: resolution
        ? {
            resolved: resolution.resolved,
            status: resolution.status,
            reason: resolution.reason,
          }
        : null,
      blocker: item.blocker_class || 'none',
      userMessageId: item.user_message_id || 'none',
      userChars: item.user_len,
      replyChars: item.reply_len,
      runtimeStatus: job?.status || 'none',
      runtime: job?.selected_runtime || 'none',
      runtimeMs: job ? msBetween(job.created_at, job.updated_at) : null,
      runtimeFailed,
      runtimeError: job?.error_text ? redactPreview(job.error_text) : 'none',
      userPreview: args.previews ? redactPreview(item.user_preview) : undefined,
      replyPreview: args.previews
        ? redactPreview(item.reply_preview)
        : undefined,
    };
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          chatJid: redactPreview(args.chatJid),
          previewsIncluded: args.previews,
          turns,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Recent Telegram turns for ${redactPreview(args.chatJid)}`);
  console.log(`Previews: ${args.previews ? 'sanitized' : 'hidden'}`);
  for (const turn of turns) {
    console.log(
      [
        `- ${turn.at}`,
        `route=${turn.route}`,
        `capability=${turn.capability}`,
        `handler=${turn.handler}`,
        `source=${turn.source}`,
        `feedback=${turn.feedbackStatus}/${turn.feedbackClassification}`,
        `repair_open=${turn.feedbackRepairOpen ? 'yes' : 'no'}`,
        `route_covered=${turn.routeRegressionCoverage ? 'yes' : 'no'}`,
        turn.metadataResolution
          ? `metadata_resolution=${turn.metadataResolution.resolved ? 'resolved' : 'not_resolved'}`
          : '',
        `reply_chars=${turn.replyChars}`,
        `runtime=${turn.runtimeStatus}${turn.runtimeMs === null ? '' : `/${turn.runtimeMs}ms`}`,
        `runtime_failed=${turn.runtimeFailed ? 'yes' : 'no'}`,
        `error=${turn.runtimeError}`,
      ].join(' | '),
    );
    if (args.previews) {
      console.log(`  ask=${turn.userPreview}`);
      console.log(`  reply=${turn.replyPreview}`);
    }
  }
}

main();
