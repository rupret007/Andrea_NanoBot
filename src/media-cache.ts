import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const DEFAULT_MEDIA_CACHE_DIR = path.join(DATA_DIR, 'media-cache');

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

export function cacheInboundMediaBytes(input: {
  bytes: Buffer;
  mimeType?: string | null;
  filename?: string | null;
  now?: Date;
  cacheRoot?: string;
}): {
  contentHash: string;
  localPath: string;
  sizeBytes: number;
} {
  const hash = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const now = input.now || new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const ext =
    extensionFromFilename(input.filename) ||
    extensionFromMimeType(input.mimeType) ||
    'bin';
  const dir = path.join(
    input.cacheRoot || DEFAULT_MEDIA_CACHE_DIR,
    'inbound',
    month,
  );
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, `${hash}.${sanitizeExt(ext)}`);
  if (!fs.existsSync(localPath)) {
    fs.writeFileSync(localPath, input.bytes);
  }
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
  return path.join(cacheRoot, 'derived', safeHash || 'unknown');
}
