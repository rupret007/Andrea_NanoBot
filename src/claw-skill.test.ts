import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('retired claw skill script', () => {
  it('fails closed before the preserved legacy runner can inspect state or start a container', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'claw', 'scripts', 'claw'),
      'utf8',
    );
    const retirementMessage = script.indexOf(
      'claw is retired and cannot start an alternate agent runner',
    );
    const failClosed = script.indexOf('raise SystemExit(78)');
    const firstLegacyImport = script.indexOf('import argparse');
    const firstLegacyStateRead = script.indexOf('NANOCLAW_DIR =');
    const legacyContainerEntry = script.indexOf('def run_container(');

    expect(script.startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(retirementMessage).toBeGreaterThan(0);
    expect(failClosed).toBeGreaterThan(retirementMessage);
    expect(firstLegacyImport).toBeGreaterThan(failClosed);
    expect(firstLegacyStateRead).toBeGreaterThan(failClosed);
    expect(legacyContainerEntry).toBeGreaterThan(failClosed);
    expect(script.slice(0, failClosed)).not.toMatch(
      /\.env|messages\.db|subprocess|docker|podman|Apple Container/i,
    );
  });
});
