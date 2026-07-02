/**
 * Filesystem skill loader.
 *
 * Walks a directory looking for SKILL.md, persona/agent .md files, and
 * reference .md files. Calls the parser on each. Returns Skill[] for the
 * caller to register.
 *
 * Network-side loading (cloning a github repo) lives in `git-sync.ts`. This
 * module is kept FS-pure so it's easy to test and reusable for vendored
 * libraries (skills shipped inside the repo) and uploaded zips.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseSkillFile } from './parser.js';
import type { Skill, SkillKind, SkillSource } from './types.js';

export interface LoadFromDirectoryOptions {
  /**
   * Root path to scan. Typically a clone of a remote repo or an in-repo
   * vendored library.
   */
  root: string;
  /** Source metadata for the resulting skills. */
  source: SkillSource;
  /**
   * Base URL used to construct `upstreamUrl` for each skill. If absent,
   * upstream URLs are omitted. Typically `https://github.com/owner/repo/blob/main/`.
   */
  upstreamBaseUrl?: string;
}

export async function loadSkillsFromDirectory(
  opts: LoadFromDirectoryOptions,
): Promise<Skill[]> {
  const { root, source, upstreamBaseUrl } = opts;
  const out: Skill[] = [];

  const skillDirs = source.paths.skills ?? [];
  for (const sub of skillDirs) {
    const absolute = join(root, sub);
    if (!(await dirExists(absolute))) continue;
    // Each immediate subdirectory containing a SKILL.md is one workflow.
    for (const child of await readdir(absolute)) {
      const childAbs = join(absolute, child);
      if (!(await dirExists(childAbs))) continue;
      const candidate = join(childAbs, 'SKILL.md');
      if (!(await fileExists(candidate))) continue;
      const raw = await readFile(candidate, 'utf-8');
      const sourcePath = relative(root, candidate).split(sep).join('/');
      const skill = parseSkillFile({
        raw,
        sourceId: source.id,
        sourcePath,
        upstreamUrl: upstreamBaseUrl ? upstreamBaseUrl + sourcePath : undefined,
        kind: 'workflow',
        fallbackName: child.toLowerCase(),
      });
      out.push(skill);
    }
  }

  for (const sub of source.paths.personas ?? []) {
    out.push(
      ...(await loadFlatMarkdown({
        root,
        sub,
        source,
        kind: 'persona',
        upstreamBaseUrl,
      })),
    );
  }
  for (const sub of source.paths.references ?? []) {
    out.push(
      ...(await loadFlatMarkdown({
        root,
        sub,
        source,
        kind: 'reference',
        upstreamBaseUrl,
      })),
    );
  }

  return out;
}

async function loadFlatMarkdown(params: {
  root: string;
  sub: string;
  source: SkillSource;
  kind: SkillKind;
  upstreamBaseUrl?: string;
}): Promise<Skill[]> {
  const absolute = join(params.root, params.sub);
  if (!(await dirExists(absolute))) return [];
  const out: Skill[] = [];
  for (const file of await readdir(absolute)) {
    if (!/\.md$/i.test(file)) continue;
    if (/^readme\.md$/i.test(file)) continue;
    const fileAbs = join(absolute, file);
    const raw = await readFile(fileAbs, 'utf-8');
    const sourcePath = relative(params.root, fileAbs).split(sep).join('/');
    out.push(
      parseSkillFile({
        raw,
        sourceId: params.source.id,
        sourcePath,
        kind: params.kind,
        fallbackName: file.replace(/\.md$/i, '').toLowerCase(),
        upstreamUrl: params.upstreamBaseUrl
          ? params.upstreamBaseUrl + sourcePath
          : undefined,
      }),
    );
  }
  return out;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
