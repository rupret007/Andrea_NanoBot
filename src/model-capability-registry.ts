import type { ModelSpec } from './models/router.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import {
  listAssistantMetricEvents,
  updateAssistantMetricEventMetadata,
} from './db.js';

export type ModelTaskClass =
  | 'ordinary_assistance'
  | 'deep_work'
  | 'research'
  | 'high_risk_planning';

export interface ModelCapabilityRecord extends ModelSpec {
  source: 'default' | 'configured' | 'operator_override';
  health: 'unknown' | 'healthy' | 'degraded' | 'blocked';
}

export interface RoutingEvaluationCase {
  caseId: string;
  taskClass: ModelTaskClass;
  promptSummary: string;
  requiredCapabilities: ModelSpec['capabilities'];
  requiresCouncil: boolean;
  containsRawUserText: false;
}

const CONFIGURED_MODELS: Array<{
  key: string;
  provider: ModelSpec['provider'];
}> = [
  { key: 'OPENAI_MODEL_SIMPLE', provider: 'openai' },
  { key: 'OPENAI_MODEL_STANDARD', provider: 'openai' },
  { key: 'OPENAI_MODEL_COMPLEX', provider: 'openai' },
  { key: 'OPENAI_MODEL_FALLBACK', provider: 'openai' },
  { key: 'ANTHROPIC_MODEL_FAST', provider: 'anthropic' },
  { key: 'ANTHROPIC_MODEL_COMPLEX', provider: 'anthropic' },
  { key: 'ANTHROPIC_MODEL', provider: 'anthropic' },
  { key: 'GEMINI_MODEL_FAST', provider: 'google' },
  { key: 'GEMINI_MODEL_CRITIC', provider: 'google' },
  { key: 'OLLAMA_MODEL', provider: 'local' },
];

function cloneForId(
  id: string,
  provider: ModelSpec['provider'],
  catalog: ModelSpec[],
): ModelSpec | null {
  const exact = catalog.find((model) => model.id === id);
  if (exact) return { ...exact };
  const template = catalog.find((model) => model.provider === provider);
  if (!template) return null;
  return {
    ...template,
    id,
    family: id.split(/[-:/]/).slice(0, 2).join('-') || template.family,
    available: false,
    checkedAt: undefined,
  };
}

export function buildConfiguredModelCatalog(
  baseCatalog: ModelSpec[],
  env: Record<string, string | undefined> = process.env,
): ModelSpec[] {
  const byId = new Map(baseCatalog.map((model) => [model.id, { ...model }]));
  for (const configured of CONFIGURED_MODELS) {
    const id = env[configured.key]?.trim();
    if (!id || byId.has(id)) continue;
    const model = cloneForId(id, configured.provider, baseCatalog);
    if (model) byId.set(id, model);
  }
  return [...byId.values()];
}

export function buildModelCapabilityRegistry(params: {
  catalog: ModelSpec[];
  env?: Record<string, string | undefined>;
  health?: Record<string, ModelCapabilityRecord['health']>;
}): ModelCapabilityRecord[] {
  const configuredIds = new Set(
    CONFIGURED_MODELS.map((item) => params.env?.[item.key]?.trim()).filter(
      Boolean,
    ),
  );
  return buildConfiguredModelCatalog(params.catalog, params.env).map(
    (model) => ({
      ...model,
      source: configuredIds.has(model.id) ? 'configured' : 'default',
      health:
        params.health?.[model.id] || (model.available ? 'healthy' : 'unknown'),
    }),
  );
}

export function rankModelsForTask(
  records: ModelCapabilityRecord[],
  taskClass: ModelTaskClass,
): ModelCapabilityRecord[] {
  const required: ModelSpec['capabilities'] =
    taskClass === 'ordinary_assistance'
      ? ['tool_use', 'low_latency']
      : taskClass === 'deep_work'
        ? ['tool_use', 'code', 'long_context']
        : taskClass === 'research'
          ? ['tool_use', 'long_context']
          : ['tool_use', 'json_mode', 'voting'];
  return records
    .filter(
      (record) =>
        record.health !== 'blocked' &&
        required.every((capability) =>
          record.capabilities.includes(capability),
        ),
    )
    .sort((left, right) => {
      const health = { healthy: 3, unknown: 2, degraded: 1, blocked: 0 };
      const quality = (model: ModelCapabilityRecord) =>
        health[model.health] * 100 +
        model.capabilities.length * 4 -
        model.p50LatencyMs / (taskClass === 'ordinary_assistance' ? 50 : 250) -
        model.costOutUsdPerMTok / 5;
      return quality(right) - quality(left);
    });
}

