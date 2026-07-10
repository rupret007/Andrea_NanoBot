import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ANDREA_MEDIA_CACHE_MAX_FILE_BYTES,
  ANDREA_MEDIA_CACHE_MAX_TOTAL_BYTES,
  ANDREA_MEDIA_CACHE_RETENTION_DAYS,
  DATA_DIR,
} from './config.js';

export const DEFAULT_MEDIA_CACHE_DIR = process.env.VITEST
  ? path.join(
      os.tmpdir(),
      'andrea-media-cache-test',
      process.env.VITEST_WORKER_ID || 'main',
    )
  : path.join(DATA_DIR, 'media-cache');

export class MediaCacheLimitError extends Error {
  constructor(
    message: string,
    public readonly limitBytes: number,
  ) {
    super(message);
    this.name = 'MediaCacheLimitError';
  }
}

export interface MediaCachePolicy {
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
}

export function getMediaCachePolicy(
  overrides: Partial<MediaCachePolicy> = {},
): MediaCachePolicy {
  return {
    maxFileBytes: overrides.maxFileBytes ?? ANDREA_MEDIA_CACHE_MAX_FILE_BYTES,
    maxTotalBytes:
      overrides.maxTotalBytes ?? ANDREA_MEDIA_CACHE_MAX_TOTAL_BYTES,
    retentionDays: overrides.retentionDays ?? ANDREA_MEDIA_CACHE_RETENTION_DAYS,
  };
}

function sanitizeExt(value: string | null | undefined): string {
  const normalized = (value || '').trim().toLowerCase().replace(/^\./, '');
  if (!normalized || !/^[a-z0-9]{1,12}$/.test(normalized)) return 'bin';
  return normalized;
}

export function extensionFromMimeType(
  mimeType: string | null | undefined,
): string {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('mpeg')) return 'mpg';
  if (normalized.includes('pdf')) return 'pdf';
  return 'bin';
}

export function extensionFromFilename(
  filename: string | null | undefined,
): string | null {
  const ext = path.extname(filename || '').replace(/^\./, '');
  return ext ? sanitizeExt(ext) : null;
}

