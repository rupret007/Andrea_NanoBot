import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANDREA_OPENCLAW_AGENT_DELEGATION,
  ANDREA_OPENCLAW_ENABLED,
} from '../src/config.js';
import {
  buildOpenClawChatSessionKey,
  delegateToOpenClawAgent,
  getOpenClawStatusSummary,
} from '../src/openclaw-connector.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

assert.equal(
  ANDREA_OPENCLAW_ENABLED,
  true,
  'ANDREA_OPENCLAW_ENABLED must be true in .env for live delegation',
);
assert.equal(
  ANDREA_OPENCLAW_AGENT_DELEGATION,
  true,
  'ANDREA_OPENCLAW_AGENT_DELEGATION must be true in .env for live delegation',
);

const summary = getOpenClawStatusSummary();
assert.equal(
  summary.gatewayState,
  'live',
  `OpenClaw gateway must be live (got ${summary.gatewayState}: ${summary.detail})`,
);

const delegation = await delegateToOpenClawAgent({
  message: 'Reply exactly OK_DELEGATION_LIVE',
  sessionKey: buildOpenClawChatSessionKey('live-test'),
});
assert.equal(delegation.ok, true, delegation.detail || 'delegation failed');
assert.match(
  delegation.reply,
  /OK_DELEGATION_LIVE/,
  `unexpected delegation reply: ${delegation.reply.slice(0, 200)}`,
);

const bridgeProbe = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts/run-with-pinned-node.mjs'),
    join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
    join(repoRoot, 'scripts/openclaw-andrea-bridge.ts'),
    'probe',
  ],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
assert.match(bridgeProbe, /probe: ok/i, `bridge probe failed:\n${bridgeProbe}`);

console.log('OpenClaw live delegation smoke passed.');
