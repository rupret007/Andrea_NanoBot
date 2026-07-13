import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyAuthenticatedIpcMessage } from './ipc-message-auth.js';

function envelope(runId: string, token: string, text: string) {
  const messageId = 'message-00000001';
  return {
    version: 1 as const,
    type: 'message' as const,
    provenance: 'host' as const,
    runId,
    messageId,
    text,
    signature: createHmac('sha256', token)
      .update(`1\nmessage\nhost\n${runId}\n${messageId}\n${text}`)
      .digest('base64url'),
  };
}

test('accepts an authenticated message only for its current run', () => {
  const token = 'protected-token-00000000000000000001';
  const message = envelope('protected-run-0001', token, 'continue safely');

  assert.equal(
    verifyAuthenticatedIpcMessage(message, 'protected-run-0001', token),
    true,
  );
  assert.equal(
    verifyAuthenticatedIpcMessage(message, 'protected-run-0002', token),
    false,
  );
});

test('rejects unsigned, altered, and prior-lane messages', () => {
  const execution = envelope(
    'execution-run-0001',
    'execution-token-00000000000000000001',
    'invoke protected work',
  );

  assert.equal(
    verifyAuthenticatedIpcMessage(
      execution,
      'host-action-run-0002',
      'host-action-token-00000000000000001',
    ),
    false,
  );
  assert.equal(
    verifyAuthenticatedIpcMessage(
      { ...execution, text: 'altered instruction' },
      'execution-run-0001',
      'execution-token-00000000000000000001',
    ),
    false,
  );
  assert.equal(
    verifyAuthenticatedIpcMessage(
      { type: 'message', text: 'legacy unsigned instruction' },
      'host-action-run-0002',
      'host-action-token-00000000000000001',
    ),
    false,
  );
});
