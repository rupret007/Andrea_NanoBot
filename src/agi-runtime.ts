/**
 * AGI runtime — the composition root that wires the new subsystems
 * together and exposes a single `ask(question)` entry point the existing
 * NanoClaw channels (WhatsApp, Telegram, Slack, Discord, Gmail, Alexa,
 * BlueBubbles) can call without knowing anything about the cognitive
 * machinery underneath.
 *
 * Think of this as the `main()` for the AGI layer. The legacy `src/index.ts`
 * orchestrator still owns process lifecycle and channel I/O; it delegates
 * the "what should the agent say/do" question to this module.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CognitiveCore,
  type CognitiveContext,
  type CognitiveResult,
  type ModelClient,
} from './agi-core/index.js';
import {
  IntegrationRegistry,
  ValidationError,
  validateArgs,
  type Integration,
} from './integrations/index.js';
import { MemoryFacade, type EmbeddingClient } from './memory/index.js';
import { ModelRouter, type ProviderAdapter } from './models/index.js';
import {
  AuditLog,
  BudgetMeter,
  CONSTITUTION_VERSION,
  constitutionPrompt,
  evaluate as evaluatePolicy,
  scan as scanInjection,
  quarantine,
  redactSecrets,
} from './safety/index.js';
import { Reflector } from './reflection/index.js';
import { SkillsSubsystem } from './skills/index.js';
import {
  beginAgentRuntimeSpineRun,
  finalizeAgentRuntimeSpineOutcome,
  recordAgentRuntimeTruthAudit,
  type AgentRuntimeSpineResult,
} from './agent-runtime-spine.js';
import {
  isDatabaseInitialized,
  listWorldFactEvidenceLinks,
  listWorldFacts,
  upsertWorldFact,
  upsertWorldFactEvidenceLink,
} from './db.js';
import {
  runtimeHashId,
  runtimePrivacyJson,
  runtimeSafeJson,
} from './agent-runtime-glue.js';
import { buildLogicKernelReport } from './logic-kernel.js';
import { runTruthEngine } from './truth-engine.js';
import type {
  TruthVerdict,
  WorldFactRecord,
  WorldFactSensitivity,
  WorldFactType,
} from './types.js';

/**
 * Module-level guard that prevents accidental construction of two AGI
 * runtimes in the same process. Two runtimes would race on the audit-log
 * hash chain, the episodic JSONL append tail, and the in-memory budget
 * meter; one or all of those will silently corrupt. Tests and rare
 * intentional multi-tenant cases can pass `force: true` to opt out.
 */
let _runtimeInstantiated = false;

export interface AgiRuntimeOptions {
  embed: EmbeddingClient;
  providers: ProviderAdapter[];
  integrations: Integration[];
  primaryModelId: string;
  smallModelId: string;
  panelModelIds: string[];
  /** Filesystem paths for stores. */
  paths: {
    vector: string;
    graph: string;
    episodic: string;
    audit: string;
    workdirRoot?: string;
  };
  /** Per-window budget caps. */
  budgets?: Record<
    string,
    { windowMs: number; maxUsd?: number; maxCalls?: number }
  >;
  /** Persona / project-specific addendum to the constitution. */
  persona?: string;
  /** Optional first-class workflow skill subsystem. */
  skills?: SkillsSubsystem;
  /** Secret store factory — receives the integration id. */
  secretsFor: (integrationId: string) => Promise<{
    get(key: string): Promise<string | undefined>;
  }>;
  /**
   * Optional IANA timezone string (e.g. "America/Los_Angeles") forwarded to
   * the reflector for daily-date stamping. Defaults to the host's resolved
   * timezone.
   */
  tz?: string;
  /**
   * Bypass the singleton guard. Defaults to false. Only set true in tests
   * or in carefully-isolated multi-tenant setups where each runtime owns
   * its own filesystem paths.
   */
  force?: boolean;
}

/** Shape of a tool invocation request, used by both invokeTool and confirmTool. */
export interface InvokeToolParams {
  name: string;
  args: Record<string, unknown>;
  initiatedByUser: boolean;
  inConfirmationFlow?: boolean;
  callId?: string;
  confirmationScope?: {
    chatJid?: string;
    sender?: string;
  };
}

/** A tool-invocation request parked awaiting user confirmation. */
export interface PendingConfirmation {
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  createdAt: number;
  chatJid?: string;
  sender?: string;
}

export interface PendingActionView {
  pendingId: string;
  tool: string;
  reason: string;
  argsPreview: string;
}

export interface AskCitation {
  sourceId: string;
  sourcePath: string;
  upstreamUrl?: string;
}

export interface AskTruthView {
  auditId: string;
  status: TruthVerdict['calibration']['status'];
  supportGrade: TruthVerdict['calibration']['supportGrade'];
  confidence: number;
  flags: string[];
  summary: string;
}

export interface AskMemoryWriteView {
  id: string;
  kind: string;
  summary: string;
}

export interface AskResult {
  reply: string;
  trace: CognitiveResult['trace'];
  pendingActions?: PendingActionView[];
  citations?: AskCitation[];
  runId?: string;
  truth?: AskTruthView;
  memoryWrites?: AskMemoryWriteView[];
  resumeToken?: string;
  liveProofTags?: string[];
  failed?: boolean;
}

/**
 * Window after which a pending-confirmation request is auto-pruned. Keeps
 * the in-memory map bounded even if the user walks away mid-flow. 5 min
 * is long enough for a back-and-forth confirmation but short enough that
 * stale state doesn't pile up.
 */
