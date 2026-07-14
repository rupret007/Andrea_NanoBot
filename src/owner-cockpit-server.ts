import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import http, { type IncomingMessage, type ServerResponse } from 'http';

import {
  approveCognitiveApprovalPacketCAS,
  listCognitiveApprovalPackets,
  listHierarchicalGoals,
  listLifeThreadsForGroup,
  listOutcomesForGroup,
  listVerifiedDeepWorkPackets,
  updateHierarchicalGoalStatus,
} from './db.js';
import {
  assessDeepWorkSkillPromotion,
  buildDeepWorkDogfoodReport,
  hasDeepWorkDeterministicReplayEvidence,
  listDeepWorkEvidenceGaps,
  reviewDeepWorkMission,
  selectDeepWorkReviewCandidate,
} from './deep-work-apprenticeship.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  deferLifeThreadCommitment,
  reactivateLifeThreadCommitment,
} from './life-threads.js';
import {
  projectEffectiveLifeThread,
  shouldProactivelySurfaceCommitment,
} from './life-thread-commitment.js';
import {
  buildAssistantMetricSnapshot,
  buildReviewedOutcomeProgress,
} from './personal-assistant-metrics.js';
import type { VerifiedDeepWorkPacket } from './types.js';
import {
  OWNER_COCKPIT_CSS,
  OWNER_COCKPIT_HTML,
  OWNER_COCKPIT_JS,
  OWNER_COCKPIT_LOGIN_HTML,
} from './owner-cockpit-ui.js';

export interface OwnerCockpitConfig {
  enabled: boolean;
  host: '127.0.0.1' | '::1';
  port: number;
  secret: string;
  sessionMinutes: number;
  groupFolder: string;
}

interface Session {
  csrfToken: string;
  expiresAt: number;
}

const COOKIE_NAME = 'andrea_owner_session';
const MAX_BODY_BYTES = 16 * 1024;

function parseBool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value || '').trim().toLowerCase());
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

export function resolveOwnerCockpitConfig(
  env: Record<string, string | undefined> = process.env,
): OwnerCockpitConfig {
  const file = readEnvFile([
    'ANDREA_OWNER_COCKPIT_ENABLED',
    'ANDREA_OWNER_COCKPIT_HOST',
    'ANDREA_OWNER_COCKPIT_PORT',
    'ANDREA_OWNER_COCKPIT_SECRET',
    'ANDREA_OWNER_COCKPIT_SESSION_MINUTES',
    'ANDREA_OWNER_COCKPIT_GROUP',
  ]);
  const value = (key: string) => env[key] || file[key];
  const configuredHost = value('ANDREA_OWNER_COCKPIT_HOST') || '127.0.0.1';
  if (configuredHost !== '127.0.0.1' && configuredHost !== '::1') {
    throw new Error('Owner cockpit must bind to a loopback address.');
  }
  return {
    enabled: parseBool(value('ANDREA_OWNER_COCKPIT_ENABLED')),
    host: configuredHost,
    port: boundedInt(value('ANDREA_OWNER_COCKPIT_PORT'), 4320, 1024, 65535),
    secret: value('ANDREA_OWNER_COCKPIT_SECRET') || '',
    sessionMinutes: boundedInt(
      value('ANDREA_OWNER_COCKPIT_SESSION_MINUTES'),
      30,
      5,
      480,
    ),
    groupFolder: value('ANDREA_OWNER_COCKPIT_GROUP') || 'main',
  };
}

function secureEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const split = part.indexOf('=');
        return split < 0
          ? [part, '']
          : [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
      }),
  );
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=()',
  );
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  res.setHeader('cache-control', 'no-store');
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeText(
  value: string | null | undefined,
  fallback: string,
  max = 240,
): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, max);
}

export function selectOwnerCockpitMission(
  packets: VerifiedDeepWorkPacket[],
): VerifiedDeepWorkPacket | null {
  return selectDeepWorkReviewCandidate(packets);
}

