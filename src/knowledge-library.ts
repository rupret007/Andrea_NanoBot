import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  disableKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeChunksForSource,
  listKnowledgeSourcesByIds,
  listKnowledgeSourcesForGroup,
  markKnowledgeSourceDeleted,
  replaceKnowledgeSourceChunks,
  searchKnowledgeChunks,
  touchKnowledgeSourcesLastUsed,
  upsertKnowledgeSource,
} from './db.js';
import { logger } from './logger.js';
import type {
  KnowledgeChunkRecord,
  KnowledgeIndexState,
  KnowledgeRetrievalHit,
  KnowledgeScope,
  KnowledgeSensitivity,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

const MAX_DIRECT_TEXT_CHARS = 60_000;
const MAX_FILE_BYTES = 512 * 1024;
const CHUNK_TARGET_CHARS = 700;
const CHUNK_MIN_CHARS = 180;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.yaml',
  '.yml',
  '.rst',
]);

const KNOWLEDGE_STOPWORDS = new Set([
  'a',
  'about',
  'already',
  'am',
  'and',
  'are',
  'at',
  'combine',
  'did',
  'do',
  'for',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'library',
  'material',
  'me',
  'my',
  'notes',
  'of',
  'on',
  'only',
  'outside',
  'saved',
  'say',
  'show',
  'sources',
  'summarize',
  'summarise',
  'that',
  'the',
  'this',
  'to',
  'use',
  'using',
  'what',
  'with',
]);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*\S+/i,
  /\bsk-[a-z0-9_-]{20,}\b/i,
];

export interface SaveKnowledgeSourceRequest {
  groupFolder: string;
  title?: string;
  shortSummary?: string;
  content: string;
  sourceType: KnowledgeSourceType;
  scope?: KnowledgeScope;
  sensitivity?: KnowledgeSensitivity;
  tags?: string[];
  sourceChannel?: KnowledgeSourceRecord['sourceChannel'];
  contentRef?: string | null;
  sourceId?: string;
  now?: Date;
}

export interface SaveKnowledgeSourceResult {
  ok: boolean;
  source?: KnowledgeSourceRecord;
  chunkCount?: number;
  message: string;
  debugPath: string[];
}

export interface ImportKnowledgeFileRequest {
  groupFolder: string;
  filePath: string;
  title?: string;
  tags?: string[];
  scope?: KnowledgeScope;
  sensitivity?: KnowledgeSensitivity;
  sourceType?: Extract<
    KnowledgeSourceType,
    'uploaded_document' | 'imported_summary'
  >;
  sourceChannel?: KnowledgeSourceRecord['sourceChannel'];
  sourceId?: string;
  now?: Date;
}

export interface KnowledgeSearchResult {
  query: string;
  normalizedQuery: string;
  hits: KnowledgeRetrievalHit[];
  sources: KnowledgeSourceRecord[];
  debugPath: string[];
}

function normalizeKnowledgeText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function deriveSummary(text: string): string {
  const sentence = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!sentence) {
    return text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text;
  }
  return sentence.length > 180
    ? `${sentence.slice(0, 177).trimEnd()}...`
    : sentence;
}

function deriveTitle(text: string, fallback = 'Saved Library Note'): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  const withoutHeading = firstLine.replace(/^#+\s*/, '').trim();
  if (!withoutHeading) return fallback;
  return withoutHeading.length > 80
    ? `${withoutHeading.slice(0, 77).trimEnd()}...`
    : withoutHeading;
}

function inferScope(text: string): KnowledgeScope {
  const lower = text.toLowerCase();
  if (/\b(candace|family|house|home|household|kids|band)\b/.test(lower)) {
    return 'household';
  }
  if (/\b(repo|project|runtime|work|client|meeting|launch)\b/.test(lower)) {
    return 'work';
  }
  if (/\b(family and work|home and work|mixed)\b/.test(lower)) {
    return 'mixed';
  }
  return 'personal';
}

function detectSecretLikeContent(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return 'That looks like secrets or credentials, so I will not index it as library material.';
    }
  }
  return null;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(
    0,
    8,
  );
}

