import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  CommunitySkillRecord,
  disableCommunitySkillForGroup,
  enableCommunitySkillForGroup,
  getCommunitySkillByCacheDirName,
  getCommunitySkillById,
  getCommunitySkillByUrl,
  listEnabledCommunitySkillsForGroup,
  upsertCommunitySkill,
} from './db.js';
import { assertValidGroupFolder } from './group-folder.js';

const GITHUB_API_ROOT = 'https://api.github.com';
const OPENCLAW_SKILLS_REPO = 'openclaw/skills';
const FILE_COUNT_LIMIT = 200;
const FILE_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
const TOTAL_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const SKILL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OPENCLAW_MARKET_MANIFEST_FILENAME =
  '.nanoclaw-openclaw-market.json';
const MARKETPLACE_CACHE_ROOT = path.resolve(DATA_DIR, 'marketplace', 'skills');

export interface OpenClawSkillSecuritySignals {
  virusTotalStatus: string | null;
  openClawStatus: string | null;
  openClawSummary: string | null;
}

export interface ResolvedOpenClawSkill {
  owner: string;
  slug: string;
  displayName: string;
  sourceUrl: string;
  canonicalClawHubUrl: string | null;
  githubTreeUrl: string;
  security: OpenClawSkillSecuritySignals;
}

export interface CachedOpenClawSkill extends ResolvedOpenClawSkill {
  skillId: string;
  cacheDirName: string;
  cachePath: string;
  manifestPath: string;
  cachedAt: string;
  fileCount: number;
}

export interface EnableOpenClawSkillParams {
  groupFolder: string;
  skillUrl: string;
}

export interface EnabledOpenClawSkill extends CachedOpenClawSkill {
  groupFolder: string;
  enabledAt: string;
  enabledPath: string;
  installDirName: string;
}

export type InstallOpenClawSkillParams = EnableOpenClawSkillParams;
export type InstalledOpenClawSkill = EnabledOpenClawSkill;

export interface DisableOpenClawSkillParams {
  groupFolder: string;
  skillIdOrUrl: string;
}

export interface DisabledOpenClawSkill {
  skillId: string;
  owner: string;
  slug: string;
  displayName: string;
  groupFolder: string;
  removedPath: string;
  disabledAt: string;
  installDirName: string;
}

interface GitHubContentEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  download_url?: string | null;
  url: string;
}

interface DownloadedSkillFile {
  relativePath: string;
  content: Buffer;
}

function fetchHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'User-Agent': 'nanoclaw-openclaw-market',
    ...extra,
  };
}

function withGitHubAuth(
  url: string,
  headers: Record<string, string>,
): Record<string, string> {
  const host = new URL(url).hostname.toLowerCase();
  const isGitHubHost =
    host === 'api.github.com' ||
    host === 'github.com' ||
    host === 'raw.githubusercontent.com';
  if (!isGitHubHost) return headers;

  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!githubToken) return headers;

  return {
    ...headers,
    Authorization: `Bearer ${githubToken}`,
  };
}

async function fetchText(url: string): Promise<string> {
  const headers = withGitHubAuth(
    url,
    fetchHeaders({
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    }),
  );
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: withGitHubAuth(url, fetchHeaders()),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: withGitHubAuth(
      url,
      fetchHeaders({ Accept: 'application/vnd.github+json' }),
    ),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function formatGitHubSkillNotFoundError(
  err: unknown,
  owner: string,
  slug: string,
): Error | null {
  if (!(err instanceof Error)) return null;
  if (
    !/api\.github\.com\/repos\/openclaw\/skills\/contents\/skills\//i.test(
      err.message,
    )
  ) {
    return null;
  }
  if (!/: 404\b/.test(err.message)) return null;

  return new Error(
    `Community skill ${owner}/${slug} was not found in the official openclaw/skills repository. Choose another catalog entry.`,
  );
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^www\./, '').toLowerCase();
}

function isValidSkillSegment(segment: string): boolean {
  return SKILL_SEGMENT_PATTERN.test(segment);
}

