import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawnSync } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function getProjectRoot() {
  return path.resolve(path.dirname(SCRIPT_PATH), '..');
}

export function normalizePinnedNodeVersion(rawValue) {
  const trimmed = String(rawValue || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    throw new Error(
      `.nvmrc must pin an exact Node version like 22.22.2. Found: ${rawValue || 'empty'}`,
    );
  }
  return trimmed;
}

export function readPinnedNodeVersion(projectRoot = getProjectRoot()) {
  const filePath = path.join(projectRoot, '.nvmrc');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing .nvmrc at ${filePath}`);
  }
  return normalizePinnedNodeVersion(fs.readFileSync(filePath, 'utf-8'));
}

export function resolvePinnedNodePaths({
  projectRoot = getProjectRoot(),
  version,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== 'win32') {
    return {
      runtimeDir: '',
      installDir: '',
      nodePath: process.execPath,
      metadataPath: path.join(projectRoot, 'data', 'runtime', 'node-runtime.json'),
      archiveUrl: '',
      archivePath: '',
      version,
      platform,
      arch,
    };
  }

  if (arch !== 'x64') {
    throw new Error(
      `Pinned Windows runtime currently supports x64 only. Detected ${arch}.`,
    );
  }

  const runtimeDir = path.join(projectRoot, 'data', 'runtime');
  const folderName = `node-v${version}-win-x64`;
  const archiveName = `${folderName}.zip`;
  const installDir = path.join(runtimeDir, folderName);
  return {
    runtimeDir,
    installDir,
    nodePath: path.join(installDir, 'node.exe'),
    metadataPath: path.join(runtimeDir, 'node-runtime.json'),
    archiveUrl: `https://nodejs.org/dist/v${version}/${archiveName}`,
    archivePath: path.join(runtimeDir, archiveName),
    version,
    platform,
    arch,
  };
}

export function readNodeRuntimeMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeNodeRuntimeMetadata(metadataPath, metadata) {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export function validateNodeBinary(nodePath, expectedVersion) {
  if (!fs.existsSync(nodePath)) return false;
  const result = spawnSync(nodePath, ['--version'], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) return false;
  return result.stdout.trim() === `v${expectedVersion}`;
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destinationPath),
  );
}

async function waitForFileReady(filePath, attempts = 12, delayMs = 250) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const handle = await fs.promises.open(filePath, 'r');
      await handle.close();
      return;
    } catch (err) {
      if (index === attempts - 1) {
        throw err;
      }
      await delay(delayMs);
    }
  }
}

function extractWindowsArchive(archivePath, destinationPath) {
  fs.rmSync(destinationPath, { recursive: true, force: true });
  fs.mkdirSync(destinationPath, { recursive: true });
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationPath.replace(/'/g, "''")}' -Force`,
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf-8' },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Failed to extract pinned Node runtime: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

async function installWindowsPinnedNode(paths, expectedVersion) {
  const tempRoot = path.join(
    paths.runtimeDir,
    `_node-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const extractedFolder = path.join(tempRoot, path.basename(paths.installDir));

  await downloadFile(paths.archiveUrl, paths.archivePath);
  await waitForFileReady(paths.archivePath);
  extractWindowsArchive(paths.archivePath, tempRoot);
  if (!fs.existsSync(extractedFolder)) {
    throw new Error(`Pinned Node archive did not produce ${extractedFolder}`);
  }

  fs.rmSync(paths.installDir, { recursive: true, force: true });
  fs.renameSync(extractedFolder, paths.installDir);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(paths.archivePath, { force: true });

  if (!validateNodeBinary(paths.nodePath, expectedVersion)) {
    throw new Error(`Pinned Node binary failed validation at ${paths.nodePath}`);
  }
}

export async function ensurePinnedNodeRuntime(options = {}) {
  const projectRoot = options.projectRoot || getProjectRoot();
  const version = options.version || readPinnedNodeVersion(projectRoot);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const paths = resolvePinnedNodePaths({
    projectRoot,
    version,
    platform,
    arch,
  });

  if (platform !== 'win32') {
    return {
      nodePath: process.execPath,
      version,
      metadataPath: paths.metadataPath,
      metadata: null,
    };
  }

  const downloadAndInstall =
    options.downloadAndInstall || installWindowsPinnedNode;
  const validator = options.validateNodeBinary || validateNodeBinary;
  const existingMetadata = readNodeRuntimeMetadata(paths.metadataPath);
  const metadataMatches =
    existingMetadata &&
    existingMetadata.version === version &&
    existingMetadata.nodePath === paths.nodePath &&
    validator(paths.nodePath, version);

  if (!metadataMatches) {
    await downloadAndInstall(paths, version);
  }

  const validatedAt = (options.now || (() => new Date().toISOString()))();
  const metadata = {
    version,
    nodePath: paths.nodePath,
    platform: `${platform}-${arch}`,
    sourceUrl: paths.archiveUrl,
    validatedAt,
  };
  writeNodeRuntimeMetadata(paths.metadataPath, metadata);

  return {
    nodePath: paths.nodePath,
    version,
    metadataPath: paths.metadataPath,
    metadata,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = getProjectRoot();

  const printNodePath = args.includes('--print-node-path');
  const verifyOnly = args.includes('--verify-only');
  const filteredArgs = args.filter(
    (arg) => arg !== '--print-node-path' && arg !== '--verify-only',
  );

  const runtime = await ensurePinnedNodeRuntime({ projectRoot });

  if (printNodePath) {
    process.stdout.write(`${runtime.nodePath}\n`);
    return;
  }

  if (verifyOnly) {
    return;
  }

  if (filteredArgs.length === 0) {
    throw new Error(
      'Usage: node scripts/run-with-pinned-node.mjs [--verify-only|--print-node-path] <script> [args...]',
    );
  }

  const result = spawnSync(runtime.nodePath, filteredArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NANOCLAW_PINNED_NODE_PATH: runtime.nodePath,
      NANOCLAW_PINNED_NODE_VERSION: runtime.version,
    },
  });

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
