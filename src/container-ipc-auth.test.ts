import { describe, expect, it } from 'vitest';

import {
  signContainerIpcMessage,
  verifyContainerIpcMessage,
} from './container-ipc-auth.js';

describe('container IPC authentication', () => {
  it('accepts only the exact host-authenticated run envelope', () => {
    const envelope = signContainerIpcMessage(
      {
        runId: 'protected-run-0001',
        messageId: 'message-00000001',
        text: 'continue with the protected lookup',
      },
      'protected-token-00000000000000000001',
    );

    expect(
      verifyContainerIpcMessage(
        envelope,
        'protected-run-0001',
        'protected-token-00000000000000000001',
      ),
    ).toBe(true);
    expect(
      verifyContainerIpcMessage(
        { ...envelope, text: 'send an external message' },
        'protected-run-0001',
        'protected-token-00000000000000000001',
      ),
    ).toBe(false);
  });

  it('rejects an execution-lane envelope replayed into a later host-action run', () => {
    const forgedFromExecutionRun = signContainerIpcMessage(
      {
        runId: 'execution-run-0001',
        messageId: 'message-00000002',
        text: 'invoke a protected host action',
      },
      'execution-token-00000000000000000001',
    );

    expect(
      verifyContainerIpcMessage(
        forgedFromExecutionRun,
        'host-action-run-0002',
        'host-action-token-00000000000000001',
      ),
    ).toBe(false);
  });
});