function assertValidSkillCoordinates(owner: string, slug: string): void {
  if (!isValidSkillSegment(owner) || !isValidSkillSegment(slug)) {
    throw new Error(`Invalid skill coordinates: ${owner}/${slug}`);
  }
}

export function normalizeOpenClawSkillUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(
    /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  url.hostname = normalizeHost(url.hostname);
  url.hash = '';
  url.search = '';

  return url.toString();
}

export function skillIdFor(owner: string, slug: string): string {
  return `${owner.toLowerCase()}/${slug.toLowerCase()}`;
}

export function extractClawHubUrlFromClawSkillsHtml(html: string): string {
  const hrefMatch = html.match(
    /href="(https:\/\/clawhub\.ai\/[^"/]+\/[^"/?#]+)"/i,
  );
  if (hrefMatch) return hrefMatch[1];

  const sourceMatch = html.match(
    /clawHub:"(https:\/\/clawhub\.ai\/[^"/]+\/[^"/?#]+)"/i,
  );
  if (sourceMatch) return sourceMatch[1];

  throw new Error('Could not locate canonical ClawHub URL in ClawSkills page');
}

export function extractClawHubMetadata(
  html: string,
  fallbackUrl: string,
): ResolvedOpenClawSkill {
  const canonicalMatch = html.match(
    /<link rel="canonical" href="(https:\/\/clawhub\.ai\/[^"/]+\/[^"/?#]+)"/i,
  );
  const canonicalUrl =
    canonicalMatch?.[1] || normalizeOpenClawSkillUrl(fallbackUrl);
  const canonical = new URL(canonicalUrl);
  const [, owner, slug] = canonical.pathname.split('/');

  if (!owner || !slug) {
    throw new Error(`Could not determine owner/slug from ${canonicalUrl}`);
  }
  assertValidSkillCoordinates(owner, slug);

  const titleMatch = html.match(
    /<title>([^<]+?)\s+[-\u2014]\s+ClawHub<\/title>/i,
  );
  const displayName = titleMatch?.[1]?.trim() || slug;

  const virusTotalMatch = html.match(
    /VirusTotal[\s\S]{0,300}?scan-result-status[^>]*>([^<]+)</i,
  );
  const openClawMatch = html.match(
    /OpenClaw[\s\S]{0,300}?scan-result-status[^>]*>([^<]+)</i,
  );
  const summaryMatch = html.match(/analysis-summary-text">([^<]+)</i);

  return {
    owner,
    slug,
    displayName,
    sourceUrl: normalizeOpenClawSkillUrl(fallbackUrl),
    canonicalClawHubUrl: canonical.toString(),
    githubTreeUrl: `https://github.com/${OPENCLAW_SKILLS_REPO}/tree/main/skills/${owner}/${slug}`,
    security: {
      virusTotalStatus: virusTotalMatch?.[1]?.trim() || null,
      openClawStatus: openClawMatch?.[1]?.trim() || null,
      openClawSummary: summaryMatch?.[1]?.trim() || null,
    },
  };
}

export function parseGitHubSkillTreeUrl(input: string): {
  owner: string;
  slug: string;
  githubTreeUrl: string;
} | null {
  const url = new URL(normalizeOpenClawSkillUrl(input));
  if (url.hostname !== 'github.com') return null;

  const match = url.pathname.match(
    /^\/openclaw\/skills\/(?:tree|blob)\/main\/skills\/([^/]+)\/([^/]+)(?:\/.*)?\/?$/i,
  );
  if (!match) return null;

  let owner: string;
  let slug: string;
  try {
    owner = decodeURIComponent(match[1]);
    slug = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!isValidSkillSegment(owner) || !isValidSkillSegment(slug)) return null;
  return {
    owner,
    slug,
    githubTreeUrl: `https://github.com/${OPENCLAW_SKILLS_REPO}/tree/main/skills/${owner}/${slug}`,
  };
}

function canonicalClawHubSkillUrl(owner: string, slug: string): string {
  assertValidSkillCoordinates(owner, slug);
  return `https://clawhub.ai/${owner}/${slug}`;
}

function parseClawHubSkillUrl(input: string): {
  owner: string;
  slug: string;
  canonicalClawHubUrl: string;
} | null {
  const url = new URL(normalizeOpenClawSkillUrl(input));
  if (normalizeHost(url.hostname) !== 'clawhub.ai') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  const [, owner, slug] = match;
  if (!isValidSkillSegment(owner) || !isValidSkillSegment(slug)) return null;

  return {
    owner,
    slug,
    canonicalClawHubUrl: url.toString(),
  };
}

function blockedBySecurityStatus(status: string | null): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'suspicious' || normalized === 'malicious';
}

function formatDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

export function installDirNameForSkill(owner: string, slug: string): string {
  return `openclaw-${owner}-${slug}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
}

function ensureWithinBase(baseDir: string, targetPath: string): void {
  const relative = path.relative(baseDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes base directory: ${targetPath}`);
  }
}

export function normalizeRelativeSkillPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('Skill file path is empty');

  const parts = normalized.split('/');
  if (
    parts.some(
      (part) =>
        part.length === 0 || part === '.' || part === '..' || part === '.git',
    )
  ) {
    throw new Error(`Unsafe skill file path: ${inputPath}`);
  }

  return parts.join('/');
}

export function validateDownloadedSkillFiles(
  files: DownloadedSkillFile[],
): void {
  if (files.length === 0) throw new Error('No skill files were downloaded');
  if (files.length > FILE_COUNT_LIMIT) {
    throw new Error(`Skill exceeds file limit (${FILE_COUNT_LIMIT})`);
  }

  let totalSize = 0;
  let hasSkillFile = false;

  for (const file of files) {
    const relativePath = normalizeRelativeSkillPath(file.relativePath);
    if (relativePath === 'SKILL.md') hasSkillFile = true;

    if (file.content.length > FILE_SIZE_LIMIT_BYTES) {
      throw new Error(`File exceeds size limit: ${relativePath}`);
    }

    totalSize += file.content.length;
  }

  if (totalSize > TOTAL_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Skill exceeds total size limit (${TOTAL_SIZE_LIMIT_BYTES})`,
    );
  }

  if (!hasSkillFile) {
    throw new Error('Skill is missing SKILL.md');
  }
}

async function resolveOpenClawSkill(
  skillUrl: string,
): Promise<ResolvedOpenClawSkill> {
  const normalizedUrl = normalizeOpenClawSkillUrl(skillUrl);
  const parsed = new URL(normalizedUrl);

  const githubSkill = parseGitHubSkillTreeUrl(normalizedUrl);
  if (githubSkill) {
    const clawHubUrl = canonicalClawHubSkillUrl(
      githubSkill.owner,
      githubSkill.slug,
    );
    try {
      const clawHubHtml = await fetchText(clawHubUrl);
      const clawHubResolved = extractClawHubMetadata(clawHubHtml, clawHubUrl);
      return {
        ...clawHubResolved,
        sourceUrl: normalizedUrl,
      };
    } catch {
      // ClawHub metadata is best-effort for direct GitHub URLs.
      // We still allow official openclaw/skills payload downloads.
    }

    return {
      owner: githubSkill.owner,
      slug: githubSkill.slug,
      displayName: formatDisplayName(githubSkill.slug),
      sourceUrl: normalizedUrl,
      canonicalClawHubUrl: null,
      githubTreeUrl: githubSkill.githubTreeUrl,
      security: {
        virusTotalStatus: null,
        openClawStatus: null,
        openClawSummary: null,
      },
    };
  }

  if (normalizeHost(parsed.hostname) === 'clawskills.sh') {
    const html = await fetchText(normalizedUrl);
    const canonicalClawHubUrl = extractClawHubUrlFromClawSkillsHtml(html);
    const clawHubHtml = await fetchText(canonicalClawHubUrl);
    return extractClawHubMetadata(clawHubHtml, normalizedUrl);
  }

  if (normalizeHost(parsed.hostname) === 'clawhub.ai') {
    const html = await fetchText(normalizedUrl);
    return extractClawHubMetadata(html, normalizedUrl);
  }

  throw new Error(
    'Only ClawSkills, ClawHub, or github.com/openclaw/skills URLs are supported',
  );
}

async function listGitHubSkillFiles(
  owner: string,
  slug: string,
  apiUrl = `${GITHUB_API_ROOT}/repos/${OPENCLAW_SKILLS_REPO}/contents/skills/${owner}/${slug}`,
): Promise<GitHubContentEntry[]> {
  let entries: GitHubContentEntry[] | GitHubContentEntry;
  try {
    entries = await fetchJson<GitHubContentEntry[] | GitHubContentEntry>(
      apiUrl,
    );
  } catch (err) {
    const friendly = formatGitHubSkillNotFoundError(err, owner, slug);
    if (friendly) throw friendly;
    throw err;
  }
  const list = Array.isArray(entries) ? entries : [entries];
  const files: GitHubContentEntry[] = [];

  for (const entry of list) {
    if (entry.type === 'file') {
      files.push(entry);
      continue;
    }
    if (entry.type === 'dir') {
      files.push(...(await listGitHubSkillFiles(owner, slug, entry.url)));
    }
  }

  return files;
}

function repoPathToRelativeSkillPath(
  owner: string,
  slug: string,
  repoPath: string,
): string {
  const prefix = `skills/${owner}/${slug}/`;
  if (!repoPath.startsWith(prefix)) {
    throw new Error(`Unexpected repository path: ${repoPath}`);
  }
  return normalizeRelativeSkillPath(repoPath.slice(prefix.length));
}

async function downloadGitHubSkillFiles(
  skill: ResolvedOpenClawSkill,
): Promise<DownloadedSkillFile[]> {
  const entries = await listGitHubSkillFiles(skill.owner, skill.slug);
  const files: DownloadedSkillFile[] = [];

  for (const entry of entries) {
    if (!entry.download_url) {
      throw new Error(`Missing download URL for ${entry.path}`);
    }
    if ((entry.size || 0) > FILE_SIZE_LIMIT_BYTES) {
      throw new Error(`File exceeds size limit: ${entry.path}`);
    }

    const content = Buffer.from(await fetchArrayBuffer(entry.download_url));
    files.push({
      relativePath: repoPathToRelativeSkillPath(
        skill.owner,
        skill.slug,
        entry.path,
      ),
      content,
    });
  }

  validateDownloadedSkillFiles(files);
  return files;
}

function writeSkillFiles(
  targetDir: string,
  files: DownloadedSkillFile[],
  manifest: object,
): void {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    const relativePath = normalizeRelativeSkillPath(file.relativePath);
    const destination = path.resolve(targetDir, relativePath);
    ensureWithinBase(targetDir, destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }

  fs.writeFileSync(
    path.join(targetDir, OPENCLAW_MARKET_MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

function assertSecurityPolicy(skill: ResolvedOpenClawSkill): void {
  if (blockedBySecurityStatus(skill.security.virusTotalStatus)) {
    throw new Error(
      `VirusTotal marked this skill as ${skill.security.virusTotalStatus}`,
    );
  }
  if (blockedBySecurityStatus(skill.security.openClawStatus)) {
    throw new Error(
      `OpenClaw marked this skill as ${skill.security.openClawStatus}`,
    );
  }
}

function getMarketplaceCachePath(owner: string, slug: string): string {
  return path.resolve(
    MARKETPLACE_CACHE_ROOT,
    owner.toLowerCase(),
    slug.toLowerCase(),
  );
}

function getGroupSkillsRoot(groupFolder: string): string {
  return path.resolve(DATA_DIR, 'sessions', groupFolder, '.claude', 'skills');
}

function getEnabledSkillPath(
  groupFolder: string,
  owner: string,
  slug: string,
): string {
  const skillsRoot = getGroupSkillsRoot(groupFolder);
  const dirName = installDirNameForSkill(owner, slug);
  const enabledPath = path.resolve(skillsRoot, dirName);
  ensureWithinBase(skillsRoot, enabledPath);
  return enabledPath;
}

function mapRecordToCachedSkill(
  record: CommunitySkillRecord,
): CachedOpenClawSkill {
  return {
    skillId: record.skill_id,
    owner: record.owner,
    slug: record.slug,
    displayName: record.display_name,
    sourceUrl: record.source_url,
    canonicalClawHubUrl: record.canonical_clawhub_url,
    githubTreeUrl: record.github_tree_url,
    cacheDirName: record.cache_dir_name,
    cachePath: record.cache_path,
    manifestPath: record.manifest_path,
    cachedAt: record.cached_at,
    fileCount: record.file_count,
    security: {
      virusTotalStatus: record.virus_total_status,
      openClawStatus: record.openclaw_status,
      openClawSummary: record.openclaw_summary,
    },
  };
}

function findCachedSkillByIdentifier(
  skillIdOrUrl: string,
): CommunitySkillRecord | undefined {
  const trimmed = skillIdOrUrl.trim();
  const normalizedInput = trimmed.toLowerCase();
  if (!trimmed) return undefined;

  const looksLikeUrl =
    trimmed.includes('://') ||
    trimmed.includes('clawskills.sh') ||
    trimmed.includes('clawhub.ai') ||
    trimmed.includes('github.com/openclaw/skills');

  if (looksLikeUrl) {
    const normalizedUrl = normalizeOpenClawSkillUrl(trimmed);
    const byUrl = getCommunitySkillByUrl(normalizedUrl);
    if (byUrl) return byUrl;

    const githubSkill = parseGitHubSkillTreeUrl(normalizedUrl);
    if (githubSkill) {
      return getCommunitySkillById(
        skillIdFor(githubSkill.owner, githubSkill.slug),
      );
    }

    const clawHubSkill = parseClawHubSkillUrl(normalizedUrl);
    if (clawHubSkill) {
      return getCommunitySkillById(
        skillIdFor(clawHubSkill.owner, clawHubSkill.slug),
      );
    }

    return undefined;
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return getCommunitySkillById(normalizedInput);
  }

  if (normalizedInput.startsWith('openclaw-')) {
    return getCommunitySkillByCacheDirName(normalizedInput);
  }

  return getCommunitySkillById(normalizedInput);
}

function syncDirectory(sourceDir: string, destinationDir: string): void {
  const destinationRoot = path.dirname(destinationDir);
  fs.mkdirSync(destinationRoot, { recursive: true });

  const tempPath = `${destinationDir}.tmp-${Date.now().toString(36)}`;
  ensureWithinBase(destinationRoot, tempPath);

  fs.rmSync(tempPath, { recursive: true, force: true });
  fs.cpSync(sourceDir, tempPath, { recursive: true, force: true });
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.renameSync(tempPath, destinationDir);
}

async function ensureCachedOpenClawSkill(
  skillUrl: string,
): Promise<CachedOpenClawSkill> {
  const normalizedUrl = normalizeOpenClawSkillUrl(skillUrl);
  const directGitHub = parseGitHubSkillTreeUrl(normalizedUrl);
  const directClawHub = parseClawHubSkillUrl(normalizedUrl);

  const knownSkillId = directGitHub
    ? skillIdFor(directGitHub.owner, directGitHub.slug)
    : directClawHub
      ? skillIdFor(directClawHub.owner, directClawHub.slug)
      : null;

  const cachedByUrl = getCommunitySkillByUrl(normalizedUrl);
  if (cachedByUrl && fs.existsSync(cachedByUrl.cache_path)) {
    return mapRecordToCachedSkill(cachedByUrl);
  }

  if (knownSkillId) {
    const cachedById = getCommunitySkillById(knownSkillId);
    if (cachedById && fs.existsSync(cachedById.cache_path)) {
      return mapRecordToCachedSkill(cachedById);
    }
  }

  const resolved = await resolveOpenClawSkill(skillUrl);
  const skillId = skillIdFor(resolved.owner, resolved.slug);
  const existingRecord = getCommunitySkillById(skillId);
  if (existingRecord && fs.existsSync(existingRecord.cache_path)) {
    return mapRecordToCachedSkill(existingRecord);
  }

  assertSecurityPolicy(resolved);
  const files = await downloadGitHubSkillFiles(resolved);

  const cachePath = getMarketplaceCachePath(resolved.owner, resolved.slug);
  const manifestPath = path.join(cachePath, OPENCLAW_MARKET_MANIFEST_FILENAME);
  const tempPath = `${cachePath}.tmp-${Date.now().toString(36)}`;
  const cachedAt = new Date().toISOString();
  const cacheDirName = installDirNameForSkill(resolved.owner, resolved.slug);
  ensureWithinBase(MARKETPLACE_CACHE_ROOT, cachePath);
  ensureWithinBase(MARKETPLACE_CACHE_ROOT, tempPath);

  fs.rmSync(tempPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  const manifest = {
    skillId,
    sourceUrl: resolved.sourceUrl,
    canonicalClawHubUrl: resolved.canonicalClawHubUrl,
    githubTreeUrl: resolved.githubTreeUrl,
    owner: resolved.owner,
    slug: resolved.slug,
    displayName: resolved.displayName,
    cachedAt,
    fileCount: files.length,
    security: resolved.security,
  };

  writeSkillFiles(tempPath, files, manifest);
  fs.rmSync(cachePath, { recursive: true, force: true });
  fs.renameSync(tempPath, cachePath);

  const record: CommunitySkillRecord = {
    skill_id: skillId,
    owner: resolved.owner,
    slug: resolved.slug,
    display_name: resolved.displayName,
    source_url: resolved.sourceUrl,
    canonical_clawhub_url: resolved.canonicalClawHubUrl,
    github_tree_url: resolved.githubTreeUrl,
    cache_dir_name: cacheDirName,
    cache_path: cachePath,
    manifest_path: manifestPath,
    cached_at: cachedAt,
    file_count: files.length,
    virus_total_status: resolved.security.virusTotalStatus,
    openclaw_status: resolved.security.openClawStatus,
    openclaw_summary: resolved.security.openClawSummary,
  };

  upsertCommunitySkill(record);
  return mapRecordToCachedSkill(record);
}

export async function enableOpenClawSkill(
  params: EnableOpenClawSkillParams,
): Promise<EnabledOpenClawSkill> {
  assertValidGroupFolder(params.groupFolder);

  const cached = await ensureCachedOpenClawSkill(params.skillUrl);
  const enabledPath = getEnabledSkillPath(
    params.groupFolder,
    cached.owner,
    cached.slug,
  );
  const enabledAt = new Date().toISOString();

  syncDirectory(cached.cachePath, enabledPath);
  enableCommunitySkillForGroup(params.groupFolder, cached.skillId, enabledAt);

  return {
    ...cached,
    groupFolder: params.groupFolder,
    enabledAt,
    enabledPath,
    installDirName: cached.cacheDirName,
  };
}

export async function installOpenClawSkill(
  params: InstallOpenClawSkillParams,
): Promise<InstalledOpenClawSkill> {
  return enableOpenClawSkill(params);
}

export async function disableOpenClawSkill(
  params: DisableOpenClawSkillParams,
): Promise<DisabledOpenClawSkill> {
  assertValidGroupFolder(params.groupFolder);

  const record = findCachedSkillByIdentifier(params.skillIdOrUrl);
  if (!record) {
    throw new Error(
      `No cached community skill matched "${params.skillIdOrUrl}"`,
    );
  }

  const removedPath = getEnabledSkillPath(
    params.groupFolder,
    record.owner,
    record.slug,
  );
  fs.rmSync(removedPath, { recursive: true, force: true });

  const disabledAt = new Date().toISOString();
  disableCommunitySkillForGroup(params.groupFolder, record.skill_id);

  return {
    skillId: record.skill_id,
    owner: record.owner,
    slug: record.slug,
    displayName: record.display_name,
    groupFolder: params.groupFolder,
    removedPath,
    disabledAt,
    installDirName: record.cache_dir_name,
  };
}

export function listEnabledOpenClawSkills(
  groupFolder: string,
): EnabledOpenClawSkill[] {
  assertValidGroupFolder(groupFolder);
  return listEnabledCommunitySkillsForGroup(groupFolder).map((record) => {
    const cached = mapRecordToCachedSkill(record);
    return {
      ...cached,
      groupFolder: record.group_folder,
      enabledAt: record.enabled_at,
      enabledPath: getEnabledSkillPath(groupFolder, record.owner, record.slug),
      installDirName: cached.cacheDirName,
    };
  });
}