function splitOversizedParagraph(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_TARGET_CHARS) return [paragraph];
  const sentenceParts = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentenceParts.length <= 1) {
    const chunks: string[] = [];
    let index = 0;
    while (index < paragraph.length) {
      chunks.push(paragraph.slice(index, index + CHUNK_TARGET_CHARS).trim());
      index += CHUNK_TARGET_CHARS;
    }
    return chunks.filter(Boolean);
  }
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentenceParts) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > CHUNK_TARGET_CHARS && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

function buildKnowledgeChunkRecords(
  sourceId: string,
  normalizedText: string,
  createdAt: string,
): KnowledgeChunkRecord[] {
  const paragraphs = normalizedText
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => splitOversizedParagraph(part));

  if (paragraphs.length === 0) {
    return [
      {
        chunkId: crypto.randomUUID(),
        sourceId,
        chunkIndex: 0,
        chunkText: normalizedText,
        charLength: normalizedText.length,
        createdAt,
      },
    ];
  }

  const chunkTexts: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (
      candidate.length > CHUNK_TARGET_CHARS &&
      current.length >= CHUNK_MIN_CHARS
    ) {
      chunkTexts.push(current.trim());
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    chunkTexts.push(current.trim());
  }

  return chunkTexts.map((chunkText, index) => ({
    chunkId: crypto.randomUUID(),
    sourceId,
    chunkIndex: index,
    chunkText,
    charLength: chunkText.length,
    createdAt,
  }));
}

function buildLexicalMatchQuery(query: string): string {
  const tokens = normalizeVoicePrompt(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !KNOWLEDGE_STOPWORDS.has(token))
    .slice(0, 8);
  return [...new Set(tokens)].map((token) => `${token}*`).join(' OR ');
}

function buildFallbackHitsFromSources(
  sources: KnowledgeSourceRecord[],
): KnowledgeRetrievalHit[] {
  return sources
    .slice(0, 5)
    .map((source) => {
      const firstChunk = listKnowledgeChunksForSource(source.sourceId)[0];
      const excerpt =
        firstChunk?.chunkText || source.shortSummary || source.title;
      return {
        sourceId: source.sourceId,
        sourceTitle: source.title,
        sourceType: source.sourceType,
        scope: source.scope,
        sensitivity: source.sensitivity,
        chunkId: firstChunk?.chunkId || `${source.sourceId}:summary`,
        chunkIndex: firstChunk?.chunkIndex || 0,
        excerpt:
          excerpt.length > 240
            ? `${excerpt.slice(0, 237).trimEnd()}...`
            : excerpt,
        retrievalScore: 0.35,
        matchReason: 'matched recent saved source',
        tags: source.tags,
      };
    })
    .filter((hit) => Boolean(hit.excerpt));
}

export function extractKnowledgeTopicQuery(text: string): string {
  const normalized = normalizeVoicePrompt(text).trim();
  if (!normalized) return '';

  const stripped = normalized
    .replace(
      /^(?:save (?:this|that|this note|that note|this result|that result|this summary|that summary) to my library(?: as .+)?)$/i,
      '',
    )
    .replace(
      /^(?:what do my saved notes say about|what did i save about|summari[sz]e what i saved about|what do i already know about|what sources are you using (?:about|for)|show me the relevant saved items (?:about|for)|compare these saved sources about|use only my saved material for|combine my notes with outside research on)\s+/i,
      '',
    )
    .replace(
      /^(?:save file|add file|import file|index file)\s+["“]?(.+?)["”]?\s+to my library.*$/i,
      '$1',
    )
    .trim();

  return stripped || normalized;
}

export function isSupportedKnowledgeFilePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.has(ext);
}

function readKnowledgeFile(filePath: string): {
  normalizedText: string;
  contentRef: string;
  title: string;
} {
  const resolved = path.resolve(filePath);
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) {
    throw new Error('That path is not a file.');
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(
      `That file is too large for the bounded library path (${stats.size} bytes).`,
    );
  }
  if (!isSupportedKnowledgeFilePath(resolved)) {
    throw new Error(
      'That file type is not supported for library indexing yet. Use plain text, Markdown, JSON, CSV, YAML, or logs.',
    );
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const normalizedText = normalizeKnowledgeText(raw);
  if (!normalizedText) {
    throw new Error('That file did not contain any readable text to index.');
  }
  return {
    normalizedText,
    contentRef: resolved,
    title: path.basename(resolved),
  };
}

