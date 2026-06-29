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

export interface AskResult {
  reply: string;
  trace: CognitiveResult['trace'];
  pendingActions?: PendingActionView[];
  citations?: AskCitation[];
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
        failed: true,
      };
    }

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
        content: result.answer,
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
      reply: result.answer,
      trace: result.trace,
      pendingActions: pendingActions.length ? pendingActions : undefined,
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
