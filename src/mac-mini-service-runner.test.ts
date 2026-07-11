import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('mac mini service runner', () => {
  it('execs the verified pinned Node binary so launchd owns the real service', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'mac-mini-service-runner.sh'),
      'utf8',
    );

    expect(script).toContain(
      'PINNED_NODE_PATH="$(node scripts/run-with-pinned-node.mjs --print-node-path)"',
    );
    expect(script).toContain('exec "$PINNED_NODE_PATH" dist/index.js');
    expect(script).not.toContain(
      'exec node scripts/run-with-pinned-node.mjs dist/index.js',
    );
  });
});
