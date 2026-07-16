import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveReceiptInboxBuildId } from './bluebubbles-receipt-inbox-main.js';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const LABEL = 'com.nanoclaw.bluebubbles-receipt-inbox';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('BlueBubbles receipt inbox launchd supervision', () => {
  it('keeps source execution explicitly in development mode', () => {
    expect(resolveReceiptInboxBuildId()).toBe('development-source');
  });

  it('binds compiled sidecar verification to its module path and Git HEAD', () => {
    const source = read('src/bluebubbles-receipt-inbox-main.ts');
    expect(source).toContain('resolveRuntimeArtifactContext(');
    expect(source).toContain("'bluebubbles-receipt-inbox-main.js'");
    expect(source).toContain('readCurrentGitCommit(projectRoot)');
    expect(source).toContain('requireVerifiedRuntimeBuild({');
    expect(source).not.toContain('projectRoot: process.cwd()');
  });

  it('uses a fixed independent always-on LaunchAgent contract', () => {
    const template = read(
      'launchd/com.nanoclaw.bluebubbles-receipt-inbox.plist.template',
    );
    expect(template).toContain(`<string>${LABEL}</string>`);
    expect(template).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/u);
    expect(template).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/u);
    expect(template).toMatch(
      /<key>ThrottleInterval<\/key>\s*<integer>15<\/integer>/u,
    );
    expect(template).toContain('scripts/bluebubbles-receipt-inbox-runner.sh');
    expect(template).toContain('/stdout.log');
    expect(template).toContain('/stderr.log');
  });

  it('runs only the compiled sidecar with a private umask and pinned Node', () => {
    const runner = read('scripts/bluebubbles-receipt-inbox-runner.sh');
    expect(runner).toContain('umask 077');
    expect(runner).toContain(
      'node scripts/run-with-pinned-node.mjs --print-node-path',
    );
    expect(runner).toContain('dist/bluebubbles-receipt-inbox-main.js');
    expect(runner).toContain('git -C "$PROJECT_ROOT" rev-parse HEAD');
    expect(runner).toContain('scripts/verify-build-manifest-id.mjs');
    expect(runner).toContain('exec "$PINNED_NODE_PATH" "$ENTRYPOINT"');
    expect(runner).not.toMatch(/^\s*npm run build(?:\s|$)/mu);
  });

  it('keeps the main restart manager outside the sidecar label', () => {
    const mainManager = read('scripts/mac-mini-service.sh');
    const receiptManager = read('scripts/bluebubbles-receipt-inbox-service.sh');
    expect(mainManager).not.toContain(LABEL);
    expect(receiptManager).toContain(`LABEL="${LABEL}"`);
    expect(receiptManager).not.toContain('scripts/mac-mini-service.sh');
  });

  it('exposes deliberate lifecycle commands without a generic start command', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    const prefix = 'mac:bluebubbles-receipt-inbox:';
    for (const command of [
      'dry-run',
      'install',
      'status',
      'restart',
      'stop',
      'uninstall',
    ]) {
      expect(packageJson.scripts[`${prefix}${command}`]).toContain(
        `bluebubbles-receipt-inbox-service.sh ${command}`,
      );
    }
    expect(packageJson.scripts[`${prefix}start`]).toBeUndefined();
  });
});
