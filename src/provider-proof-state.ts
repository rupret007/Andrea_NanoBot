import fs from 'fs';
import path from 'path';

export type ProviderProofStateKind =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'degraded_but_usable'
  | 'not_intended_for_trial';

export type ProviderProofSource =
  | 'debug_research_mode'
  | 'debug_google_calendar'
  | 'verify';

export interface ProviderProofSurfaceState {
  proofState: ProviderProofStateKind;
  blocker: string;
  detail: string;
  nextAction: string;
  checkedAt: string;
  source: ProviderProofSource;
}

export interface ProviderProofState {
  updatedAt: string;
  research?: ProviderProofSurfaceState | null;
  imageGeneration?: ProviderProofSurfaceState | null;
  googleCalendar?: ProviderProofSurfaceState | null;
}

export type ProviderProofSurfaceKey = Exclude<
  keyof ProviderProofState,
  'updatedAt'
>;

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
    proofState !== 'degraded_but_usable' &&
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
      record.source === 'verify' || record.source === 'debug_google_calendar'
        ? record.source
        : 'debug_research_mode',
  };
}

function normalizeWriteSurfaceState(
  value: ProviderProofSurfaceState | null | undefined,
  updatedAt: string,
): ProviderProofSurfaceState | undefined {
  if (!value) return undefined;
  return {
    ...value,
    blocker: value.blocker || '',
    detail: value.detail || '',
    nextAction: value.nextAction || '',
    checkedAt: value.checkedAt || updatedAt,
    source: value.source || 'debug_research_mode',
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
    const googleCalendar = normalizeSurfaceState(parsed.googleCalendar);
    if (!research && !imageGeneration && !googleCalendar) return null;
    return {
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
      research,
      imageGeneration,
      googleCalendar,
    };
  } catch {
    return null;
  }
}

export function writeProviderProofState(
  state: ProviderProofState,
  projectRoot = process.cwd(),
): ProviderProofState {
  const existing = readProviderProofState(projectRoot);
  const updatedAt =
    state.updatedAt || existing?.updatedAt || new Date().toISOString();
  const normalized: ProviderProofState = {
    updatedAt,
    research: normalizeWriteSurfaceState(
      state.research === undefined ? existing?.research : state.research,
      updatedAt,
    ),
    imageGeneration: normalizeWriteSurfaceState(
      state.imageGeneration === undefined
        ? existing?.imageGeneration
        : state.imageGeneration,
      updatedAt,
    ),
    googleCalendar: normalizeWriteSurfaceState(
      state.googleCalendar === undefined
        ? existing?.googleCalendar
        : state.googleCalendar,
      updatedAt,
    ),
  };
  const filePath = getProviderProofStatePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serializable: ProviderProofState = {
    updatedAt: normalized.updatedAt,
    ...(normalized.research ? { research: normalized.research } : {}),
    ...(normalized.imageGeneration
      ? { imageGeneration: normalized.imageGeneration }
      : {}),
    ...(normalized.googleCalendar
      ? { googleCalendar: normalized.googleCalendar }
      : {}),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(serializable, null, 2)}\n`);
  return normalized;
}

export function writeProviderProofSurface(
  surfaceKey: ProviderProofSurfaceKey,
  surface: ProviderProofSurfaceState | null,
  projectRoot = process.cwd(),
): ProviderProofState {
  return writeProviderProofState(
    {
      updatedAt: new Date().toISOString(),
      [surfaceKey]: surface,
    } as ProviderProofState,
    projectRoot,
  );
}
