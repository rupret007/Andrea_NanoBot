import { getAnthropicProviderStatus } from './anthropic-provider.js';
import { readEnvFile } from './env.js';
import { getGeminiProviderStatus } from './gemini-provider.js';
import { getMiniMaxProviderStatus } from './minimax-provider.js';
import { getOpenAiProviderStatus } from './openai-provider.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';

export interface RuntimeModelProviderSummary {
  providerId:
    | 'openai_cloud'
    | 'anthropic_cloud'
    | 'gemini_cloud'
    | 'minimax_cloud';
  label: string;
  state: ProviderHealthSnapshot['state'];
  models: string[];
  role: string;
}

export interface RuntimeModelInventory {
  defaultModel: string | null;
  providers: RuntimeModelProviderSummary[];
  configuredModelCount: number;
  privacy: {
    credentialsIncluded: false;
    endpointsIncluded: false;
  };
}

interface RuntimeModelStatusInput {
  openai: ReturnType<typeof getOpenAiProviderStatus>;
  anthropic: ReturnType<typeof getAnthropicProviderStatus>;
  gemini: ReturnType<typeof getGeminiProviderStatus>;
  minimax: ReturnType<typeof getMiniMaxProviderStatus>;
}

export interface BuildRuntimeModelInventoryInput {
  statuses?: RuntimeModelStatusInput;
  health?: ProviderHealthSnapshot[];
  defaultModel?: string | null;
  env?: Record<string, string | undefined>;
}

function uniqueModels(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]),
  );
}

function statusState(
  providerId: RuntimeModelProviderSummary['providerId'],
  configured: boolean,
  health: ProviderHealthSnapshot[],
): ProviderHealthSnapshot['state'] {
  if (!configured) return 'not_configured';
  const observed = health.find((item) => item.providerId === providerId);
  if (observed) return observed.state;
  return 'unknown';
}

function readDefaultModel(
  input: BuildRuntimeModelInventoryInput,
  statuses: RuntimeModelStatusInput,
): string | null {
  if (input.defaultModel !== undefined) {
    return input.defaultModel?.trim() || null;
  }
  const fileEnv = readEnvFile([
    'NANOCLAW_AGENT_MODEL',
    'CLAUDE_CODE_MODEL',
    'CLAUDE_MODEL',
  ]);
  const env = input.env || process.env;
  const configured =
    env.NANOCLAW_AGENT_MODEL ||
    env.CLAUDE_CODE_MODEL ||
    env.CLAUDE_MODEL ||
    fileEnv.NANOCLAW_AGENT_MODEL ||
    fileEnv.CLAUDE_CODE_MODEL ||
    fileEnv.CLAUDE_MODEL;
  if (configured?.trim()) return configured.trim();
  if (statuses.minimax.configured) return statuses.minimax.complexModel;
  if (statuses.openai.configured) return statuses.openai.standardModel;
  if (statuses.anthropic.configured) return statuses.anthropic.complexModel;
  if (statuses.gemini.configured) return statuses.gemini.criticModel;
  return null;
}

export function buildRuntimeModelInventory(
  input: BuildRuntimeModelInventoryInput = {},
): RuntimeModelInventory {
  const statuses =
    input.statuses ||
    ({
      openai: getOpenAiProviderStatus(),
      anthropic: getAnthropicProviderStatus(),
      gemini: getGeminiProviderStatus(),
      minimax: getMiniMaxProviderStatus(),
    } satisfies RuntimeModelStatusInput);
  const health = input.health || collectProviderHealthSnapshots();
  const candidates: RuntimeModelProviderSummary[] = [
    {
      providerId: 'minimax_cloud',
      label: 'MiniMax',
      state: statusState('minimax_cloud', statuses.minimax.configured, health),
      models: uniqueModels([
        statuses.minimax.complexModel,
        statuses.minimax.fastModel,
      ]),
      role: 'default conversation and independent council critique',
    },
    {
      providerId: 'openai_cloud',
      label: 'OpenAI',
      state: statusState('openai_cloud', statuses.openai.configured, health),
      models: uniqueModels([
        statuses.openai.simpleModel,
        statuses.openai.standardModel,
        statuses.openai.complexModel,
        statuses.openai.researchModel,
      ]),
      role: 'planning, general assistance, coding, and verifier fallback',
    },
    {
      providerId: 'anthropic_cloud',
      label: 'Anthropic',
      state: statusState(
        'anthropic_cloud',
        statuses.anthropic.configured,
        health,
      ),
      models: uniqueModels([
        statuses.anthropic.complexModel,
        statuses.anthropic.fastModel,
      ]),
      role: 'independent deep reasoning and council review',
    },
    {
      providerId: 'gemini_cloud',
      label: 'Google Gemini',
      state: statusState('gemini_cloud', statuses.gemini.configured, health),
      models: uniqueModels([
        statuses.gemini.criticModel,
        statuses.gemini.fastModel,
      ]),
      role: 'independent verification and fast fallback',
    },
  ];
  const providers = candidates.filter(
    (provider) => provider.state !== 'not_configured',
  );

  return {
    defaultModel: readDefaultModel(input, statuses),
    providers,
    configuredModelCount: new Set(
      providers.flatMap((provider) => provider.models),
    ).size,
    privacy: {
      credentialsIncluded: false,
      endpointsIncluded: false,
    },
  };
}

function formatProvider(provider: RuntimeModelProviderSummary): string {
  const health = provider.state === 'healthy' ? '' : ` (${provider.state})`;
  return `${provider.label}${health}: ${provider.models.join(', ')}`;
}

export function formatRuntimeModelInventoryReply(
  inventory = buildRuntimeModelInventory(),
): string {
  if (inventory.providers.length === 0) {
    return "I don't have a configured model provider available right now. I can still use deterministic local capabilities, but I should not claim a live LLM until provider health recovers.";
  }
  const defaultDescription = inventory.defaultModel
    ? `My normal conversational worker currently defaults to ${inventory.defaultModel}.`
    : 'My default conversational worker is selected from the currently healthy routes.';
  return [
    "I don't run on only one LLM.",
    defaultDescription,
    `Configured model lanes: ${inventory.providers.map(formatProvider).join('; ')}.`,
    'I normally use one suitable model for an ordinary reply. I use multiple providers together only for deep, ambiguous, or high-risk council work.',
  ].join(' ');
}

export function formatChineseModelInventoryReply(
  inventory = buildRuntimeModelInventory(),
): string {
  const minimax = inventory.providers.find(
    (provider) => provider.providerId === 'minimax_cloud',
  );
  if (!minimax) {
    return "I don't have a currently configured Chinese-model provider, so I should not claim one is available.";
  }
  const health = minimax.state === 'healthy' ? '' : ` It is ${minimax.state}.`;
  const defaultUse =
    inventory.defaultModel && minimax.models.includes(inventory.defaultModel)
      ? ` ${inventory.defaultModel} is also my current default conversational worker.`
      : '';
  return `The Chinese-model integration is MiniMax. The configured MiniMax models are ${minimax.models.join(' and ')}.${defaultUse}${health}`.trim();
}
