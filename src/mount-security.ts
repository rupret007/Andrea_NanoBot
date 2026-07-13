/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js';

// Cache the allowlist in memory - only reloads on process restart
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate the external mount authority configuration without coercion. */
export function parseMountAllowlist(value: unknown): MountAllowlist {
  if (!isPlainObject(value)) {
    throw new Error('Mount allowlist must be an object');
  }
  if (!Array.isArray(value.allowedRoots)) {
    throw new Error('allowedRoots must be an array');
  }
  if (!Array.isArray(value.blockedPatterns)) {
    throw new Error('blockedPatterns must be an array');
  }
  if (typeof value.nonMainReadOnly !== 'boolean') {
    throw new Error('nonMainReadOnly must be a boolean');
  }

  const allowedRoots = value.allowedRoots.map((entry, index): AllowedRoot => {
    if (
      !isPlainObject(entry) ||
      typeof entry.path !== 'string' ||
      entry.path.trim().length === 0 ||
      typeof entry.allowReadWrite !== 'boolean' ||
      (entry.description !== undefined && typeof entry.description !== 'string')
    ) {
      throw new Error(`allowedRoots[${index}] is invalid`);
    }
    return {
      path: entry.path,
      allowReadWrite: entry.allowReadWrite,
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
    };
  });
  const blockedPatterns = value.blockedPatterns.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`blockedPatterns[${index}] must be a nonempty string`);
    }
    return entry;
  });

  return {
    allowedRoots,
    blockedPatterns,
    nonMainReadOnly: value.nonMainReadOnly,
  };
}

/**
 * Default blocked patterns - paths that should never be mounted
 */
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.codex',
  '.claude',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  if (allowlistLoadError !== null) {
    // Already tried and failed, don't spam logs
    return null;
  }

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      // Do NOT cache this as an error — file may be created later without restart.
      // Only parse/structural errors are permanently cached.
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found - additional mounts will be BLOCKED. ' +
          'Create the file to enable additional mounts.',
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = parseMountAllowlist(JSON.parse(content));

    // Merge with default blocked patterns
    const mergedBlockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ];
    allowlist.blockedPatterns = mergedBlockedPatterns;

    cachedAllowlist = allowlist;
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );

    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        path: MOUNT_ALLOWLIST_PATH,
        error: allowlistLoadError,
      },
      'Failed to load mount allowlist - additional mounts will be BLOCKED',
    );
    return null;
  }
}

/**
 * Expand ~ to home directory and resolve to absolute path
 */
function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

/**
 * Get the real path, resolving symlinks.
 * Returns null if the path doesn't exist.
 */
function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern
 */
function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    // Check if any path component matches the pattern
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    // Also check if the full path contains the pattern
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Check if a real path is under an allowed root
 */
function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      // Allowed root doesn't exist, skip it
      continue;
    }

    // Check if realPath is under realRoot
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root;
    }
  }

  return null;
}

/**
 * Validate the container path to prevent escaping /workspace/extra/
 */
export function isValidContainerPath(containerPath: string): boolean {
  // Docker/Podman --mount uses comma-delimited key/value fields. Accept only
  // simple relative POSIX segments so a user-controlled destination can never
  // inject another source, target, or mount option.
  const segments = containerPath.split('/');
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    )
  );
}

export function isValidHostMountPath(hostPath: string): boolean {
  return (
    hostPath.length > 0 &&
    !hostPath.includes(',') &&
    !Array.from(hostPath).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

export function isDirectoryMountSource(realPath: string): boolean {
  try {
    return fs.lstatSync(realPath).isDirectory();
  } catch {
    return false;
  }
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

/**
 * Validate a single additional mount against the allowlist.
 * Returns validation result with reason.
 */
export function validateMount(
  mount: AdditionalMount,
  isMain: boolean,
): MountValidationResult {
  const allowlist = loadMountAllowlist();

  // If no allowlist, block all additional mounts
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  // Docker and Podman parse --mount as a comma-delimited option string. Fail
  // closed before filesystem resolution so a host path can never inject a new
  // source, target, or mount option into that string.
  if (!isValidHostMountPath(mount.hostPath)) {
    return {
      allowed: false,
      reason:
        'Invalid host path - commas and control characters are not supported for additional mounts',
    };
  }

  // Derive containerPath from hostPath basename if not specified
  const containerPath = mount.containerPath || path.basename(mount.hostPath);

  // Validate container path (cheap check)
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - use only relative alphanumeric, dot, underscore, hyphen, and slash-separated segments`,
    };
  }

  // Expand and resolve the host path
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // Additional mounts are directory-only. Accepting a regular file, FIFO,
  // device, or Unix socket beneath an allowed root could expose a privileged
  // host control surface (for example a container-runtime socket).
  if (!isDirectoryMountSource(realPath)) {
    return {
      allowed: false,
      reason: `Host path is not a directory: "${realPath}"`,
    };
  }

  // Check against blocked patterns
  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // Check if under an allowed root
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(', ')}`,
    };
  }

  // Determine effective readonly status
  const requestedReadWrite = mount.readonly === false;
  let effectiveReadonly = true; // Default to readonly

  if (requestedReadWrite) {
    if (!isMain && allowlist.nonMainReadOnly) {
      // Non-main groups forced to read-only
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
        },
        'Mount forced to read-only for non-main group',
      );
    } else if (!allowedRoot.allowReadWrite) {
      // Root doesn't allow read-write
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
          root: allowedRoot.path,
        },
        'Mount forced to read-only - root does not allow read-write',
      );
    } else {
      // Read-write allowed
      effectiveReadonly = false;
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount, isMain);

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: result.resolvedContainerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }

  return validatedMounts;
}

/**
 * Generate a template allowlist file for users to customize
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/repos',
        allowReadWrite: true,
        description: 'Git repositories',
      },
      {
        path: '~/Documents/work',
        allowReadWrite: false,
        description: 'Work documents (read-only)',
      },
    ],
    blockedPatterns: [
      // Additional patterns beyond defaults
      'password',
      'secret',
      'token',
    ],
    nonMainReadOnly: true,
  };

  return JSON.stringify(template, null, 2);
}