export function saveKnowledgeSource(
  request: SaveKnowledgeSourceRequest,
): SaveKnowledgeSourceResult {
  const normalizedText = normalizeKnowledgeText(request.content);
  if (!normalizedText) {
    return {
      ok: false,
      message: 'I need some actual text before I can save a library source.',
      debugPath: ['knowledge.save:empty_content'],
    };
  }
  if (normalizedText.length > MAX_DIRECT_TEXT_CHARS) {
    return {
      ok: false,
      message:
        'That text is too large for the bounded library path. Save a smaller summary or import a supported local file instead.',
      debugPath: ['knowledge.save:content_too_large'],
    };
  }
  const secretBlocker = detectSecretLikeContent(normalizedText);
  if (secretBlocker) {
    return {
      ok: false,
      message: secretBlocker,
      debugPath: ['knowledge.save:secret_like_content'],
    };
  }

  const now = request.now || new Date();
  const timestamp = now.toISOString();
  const sourceId = request.sourceId || crypto.randomUUID();
  const title = (request.title || deriveTitle(normalizedText)).trim();
  const source: KnowledgeSourceRecord = {
    sourceId,
    groupFolder: request.groupFolder,
    sourceType: request.sourceType,
    title,
    shortSummary: (
      request.shortSummary || deriveSummary(normalizedText)
    ).trim(),
    contentRef: request.contentRef || null,
    normalizedText,
    tags: normalizeTags(request.tags),
    scope: request.scope || inferScope(`${title}\n${normalizedText}`),
    sensitivity:
      request.sensitivity || (request.contentRef ? 'private' : 'normal'),
    ingestionState: 'ready',
    indexState: 'pending',
    sourceChannel: request.sourceChannel || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: null,
    disabledAt: null,
    deletedAt: null,
  };

  try {
    upsertKnowledgeSource(source);
    const chunks = buildKnowledgeChunkRecords(
      source.sourceId,
      source.normalizedText,
      timestamp,
    );
    replaceKnowledgeSourceChunks(source.sourceId, source, chunks);
    const saved = getKnowledgeSource(source.sourceId) || {
      ...source,
      indexState: 'indexed' as KnowledgeIndexState,
    };
    return {
      ok: true,
      source: saved,
      chunkCount: chunks.length,
      message: `Saved "${saved.title}" to your library.`,
      debugPath: [
        `knowledge.save:source=${saved.sourceId}`,
        `knowledge.save:chunks=${chunks.length}`,
      ],
    };
  } catch (err) {
    logger.warn({ err, sourceId }, 'Knowledge source save failed');
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'I ran into an error while saving that library source.',
      debugPath: ['knowledge.save:exception'],
    };
  }
}

export function importKnowledgeFile(
  request: ImportKnowledgeFileRequest,
): SaveKnowledgeSourceResult {
  try {
    const file = readKnowledgeFile(request.filePath);
    return saveKnowledgeSource({
      groupFolder: request.groupFolder,
      title: request.title || file.title,
      content: file.normalizedText,
      sourceType: request.sourceType || 'uploaded_document',
      scope: request.scope,
      sensitivity: request.sensitivity || 'private',
      tags: request.tags,
      sourceChannel: request.sourceChannel,
      contentRef: file.contentRef,
      sourceId: request.sourceId,
      now: request.now,
    });
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'I could not read that file for the Knowledge Library.',
      debugPath: ['knowledge.import_file:failed'],
    };
  }
}

export function searchKnowledgeLibrary(params: {
  groupFolder: string;
  query: string;
  requestedSourceIds?: string[];
  limit?: number;
}): KnowledgeSearchResult {
  const normalizedQuery = extractKnowledgeTopicQuery(params.query);
  const matchQuery = buildLexicalMatchQuery(normalizedQuery);
  let hits: KnowledgeRetrievalHit[] = [];
  const debugPath = [`knowledge.search:query=${normalizedQuery || '(empty)'}`];

  if (matchQuery) {
    hits = searchKnowledgeChunks({
      groupFolder: params.groupFolder,
      matchQuery,
      requestedSourceIds: params.requestedSourceIds,
      limit: params.limit,
    });
    debugPath.push(`knowledge.search:match_query=${matchQuery}`);
  } else {
    debugPath.push('knowledge.search:match_query=none');
  }

  let sources =
    hits.length > 0
      ? listKnowledgeSourcesByIds(params.groupFolder, [
          ...new Set(hits.map((hit) => hit.sourceId)),
        ])
      : [];

  if (hits.length === 0) {
    sources = params.requestedSourceIds?.length
      ? listKnowledgeSourcesByIds(params.groupFolder, params.requestedSourceIds)
      : listKnowledgeSourcesForGroup(params.groupFolder, {
          limit: params.limit || 5,
          query: normalizedQuery || undefined,
        });
    hits = buildFallbackHitsFromSources(sources);
    debugPath.push('knowledge.search:fallback=recent_sources');
  } else {
    debugPath.push(`knowledge.search:hits=${hits.length}`);
  }

  if (sources.length > 0) {
    touchKnowledgeSourcesLastUsed(
      sources.map((source) => source.sourceId),
      new Date().toISOString(),
    );
  }

  return {
    query: params.query,
    normalizedQuery,
    hits,
    sources,
    debugPath,
  };
}

