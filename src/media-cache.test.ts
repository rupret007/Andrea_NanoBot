import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cacheInboundMediaBytes,
  getUsableCachedMediaFile,
  MediaCacheLimitError,
  pruneMediaCache,
  readMediaResponseBytes,
} from './media-cache.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-media-cache-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('media cache', () => {
  it('rejects downloads that exceed the configured streaming limit', async () => {
    const response = new Response(Buffer.alloc(6), {
      headers: { 'content-length': '6' },
    });

    await expect(readMediaResponseBytes(response, 5)).rejects.toBeInstanceOf(
      MediaCacheLimitError,
    );
  });

  it('rejects oversized cache writes without creating a file', () => {
    const root = makeRoot();

    expect(() =>
      cacheInboundMediaBytes({
        bytes: Buffer.alloc(6),
        cacheRoot: root,
        maxFileBytes: 5,
      }),
    ).toThrow(MediaCacheLimitError);
    expect(fs.existsSync(path.join(root, 'inbound'))).toBe(false);
  });

  it('keeps only recent files within the retention and total-size budget', () => {
    const root = makeRoot();
    const oldPath = path.join(root, 'inbound', 'old.bin');
    const recentPath = path.join(root, 'derived', 'recent.bin');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.mkdirSync(path.dirname(recentPath), { recursive: true });
    fs.writeFileSync(oldPath, Buffer.alloc(8));
    fs.writeFileSync(recentPath, Buffer.alloc(8));
    const now = new Date('2026-07-10T12:00:00.000Z');
    fs.utimesSync(
      oldPath,
      new Date('2026-06-01T12:00:00.000Z'),
      new Date('2026-06-01T12:00:00.000Z'),
    );
    fs.utimesSync(recentPath, now, now);

    const result = pruneMediaCache({
      cacheRoot: root,
      now,
      retentionDays: 7,
      maxTotalBytes: 8,
    });

    expect(result.removedFiles).toBe(1);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(recentPath)).toBe(true);
  });

  it('only accepts regular files within the configured cache root', () => {
    const root = makeRoot();
    const cached = cacheInboundMediaBytes({
      bytes: Buffer.from('photo'),
      cacheRoot: root,
      filename: 'photo.jpg',
    });
    const outside = path.join(
      os.tmpdir(),
      `outside-${path.basename(root)}.jpg`,
    );
    fs.writeFileSync(outside, 'photo');

    expect(
      getUsableCachedMediaFile(cached.localPath, { cacheRoot: root }),
    ).toMatchObject({
      sizeBytes: 5,
    });
    expect(getUsableCachedMediaFile(outside, { cacheRoot: root })).toBeNull();
    fs.rmSync(outside, { force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects cache symlinks so local paths cannot escape the cache root',
    () => {
      const root = makeRoot();
      const outside = path.join(
        os.tmpdir(),
        `outside-${path.basename(root)}.jpg`,
      );
      const link = path.join(root, 'inbound', 'link.jpg');
      fs.writeFileSync(outside, 'photo');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link);

      expect(getUsableCachedMediaFile(link, { cacheRoot: root })).toBeNull();
      fs.rmSync(outside, { force: true });
    },
  );
});
