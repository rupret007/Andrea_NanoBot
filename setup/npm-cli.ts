import fs from 'fs';
import path from 'path';

interface ResolveNpmCliOptions {
  npmExecPath?: string | null;
  nodePath?: string;
  platform?: NodeJS.Platform;
}

export interface NpmRunInvocation {
  command: string;
  args: string[];
  shell: false;
}

function resolveRegularNpmCli(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  if (path.basename(resolved).toLowerCase() !== 'npm-cli.js') return null;

  try {
    const stat = fs.lstatSync(resolved);
    return stat.isFile() && !stat.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveNpmCliPath(options: ResolveNpmCliOptions = {}): string {
  const nodePath = options.nodePath || process.execPath;
  const platform = options.platform || process.platform;
  const npmExecPath = options.npmExecPath ?? process.env.npm_execpath;
  const candidates: string[] = [];

  if (npmExecPath?.trim()) candidates.push(npmExecPath.trim());

  if (platform === 'win32') {
    candidates.push(
      path.join(
        path.dirname(nodePath),
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      ),
    );
  } else {
    candidates.push(
      path.resolve(
        path.dirname(nodePath),
        '..',
        'lib',
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js',
      ),
    );
  }

  for (const candidate of candidates) {
    const resolved = resolveRegularNpmCli(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    'Could not resolve a regular npm-cli.js file. Run setup through npm or repair the pinned Node runtime.',
  );
}

export function buildNpmRunInvocation(
  scriptName: string,
  options: ResolveNpmCliOptions = {},
): NpmRunInvocation {
  if (!/^[A-Za-z0-9:_-]+$/.test(scriptName)) {
    throw new Error(`Invalid npm script name: ${scriptName}`);
  }

  const nodePath = options.nodePath || process.execPath;
  return {
    command: nodePath,
    args: [resolveNpmCliPath({ ...options, nodePath }), 'run', scriptName],
    shell: false,
  };
}
