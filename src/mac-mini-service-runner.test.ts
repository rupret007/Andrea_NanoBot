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

  it('waits for a new boot and matching serving/build commit before reporting start success', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'mac-mini-service.sh'),
      'utf8',
    );

    expect(script).toContain('wait_for_service_ready "$previous_boot_id"');
    expect(script).toContain('dist/mac-service-readiness.js');
    expect(script).toContain('ANDREA_MAC_READY_TIMEOUT_SECONDS');
    expect(script).toContain('git -C "$PROJECT_ROOT" rev-parse HEAD');
    expect(script).toContain('restart_previous_boot_id="$(current_boot_id)"');
    expect(script).toContain('start_service "$restart_previous_boot_id"');
  });
});
