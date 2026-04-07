import fs from 'fs';
import path from 'path';

export type ProviderProofStateKind =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'not_intended_for_trial';

export interface ProviderProofSurfaceState {
  proofState: ProviderProofStateKind;
  blocker: string;
  detail: string;
  nextAction: string;
  checkedAt: string;
  source: 'debug_research_mode' | 'verify';
}

export interface ProviderProofState {
  updatedAt: string;
  research: ProviderProofSurfaceState;
  imageGeneration: ProviderProofSurfaceState;
}

function getProviderProofStatePath(projectRoot = process.cwd()): string {
  return path.join(projectRoot, 'data', 'runtime', 'provider-proof-state.json');
}

function normalizeSurfaceState(
  value: unknown,
): ProviderProofSurfaceState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const proofState =
    typeof record.proofState === 'string' ? record.proofState.trim() : '';
  if (
    proofState !== 'live_proven' &&
    proofState !== 'near_live_only' &&
    proofState !== 'externally_blocked' &&
    proofState !== 'not_intended_for_trial'
  ) {
    return null;
  }

  return {
    proofState,
    blocker: typeof record.blocker === 'string' ? record.blocker : '',
    detail: typeof record.detail === 'string' ? record.detail : '',
    nextAction: typeof record.nextAction === 'string' ? record.nextAction : '',
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : '',
    source:
      record.source === 'verify' ? 'verify' : 'debug_research_mode',
  };
}

export function readProviderProofState(
  projectRoot = process.cwd(),
): ProviderProofState | null {
  const filePath = getProviderProofStatePath(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const research = normalizeSurfaceState(parsed.research);
    const imageGeneration = normalizeSurfaceState(parsed.imageGeneration);
    if (!research || !imageGeneration) return null;
    return {
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
      research,
      imageGeneration,
    };
  } catch {
    return null;
  }
}

export function writeProviderProofState(
  state: ProviderProofState,
  projectRoot = process.cwd(),
): ProviderProofState {
  const normalized: ProviderProofState = {
    updatedAt: state.updatedAt || new Date().toISOString(),
    research: {
      ...state.research,
      blocker: state.research.blocker || '',
      detail: state.research.detail || '',
      nextAction: state.research.nextAction || '',
      checkedAt: state.research.checkedAt || state.updatedAt,
      source: state.research.source || 'debug_research_mode',
    },
    imageGeneration: {
      ...state.imageGeneration,
      blocker: state.imageGeneration.blocker || '',
      detail: state.imageGeneration.detail || '',
      nextAction: state.imageGeneration.nextAction || '',
      checkedAt: state.imageGeneration.checkedAt || state.updatedAt,
      source: state.imageGeneration.source || 'debug_research_mode',
    },
  };
  const filePath = getProviderProofStatePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}