export function buildOwnerCockpitMissionView(packet: VerifiedDeepWorkPacket) {
  const evidenceGaps = listDeepWorkEvidenceGaps(packet);
  return {
    packetId: packet.packetId,
    objective: safeText(packet.objective, 'Deep-work mission'),
    taskFamily: packet.taskFamily,
    status: packet.status,
    stage: packet.currentStage,
    nextDecision: safeText(packet.nextDecision, 'Review the mission evidence.'),
    sourceCount: packet.sources.length,
    artifactCount: packet.artifacts.length,
    checks: packet.checks.slice(0, 8).map((check) => ({
      name: safeText(check.name, 'Recorded check', 120),
      passed: check.passed,
    })),
    checksPassed: packet.checks.filter((check) => check.passed).length,
    checksTotal: packet.checks.length,
    risks: packet.unresolvedRisks
      .slice(0, 5)
      .map((risk) => safeText(risk, 'Unresolved risk', 160)),
    review: packet.review || null,
    reviewPending: !packet.review,
    modelRoute: packet.modelRoute || null,
    evidenceComplete: evidenceGaps.length === 0,
    evidenceGaps,
    deterministicReplayPassed: hasDeepWorkDeterministicReplayEvidence(packet),
  };
}

export class OwnerCockpitServer {
  private readonly sessions = new Map<string, Session>();
  private readonly loginAttempts = new Map<string, number[]>();

  constructor(
    private readonly config: OwnerCockpitConfig,
    private readonly now = () => new Date(),
  ) {}

