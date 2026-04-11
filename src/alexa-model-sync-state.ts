import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface AlexaModelSyncState {
  version: 1;
  interactionModelPath: string;
  interactionModelHash: string;
  syncedAt: string;
  syncedBy: string;
}

export interface AlexaModelSyncStatus {
  syncStatus: 'synced' | 'pending' | 'not_tracked';
  interactionModelPath: string;
  interactionModelHash: string;
  lastSyncedHash: string;
  lastSyncedAt: string;
  lastSyncedBy: string;
}

export function getAlexaInteractionModelPath(
  projectRoot = process.cwd(),
): string {
  return path.join(
    projectRoot,
    'docs',
    'alexa',
    'interaction-model.en-US.json',
  );
}

export function getAlexaModelSyncStatePath(
  projectRoot = process.cwd(),
): string {
  return path.join(
    projectRoot,
    'data',
    'runtime',
    'alexa-model-sync-state.json',
  );
}

export function computeAlexaInteractionModelHash(
  projectRoot = process.cwd(),
): string {
  const modelPath = getAlexaInteractionModelPath(projectRoot);
  if (!fs.existsSync(modelPath)) return 'missing';
  const raw = fs.readFileSync(modelPath);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function normalizeAlexaModelSyncState(
  value: unknown,
): AlexaModelSyncState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.interactionModelHash !== 'string') return null;
  return {
    version: 1,
    interactionModelPath:
      typeof record.interactionModelPath === 'string'
        ? record.interactionModelPath
        : '',
    interactionModelHash: record.interactionModelHash,
    syncedAt: typeof record.syncedAt === 'string' ? record.syncedAt : '',
    syncedBy: typeof record.syncedBy === 'string' ? record.syncedBy : '',
  };
}

export function readAlexaModelSyncState(
  projectRoot = process.cwd(),
): AlexaModelSyncState | null {
  const statePath = getAlexaModelSyncStatePath(projectRoot);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    return normalizeAlexaModelSyncState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeAlexaModelSyncState(
  state: AlexaModelSyncState,
  projectRoot = process.cwd(),
): AlexaModelSyncState {
  const statePath = getAlexaModelSyncStatePath(projectRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function markAlexaInteractionModelSynced(params?: {
  projectRoot?: string;
  syncedAt?: string;
  syncedBy?: string;
}): AlexaModelSyncState {
  const projectRoot = params?.projectRoot || process.cwd();
  const interactionModelPath = getAlexaInteractionModelPath(projectRoot);
  const interactionModelHash = computeAlexaInteractionModelHash(projectRoot);
  const state: AlexaModelSyncState = {
    version: 1,
    interactionModelPath,
    interactionModelHash,
    syncedAt: params?.syncedAt || new Date().toISOString(),
    syncedBy: params?.syncedBy || 'setup',
  };
  return writeAlexaModelSyncState(state, projectRoot);
}

export function getAlexaModelSyncStatus(
  projectRoot = process.cwd(),
): AlexaModelSyncStatus {
  const interactionModelPath = getAlexaInteractionModelPath(projectRoot);
  const interactionModelHash = computeAlexaInteractionModelHash(projectRoot);
  const persisted = readAlexaModelSyncState(projectRoot);

  if (
    interactionModelHash === 'missing' ||
    !fs.existsSync(interactionModelPath)
  ) {
    return {
      syncStatus: 'not_tracked',
      interactionModelPath,
      interactionModelHash,
      lastSyncedHash: persisted?.interactionModelHash || 'none',
      lastSyncedAt: persisted?.syncedAt || 'none',
      lastSyncedBy: persisted?.syncedBy || 'none',
    };
  }

  if (persisted?.interactionModelHash === interactionModelHash) {
    return {
      syncStatus: 'synced',
      interactionModelPath,
      interactionModelHash,
      lastSyncedHash: persisted.interactionModelHash,
      lastSyncedAt: persisted.syncedAt || 'none',
      lastSyncedBy: persisted.syncedBy || 'none',
    };
  }

  return {
    syncStatus: 'pending',
    interactionModelPath,
    interactionModelHash,
    lastSyncedHash: persisted?.interactionModelHash || 'none',
    lastSyncedAt: persisted?.syncedAt || 'none',
    lastSyncedBy: persisted?.syncedBy || 'none',
  };
}
