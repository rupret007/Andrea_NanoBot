import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveBlueBubblesSendMethod } from './channels/bluebubbles.js';
import { interpretMessageActionFollowup } from './message-actions.js';
import { isNeverAuthorizeSendCaller } from './trusted-owner-review-surface.js';
import type { RegisteredGroup } from './types.js';

/**
 * Send-path source blobs at leftover-squash #29
 * (main 89459510ba5b5e1ff022c5fb52cb2abd53e4bcda).
 * These hashes may change only when a test in this file still proves the
 * exact Bob fence: send it / send it now / send now.
 */
const PINNED_SEND_PATH_BLOBS = {
  'src/message-actions.ts':
    '6d0f14df134bbc430a6770c5c2991d1476e15fb8dfd57fa334d3643064cd7c73',
  'src/trusted-owner-review-surface.ts':
    '2e401cb1b0902f56085d8e6e61e07554af79f7cb4572ae0bc7de6630f4a897b1',
  'src/bluebubbles-outbound-request.ts':
    'b4e477b44ef03964beaeb00a73038938ebdedbf0b21b967516d6de64d09fde0f',
  'src/bluebubbles-outbound-turn.ts':
    '66fb26455bdd1ca952db59b5ca18119ecb53c04dd2588714998bbf0763dd0906',
  'src/channels/bluebubbles.ts':
    '0315e2416bcdca5fa7c2f3757d0e284d2365d9608833eb3e467fdfc30e1e21e6',
  'src/channels/telegram.ts':
    '5022a42d1d669d48884bc37b78a040fc92de1bf99d9b0f3ef85a42d67203cbd9',
} as const;

function sha256OfRepoFile(relativePath: string): string {
  return createHash('sha256')
    .update(readFileSync(join(process.cwd(), relativePath)))
    .digest('hex');
}

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-08-23T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

describe('send-path blob identity after named-person leftover', () => {
  it('keeps send-path source blobs identical to leftover-squash #29', () => {
    for (const [relativePath, pinned] of Object.entries(
      PINNED_SEND_PATH_BLOBS,
    )) {
      expect(sha256OfRepoFile(relativePath)).toBe(pinned);
    }
  });

  it('proves the exact Bob fence is still send it / send it now / send now', () => {
    expect(interpretMessageActionFollowup('send it')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('send it now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('send now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('Send now')).toEqual({
      kind: 'send',
    });
    expect(interpretMessageActionFollowup('yes')).toBeNull();
    expect(interpretMessageActionFollowup('ok')).toBeNull();
    expect(interpretMessageActionFollowup('send it later')).toEqual({
      kind: 'defer',
      timingHint: null,
    });
    expect(interpretMessageActionFollowup('approve and send now')).toBeNull();
    expect(interpretMessageActionFollowup('send it again')).toBeNull();
    expect(resolveBlueBubblesSendMethod()).toBe('apple-script');
    expect(resolveBlueBubblesSendMethod('private-api')).toBe('apple-script');
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:karen' }),
    ).toBe(true);
    expect(
      isNeverAuthorizeSendCaller({ group: mainGroup, chatJid: 'tg:qa' }),
    ).toBe(true);
  });
});
