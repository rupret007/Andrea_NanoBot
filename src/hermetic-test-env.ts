const TEST_NETWORK_GUARD_URL = new URL(
  '../scripts/test-network-guard.mjs',
  import.meta.url,
).href;

const PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_',
  'BEDROCK_',
  'BRACE_',
  'BRAVE_',
  'CLAUDE_',
  'CLAUDE_CODE_',
  'CODEX_',
  'COHERE_',
  'CURSOR_',
  'DEEPSEEK_',
  'EXA_',
  'FIREWORKS_',
  'GEMINI_',
  'GOOGLE_',
  'GROQ_',
  'HUGGINGFACE_',
  'LMSTUDIO_',
  'MINIMAX_',
  'MISTRAL_',
  'OLLAMA_',
  'ONECLI_',
  'OPENAI_',
  'OPENROUTER_',
  'PERPLEXITY_',
  'REPLICATE_',
  'SERPER_',
  'TAVILY_',
  'TOGETHER_',
  'VERTEX_AI_',
  'VLLM_',
  'VOYAGE_',
  'XAI_',
] as const;

const PROVIDER_ENV_EXACT_KEYS = new Set([
  'ANDREA_OPENAI_BACKEND_ENABLED',
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'NANOCLAW_AGENT_MODEL',
]);

const CREDENTIAL_ENV_SUFFIX =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|TOKEN|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/;

const ENDPOINT_ENV_SUFFIX =
  /(?:^|_)(?:BASE_URL|ENDPOINT|ENDPOINT_URL|API_URL)$/;

const LIVE_EVALUATION_ENV_KEY =
  /(?:^|_)(?:LIVE|NETWORKED)(?:_|$)|^ANDREA_EVALUATION(?:_|$)|(?:^|_)(?:EVALUATION|SCORECARD|BENCHMARK|COUNCIL|PROVIDER)_(?:MODE|ORIGIN)$/;

const PROXY_ENV_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

const FORCED_TEST_ENV_KEYS = new Set([
  'ANDREA_DETERMINISTIC_STORAGE_MODE',
  'ANDREA_EVALUATION_ORIGIN',
  'ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE',
  'NODE_OPTIONS',
]);

const SAFE_NODE_OPTION_TOKENS = new Set([
  '--enable-source-maps',
  '--no-warnings',
  '--trace-warnings',
  '--unhandled-rejections=strict',
]);

function isUnsafeInheritedTestSetting(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    FORCED_TEST_ENV_KEYS.has(normalizedKey) ||
    PROVIDER_ENV_EXACT_KEYS.has(normalizedKey) ||
    PROXY_ENV_KEYS.has(normalizedKey) ||
    PROVIDER_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix)) ||
    CREDENTIAL_ENV_SUFFIX.test(normalizedKey) ||
    ENDPOINT_ENV_SUFFIX.test(normalizedKey) ||
    LIVE_EVALUATION_ENV_KEY.test(normalizedKey)
  );
}

export function withTestNetworkGuard(
  nodeOptions = '',
  networkGuardUrl = TEST_NETWORK_GUARD_URL,
): string {
  const preload = `--import=${networkGuardUrl}`;
  const existingOptions = nodeOptions
    .trim()
    .split(/\s+/)
    .filter((option) => SAFE_NODE_OPTION_TOKENS.has(option));
  return [...existingOptions, preload].join(' ');
}

export function buildHermeticTestEnv(
  environment: NodeJS.ProcessEnv = process.env,
  options: { isolateStorage?: boolean } = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!isUnsafeInheritedTestSetting(key)) {
      result[key] = value;
    }
  }
  Object.assign(result, {
    ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE: '1',
    ANDREA_EVALUATION_ORIGIN: 'synthetic',
    NODE_OPTIONS: withTestNetworkGuard(environment.NODE_OPTIONS),
  });
  if (options.isolateStorage !== false) {
    result.ANDREA_DETERMINISTIC_STORAGE_MODE = 'memory';
  } else {
    delete result.ANDREA_DETERMINISTIC_STORAGE_MODE;
  }
  return result;
}