export const GROUNDED_AGENCY_EVALUATION_CASES: RoutingEvaluationCase[] = [
  ...Array.from({ length: 4 }, (_, index) => ({
    caseId: `daily-${index + 1}`,
    taskClass: 'ordinary_assistance' as const,
    promptSummary: `Redacted daily-assistant case ${index + 1}`,
    requiredCapabilities: [
      'tool_use',
      'low_latency',
    ] as ModelSpec['capabilities'],
    requiresCouncil: false,
    containsRawUserText: false as const,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    caseId: `coding-${index + 1}`,
    taskClass: 'deep_work' as const,
    promptSummary: `Redacted repository mission case ${index + 1}`,
    requiredCapabilities: [
      'tool_use',
      'code',
      'long_context',
    ] as ModelSpec['capabilities'],
    requiresCouncil: false,
    containsRawUserText: false as const,
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    caseId: `research-${index + 1}`,
    taskClass: 'research' as const,
    promptSummary: `Redacted cited-research case ${index + 1}`,
    requiredCapabilities: [
      'tool_use',
      'long_context',
    ] as ModelSpec['capabilities'],
    requiresCouncil: false,
    containsRawUserText: false as const,
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    caseId: `risk-${index + 1}`,
    taskClass: 'high_risk_planning' as const,
    promptSummary: `Redacted high-risk planning case ${index + 1}`,
    requiredCapabilities: [
      'tool_use',
      'json_mode',
      'voting',
    ] as ModelSpec['capabilities'],
    requiresCouncil: true,
    containsRawUserText: false as const,
  })),
];

export class LiveRoutingEvaluationBudget {
  private spentUsd = 0;

  constructor(readonly capUsd = 25) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error('Live routing evaluation requires a positive cost cap.');
    }
  }

  reserve(estimatedCostUsd: number): void {
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
      throw new Error('Estimated live evaluation cost must be non-negative.');
    }
    if (this.spentUsd + estimatedCostUsd > this.capUsd) {
      throw new Error(
        `Live routing evaluation cost cap would be exceeded (${this.spentUsd.toFixed(4)} + ${estimatedCostUsd.toFixed(4)} > ${this.capUsd.toFixed(4)}).`,
      );
    }
    this.spentUsd = Number((this.spentUsd + estimatedCostUsd).toFixed(6));
  }

  canReserve(estimatedCostUsd: number): boolean {
    return (
      Number.isFinite(estimatedCostUsd) &&
      estimatedCostUsd >= 0 &&
      this.spentUsd + estimatedCostUsd <= this.capUsd
    );
  }

  get spent(): number {
    return this.spentUsd;
  }
}

export function recordLiveRoutingEvaluation(params: {
  groupFolder: string;
  budget: LiveRoutingEvaluationBudget;
  caseId: string;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  outcome: 'structural_pass' | 'partial' | 'failed' | 'blocked';
  evidenceCoverage: number;
  toolCorrect: boolean;
  inputTokens?: number;
  outputTokens?: number;
  now?: Date;
}): void {
  if (
    !GROUNDED_AGENCY_EVALUATION_CASES.some(
      (item) => item.caseId === params.caseId,
    )
  ) {
    throw new Error(
      `Unknown grounded-agency evaluation case ${params.caseId}.`,
    );
  }
  params.budget.reserve(params.costUsd);
  const metadata = {
    caseId: params.caseId,
    provider: params.provider,
    model: params.model,
    outcome: params.outcome,
    evidenceCoverage: Math.max(0, Math.min(1, params.evidenceCoverage)),
    toolCorrect: params.toolCorrect,
    inputTokens: params.inputTokens || 0,
    outputTokens: params.outputTokens || 0,
  };
  recordAssistantMetric({
    groupFolder: params.groupFolder,
    kind: 'latency_sample',
    value: Math.max(0, params.latencyMs),
    metadata,
    now: params.now,
  });
  recordAssistantMetric({
    groupFolder: params.groupFolder,
    kind: 'live_eval_cost',
    value: params.costUsd,
    metadata,
    now: params.now,
  });
  recordAssistantMetric({
    groupFolder: params.groupFolder,
    kind: 'tool_attempt',
    metadata,
    now: params.now,
  });
  if (params.toolCorrect) {
    recordAssistantMetric({
      groupFolder: params.groupFolder,
      kind: 'tool_success',
      metadata,
      now: params.now,
    });
  }
}

export function repairGroundedAgencyOutcomeLabels(groupFolder: string): number {
  let repaired = 0;
  for (const event of listAssistantMetricEvents({
    groupFolder,
    limit: 10_000,
  })) {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(event.metadataJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof metadata.caseId !== 'string' ||
      !GROUNDED_AGENCY_EVALUATION_CASES.some(
        (item) => item.caseId === metadata.caseId,
      ) ||
      metadata.outcome !== 'verified'
    ) {
      continue;
    }
    metadata.outcome = 'structural_pass';
    updateAssistantMetricEventMetadata(event.eventId, JSON.stringify(metadata));
    repaired += 1;
  }
  return repaired;
}
