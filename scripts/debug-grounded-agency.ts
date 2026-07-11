import { pathToFileURL } from 'node:url';

import {
  getAnthropicProviderStatus,
  runAnthropicText,
} from '../src/anthropic-provider.js';
import { initDatabase } from '../src/db.js';
import {
  getGeminiProviderStatus,
  runGeminiOpenAiText,
} from '../src/gemini-provider.js';
import {
  buildModelCapabilityRegistry,
  GROUNDED_AGENCY_EVALUATION_CASES,
  LiveRoutingEvaluationBudget,
  recordLiveRoutingEvaluation,
  repairGroundedAgencyOutcomeLabels,
} from '../src/model-capability-registry.js';
import { DEFAULT_CATALOG } from '../src/models/router.js';
import {
  getOpenAiProviderStatus,
  runOpenAiChatText,
} from '../src/openai-provider.js';

function readValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function structuralCoverage(text: string): number {
  const signals = ['evidence', 'uncertainty', 'action', 'verdict'];
  return Number(
    (
      signals.filter((signal) => text.toLowerCase().includes(signal)).length /
      signals.length
    ).toFixed(2),
  );
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const maxCostUsd = Number(readValue('--max-cost-usd') || '0');
  const groupFolder = readValue('--group') || 'main';
  const repairLabelsOnly = process.argv.includes('--repair-labels-only');
  if (repairLabelsOnly) {
    initDatabase();
    console.log(
      JSON.stringify({
        repaired: repairGroundedAgencyOutcomeLabels(groupFolder),
        replacement: 'structural_pass',
      }),
    );
    return;
  }
  if (live && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new Error(
      'Live grounded-agency evaluation requires --max-cost-usd=<positive>.',
    );
  }
  const statuses = {
    openai: getOpenAiProviderStatus(),
    anthropic: getAnthropicProviderStatus(),
    google: getGeminiProviderStatus(),
  };
  const health: Record<string, 'healthy' | 'unknown' | 'blocked'> = {};
  for (const model of DEFAULT_CATALOG) {
    const status =
      model.provider === 'openai'
        ? statuses.openai
        : model.provider === 'anthropic'
          ? statuses.anthropic
          : model.provider === 'google'
            ? statuses.google
            : null;
    health[model.id] = status
      ? status.configured
        ? 'unknown'
        : 'blocked'
      : 'unknown';
  }
  const configuredEnv = {
    ...process.env,
    OPENAI_MODEL_SIMPLE: statuses.openai.simpleModel,
    OPENAI_MODEL_STANDARD: statuses.openai.standardModel,
    OPENAI_MODEL_COMPLEX: statuses.openai.complexModel,
    OPENAI_MODEL_FALLBACK: statuses.openai.complexModel,
    ANTHROPIC_MODEL_FAST: statuses.anthropic.fastModel,
    ANTHROPIC_MODEL_COMPLEX: statuses.anthropic.complexModel,
    GEMINI_MODEL_FAST: statuses.google.fastModel,
    GEMINI_MODEL_CRITIC: statuses.google.criticModel,
  };
  const registry = buildModelCapabilityRegistry({
    catalog: DEFAULT_CATALOG,
    env: configuredEnv,
    health,
  });
  if (!live) {
    console.log(
      JSON.stringify(
        {
          mode: 'deterministic',
          cases: GROUNDED_AGENCY_EVALUATION_CASES,
          registry: registry.map((model) => ({
            id: model.id,
            provider: model.provider,
            source: model.source,
            health: model.health,
            capabilities: model.capabilities,
          })),
          privacy: { rawUserTextIncluded: false },
          estimatedCostUsd: 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  initDatabase();
  repairGroundedAgencyOutcomeLabels(groupFolder);
  const budget = new LiveRoutingEvaluationBudget(maxCostUsd);
  const providers = [
    statuses.openai.configured ? 'openai' : null,
    statuses.anthropic.configured ? 'anthropic' : null,
    statuses.google.configured ? 'google' : null,
  ].filter(Boolean) as Array<'openai' | 'anthropic' | 'google'>;
  if (providers.length === 0)
    throw new Error('No live evaluation provider is configured.');
  const results: Array<Record<string, unknown>> = [];
  for (const [
    index,
    evaluationCase,
  ] of GROUNDED_AGENCY_EVALUATION_CASES.entries()) {
    const provider = providers[index % providers.length]!;
    const model =
      provider === 'openai'
        ? statuses.openai.complexModel
        : provider === 'anthropic'
          ? statuses.anthropic.complexModel
          : statuses.google.criticModel;
    const catalogModel = registry.find((item) => item.id === model);
    const providerOutputBudget =
      provider === 'google' ? 2048 : provider === 'anthropic' ? 1536 : 220;
    const estimatedCostUsd = Number(
      (
        ((catalogModel?.costInUsdPerMTok || 10) * 180 +
          (catalogModel?.costOutUsdPerMTok || 40) * providerOutputBudget) /
        1_000_000
      ).toFixed(6),
    );
    if (!budget.canReserve(estimatedCostUsd)) break;
    const prompt = [
      evaluationCase.promptSummary,
      'Return a concise JSON object with verdict, evidence, uncertainty, and action.',
      'Do not request tools, use private data, or perform an external action.',
    ].join(' ');
    const started = Date.now();
    const response =
      provider === 'openai'
        ? await runOpenAiChatText({
            prompt,
            modelTier: 'complex',
            maxTokens: 220,
          })
        : provider === 'anthropic'
          ? await runAnthropicText({
              prompt,
              modelTier: 'complex',
              maxTokens: 220,
            })
          : await runGeminiOpenAiText({
              prompt,
              modelTier: 'critic',
              maxTokens: 220,
            });
    const latencyMs = Date.now() - started;
    const failed =
      !response ||
      ('providerFailure' in response && Boolean(response.providerFailure));
    const text = !failed && response && 'text' in response ? response.text : '';
    const inputTokens =
      !failed && response && 'inputTokens' in response
        ? response.inputTokens || 0
        : 0;
    const outputTokens =
      !failed && response && 'outputTokens' in response
        ? response.outputTokens || 0
        : 0;
    const evidenceCoverage = structuralCoverage(text);
    recordLiveRoutingEvaluation({
      groupFolder,
      budget,
      caseId: evaluationCase.caseId,
      provider,
      model,
      latencyMs,
      costUsd: estimatedCostUsd,
      outcome: failed
        ? 'blocked'
        : evidenceCoverage >= 0.75
          ? 'structural_pass'
          : 'partial',
      evidenceCoverage,
      toolCorrect: !failed,
      inputTokens,
      outputTokens,
    });
    results.push({
      caseId: evaluationCase.caseId,
      provider,
      model,
      latencyMs,
      estimatedCostUsd,
      outcome: failed
        ? 'blocked'
        : evidenceCoverage >= 0.75
          ? 'structural_pass'
          : 'partial',
      evidenceCoverage,
      inputTokens,
      outputTokens,
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: 'live',
        terminal: 'completed',
        evaluated: results.length,
        requiredCases: GROUNDED_AGENCY_EVALUATION_CASES.length,
        spentUsd: budget.spent,
        maxCostUsd,
        complete: results.length === GROUNDED_AGENCY_EVALUATION_CASES.length,
        results,
        privacy: { rawUserTextIncluded: false, rawProviderOutputStored: false },
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
