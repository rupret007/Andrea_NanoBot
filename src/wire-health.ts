/**
 * Wire Health Module
 *
 * Surfaces build/runtime freshness for Bob to detect stale binaries after
 * branch flips. Exposes git tip, package version, and dist/build mtime so
 * external orchestrators can verify NanoBot is running the expected code.
 *
 * This module is part of the "NanoBot is wire-only" architecture boundary.
 */

import fs from 'fs';
import path from 'path';

import { readBuildProvenance } from './build-provenance.js';

export interface WireHealthSnapshot {
  packageVersion: string;
  gitCommit: string;
  gitBranch: string;
  gitDirtyPathCount: number | null;
  buildAt: string | null;
  buildArtifactSha256: string | null;
  buildArtifactFileCount: number | null;
  distMtime: string | null;
  snapshotAt: string;
}

function readPackageVersion(projectRoot: string): string {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readDistMtime(projectRoot: string): string | null {
  try {
    const distPath = path.join(projectRoot, 'dist');
    const stat = fs.statSync(distPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export function buildWireHealthSnapshot(
  projectRoot: string = process.cwd(),
): WireHealthSnapshot {
  const provenance = readBuildProvenance(projectRoot);
  const packageVersion = readPackageVersion(projectRoot);
  const distMtime = readDistMtime(projectRoot);

  return {
    packageVersion,
    gitCommit: provenance?.gitCommit || 'unknown',
    gitBranch: provenance?.gitBranch || 'unknown',
    gitDirtyPathCount: provenance?.gitDirtyPathCount ?? null,
    buildAt: provenance?.builtAt || null,
    buildArtifactSha256: provenance?.artifactSha256 || null,
    buildArtifactFileCount: provenance?.artifactFileCount ?? null,
    distMtime,
    snapshotAt: new Date().toISOString(),
  };
}

export function formatWireHealthStatus(snapshot: WireHealthSnapshot): string {
  const lines = [
    '*Wire Health*',
    `- Package version: ${snapshot.packageVersion}`,
    `- Git commit: ${snapshot.gitCommit}`,
    `- Git branch: ${snapshot.gitBranch}`,
    `- Git dirty paths: ${snapshot.gitDirtyPathCount ?? 'unknown'}`,
    `- Build time: ${snapshot.buildAt || 'unknown'}`,
    `- Dist mtime: ${snapshot.distMtime || 'unknown'}`,
    `- Artifact SHA256: ${snapshot.buildArtifactSha256 ? snapshot.buildArtifactSha256.slice(0, 16) + '…' : 'unknown'}`,
    `- Artifact file count: ${snapshot.buildArtifactFileCount ?? 'unknown'}`,
    `- Snapshot at: ${snapshot.snapshotAt}`,
  ];
  return lines.join('\n');
}

export interface WireFreshnessCheck {
  fresh: boolean;
  reason: string;
  expectedCommit: string | null;
  actualCommit: string;
  commitMatch: boolean;
  buildProvenancePresent: boolean;
  buildClean: boolean;
}

export function checkWireFreshness(
  snapshot: WireHealthSnapshot,
  expectedCommit?: string | null,
): WireFreshnessCheck {
  const actualCommit = snapshot.gitCommit;
  const commitMatch =
    !expectedCommit ||
    expectedCommit === actualCommit ||
    actualCommit === 'unknown';
  const buildProvenancePresent = snapshot.buildAt !== null;
  const buildClean =
    snapshot.gitDirtyPathCount === null || snapshot.gitDirtyPathCount === 0;

  let fresh = true;
  let reason = 'Wire is fresh and aligned.';

  if (actualCommit === 'unknown') {
    fresh = false;
    reason = 'Build provenance missing; cannot verify wire freshness.';
  } else if (!commitMatch) {
    fresh = false;
    reason = `Wire commit ${actualCommit.slice(0, 8)} does not match expected ${expectedCommit?.slice(0, 8) || 'unknown'}.`;
  } else if (!buildProvenancePresent) {
    fresh = false;
    reason = 'Build provenance missing; wire may be stale.';
  } else if (!buildClean) {
    fresh = false;
    reason = `Build created with ${snapshot.gitDirtyPathCount} uncommitted path(s).`;
  }

  return {
    fresh,
    reason,
    expectedCommit: expectedCommit || null,
    actualCommit,
    commitMatch,
    buildProvenancePresent,
    buildClean,
  };
}
