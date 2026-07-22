import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CursorDesktopEntrypoints {
  appInstalled: boolean;
  desktopCliPath: string | null;
  agentCliPath: string | null;
  agentExecutionStatus: 'not_installed' | 'installed_needs_auth_proof';
  detail: string;
}

function executableRealPath(candidate: string | undefined): string | null {
  if (!candidate?.trim()) return null;
  const resolved = path.resolve(candidate.trim());
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return fs.realpathSync(resolved);
  } catch {
    return null;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)) {
    const found = executableRealPath(path.join(directory, name));
    if (found) return found;
  }
  return null;
}

export function inspectCursorDesktopEntrypoints(
  env: NodeJS.ProcessEnv = process.env,
): CursorDesktopEntrypoints {
  const appExecutable = executableRealPath(
    '/Applications/Cursor.app/Contents/MacOS/Cursor',
  );
  const bundledCli = executableRealPath(
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
  );
  const explicitAgent = executableRealPath(env.CURSOR_DESKTOP_AGENT_CLI_PATH);
  const explicitLegacy = executableRealPath(env.CURSOR_DESKTOP_CLI_PATH);
  const legacyBasename = explicitLegacy
    ? path.basename(explicitLegacy).toLowerCase()
    : '';
  const legacyIsStandaloneAgent =
    legacyBasename === 'cursor-agent' || legacyBasename === 'agent';
  const agentCliPath =
    explicitAgent ||
    (legacyIsStandaloneAgent ? explicitLegacy : null) ||
    executableRealPath(path.join(os.homedir(), '.local/bin/cursor-agent')) ||
    findOnPath('cursor-agent', env);
  const desktopCliPath =
    (legacyIsStandaloneAgent ? null : explicitLegacy) ||
    bundledCli ||
    findOnPath('cursor', env) ||
    appExecutable;

  return {
    appInstalled: Boolean(appExecutable),
    desktopCliPath,
    agentCliPath,
    agentExecutionStatus: agentCliPath
      ? 'installed_needs_auth_proof'
      : 'not_installed',
    detail: agentCliPath
      ? 'A standalone Cursor agent executable exists. Authentication and disposable-worktree execution still require proof.'
      : desktopCliPath
        ? 'Cursor desktop/launcher CLI exists, but no standalone agent executable is installed. The launcher `agent` subcommand is not probed because it may auto-install software.'
        : 'No supported Cursor desktop or standalone agent executable was found.',
  };
}