export function resolveKnowledgeSourceSelection(params: {
  groupFolder: string;
  text: string;
  priorSourceIds?: string[];
  allowMany?: boolean;
}): KnowledgeSearchResult {
  const lower = normalizeVoicePrompt(params.text).toLowerCase();
  const shouldUsePrior =
    Boolean(params.priorSourceIds?.length) &&
    (/^(?:this|that|these) source/.test(lower) ||
      /^(?:forget|delete|stop using|disable|reindex) this\b/.test(lower) ||
      /^(?:forget|delete|stop using|disable|reindex) that\b/.test(lower));
  return searchKnowledgeLibrary({
    groupFolder: params.groupFolder,
    query: params.text,
    requestedSourceIds: shouldUsePrior ? params.priorSourceIds : undefined,
    limit: params.allowMany ? 5 : 3,
  });
}

export function disableKnowledgeSourceById(
  sourceId: string,
  now = new Date(),
): { ok: boolean; message: string } {
  const record = getKnowledgeSource(sourceId);
  if (!record) {
    return {
      ok: false,
      message: 'I could not find that saved source.',
    };
  }
  const changed = disableKnowledgeSource(sourceId, now.toISOString());
  return changed
    ? {
        ok: true,
        message: `Okay. I will stop using "${record.title}" in future library answers.`,
      }
    : {
        ok: false,
        message: 'I could not disable that source cleanly.',
      };
}

export function deleteKnowledgeSourceById(
  sourceId: string,
  now = new Date(),
): { ok: boolean; message: string } {
  const record = getKnowledgeSource(sourceId);
  if (!record) {
    return {
      ok: false,
      message: 'I could not find that saved source.',
    };
  }
  const changed = markKnowledgeSourceDeleted(sourceId, now.toISOString());
  return changed
    ? {
        ok: true,
        message: `Deleted "${record.title}" from your Knowledge Library.`,
      }
    : {
        ok: false,
        message: 'I could not delete that source cleanly.',
      };
}

export function reindexKnowledgeSourceById(
  sourceId: string,
  now = new Date(),
): SaveKnowledgeSourceResult {
  const record = getKnowledgeSource(sourceId);
  if (!record) {
    return {
      ok: false,
      message: 'I could not find that saved source.',
      debugPath: ['knowledge.reindex:missing_source'],
    };
  }

  if (record.contentRef) {
    try {
      const file = readKnowledgeFile(record.contentRef);
      return saveKnowledgeSource({
        sourceId: record.sourceId,
        groupFolder: record.groupFolder,
        title: record.title,
        shortSummary: deriveSummary(file.normalizedText),
        content: file.normalizedText,
        sourceType: record.sourceType,
        scope: record.scope,
        sensitivity: record.sensitivity,
        tags: record.tags,
        sourceChannel: record.sourceChannel,
        contentRef: file.contentRef,
        now,
      });
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : 'I could not re-read that saved file source.',
        debugPath: ['knowledge.reindex:file_reload_failed'],
      };
    }
  }

  return saveKnowledgeSource({
    sourceId: record.sourceId,
    groupFolder: record.groupFolder,
    title: record.title,
    shortSummary: record.shortSummary,
    content: record.normalizedText,
    sourceType: record.sourceType,
    scope: record.scope,
    sensitivity: record.sensitivity,
    tags: record.tags,
    sourceChannel: record.sourceChannel,
    contentRef: record.contentRef,
    now,
  });
}
