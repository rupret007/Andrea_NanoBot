import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { writeJsonFileAtomic } from './atomic-json-file.js';
import { parseGitDirtyPaths } from './git-status-paths.js';

export const BUILD_PROVENANCE_FILENAME = 'build-provenance.json';

export interface BuildProvenanceManifest {
  version: 1;
  builtAt: string;
  gitBranch: string;
  gitCommit: string;
  gitDirtyPathCount: number;
  artifactSha256: string;
  artifactFileCount: number;
}

export type BuildProvenanceState =
  | 'verified'
  | 'missing'
  | 'invalid'
  | 'dirty_source'
  | 'commit_mismatch'
  | 'artifact_mismatch';

export interface BuildProvenanceAssessment {
  state: BuildProvenanceState;
  detail: string;
  manifest: BuildProvenanceManifest | null;
  artifactVerified: boolean | null;
}

function manifestPath(projectRoot: string): string {
  return path.join(projectRoot, 'dist', BUILD_PROVENANCE_FILENAME);
}

function listArtifactFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listArtifactFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile() || entry.name === BUILD_PROVENANCE_FILENAME) continue;
    files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
  }
  return files.sort();
}

export function computeBuildArtifactDigest(distDir: string): {
  artifactSha256: string;
  artifactFileCount: number;
} {
  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    throw new Error(`Build output directory is missing: ${distDir}`);
  }
  const files = listArtifactFiles(distDir);
  const hash = crypto.createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(distDir, relativePath)));
    hash.update('\0');
  }
  return {
    artifactSha256: hash.digest('hex'),
    artifactFileCount: files.length,
  };
}

function readGitValue(projectRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function readGitDirtyPathCount(projectRoot: string): number {
  const output = readGitValue(projectRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  return output ? parseGitDirtyPaths(output).length : 0;
}

function normalizeManifest(value: unknown): BuildProvenanceManifest | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<BuildProvenanceManifest>;
  if (
    input.version !== 1 ||
    typeof input.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(input.builtAt)) ||
    typeof input.gitBranch !== 'string' ||
    !input.gitBranch.trim() ||
    typeof input.gitCommit !== 'string' ||
    !input.gitCommit.trim() ||
    typeof input.gitDirtyPathCount !== 'number' ||
    !Number.isInteger(input.gitDirtyPathCount) ||
    input.gitDirtyPathCount < 0 ||
    typeof input.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(input.artifactSha256) ||
    typeof input.artifactFileCount !== 'number' ||
    !Number.isInteger(input.artifactFileCount) ||
    input.artifactFileCount < 1
  ) {
    return null;
  }
  return {
    version: 1,
    builtAt: input.builtAt,
    gitBranch: input.gitBranch,
    gitCommit: input.gitCommit,
    gitDirtyPathCount: input.gitDirtyPathCount,
    artifactSha256: input.artifactSha256,
    artifactFileCount: input.artifactFileCount,
  };
}

export function readBuildProvenance(
  projectRoot = process.cwd(),
): BuildProvenanceManifest | null {
  const target = manifestPath(projectRoot);
  if (!fs.existsSync(target)) return null;
  try {
    return normalizeManifest(JSON.parse(fs.readFileSync(target, 'utf-8')));
  } catch {
    return null;
  }
}

export function writeBuildProvenance(options?: {
  projectRoot?: string;
  now?: Date;
}): BuildProvenanceManifest {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const distDir = path.join(projectRoot, 'dist');
  const artifact = computeBuildArtifactDigest(distDir);
  const manifest: BuildProvenanceManifest = {
    version: 1,
    builtAt: (options?.now || new Date()).toISOString(),
    gitBranch: readGitValue(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitCommit: readGitValue(projectRoot, ['rev-parse', 'HEAD']),
    gitDirtyPathCount: readGitDirtyPathCount(projectRoot),
    ...artifact,
  };
  writeJsonFileAtomic(manifestPath(projectRoot), manifest);
  return manifest;
}

export function assessBuildProvenance(options?: {
  projectRoot?: string;
  expectedGitCommit?: string;
}): BuildProvenanceAssessment {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const target = manifestPath(projectRoot);
  if (!fs.existsSync(target)) {
    return {
      state: 'missing',
      detail: 'Build provenance manifest is missing.',
      manifest: null,
      artifactVerified: null,
    };
  }
  const manifest = readBuildProvenance(projectRoot);
  if (!manifest) {
    return {
      state: 'invalid',
      detail: 'Build provenance manifest is invalid.',
      manifest: null,
      artifactVerified: null,
    };
  }
  let artifact;
  try {
    artifact = computeBuildArtifactDigest(path.join(projectRoot, 'dist'));
  } catch (err) {
    return {
      state: 'artifact_mismatch',
      detail:
        err instanceof Error
          ? err.message
          : 'Build artifact could not be verified.',
      manifest,
      artifactVerified: false,
    };
  }
  if (
    artifact.artifactSha256 !== manifest.artifactSha256 ||
    artifact.artifactFileCount !== manifest.artifactFileCount
  ) {
    return {
      state: 'artifact_mismatch',
      detail: 'Compiled artifact contents do not match the build manifest.',
      manifest,
      artifactVerified: false,
    };
  }
  if (
    options?.expectedGitCommit &&
    manifest.gitCommit !== options.expectedGitCommit
  ) {
    return {
      state: 'commit_mismatch',
      detail: 'Build manifest commit does not match the runtime Git commit.',
      manifest,
      artifactVerified: true,
    };
  }
  if (manifest.gitDirtyPathCount > 0) {
    return {
      state: 'dirty_source',
      detail: `Build was created with ${manifest.gitDirtyPathCount} uncommitted path(s).`,
      manifest,
      artifactVerified: true,
    };
  }
  return {
    state: 'verified',
    detail: 'Compiled artifact matches a clean committed source tree.',
    manifest,
    artifactVerified: true,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (
  invokedPath === fileURLToPath(import.meta.url) &&
  process.argv.includes('--write')
) {
  const manifest = writeBuildProvenance();
  process.stdout.write(
    `Build provenance written: commit=${manifest.gitCommit.slice(0, 8)} dirty_paths=${manifest.gitDirtyPathCount} files=${manifest.artifactFileCount}\n`,
  );
}
