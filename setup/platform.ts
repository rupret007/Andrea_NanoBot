/**
 * Cross-platform detection utilities for NanoClaw setup.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

export type Platform = 'macos' | 'linux' | 'windows' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execFileSync('open', [url], { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // Try xdg-open first, then wslview for WSL
      if (commandExists('xdg-open')) {
        execFileSync('xdg-open', [url], { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execFileSync('wslview', [url], { stdio: 'ignore' });
        return true;
      }
      // WSL without wslview: try cmd.exe
      if (isWSL()) {
        try {
          execFileSync('cmd.exe', ['/c', 'start', '', url], {
            stdio: 'ignore',
          });
          return true;
        } catch {
          // cmd.exe not available
        }
      }
    }
    if (platform === 'windows') {
      execFileSync('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore' });
      return true;
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

export function getNodePath(): string {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('where.exe', ['node'], {
        encoding: 'utf-8',
      }).trim();
      const candidates = output.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
      const preferred = candidates.find((candidate) => {
        const normalized = candidate.replace(/\\/g, '/').toLowerCase();
        return (
          !normalized.includes('/.npm/_npx/') &&
          !normalized.includes('/npm-cache/_npx/') &&
          !normalized.includes('/appdata/local/npm-cache/_npx/')
        );
      });
      return preferred || candidates[0] || process.execPath;
    }
    return execFileSync('which', ['node'], { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [name], { stdio: 'ignore' });
    } else {
      execFileSync('which', [name], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const runtimeVersion = process.versions.node?.trim();
    if (runtimeVersion) return runtimeVersion.replace(/^v/, '');

    const shellVersion = execFileSync('node', ['--version'], {
      encoding: 'utf-8',
    }).trim();
    return shellVersion.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
