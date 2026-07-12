import fs from 'node:fs';

export const HOST_DISK_WARNING_AVAILABLE_BYTES = 5 * 1024 ** 3;
export const HOST_DISK_CRITICAL_AVAILABLE_BYTES = 1 * 1024 ** 3;
export const HOST_DISK_WARNING_AVAILABLE_PERCENT = 5;
export const HOST_DISK_CRITICAL_AVAILABLE_PERCENT = 1;
export const HOST_INODE_WARNING_AVAILABLE_PERCENT = 5;
export const HOST_INODE_CRITICAL_AVAILABLE_PERCENT = 1;

export type HostDiskPressureState =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'unknown';

export interface HostDiskHealthReport {
  state: HostDiskPressureState;
  checkedAt: string;
  totalBytes: number | null;
  availableBytes: number | null;
  availablePercent: number | null;
  totalInodes: number | null;
  availableInodes: number | null;
  availableInodePercent: number | null;
  probeErrorCode: string | null;
  summary: string;
  nextAction: string;
  automaticCleanupAllowed: false;
}

export interface HostFilesystemStats {
  bsize: number | bigint;
  blocks: number | bigint;
  bavail: number | bigint;
  files?: number | bigint;
  ffree?: number | bigint;
}

function finiteNonnegative(value: number | bigint | undefined): number | null {
  if (value === undefined) return null;
  const numberValue = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function percent(
  available: number | null,
  total: number | null,
): number | null {
  if (available === null || total === null || total <= 0) return null;
  return Number(
    Math.max(0, Math.min(100, (available / total) * 100)).toFixed(2),
  );
}

export function formatHostBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function classifyHostDiskHealth(input: {
  totalBytes: number;
  availableBytes: number;
  totalInodes?: number | null;
  availableInodes?: number | null;
  checkedAt?: string;
}): HostDiskHealthReport {
  const totalBytes = Math.max(0, input.totalBytes);
  const availableBytes = Math.max(0, input.availableBytes);
  const availablePercent = percent(availableBytes, totalBytes);
  const totalInodes =
    input.totalInodes === undefined || input.totalInodes === null
      ? null
      : Math.max(0, input.totalInodes);
  const availableInodes =
    input.availableInodes === undefined || input.availableInodes === null
      ? null
      : Math.max(0, input.availableInodes);
  const availableInodePercent = percent(availableInodes, totalInodes);
  const critical =
    availableBytes < HOST_DISK_CRITICAL_AVAILABLE_BYTES ||
    (availablePercent !== null &&
      availablePercent < HOST_DISK_CRITICAL_AVAILABLE_PERCENT) ||
    (availableInodePercent !== null &&
      availableInodePercent < HOST_INODE_CRITICAL_AVAILABLE_PERCENT);
  const warning =
    !critical &&
    (availableBytes < HOST_DISK_WARNING_AVAILABLE_BYTES ||
      (availablePercent !== null &&
        availablePercent < HOST_DISK_WARNING_AVAILABLE_PERCENT) ||
      (availableInodePercent !== null &&
        availableInodePercent < HOST_INODE_WARNING_AVAILABLE_PERCENT));
  const state: HostDiskPressureState = critical
    ? 'critical'
    : warning
      ? 'warning'
      : 'healthy';
  const inodeSuffix =
    availableInodePercent !== null &&
    availableInodePercent < HOST_INODE_WARNING_AVAILABLE_PERCENT
      ? `; ${availableInodePercent.toFixed(2)}% inodes free`
      : '';
  const summary = `${formatHostBytes(availableBytes)} available (${(availablePercent || 0).toFixed(2)}% free)${inodeSuffix}`;
  const recommendedAvailableBytes = Math.max(
    HOST_DISK_WARNING_AVAILABLE_BYTES,
    totalBytes * (HOST_DISK_WARNING_AVAILABLE_PERCENT / 100),
  );
  return {
    state,
    checkedAt: input.checkedAt || new Date().toISOString(),
    totalBytes,
    availableBytes,
    availablePercent,
    totalInodes,
    availableInodes,
    availableInodePercent,
    probeErrorCode: null,
    summary,
    nextAction:
      state === 'healthy'
        ? ''
        : `Review owner-controlled disk usage and free space safely; do not delete Docker images, containers, evidence, or user files automatically. Target at least ${formatHostBytes(recommendedAvailableBytes)} free, then rerun npm run integrations:doctor.`,
    automaticCleanupAllowed: false,
  };
}

export function probeHostDiskHealth(
  params: {
    targetPath?: string;
    now?: Date;
    statfs?: (targetPath: string) => HostFilesystemStats;
  } = {},
): HostDiskHealthReport {
  const targetPath = params.targetPath || process.cwd();
  const checkedAt = (params.now || new Date()).toISOString();
  try {
    const stats = (params.statfs || ((value: string) => fs.statfsSync(value)))(
      targetPath,
    );
    const blockSize = finiteNonnegative(stats.bsize);
    const blocks = finiteNonnegative(stats.blocks);
    const availableBlocks = finiteNonnegative(stats.bavail);
    if (blockSize === null || blocks === null || availableBlocks === null) {
      throw Object.assign(new Error('invalid filesystem statistics'), {
        code: 'INVALID_STATS',
      });
    }
    return classifyHostDiskHealth({
      totalBytes: blockSize * blocks,
      availableBytes: blockSize * availableBlocks,
      totalInodes: finiteNonnegative(stats.files),
      availableInodes: finiteNonnegative(stats.ffree),
      checkedAt,
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || 'UNKNOWN')
        : 'UNKNOWN';
    return {
      state: 'unknown',
      checkedAt,
      totalBytes: null,
      availableBytes: null,
      availablePercent: null,
      totalInodes: null,
      availableInodes: null,
      availableInodePercent: null,
      probeErrorCode:
        code.replace(/[^A-Z0-9_-]/gi, '').slice(0, 40) || 'UNKNOWN',
      summary: 'filesystem capacity probe unavailable',
      nextAction:
        'Check free disk space with the host operating system, then rerun npm run integrations:doctor.',
      automaticCleanupAllowed: false,
    };
  }
}