  private session(req: IncomingMessage): { id: string; value: Session } | null {
    const id = cookies(req)[COOKIE_NAME];
    if (!id) return null;
    const value = this.sessions.get(id);
    if (!value || value.expiresAt <= this.now().getTime()) {
      this.sessions.delete(id);
      return null;
    }
    return { id, value };
  }

  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin || !URL.canParse(origin)) return false;
    const parsed = new URL(origin);
    return (
      parsed.host === req.headers.host &&
      ['http:', 'https:'].includes(parsed.protocol)
    );
  }

  private requireMutationAuth(
    req: IncomingMessage,
    res: ServerResponse,
  ): Session | null {
    const active = this.session(req)?.value;
    if (!active) {
      json(res, 401, { error: 'Sign in again.' });
      return null;
    }
    if (
      !this.sameOrigin(req) ||
      !secureEqual(String(req.headers['x-csrf-token'] || ''), active.csrfToken)
    ) {
      json(res, 403, { error: 'Request verification failed.' });
      return null;
    }
    return active;
  }

  private buildSnapshot(csrfToken: string) {
    const generatedAt = this.now().toISOString();
    const threads = listLifeThreadsForGroup(this.config.groupFolder, [
      'active',
      'paused',
    ]).slice(0, 8);
    const goals = listHierarchicalGoals({
      groupFolder: this.config.groupFolder,
      statuses: ['active', 'blocked', 'paused'],
      limit: 8,
    });
    const approvals = listCognitiveApprovalPackets({
      groupFolder: this.config.groupFolder,
      status: 'staged',
      limit: 8,
    }).filter((item) => !item.expiresAt || item.expiresAt > generatedAt);
    const outcomes = listOutcomesForGroup({
      groupFolder: this.config.groupFolder,
      statuses: ['completed', 'partial', 'failed'],
      includeSuppressed: true,
      limit: 6,
    });
    const deepWorkPackets = listVerifiedDeepWorkPackets({
      groupFolder: this.config.groupFolder,
      limit: 20,
    });
    const currentMission = selectOwnerCockpitMission(deepWorkPackets);
    const assistantMetrics = buildAssistantMetricSnapshot({
      groupFolder: this.config.groupFolder,
      now: this.now(),
    });
    const reviewedOutcomeProgress = buildReviewedOutcomeProgress({
      groupFolder: this.config.groupFolder,
      now: this.now(),
    });
    const snapshotNow = new Date(generatedAt);
    const activeThread = threads
      .filter((item) => shouldProactivelySurfaceCommitment(item, snapshotNow))
      .map((item) => projectEffectiveLifeThread(item, snapshotNow))
      .find((item) => item.status === 'active' && item.nextAction);
    const activeGoal = goals.find(
      (item) => item.status === 'active' && item.nextAction,
    );
    const focus = activeThread
      ? {
          title: safeText(activeThread.nextAction, activeThread.title),
          reason: `From your open loop: ${safeText(activeThread.title, 'current priority')}`,
        }
      : activeGoal
        ? {
            title: safeText(activeGoal.nextAction, activeGoal.title),
            reason: `Supports ${safeText(activeGoal.title, 'your active goal')}`,
          }
        : {
            title:
              'Choose the one outcome that would make today feel complete.',
            reason: 'Nothing urgent is currently ranked above it.',
          };
    return {
      version: 1,
      generatedAt,
      csrfToken,
      focus,
      today: approvals.slice(0, 2).map((item) => ({
        title: item.summary,
        detail: 'Waiting for your review',
        meta: item.actionClass,
      })),
      threads: threads.map((item) => ({
        id: item.id,
        title: safeText(item.title, 'Open loop'),
        nextAction: safeText(
          item.nextAction,
          item.summary || 'No next action recorded',
        ),
        status: item.status,
        updatedAt: item.lastUpdatedAt,
      })),
      goals: goals.map((item) => ({
        id: item.goalId,
        title: safeText(item.title, 'Goal'),
        nextAction: safeText(item.nextAction, item.objective),
        status: item.status,
        priority: item.priority,
        updatedAt: item.updatedAt,
      })),
      approvals: approvals.map((item) => ({
        id: item.approvalPacketId,
        // Confirmation compare-and-set uses the exact summary shown to the
        // owner. Approval summaries are already bounded and redacted when
        // persisted; normalizing or truncating here would make the displayed
        // value differ from the value protected by the CAS.
        summary: item.summary,
        actionClass: item.actionClass,
        expiresAt: item.expiresAt || null,
        approvalVersion: item.approvalVersion || 1,
        scopeDigest: item.scopeDigest || null,
      })),
      outcomes: outcomes.map((item) => ({
        id: item.outcomeId,
        summary: safeText(
          item.completionSummary,
          item.sourceType === 'reminder'
            ? 'Reminder outcome'
            : 'Outcome reviewed',
        ),
        nextAction: safeText(item.nextFollowupText, item.blockerText || ''),
        status: item.status,
        updatedAt: item.updatedAt,
      })),
      deepWork: {
        current: currentMission
          ? buildOwnerCockpitMissionView(currentMission)
          : null,
        promotion: assessDeepWorkSkillPromotion(this.config.groupFolder),
        dogfood: buildDeepWorkDogfoodReport(
          this.config.groupFolder,
          this.now(),
        ),
      },
      intelligence: {
        reviewedOutcomeCount: assistantMetrics.reviewedOutcomeCount,
        requiredOutcomeCount: 5,
        baselineReady: assistantMetrics.reviewedOutcomeCount >= 5,
        baselineSaved: reviewedOutcomeProgress.baselineSaved,
        latency: {
          sampleCount: assistantMetrics.interactionLatencySampleCount,
          averageMs: assistantMetrics.averageLatencyMs,
          p50Ms: assistantMetrics.p50LatencyMs,
          p95Ms: assistantMetrics.p95LatencyMs,
          slowestStage: assistantMetrics.slowestLatencyStage,
          slowestRoute: assistantMetrics.slowestLatencyRoute,
          slowestProvider: assistantMetrics.slowestLatencyProvider,
          slowestTool: assistantMetrics.slowestLatencyTool,
          worstBreachingRoute: assistantMetrics.worstBreachingLatencyRoute,
          targetBreaches: assistantMetrics.interactionLatencyTargetBreaches,
          legacySampleCount:
            assistantMetrics.legacyInteractionLatencySampleCount,
          invalidSampleCount:
            assistantMetrics.invalidInteractionLatencySampleCount,
          hostPressureSampleCount: assistantMetrics.hostPressureSampleCount,
          highHostPressureSampleCount:
            assistantMetrics.highHostPressureSampleCount,
          latestHostPressureClass: assistantMetrics.latestHostPressureClass,
          degradedDeliveryCount:
            assistantMetrics.degradedInteractionDeliveryCount,
          partialDeliveryCount:
            assistantMetrics.partialInteractionDeliveryCount,
          unknownDeliveryCount:
            assistantMetrics.unknownInteractionDeliveryCount,
          latestDegradedDeliveryOutcome:
            assistantMetrics.latestDegradedDeliveryOutcome,
          latestDegradedDeliveryRoute:
            assistantMetrics.latestDegradedDeliveryRoute,
          routes: assistantMetrics.interactionLatencyByRoute.slice(0, 5),
          providers: assistantMetrics.interactionLatencyByProvider.slice(0, 5),
          tools: assistantMetrics.interactionLatencyByTool.slice(0, 5),
        },
      },
    };
  }

  private async login(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const key = req.socket.remoteAddress || 'loopback';
    const cutoff = this.now().getTime() - 60_000;
    const attempts = (this.loginAttempts.get(key) || []).filter(
      (time) => time > cutoff,
    );
    if (attempts.length >= 5) {
      json(res, 429, { error: 'Too many attempts. Try again shortly.' });
      return;
    }
    attempts.push(this.now().getTime());
    this.loginAttempts.set(key, attempts);
    const form = new URLSearchParams(await readBody(req));
    if (!secureEqual(form.get('secret') || '', this.config.secret)) {
      send(res, 401, 'text/html; charset=utf-8', OWNER_COCKPIT_LOGIN_HTML);
      return;
    }
    this.loginAttempts.delete(key);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      csrfToken: randomBytes(24).toString('base64url'),
      expiresAt: this.now().getTime() + this.config.sessionMinutes * 60_000,
    });
    const forwardedHttps =
      req.socket.remoteAddress === '127.0.0.1' ||
      req.socket.remoteAddress === '::1'
        ? req.headers['x-forwarded-proto'] === 'https'
        : false;
    res.setHeader(
      'set-cookie',
      `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.config.sessionMinutes * 60}${forwardedHttps ? '; Secure' : ''}`,
    );
    securityHeaders(res);
    res.statusCode = 303;
    res.setHeader('location', '/');
    res.end();
  }

  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'andrea-owner-cockpit',
        enabled: true,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/assets/cockpit.css')
      return send(res, 200, 'text/css; charset=utf-8', OWNER_COCKPIT_CSS);
    if (req.method === 'GET' && url.pathname === '/assets/cockpit.js')
      return send(res, 200, 'text/javascript; charset=utf-8', OWNER_COCKPIT_JS);
    if (
      req.method === 'GET' &&
      (url.pathname === '/login' || url.pathname === '/auth/login')
    )
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        OWNER_COCKPIT_LOGIN_HTML,
      );
    if (req.method === 'POST' && url.pathname === '/auth/login')
      return this.login(req, res);
    const active = this.session(req);
    if (!active) {
      if (url.pathname.startsWith('/api/'))
        return json(res, 401, { error: 'Sign in required.' });
      securityHeaders(res);
      res.statusCode = 303;
      res.setHeader('location', '/login');
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/')
      return send(res, 200, 'text/html; charset=utf-8', OWNER_COCKPIT_HTML);
    if (req.method === 'GET' && url.pathname === '/api/v1/snapshot')
      return json(res, 200, this.buildSnapshot(active.value.csrfToken));
    if (req.method === 'POST' && url.pathname === '/api/v1/reversible-state') {
      if (!this.requireMutationAuth(req, res)) return;
      const body = JSON.parse(await readBody(req)) as Record<string, string>;
      const ok =
        body.kind === 'thread' && ['active', 'paused'].includes(body.state)
          ? Boolean(
              body.state === 'paused'
                ? deferLifeThreadCommitment({
                    threadId: body.id,
                    groupFolder: this.config.groupFolder,
                    now: this.now(),
                    sourceKind: 'action_layer',
                    reason: 'The owner paused this commitment in the cockpit.',
                  })
                : reactivateLifeThreadCommitment({
                    threadId: body.id,
                    groupFolder: this.config.groupFolder,
                    now: this.now(),
                    reason: 'The owner resumed this commitment in the cockpit.',
                  }),
            )
          : body.kind === 'goal' && ['active', 'paused'].includes(body.state)
            ? updateHierarchicalGoalStatus(
                body.id,
                body.state as 'active' | 'paused',
                this.now().toISOString(),
              )
            : false;
      return ok
        ? json(res, 200, { ok: true })
        : json(res, 400, { error: 'That reversible change is not available.' });
    }
    const approvalMatch = url.pathname.match(
      /^\/api\/v1\/approvals\/([^/]+)\/confirm$/,
    );
    const missionReviewMatch = url.pathname.match(
      /^\/api\/v1\/deep-work\/([^/]+)\/review$/,
    );
    if (req.method === 'POST' && missionReviewMatch) {
      if (!this.requireMutationAuth(req, res)) return;
      const body = JSON.parse(await readBody(req)) as Record<string, string>;
      const verdicts = [
        'verified',
        'partial',
        'blocked',
        'corrected',
        'rejected',
      ] as const;
      if (!verdicts.includes(body.verdict as (typeof verdicts)[number])) {
        return json(res, 400, { error: 'Unknown mission review verdict.' });
      }
      const snapshot = reviewDeepWorkMission({
        packetId: decodeURIComponent(missionReviewMatch[1]!),
        verdict: body.verdict as (typeof verdicts)[number],
        summary: body.summary || `Owner marked mission ${body.verdict}.`,
        now: this.now(),
      });
      return json(res, 200, {
        ok: true,
        verdict: snapshot.packet.review?.verdict,
        promotion: snapshot.promotion,
      });
    }
    if (req.method === 'POST' && approvalMatch) {
      if (!this.requireMutationAuth(req, res)) return;
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (
        body.confirmation !== 'APPROVE' ||
        typeof body.summary !== 'string' ||
        !body.summary ||
        typeof body.approvalVersion !== 'number' ||
        !Number.isSafeInteger(body.approvalVersion) ||
        (body.scopeDigest !== null && typeof body.scopeDigest !== 'string')
      )
        return json(res, 409, {
          error: 'The action summary changed. Review it again.',
        });
      const result = approveCognitiveApprovalPacketCAS({
        approvalPacketId: decodeURIComponent(approvalMatch[1]!),
        groupFolder: this.config.groupFolder,
        expectedSummary: body.summary,
        expectedApprovalVersion: body.approvalVersion,
        expectedScopeDigest: body.scopeDigest,
        now: this.now().toISOString(),
        approvalChannel: 'owner_cockpit',
      });
      if (result.status !== 'approved')
        return json(res, 409, {
          error:
            'This approval is stale, changed, expired, or no longer available. Review it again.',
        });
      return json(res, 200, { ok: true, status: 'approved' });
    }
    json(res, 404, { error: 'Not found.' });
  }
}

export function startOwnerCockpitServer(
  config = resolveOwnerCockpitConfig(),
): http.Server | null {
  if (!config.enabled) return null;
  if (config.secret.length < 20)
    throw new Error(
      'ANDREA_OWNER_COCKPIT_SECRET must contain at least 20 characters.',
    );
  const server = createOwnerCockpitHttpServer(config);
  server.listen(config.port, config.host, () =>
    logger.info(
      { host: config.host, port: config.port },
      'Andrea owner cockpit started',
    ),
  );
  return server;
}

export function createOwnerCockpitHttpServer(
  config: OwnerCockpitConfig,
): http.Server {
  const cockpit = new OwnerCockpitServer(config);
  return http.createServer((req, res) =>
    cockpit.handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'Owner cockpit request failed');
      json(res, 500, { error: 'Andrea could not complete that request.' });
    }),
  );
}