const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export class AgiRuntime {
  readonly memory: MemoryFacade;
  readonly registry: IntegrationRegistry;
  readonly router: ModelRouter;
  readonly audit: AuditLog;
  readonly budget: BudgetMeter;
  readonly reflector: Reflector;
  readonly cognition: CognitiveCore;
  readonly skills?: SkillsSubsystem;
  private readonly modelClient: ModelClient;
  private readonly integrationWorkdirRoot: string;

  /**
   * In-memory map of pending tool-invocation confirmations keyed by callId.
   * When `invokeTool` returns `kind: "confirm"`, the request is parked here
   * and the caller gets back a `pendingId`. `confirmTool(pendingId, true)`
   * promotes it to an `inConfirmationFlow: true` invocation; `false`
   * declines and removes it. Entries expire after 5 minutes.
   */
  readonly pendingConfirmations = new Map<string, PendingConfirmation>();

  private constructor(opts: AgiRuntimeOptions) {
    this.integrationWorkdirRoot =
      opts.paths.workdirRoot ?? join(dirname(opts.paths.audit), 'integrations');
    this.memory = new MemoryFacade(opts.embed, {
      vectorPath: opts.paths.vector,
      graphPath: opts.paths.graph,
      episodicPath: opts.paths.episodic,
    });
    this.audit = new AuditLog(opts.paths.audit);
    this.budget = new BudgetMeter(
      opts.budgets ?? {
        hour: { windowMs: 60 * 60 * 1000, maxUsd: 5, maxCalls: 200 },
        day: { windowMs: 24 * 60 * 60 * 1000, maxUsd: 25, maxCalls: 2000 },
        month: { windowMs: 30 * 24 * 60 * 60 * 1000, maxUsd: 200 },
      },
    );

    this.router = new ModelRouter({
      onSpend: (usd, modelId) => {
        this.budget.charge(usd, modelId);
        void this.safeAudit({
          scope: 'model',
          kind: 'spend',
          payload: { usd, modelId },
        });
      },
    });
    for (const p of opts.providers) this.router.registerAdapter(p);

    const modelClient: ModelClient = {
      primary: opts.primaryModelId,
      small: opts.smallModelId,
      panel: opts.panelModelIds,
      complete: async (req) => {
        // Honor `req.model` as `preferId` so the cognitive core can pin a
        // particular model for a particular reasoning step (council, critic,
        // synth). The model-router fix pass made `preferId` fail loud when
        // the requested model is unavailable; we catch that here and fall
        // back to scoring unless the caller opted into fail-loud via
        // `failLoudOnPreference`.
        const failLoud = Boolean(
          (req as { failLoudOnPreference?: boolean }).failLoudOnPreference,
        );
        try {
          const out = await this.router.complete({
            system: req.system,
            messages: req.messages,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            preferId: req.model,
            preferIdOptional: !failLoud,
          });
          return {
            text: out.text,
            inputTokens: out.inputTokens,
            outputTokens: out.outputTokens,
            costUsd: out.costUsd,
          };
        } catch (err) {
          if (failLoud) throw err;
          // Last-ditch fallback: drop the preference entirely and try
          // scoring. If that also fails the caller sees the original error.
          const message = err instanceof Error ? err.message : String(err);
          if (!/preferId/i.test(message)) throw err;
          const out = await this.router.complete({
            system: req.system,
            messages: req.messages,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
          });
          return {
            text: out.text,
            inputTokens: out.inputTokens,
            outputTokens: out.outputTokens,
            costUsd: out.costUsd,
          };
        }
      },
    };
    this.modelClient = modelClient;
    this.cognition = new CognitiveCore(modelClient);
    this.reflector = new Reflector(
      {
        complete: async (req) =>
          this.router.complete({
            system: req.system,
            messages: req.messages,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            preferId: opts.smallModelId,
            preferIdOptional: true,
          }),
      },
      this.memory,
      { tz: opts.tz },
    );

    this.registry = new IntegrationRegistry((id) => ({
      userId: 'default',
      scope: id,
      secrets: makeLazySecrets(opts.secretsFor, id),
      workdir: join(this.integrationWorkdirRoot, safePathSegment(id)),
      audit: (event) => {
        void this.safeAudit({
          scope: id,
          kind: event.kind,
          payload: event.payload,
        });
      },
    }));

    this.persona = opts.persona ?? '';
    this.skills = opts.skills;
  }

  private persona: string;

  static async create(opts: AgiRuntimeOptions): Promise<AgiRuntime> {
    if (_runtimeInstantiated && !opts.force) {
      throw new Error(
        'AgiRuntime already instantiated in this process. Pass `force: true` if you really mean to construct a second runtime (concurrent runtimes will race on the audit log hash chain and episodic JSONL).',
      );
    }
    const rt = new AgiRuntime(opts);
    _runtimeInstantiated = true;
    await mkdir(rt.integrationWorkdirRoot, { recursive: true });
    await rt.memory.load();
    await rt.audit.load();
    if (await fileExists(opts.paths.audit)) {
      const auditChain = await rt.audit.verifyChain();
      if (!auditChain.ok) {
        console.warn(
          `[agi-runtime] audit chain invalid at startup: ${auditChain.reason ?? 'unknown'}`,
        );
        await rt.safeAudit({
          scope: 'audit',
          kind: 'audit_chain.invalid',
          payload: auditChain,
        });
      }
    }
    try {
      await rt.registry.register(rt.createMemoryIntegration());
    } catch (err) {
      await rt.safeAudit({
        scope: 'memory',
        kind: 'integration.init_failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    for (const integration of opts.integrations) {
      try {
        await rt.registry.register(integration);
      } catch (err) {
        // An integration failing to init should NEVER crash the runtime.
        await rt.safeAudit({
          scope: integration.id,
          kind: 'integration.init_failed',
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    return rt;
  }

  /**
   * Test-only escape hatch. Resets the singleton flag so the next `create`
   * can construct a runtime without `force: true`. Do not call from prod.
   * @internal
   */
  static __resetSingletonForTests(): void {
    _runtimeInstantiated = false;
  }

  /**
   * Single-shot entry point used by every channel. Returns the assistant's
   * reply text plus the cognition trace (for logging & debugging).
   *
   * Resilience contract: the user has paid for a reply once `cognition.think`
   * returns. Persistence-side failures (memory recall on the way in,
   * episode log on the way out, audit write) MUST NOT bubble — they get
   * swallowed and audit-stamped. Only `cognition.think` itself failing
   * surfaces as an error reply.
   */
  async ask(params: {
    scope: string;
    text: string;
    /** External text source label (e.g. "telegram:chat:123", "email:from:@..."). */
    source?: string;
    /** Treat the message body as data rather than instruction (for forwarded content). */
    untrusted?: boolean;
    initiatedByUser?: boolean;
    /** History segment provided by the channel — recent turns from this convo. */
    history?: { role: 'user' | 'assistant'; content: string }[];
  }): Promise<AskResult> {
    const { scope, text, source } = params;
    const generatedAt = new Date().toISOString();
    const channel = channelFromSource(source);
    const liveProofTags = liveProofTagsFor({ source, scope });

    // Prompt-injection scan on user text.
    const scan = scanInjection(text);
    let prompt = text;
    if (scan.treatAsData || params.untrusted) {
      prompt = quarantine(text, source ?? 'user');
    }

    // Pull semantic memory context. If recall throws (vector store I/O
    // failure, embedder outage), don't reject the whole turn — log and
    // proceed with empty context.
    let memContext = '';
    try {
      memContext = await this.memory.contextFor({
        text,
        scopes: [scope, 'global'],
        topK: 8,
      });
    } catch (err) {
      await this.safeAudit({
        scope,
        kind: 'memory.recall.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
      memContext = '';
    }

    // Compose system prompt: constitution + persona + memory.
    // Trim each section first so a whitespace-only persona doesn't yield a
    // leading blank section after the join.
    const system = [
      constitutionPrompt(),
      this.persona,
      memContext ? `## Long-term memory\n${memContext}` : '',
    ]
      .map((s) => (typeof s === 'string' ? s.trim() : s))
      .filter(Boolean)
      .join('\n\n');

    const skillCommand = this.skills?.resolveSlashCommand(text);
    if (skillCommand) {
      const result = await this.runSkillCommand({
        scope,
        text,
        system,
        history: params.history,
        command: skillCommand,
      });
      return result;
    }

    // traceId: scope+timestamp is collision-prone under concurrent ask()s
    // in the same scope+ms. Append a UUID suffix for global uniqueness.
    const traceId = `${scope}-${Date.now()}-${randomUUID()}`;
    const pendingActions: PendingActionView[] = [];
    const memoryWrites: AskMemoryWriteView[] = [];
    const runtime = await this.safeBeginRuntimeSpine({
      traceId,
      scope,
      text,
      source,
      channel,
      generatedAt,
    });
    const ctx: CognitiveContext = {
      traceId,
      goal: prompt,
      system,
      history: (params.history ?? []).map((h) => ({
        role: h.role,
        content: h.content,
      })),
      tools: this.registry.list(),
      toolRunner: async (call) => {
        const out = await this.invokeTool({
          name: call.tool,
          args: call.args,
          initiatedByUser: params.initiatedByUser ?? true,
          callId: call.callId,
          confirmationScope: {
            chatJid: scope,
            sender: source,
          },
        });
        if (
          'pendingId' in out &&
          out.pendingId &&
          'decision' in out &&
          out.decision
        ) {
          const pendingId = out.pendingId;
          const reason = out.decision.reason;
          pendingActions.push({
            pendingId,
            tool: call.tool,
            reason,
            argsPreview: previewArgs(call.args),
          });
          return {
            callId: call.callId,
            ok: false,
            error: `Confirmation required (${pendingId}): ${reason}`,
          };
        }
        collectMemoryWrites(out, memoryWrites);
        if ('decision' in out && out.decision?.kind === 'deny') {
          return { callId: call.callId, ok: false, error: out.decision.reason };
        }
        return {
          callId: call.callId,
          ok: out.ok,
          output: 'output' in out ? out.output : undefined,
          error: 'error' in out ? out.error : undefined,
          latencyMs: 'latencyMs' in out ? out.latencyMs : undefined,
        };
      },
    };

    let result: CognitiveResult;
    try {
      result = await this.cognition.think(ctx);
    } catch (err) {
      const short = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        scope,
        kind: 'cognition.failed',
        payload: { traceId, error: short },
      });
      const errorTrace: CognitiveResult['trace'] = {
        goal: prompt,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        nodes: [],
        acceptedPath: [],
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        costUsd: 0,
      };
      return {
        reply: `Andrea hit an internal error: ${short.slice(0, 200)}`,
        trace: errorTrace,
        pendingActions: pendingActions.length ? pendingActions : undefined,
        runId: runtime?.run.runtimeRunId,
        resumeToken: activeResumeToken(runtime),
        liveProofTags,
        failed: true,
      };
    }

    const truth = await this.safeCalibrateTruth({
      traceId,
      text,
      answer: result.answer,
      scope,
      channel,
      runtime,
      generatedAt,
    });
    const reply = truth?.rewrittenText || result.answer;
    if (reply !== result.answer) {
      result.answer = reply;
      result.trace.answer = reply;
    }
    await this.safeFinalizeRuntimeSpine({
      runtime,
      generatedAt,
      strategy: result.strategy,
      truth,
    });

    // Best-effort persistence below this line — the user already has their
    // reply, so a failed write should NEVER be observable as a rejected
    // promise.
    try {
      await this.memory.logEpisode({
        id: ctx.traceId,
        scope,
        actor: 'user',
        content: text,
      });
      await this.memory.logEpisode({
        id: ctx.traceId + '.reply',
        scope,
        actor: 'assistant',
        content: reply,
      });
    } catch (err) {
      await this.safeAudit({
        scope,
        kind: 'memory.logEpisode.failed',
        payload: {
          traceId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    await this.safeAudit({
      scope,
      kind: 'cognition.complete',
      payload: {
        strategy: result.strategy,
        latencyMs: result.trace.latencyMs,
        tokens: result.trace.tokens,
        costUsd: result.trace.costUsd,
        pendingActions: pendingActions.length,
        constitutionVersion: CONSTITUTION_VERSION,
      },
    });
    await this.appendTraceSummary({
      scope,
      traceId,
      strategy: result.strategy,
      latencyMs: result.trace.latencyMs ?? 0,
      costUsd: result.trace.costUsd ?? 0,
      pendingActions,
      toolsAdvertised: ctx.tools?.map((t) => t.name) ?? [],
      toolsUsed: result.trace.nodes
        .map((node) => node.toolCall?.tool)
        .filter(
          (tool): tool is string => typeof tool === 'string' && tool.length > 0,
        ),
      trace: result.trace,
    });

    return {
      reply,
      trace: result.trace,
      pendingActions: pendingActions.length ? pendingActions : undefined,
      runId: runtime?.run.runtimeRunId,
      truth: truth ? truthView(truth) : undefined,
      memoryWrites: memoryWrites.length ? memoryWrites : undefined,
      resumeToken: activeResumeToken(runtime),
      liveProofTags,
    };
  }

  private async safeBeginRuntimeSpine(params: {
    traceId: string;
    scope: string;
    text: string;
    source?: string;
    channel: string;
    generatedAt: string;
  }): Promise<AgentRuntimeSpineResult | null> {
    try {
      return beginAgentRuntimeSpineRun({
        turnId: params.traceId,
        channel: params.channel,
        groupFolder: params.scope,
        goal: params.text,
        generatedAt: params.generatedAt,
        mode: 'assistive',
        persist: isDatabaseInitialized(),
      });
    } catch (err) {
      await this.safeAudit({
        scope: params.scope,
        kind: 'runtime_spine.begin.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  }

  private async safeCalibrateTruth(params: {
    traceId: string;
    text: string;
    answer: string;
    scope: string;
    channel: string;
    runtime: AgentRuntimeSpineResult | null;
    generatedAt: string;
  }): Promise<TruthVerdict | undefined> {
    try {
      const logicReport = buildLogicKernelReport({
        subject: params.text,
        episodeId: params.runtime?.run.agentOSEpisodeId,
        generatedAt: params.generatedAt,
      });
      const truth = runTruthEngine({
        text: params.answer,
        turnId: params.traceId,
        channel: params.channel,
        taskFamily: params.runtime?.run.taskFamily,
        subject: params.text,
        logicReport,
        generatedAt: params.generatedAt,
        persist: isDatabaseInitialized(),
      });
      recordAgentRuntimeTruthAudit({
        runtime: params.runtime,
        truthVerdict: truth,
        generatedAt: params.generatedAt,
        textShape: `${params.answer.trim().split(/\s+/).filter(Boolean).length}_words`,
      });
      return truth;
    } catch (err) {
      await this.safeAudit({
        scope: params.scope,
        kind: 'truth.calibration.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
      return undefined;
    }
  }

  private async safeFinalizeRuntimeSpine(params: {
    runtime: AgentRuntimeSpineResult | null;
    generatedAt: string;
    strategy: CognitiveResult['strategy'];
    truth?: TruthVerdict;
  }): Promise<void> {
    try {
      finalizeAgentRuntimeSpineOutcome({
        runtime: params.runtime,
        generatedAt: params.generatedAt,
        evaluationStatus:
          params.truth?.calibration.status === 'block'
            ? 'block'
            : params.truth?.calibration.status === 'warn' ||
                params.truth?.calibration.status === 'clarify'
              ? 'warn'
              : 'pass',
        evidenceGap:
          params.truth?.sourceCoverage.coverageGrade === 'none'
            ? 'truth_source_coverage_none'
            : null,
        evaluatorFlags: params.truth?.calibration.flags ?? [],
        routeUsed: params.strategy,
        answerClass: params.truth?.calibration.supportGrade,
        blockerClass:
          params.truth?.calibration.status === 'block' ? 'truth_block' : null,
      });
    } catch (err) {
      await this.safeAudit({
        scope: 'runtime',
        kind: 'runtime_spine.finalize.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private createMemoryIntegration(): Integration {
    return {
      id: 'memory',
      displayName: 'Andrea Memory',
      enabled: true,
      init: async () => undefined,
      register: async () => [
        {
          name: 'save_fact',
          description:
            'Save a durable user fact, preference, goal, responsibility, or useful memory with provenance.',
          schema: {
            type: 'object',
            required: ['fact'],
            properties: {
              fact: { type: 'string' },
              subject: { type: 'string' },
              scope: { type: 'string' },
              factType: { type: 'string' },
              sensitivity: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
          effect: 'write',
          integrationId: 'memory',
          handler: async (args) => this.handleMemorySaveFact(args),
        },
        {
          name: 'correct_fact',
          description:
            'Record a correction that supersedes an old memory or belief without deleting audit history.',
          schema: {
            type: 'object',
            required: ['correction'],
            properties: {
              correction: { type: 'string' },
              factId: { type: 'string' },
              oldFact: { type: 'string' },
              scope: { type: 'string' },
            },
          },
          effect: 'write',
          integrationId: 'memory',
          handler: async (args) => this.handleMemoryCorrectFact(args),
        },
        {
          name: 'mark_stale',
          description:
            'Mark a saved belief stale when it may no longer be true.',
          schema: {
            type: 'object',
            required: ['factId'],
            properties: {
              factId: { type: 'string' },
              reason: { type: 'string' },
            },
          },
          effect: 'write',
          integrationId: 'memory',
          handler: async (args) => this.handleMemoryStatus(args, 'stale'),
        },
        {
          name: 'forget',
          description:
            'Forget a saved belief for user privacy. Requires confirmation because it is destructive.',
          schema: {
            type: 'object',
            required: ['factId'],
            properties: {
              factId: { type: 'string' },
              reason: { type: 'string' },
            },
          },
          effect: 'destructive',
          integrationId: 'memory',
          handler: async (args) => this.handleMemoryStatus(args, 'forgotten'),
        },
        {
          name: 'explain_source',
          description:
            'Explain where a memory or belief came from, including evidence and freshness.',
          schema: {
            type: 'object',
            properties: {
              factId: { type: 'string' },
              query: { type: 'string' },
              scope: { type: 'string' },
            },
          },
          effect: 'read',
          integrationId: 'memory',
          handler: async (args) => this.handleMemoryExplainSource(args),
        },
      ],
    };
  }

  private async handleMemorySaveFact(args: Record<string, unknown>) {
    const fact = String(args.fact ?? '').trim();
    if (!fact) throw new Error('fact is required');
    const scope = safeMemoryScope(args.scope);
    const now = new Date().toISOString();
    const factId = runtimeHashId('world:fact:memory', `${scope}|${fact}`);
    const sensitivity = normalizeSensitivity(args.sensitivity);
    const confidence = normalizeConfidence(args.confidence, 0.72);
    const factType = normalizeFactType(args.factType, fact);
    await this.memory.remember({
      kind: 'semantic',
      content: fact,
      scope,
      importance: confidence,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
      source: 'memory.save_fact',
      tags: ['belief-ledger', factType],
    });
    if (isDatabaseInitialized()) {
      const groupFolder = worldFactGroupFolder(scope);
      const record: WorldFactRecord = {
        factId,
        createdAt: now,
        updatedAt: now,
        groupFolder,
        factType,
        summary: fact,
        confidence,
        evidenceRefsJson: runtimeSafeJson(
          [
            'memory.save_fact',
            `scope:${scope}`,
            String(args.subject ?? ''),
          ].filter(Boolean),
          1200,
        ),
        lastSeenAt: now,
        lastConfirmedAt: now,
        sensitivity,
        autoSurfacePolicy:
          sensitivity === 'sensitive' ? 'ask_first' : 'when_relevant',
        reviewAfterAt: reviewAfter(now, sensitivity),
        expiresAt: null,
        status:
          sensitivity === 'sensitive' ? 'pending_confirmation' : 'confirmed',
        sourceKind: 'agi_memory_tool',
        nextAction:
          sensitivity === 'sensitive'
            ? 'Ask before surfacing this sensitive memory.'
            : 'Use when relevant and cite memory provenance if asked.',
        privacyJson: runtimePrivacyJson(),
      };
      upsertWorldFact(record);
      upsertWorldFactEvidenceLink({
        linkId: runtimeHashId('world:fact:evidence', `${factId}|${now}`),
        factId,
        createdAt: now,
        evidenceSourceKind: 'memory_tool',
        evidenceSourceId: 'memory.save_fact',
        confidenceDelta: confidence,
        summary: 'Saved through Andrea memory tool.',
        privacyJson: runtimePrivacyJson(),
      });
    }
    return {
      saved: true,
      memoryWriteIds: [factId],
      memoryWrites: [{ id: factId, kind: 'fact', summary: fact }],
    };
  }

  private async handleMemoryCorrectFact(args: Record<string, unknown>) {
    const correction = String(args.correction ?? '').trim();
    if (!correction) throw new Error('correction is required');
    const scope = safeMemoryScope(args.scope);
    const now = new Date().toISOString();
    const oldFact = String(args.oldFact ?? '').trim();
    const targetId = String(args.factId ?? '').trim();
    const correctionId = runtimeHashId(
      'world:fact:correction',
      `${scope}|${targetId}|${oldFact}|${correction}`,
    );
    await this.memory.remember({
      kind: 'procedural',
      content: `Correction: ${correction}${oldFact ? ` (replaces: ${oldFact})` : ''}`,
      scope,
      importance: 0.9,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
      source: 'memory.correct_fact',
      tags: ['belief-ledger', 'correction'],
    });
    if (isDatabaseInitialized()) {
      if (targetId) {
        const target = listWorldFacts({
          groupFolder: worldFactGroupFolder(scope) ?? undefined,
          limit: 100,
        }).find((fact) => fact.factId === targetId);
        if (target) {
          upsertWorldFact({
            ...target,
            updatedAt: now,
            status: 'stale',
            confidence: Math.min(target.confidence, 0.35),
            nextAction: `Superseded by correction ${correctionId}.`,
          });
        }
      }
      upsertWorldFact({
        factId: correctionId,
        createdAt: now,
        updatedAt: now,
        groupFolder: worldFactGroupFolder(scope),
        factType: 'friction_pattern',
        summary: correction,
        confidence: 0.88,
        evidenceRefsJson: runtimeSafeJson(
          [targetId, oldFact, 'memory.correct_fact'].filter(Boolean),
          1600,
        ),
        lastSeenAt: now,
        lastConfirmedAt: now,
        sensitivity: 'personal',
        autoSurfacePolicy: 'when_relevant',
        reviewAfterAt: reviewAfter(now, 'personal'),
        expiresAt: null,
        status: 'confirmed',
        sourceKind: 'agi_memory_correction',
        nextAction:
          'Prefer this correction over older conflicting memories; mention uncertainty if conflict remains.',
        privacyJson: runtimePrivacyJson(),
      });
    }
    return {
      corrected: true,
      memoryWriteIds: [correctionId],
      memoryWrites: [
        { id: correctionId, kind: 'correction', summary: correction },
      ],
    };
  }

  private async handleMemoryStatus(
    args: Record<string, unknown>,
    status: 'stale' | 'forgotten',
  ) {
    const factId = String(args.factId ?? '').trim();
    if (!factId) throw new Error('factId is required');
    const now = new Date().toISOString();
    let found: WorldFactRecord | undefined;
    if (isDatabaseInitialized()) {
      found = listWorldFacts({ limit: 500 }).find(
        (fact) => fact.factId === factId,
      );
      if (found) {
        upsertWorldFact({
          ...found,
          updatedAt: now,
          status,
          confidence:
            status === 'forgotten' ? 0 : Math.min(found.confidence, 0.3),
          nextAction:
            status === 'forgotten'
              ? `Do not surface. Forget requested: ${String(args.reason ?? '').slice(0, 160)}`
              : `Verify before reuse. Stale reason: ${String(args.reason ?? '').slice(0, 160)}`,
        });
      }
    }
    return {
      updated: Boolean(found) || !isDatabaseInitialized(),
      status,
      memoryWriteIds: [factId],
      memoryWrites: [
        {
          id: factId,
          kind: status,
          summary: found?.summary ?? `Marked ${status}`,
        },
      ],
    };
  }

  private async handleMemoryExplainSource(args: Record<string, unknown>) {
    const factId = String(args.factId ?? '').trim();
    const scope = safeMemoryScope(args.scope);
    const query = String(args.query ?? '').trim();
    const facts = isDatabaseInitialized()
      ? listWorldFacts({
          groupFolder: worldFactGroupFolder(scope) ?? undefined,
          limit: 100,
        })
      : [];
    const fact =
      (factId
        ? facts.find((candidate) => candidate.factId === factId)
        : undefined) ||
      (query
        ? facts.find((candidate) =>
            candidate.summary.toLowerCase().includes(query.toLowerCase()),
          )
        : undefined);
    const vectorHits = query
      ? await this.memory.recall({
          text: query,
          scopes: [scope, 'global'],
          topK: 3,
        })
      : [];
    return {
      fact: fact
        ? {
            id: fact.factId,
            summary: fact.summary,
            status: fact.status,
            confidence: fact.confidence,
            freshness: fact.lastConfirmedAt ? 'confirmed' : 'observed',
            sensitivity: fact.sensitivity,
            sourceKind: fact.sourceKind,
            evidenceRefs: safeJsonArray(fact.evidenceRefsJson),
            evidenceLinks: isDatabaseInitialized()
              ? listWorldFactEvidenceLinks({ factId: fact.factId, limit: 10 })
              : [],
          }
        : null,
      semanticRecall: vectorHits.map((hit) => ({
        id: hit.entry.id,
        kind: hit.entry.kind,
        source: hit.entry.source,
        score: hit.score,
        summary: hit.entry.content.slice(0, 300),
      })),
    };
  }

  /**
   * Run a tool call subject to safety policy. Channels that bypass the
   * cognitive core for direct slash-commands should still go through here.
   *
   * Returns one of:
   *   - `{ ok: true, ... }` — handler ran (see registry.invoke shape).
   *   - `{ ok: false, error }` — denied, validation-failed, or unknown tool.
   *   - `{ ok: false, decision, pendingId }` — policy decided "confirm".
   *     Caller should surface the reason to the user; if they approve,
   *     call `confirmTool(pendingId, true)` to actually run the handler.
   *
   * Args are pre-validated against the tool's JSON schema at this boundary
   * so the failure mode is symmetric whether the call originated from the
   * cognitive core (which goes through `registry.invoke`) or directly
   * (which now does the same).
   */
  async invokeTool(params: InvokeToolParams) {
    this.pruneExpiredConfirmations();

    const tools = this.registry.list();
    const tool = tools.find((t) => t.name === params.name);
    if (!tool)
      return { ok: false as const, error: `Unknown tool ${params.name}` };

    // Pre-validate args at this boundary. The registry will validate too,
    // but doing it here means slash-command callers and cognitive-core
    // callers see identical failure modes.
    const issues = validateArgs(tool.schema, params.args);
    if (issues.length) {
      return {
        ok: false as const,
        error: new ValidationError(tool.name, issues).message,
      };
    }

    const callId = params.callId ?? 'direct-' + Date.now() + '-' + randomUUID();
    const decision = evaluatePolicy(
      tool,
      { tool: tool.name, args: params.args, callId },
      {
        initiatedByUser: params.initiatedByUser,
        inConfirmationFlow: Boolean(params.inConfirmationFlow),
        budgetExceeded: !!this.budget.exceeded(),
        allowed: new Set(),
        denied: new Set(),
        alwaysConfirm: new Set(),
      },
    );
    if (decision.kind === 'deny') {
      return { ok: false as const, decision };
    }
    if (decision.kind === 'warn') {
      await this.safeAudit({
        scope:
          params.confirmationScope?.chatJid ??
          tool.name.split('.')[0] ??
          'tool',
        kind: 'policy.warn',
        payload: {
          tool: tool.name,
          effect: tool.effect,
          reason: decision.reason,
          callId,
          argsPreview: previewArgs(params.args),
        },
      });
    }
    if (decision.kind === 'confirm') {
      // Park the request and return the id. `confirmTool` will replay it
      // with `inConfirmationFlow: true` if the user approves.
      this.pendingConfirmations.set(callId, {
        tool: tool.name,
        args: params.args,
        callId,
        createdAt: Date.now(),
        chatJid: params.confirmationScope?.chatJid,
        sender: params.confirmationScope?.sender,
      });
      const pendingId = randomUUID();
      const pending = this.pendingConfirmations.get(callId)!;
      this.pendingConfirmations.delete(callId);
      this.pendingConfirmations.set(pendingId, pending);
      return { ok: false as const, decision, pendingId };
    }
    this.budget.chargeToolCall(tool.name);
    return this.registry.invoke({
      tool: tool.name,
      args: params.args,
      callId,
    });
  }

  /**
   * Resolve a pending confirmation. If `approve` is true the tool is
   * re-invoked with `inConfirmationFlow: true`, which causes the policy
   * gate to allow `external` and `destructive` effects. If false the
   * pending entry is dropped and the caller is told the user declined.
   *
   * Pending entries that are older than 5 minutes are pruned and treated
   * as "not found".
   */
  async confirmTool(
    pendingId: string,
    approve: boolean,
    confirmationScope?: { chatJid?: string; sender?: string },
  ) {
    this.pruneExpiredConfirmations();
    const pending = this.pendingConfirmations.get(pendingId);
    if (!pending) {
      return {
        ok: false as const,
        error: 'Unknown or expired pending confirmation',
      };
    }
    if (
      confirmationScope?.chatJid &&
      pending.chatJid &&
      confirmationScope.chatJid !== pending.chatJid
    ) {
      return {
        ok: false as const,
        error: 'Pending confirmation scope mismatch',
      };
    }
    if (
      confirmationScope?.sender &&
      pending.sender &&
      confirmationScope.sender !== pending.sender
    ) {
      return {
        ok: false as const,
        error: 'Pending confirmation sender mismatch',
      };
    }
    this.pendingConfirmations.delete(pendingId);
    if (!approve) {
      return { ok: false as const, error: 'User declined' };
    }
    return this.invokeTool({
      name: pending.tool,
      args: pending.args,
      initiatedByUser: true,
      inConfirmationFlow: true,
      callId: pending.callId,
      confirmationScope,
    });
  }

  /**
   * Flush in-memory state to disk and ask the integration registry to
   * close any open MCP child processes / sockets. Idempotent. Wire to
   * SIGTERM/SIGINT in the bootstrap layer.
   */
  async shutdown(): Promise<void> {
    try {
      await this.memory.flush();
    } catch (err) {
      console.error('[agi-runtime] memory.flush failed during shutdown:', err);
    }
    try {
      await this.registry.close();
    } catch (err) {
      console.error(
        '[agi-runtime] registry.close failed during shutdown:',
        err,
      );
    }
  }

  /** Best-effort audit write — last line of defense; never throws. */
  private async safeAudit(entry: {
    scope: string;
    kind: string;
    payload?: unknown;
  }): Promise<void> {
    try {
      await this.audit.write(entry);
    } catch (err) {
      // We're already in the failure path; don't compound the problem.
      console.error('[agi-runtime] audit.write failed:', err);
    }
  }

  private pruneExpiredConfirmations(): void {
    const now = Date.now();
    for (const [id, p] of this.pendingConfirmations) {
      if (now - p.createdAt > PENDING_CONFIRMATION_TTL_MS) {
        this.pendingConfirmations.delete(id);
      }
    }
  }

  private async runSkillCommand(params: {
    scope: string;
    text: string;
    system: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    command: NonNullable<ReturnType<SkillsSubsystem['resolveSlashCommand']>>;
  }): Promise<AskResult> {
    const traceId = `${params.scope}-${Date.now()}-${randomUUID()}`;
    const startedAt = Date.now();
    const result = await this.skills!.execute({
      skill: params.command.skill,
      goal: params.command.goal,
      scope: params.scope,
      model: this.modelClient,
      system: params.system,
      history: params.history,
    });
    const citations = result.citations.map((c) => ({
      sourceId: c.sourceId,
      sourcePath: c.sourcePath,
      upstreamUrl: c.upstreamUrl,
    }));
    const citationBlock = SkillsSubsystem.formatCitations(result);
    const reply = result.answer + citationBlock;
    try {
      await this.memory.logEpisode({
        id: `${traceId}.skill.user`,
        scope: params.scope,
        actor: 'user',
        content: params.text,
      });
      await this.memory.logEpisode({
        id: `${traceId}.skill.reply`,
        scope: params.scope,
        actor: 'assistant',
        content: reply,
      });
      await this.memory.logEpisode({
        id: `${traceId}.skill`,
        scope: params.scope,
        actor: 'assistant',
        content: `skill:${result.skillId} outcome:${result.outcome} goal:${params.command.goal}`,
      });
    } catch (err) {
      await this.safeAudit({
        scope: params.scope,
        kind: 'skill.logEpisode.failed',
        payload: {
          traceId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    await this.safeAudit({
      scope: params.scope,
      kind: 'skill.complete',
      payload: {
        traceId,
        command: params.command.command,
        skillId: result.skillId,
        outcome: result.outcome,
        stepsTotal: result.trace.length,
        stepsSatisfied: result.trace.filter((step) => step.satisfied).length,
        failureReason: result.failureReason,
        citations,
        trace: result.trace.map((step) => ({
          index: step.step.index,
          title: step.step.title,
          satisfied: step.satisfied,
          evidence: step.evidence,
        })),
      },
    });
    return {
      reply,
      citations: citations.length ? citations : undefined,
      trace: {
        goal: params.text,
        startedAt,
        finishedAt: Date.now(),
        nodes: [],
        acceptedPath: [],
        answer: reply,
        tokens: { input: 0, output: 0 },
        latencyMs: Date.now() - startedAt,
        costUsd: 0,
      },
    };
  }

  private async appendTraceSummary(
    summary: Record<string, unknown>,
  ): Promise<void> {
    const tracePath = `${this.auditPath()}.traces.jsonl`;
    try {
      await mkdir(dirname(tracePath), { recursive: true });
      await appendFile(
        tracePath,
        JSON.stringify({ at: Date.now(), ...summary }) + '\n',
        'utf8',
      );
    } catch (err) {
      await this.safeAudit({
        scope: 'trace',
        kind: 'trace.write.failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private auditPath(): string {
    return (this.audit as unknown as { path?: string }).path ?? 'audit.jsonl';
  }
}

function makeLazySecrets(
  factory: AgiRuntimeOptions['secretsFor'],
  id: string,
): { get(key: string): Promise<string | undefined> } {
  let cached: { get(key: string): Promise<string | undefined> } | undefined;
  return {
    get: async (key) => {
      if (!cached) cached = await factory(id);
      return cached.get(key);
    },
  };
}

function previewArgs(args: Record<string, unknown>): string {
  const redacted = redactSecrets(args);
  let s: string;
  try {
    s = JSON.stringify(redacted);
  } catch {
    s = String(redacted);
  }
  return s.length > 500 ? `${s.slice(0, 497)}...` : s;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'integration';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function channelFromSource(source: string | undefined): string {
  const raw = (source || 'cli').split(':')[0]?.trim().toLowerCase() || 'cli';
  return raw.replace(/[^a-z0-9_-]/g, '_').slice(0, 80) || 'cli';
}

function liveProofTagsFor(params: {
  source?: string;
  scope: string;
}): string[] {
  const channel = channelFromSource(params.source);
  return Array.from(
    new Set(
      [
        `channel:${channel}`,
        channel === 'telegram' ? 'telegram_canary' : '',
        params.scope ? 'scope_bound' : '',
        'runtime_spine',
        'truth_calibrated',
      ].filter(Boolean),
    ),
  );
}

function truthView(truth: TruthVerdict): AskTruthView {
  return {
    auditId: truth.audit.auditId,
    status: truth.calibration.status,
    supportGrade: truth.calibration.supportGrade,
    confidence: truth.calibration.confidence,
    flags: truth.calibration.flags,
    summary: truth.summary,
  };
}

function activeResumeToken(
  runtime: AgentRuntimeSpineResult | null,
): string | undefined {
  return runtime?.report.resumeTokens.find((token) => token.status === 'active')
    ?.resumeTokenId;
}

function collectMemoryWrites(value: unknown, out: AskMemoryWriteView[]): void {
  const output =
    value && typeof value === 'object' && 'output' in value
      ? (value as { output?: unknown }).output
      : value;
  if (!output || typeof output !== 'object') return;
  const raw = (output as { memoryWrites?: unknown }).memoryWrites;
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? '').trim();
    if (!id) continue;
    out.push({
      id,
      kind: String(record.kind ?? 'memory'),
      summary: String(record.summary ?? '').slice(0, 300),
    });
  }
}

function safeMemoryScope(value: unknown): string {
  const raw = String(value ?? 'global').trim();
  const normalized = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return normalized || 'global';
}

function worldFactGroupFolder(scope: string): string | null {
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(scope) && scope !== 'global') {
    return scope;
  }
  return null;
}

function normalizeSensitivity(value: unknown): WorldFactSensitivity {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'sensitive') return 'sensitive';
  if (raw === 'personal') return 'personal';
  return 'low';
}

function normalizeConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeFactType(value: unknown, fact: string): WorldFactType {
  const raw = String(value ?? '').toLowerCase();
  const allowed: WorldFactType[] = [
    'person',
    'household',
    'responsibility',
    'active_goal',
    'active_concern',
    'routine',
    'communication_obligation',
    'calendar_pressure',
    'bill',
    'errand',
    'grocery',
    'meal',
    'preference',
    'delegated_default',
    'tool_health',
    'friction_pattern',
  ];
  if (allowed.includes(raw as WorldFactType)) return raw as WorldFactType;
  const lower = fact.toLowerCase();
  if (/\b(like|prefer|favorite|hate|avoid)\b/.test(lower)) return 'preference';
  if (/\b(goal|trying to|working on|project)\b/.test(lower)) {
    return 'active_goal';
  }
  if (/\b(remind|responsible|owns|handle|needs to)\b/.test(lower)) {
    return 'responsibility';
  }
  return 'active_concern';
}

function reviewAfter(
  nowIso: string,
  sensitivity: WorldFactSensitivity,
): string {
  const now = Date.parse(nowIso);
  const days =
    sensitivity === 'sensitive' ? 7 : sensitivity === 'personal' ? 30 : 90;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

function safeJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
