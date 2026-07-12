import fs from 'node:fs';
import path from 'node:path';

export interface AtomicJsonFileOps {
  mkdirSync: (targetPath: string, options: { recursive: true }) => unknown;
  writeFileSync: (
    targetPath: string,
    data: string,
    options: { encoding: 'utf8'; mode: number },
  ) => unknown;
  renameSync: (oldPath: string, newPath: string) => unknown;
  rmSync: (targetPath: string, options: { force: true }) => unknown;
}

let atomicWriteCounter = 0;

/**
 * Writes a small JSON state file without truncating the last known-good file
 * first. This matters under ENOSPC: a failed health-marker refresh must not
 * destroy the prior readable marker and make diagnosis harder.
 */
export function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  ops: AtomicJsonFileOps = fs,
): void {
  const directory = path.dirname(filePath);
  ops.mkdirSync(directory, { recursive: true });
  atomicWriteCounter += 1;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${atomicWriteCounter}.tmp`,
  );
  try {
    ops.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    ops.renameSync(temporaryPath, filePath);
  } finally {
    ops.rmSync(temporaryPath, { force: true });
  }
}
