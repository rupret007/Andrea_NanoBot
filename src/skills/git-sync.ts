/**
 * Git-backed skill sync.
 *
 * Clones (or pulls) a remote repo into a cache directory, then hands off to
 * the filesystem loader. The cache layout is:
 *
 *   ${cacheDir}/${ownerRepoSlug}/   ← shallow clone of the repo
 *
 * On second sync we run `git fetch --depth=1 && git reset --hard origin/<ref>`
 * to keep the clone shallow. This is fast (a few seconds for typical skill
 * repos) and avoids bloating disk.
 *
 * Safety:
 *   - URL must be https:// (no ssh, no file://, no git protocol).
 *   - Host must be in the allowlist (defaults to github.com / gitlab.com /
 *     codeberg.org). The runtime can override with its own list.
 *   - We invoke `git` via execFile (no shell) and timeout at 60s.
 */

import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadSkillsFromDirectory } from './loader.js';
import type { Skill, SkillSource } from './types.js';

const execFileP = promisify(execFile);

export interface GitSyncOptions {
  /** Local directory used as the clone cache. */
  cacheDir: string;
  /** Allowlist of host names. Defaults to a small curated list. */
  allowedHosts?: string[];
  /** Override the git binary (mostly for tests). */
  gitBinary?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org'];

export class GitSyncError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`[git-sync ${source}] ${message}`);
    this.name = 'GitSyncError';
  }
}

export class GitSync {
  constructor(private readonly opts: GitSyncOptions) {}

  /**
   * Clone or refresh a source's repo, then load its skills. Idempotent:
   * calling sync twice on a fresh source is the same as calling it once.
   */
  async sync(source: SkillSource): Promise<Skill[]> {
    const url = new URL(source.url);
    if (url.protocol !== 'https:') {
      throw new GitSyncError(`refused non-https url ${source.url}`, source.id);
    }
    const allowed = this.opts.allowedHosts ?? DEFAULT_HOSTS;
    if (!allowed.includes(url.host)) {
      throw new GitSyncError(
        `host ${url.host} not in allowlist (${allowed.join(', ')})`,
        source.id,
      );
    }
    const slug = source.id
      .replace(/[^A-Za-z0-9._/-]/g, '_')
      .replace(/\//g, '__');
    const dest = join(this.opts.cacheDir, slug);
    await mkdir(this.opts.cacheDir, { recursive: true });

    const exists = await dirExists(join(dest, '.git'));
    const ref = source.ref ?? 'HEAD';
    const git = this.opts.gitBinary ?? 'git';
    const timeout = this.opts.timeoutMs ?? 60_000;

    if (!exists) {
      await execFileP(git, ['clone', '--depth=1', source.url, dest], {
        timeout,
      });
    } else {
      // Refresh shallow.
      await execFileP(git, ['-C', dest, 'fetch', '--depth=1', 'origin', ref], {
        timeout,
      });
      // Reset hard so local edits don't accidentally persist.
      await execFileP(git, ['-C', dest, 'reset', '--hard', 'FETCH_HEAD'], {
        timeout,
      });
    }

    return loadSkillsFromDirectory({
      root: dest,
      source: { ...source, lastSyncedAt: Date.now() },
      upstreamBaseUrl: upstreamBaseUrlFor(source),
    });
  }

  async loadCached(source: SkillSource): Promise<Skill[]> {
    const dest = join(
      this.opts.cacheDir,
      source.id.replace(/[^A-Za-z0-9._/-]/g, '_').replace(/\//g, '__'),
    );
    if (!(await dirExists(dest))) return [];
    return loadSkillsFromDirectory({
      root: dest,
      source,
      upstreamBaseUrl: upstreamBaseUrlFor(source),
    });
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function upstreamBaseUrlFor(source: SkillSource): string | undefined {
  const url = new URL(source.url);
  if (url.host !== 'github.com' && url.host !== 'gitlab.com') return undefined;
  const trimmed = url.pathname.replace(/\.git$/, '').replace(/^\//, '');
  const branch = source.ref && source.ref !== 'HEAD' ? source.ref : 'main';
  return url.host === 'github.com'
    ? `https://github.com/${trimmed}/blob/${branch}/`
    : `https://gitlab.com/${trimmed}/-/blob/${branch}/`;
}