export function inferMediaKindFromMime(
  mimeType: string | null | undefined,
  filename?: string | null,
): 'image' | 'video' | 'audio' | 'file' {
  const normalized = (mimeType || '').toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  const ext = (extensionFromFilename(filename) || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'mov', 'm4v', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav', 'aac'].includes(ext)) return 'audio';
  return 'file';
}

export function buildMediaAttachmentId(input: {
  sourceChannel: string;
  chatJid: string;
  messageId: string;
  sourceId?: string | null;
  filename?: string | null;
  index?: number;
}): string {
  const raw = [
    input.sourceChannel,
    input.chatJid,
    input.messageId,
    input.sourceId || '',
    input.filename || '',
    String(input.index ?? 0),
  ].join('|');
  return `media:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function resolveCacheRoot(cacheRoot?: string): string {
  return path.resolve(cacheRoot || DEFAULT_MEDIA_CACHE_DIR);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
}

export function getUsableCachedMediaFile(
  localPath: string | null | undefined,
  options: { cacheRoot?: string; maxBytes?: number } = {},
): { localPath: string; sizeBytes: number } | null {
  if (!localPath) return null;
  const root = resolveCacheRoot(options.cacheRoot);
  const resolved = path.resolve(localPath);
  if (!isPathInside(root, resolved)) return null;
  try {
    const stat = fs.lstatSync(resolved);
    const maxBytes = options.maxBytes ?? getMediaCachePolicy().maxFileBytes;
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const realRoot = fs.realpathSync(root);
    const realPath = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, realPath)) return null;
    return { localPath: realPath, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

export async function readMediaResponseBytes(
  response: Response,
  maxBytes = getMediaCachePolicy().maxFileBytes,
): Promise<Buffer> {
  const contentLength = Number.parseInt(
    response.headers.get('content-length') || '',
    10,
  );
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MediaCacheLimitError(
      `Media download exceeds the ${maxBytes}-byte limit.`,
      maxBytes,
    );
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new MediaCacheLimitError(
        `Media download exceeds the ${maxBytes}-byte limit.`,
        maxBytes,
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaCacheLimitError(
          `Media download exceeds the ${maxBytes}-byte limit.`,
          maxBytes,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function listCacheFiles(cacheRoot: string): Array<{
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
}> {
  const files: Array<{
    path: string;
    sizeBytes: number;
    modifiedAtMs: number;
  }> = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(entryPath);
        files.push({
          path: entryPath,
          sizeBytes: stat.size,
          modifiedAtMs: stat.mtimeMs,
        });
      } catch {
        // Cache cleanup is best effort; a concurrent write can disappear.
      }
    }
  };
  visit(cacheRoot);
  return files;
}

function removeEmptyDirectories(dir: string, root: string): void {
  if (dir === root) return;
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      removeEmptyDirectories(path.dirname(dir), root);
    }
  } catch {
    // Cache cleanup is best effort.
  }
}

export function pruneMediaCache(
  options: {
    cacheRoot?: string;
    now?: Date;
    maxTotalBytes?: number;
    retentionDays?: number;
  } = {},
): { removedFiles: number; removedBytes: number } {
  const root = resolveCacheRoot(options.cacheRoot);
  const policy = getMediaCachePolicy(options);
  const cutoffMs =
    (options.now || new Date()).getTime() - policy.retentionDays * 86_400_000;
  const files = listCacheFiles(root).sort(
    (left, right) => left.modifiedAtMs - right.modifiedAtMs,
  );
  let remainingBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  let removedFiles = 0;
  let removedBytes = 0;

  for (const file of files) {
    if (
      file.modifiedAtMs >= cutoffMs &&
      remainingBytes <= policy.maxTotalBytes
    ) {
      continue;
    }
    try {
      fs.unlinkSync(file.path);
      removeEmptyDirectories(path.dirname(file.path), root);
      remainingBytes -= file.sizeBytes;
      removedFiles += 1;
      removedBytes += file.sizeBytes;
    } catch {
      // Cache cleanup is best effort.
    }
  }
  return { removedFiles, removedBytes };
}

export function cacheInboundMediaBytes(input: {
  bytes: Buffer;
  mimeType?: string | null;
  filename?: string | null;
  now?: Date;
  cacheRoot?: string;
  maxFileBytes?: number;
}): {
  contentHash: string;
  localPath: string;
  sizeBytes: number;
} {
  const cacheRoot = resolveCacheRoot(input.cacheRoot);
  const maxFileBytes = input.maxFileBytes ?? getMediaCachePolicy().maxFileBytes;
  if (input.bytes.length > maxFileBytes) {
    throw new MediaCacheLimitError(
      `Media file exceeds the ${maxFileBytes}-byte limit.`,
      maxFileBytes,
    );
  }
  pruneMediaCache({ cacheRoot, now: input.now });
  const hash = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const now = input.now || new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const ext =
    extensionFromFilename(input.filename) ||
    extensionFromMimeType(input.mimeType) ||
    'bin';
  const dir = path.join(cacheRoot, 'inbound', month);
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, `${hash}.${sanitizeExt(ext)}`);
  if (!fs.existsSync(localPath)) {
    fs.writeFileSync(localPath, input.bytes);
  }
  pruneMediaCache({ cacheRoot, now: input.now });
  return {
    contentHash: hash,
    localPath,
    sizeBytes: input.bytes.length,
  };
}

export function buildDerivedMediaDir(
  contentHash: string,
  cacheRoot = DEFAULT_MEDIA_CACHE_DIR,
): string {
  const safeHash = contentHash.replace(/[^a-f0-9]/gi, '').slice(0, 64);
  return path.join(
    resolveCacheRoot(cacheRoot),
    'derived',
    safeHash || 'unknown',
  );
}
