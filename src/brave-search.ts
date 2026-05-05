import { readEnvFile } from './env.js';
import {
  describeProviderTransportFailure,
  providerRequestSignal,
} from './provider-http.js';

const envConfig = readEnvFile([
  'BRAVE_SEARCH_ENABLED',
  'BRAVE_SEARCH_API_KEY',
  'BRACE_SEARCH_API_KEY',
  'BRAVE_SEARCH_BASE_URL',
  'BRAVE_SEARCH_COUNTRY',
  'BRAVE_SEARCH_LANG',
  'BRAVE_SEARCH_SAFESEARCH',
  'BRAVE_SEARCH_COUNT',
]);

export interface BraveSearchConfig {
  apiKey: string;
  baseUrl: string;
  country: string;
  language: string;
  safeSearch: string;
  count: number;
}

export interface BraveSearchStatus {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  baseUrl: string;
  count: number;
  aliasUsed: 'BRAVE_SEARCH_API_KEY' | 'BRACE_SEARCH_API_KEY' | null;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  publishedAt?: string;
  source?: string;
}

export interface BraveSearchResponse {
  query: string;
  results: BraveSearchResult[];
  requestId?: string;
}

export interface BraveSearchFailure {
  providerFailure: string;
  status?: number;
  requestId?: string;
}

function readConfigValue(key: keyof typeof envConfig | string): string {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key] || '';
  }
  return envConfig[key] || '';
}

function resolveApiKey(): {
  key: string;
  aliasUsed: BraveSearchStatus['aliasUsed'];
} {
  const brave = readConfigValue('BRAVE_SEARCH_API_KEY');
  if (brave) return { key: brave, aliasUsed: 'BRAVE_SEARCH_API_KEY' };
  const brace = readConfigValue('BRACE_SEARCH_API_KEY');
  if (brace) return { key: brace, aliasUsed: 'BRACE_SEARCH_API_KEY' };
  return { key: '', aliasUsed: null };
}

function normalizeBaseUrl(value: string): string {
  return (value || 'https://api.search.brave.com/res/v1').replace(/\/+$/g, '');
}

export function resolveBraveSearchConfig(): BraveSearchConfig | null {
  const enabledValue = readConfigValue('BRAVE_SEARCH_ENABLED');
  const enabled =
    enabledValue === ''
      ? Boolean(resolveApiKey().key)
      : enabledValue !== 'false';
  if (!enabled) return null;
  const { key } = resolveApiKey();
  if (!key) return null;
  const count = parseInt(readConfigValue('BRAVE_SEARCH_COUNT') || '5', 10);
  return {
    apiKey: key,
    baseUrl: normalizeBaseUrl(readConfigValue('BRAVE_SEARCH_BASE_URL')),
    country: readConfigValue('BRAVE_SEARCH_COUNTRY') || 'US',
    language: readConfigValue('BRAVE_SEARCH_LANG') || 'en',
    safeSearch: readConfigValue('BRAVE_SEARCH_SAFESEARCH') || 'moderate',
    count: Number.isFinite(count) ? Math.max(1, Math.min(count, 10)) : 5,
  };
}

export function getBraveSearchStatus(): BraveSearchStatus {
  const enabledValue = readConfigValue('BRAVE_SEARCH_ENABLED');
  const { key, aliasUsed } = resolveApiKey();
  const enabled = enabledValue === '' ? Boolean(key) : enabledValue !== 'false';
  return {
    enabled,
    configured: enabled && Boolean(key),
    missing: enabled && !key ? ['BRAVE_SEARCH_API_KEY'] : [],
    baseUrl: normalizeBaseUrl(readConfigValue('BRAVE_SEARCH_BASE_URL')),
    count: parseInt(readConfigValue('BRAVE_SEARCH_COUNT') || '5', 10) || 5,
    aliasUsed,
  };
}

export function describeBraveConfigBlocker(missing: string[]): string {
  if (missing.includes('BRAVE_SEARCH_API_KEY')) {
    return 'Brave Search is not configured. Set BRAVE_SEARCH_API_KEY or the backward-compatible BRACE_SEARCH_API_KEY alias.';
  }
  return 'Brave Search is not configured for this host.';
}

export function describeBraveSearchFailure(
  status: number,
  body: string,
): string {
  const normalized = body.toLowerCase();
  if (status === 401 || status === 403) {
    return 'Brave Search rejected the configured subscription token. Regenerate or replace the Brave Search key, then rerun provider health checks.';
  }
  if (
    status === 429 ||
    normalized.includes('rate') ||
    normalized.includes('quota')
  ) {
    return 'Brave Search rate limit or quota blocked this request. Wait for quota recovery or adjust the Brave Search plan.';
  }
  if (status >= 500) {
    return 'Brave Search returned a server-side error before Andrea could ground the live lookup.';
  }
  return 'Brave Search returned an unexpected error before Andrea could ground the live lookup.';
}

function resultFromRecord(
  record: Record<string, unknown>,
): BraveSearchResult | null {
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const description =
    typeof record.description === 'string'
      ? record.description.trim()
      : typeof record.snippet === 'string'
        ? record.snippet.trim()
        : '';
  if (!title || !url) return null;
  return {
    title,
    url,
    description,
    publishedAt:
      typeof record.age === 'string'
        ? record.age
        : typeof record.page_age === 'string'
          ? record.page_age
          : undefined,
    source: typeof record.profile === 'string' ? record.profile : undefined,
  };
}

export async function searchBraveWeb(
  query: string,
): Promise<BraveSearchResponse | BraveSearchFailure | null> {
  const config = resolveBraveSearchConfig();
  if (!config) return null;
  const url = new URL(`${config.baseUrl}/web/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(config.count));
  url.searchParams.set('country', config.country);
  url.searchParams.set('search_lang', config.language);
  url.searchParams.set('safesearch', config.safeSearch);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.apiKey,
      },
      signal: providerRequestSignal(),
    });
  } catch (err) {
    return {
      providerFailure: describeProviderTransportFailure('Brave Search', err),
    };
  }
  const requestId = response.headers.get('x-request-id') || undefined;
  if (!response.ok) {
    const body = await response.text();
    return {
      providerFailure: describeBraveSearchFailure(response.status, body),
      status: response.status,
      requestId,
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const web = payload.web as Record<string, unknown> | undefined;
  const rawResults = Array.isArray(web?.results) ? web.results : [];
  const results = rawResults
    .map((item) =>
      item && typeof item === 'object'
        ? resultFromRecord(item as Record<string, unknown>)
        : null,
    )
    .filter((item): item is BraveSearchResult => Boolean(item));
  return {
    query,
    results,
    requestId,
  };
}
