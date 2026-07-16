import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getAllChats,
  storeChatMetadata,
} from './db.js';
import {
  hydrateBlueBubblesRecipientDirectory,
  resolveBlueBubblesContactRecipient,
} from './channels/bluebubbles.js';
import { resolveBlueBubblesThreadTargetByName } from './message-actions.js';

const originalFetch = globalThis.fetch;

describe('BlueBubbles recipient directory hydration', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('derives a direct-chat name without retaining a raw contact card', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-07-15T18:00:00.000Z',
      'iMessage;-;+12025550123',
      'bluebubbles',
      false,
    );
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        addresses: ['+12025550123'],
      });
      return new Response(
        JSON.stringify({
          status: 200,
          message: 'Success',
          data: [
            {
              displayName: 'Travis Story',
              firstName: 'Travis',
              lastName: 'Story',
              phoneNumbers: [{ address: '+1 (202) 555-0123', id: 'phone-1' }],
              emails: [],
              avatar: 'must-not-be-stored',
              id: 'contact-1',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const hydrated = await hydrateBlueBubblesRecipientDirectory({
      baseUrl: 'http://bluebubbles.test',
      password: 'test-secret',
    });

    expect(hydrated).toEqual({
      queriedChatCount: 1,
      matchedChatCount: 1,
      updatedChatCount: 1,
    });
    expect(getAllChats()).toEqual([
      expect.objectContaining({
        jid: 'bb:iMessage;-;+12025550123',
        name: 'Travis Story',
      }),
    ]);
    expect(resolveBlueBubblesThreadTargetByName('Travis Story')).toMatchObject({
      state: 'resolved',
      target: { chatJid: 'bb:iMessage;-;+12025550123' },
    });
    expect(JSON.stringify(getAllChats())).not.toContain('must-not-be-stored');
    expect(JSON.stringify(getAllChats())).not.toContain('contact-1');
  });

  it('resolves an explicit first-contact phone or email without querying the address book', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;

    await expect(
      resolveBlueBubblesContactRecipient(
        { baseUrl: null, password: null },
        '+1 (202) 555-0123',
      ),
    ).resolves.toEqual({
      state: 'resolved',
      target: {
        chatJid: 'bb:iMessage;-;+12025550123',
        displayName: '+12025550123',
        isGroup: false,
        blueBubblesCreateChatAddress: '+12025550123',
      },
    });
    await expect(
      resolveBlueBubblesContactRecipient(
        { baseUrl: null, password: null },
        'Person@Example.com',
      ),
    ).resolves.toMatchObject({
      state: 'resolved',
      target: {
        chatJid: 'bb:iMessage;-;person@example.com',
      },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('resolves one exact contact name without persisting the contact response', async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ addresses: [] });
      return new Response(
        JSON.stringify({
          data: [
            {
              displayName: 'New Person',
              phoneNumbers: [{ address: '+1 (202) 555-0199' }],
              emails: [],
              avatar: 'must-not-be-stored',
              id: 'must-not-be-stored-either',
            },
            {
              displayName: 'New Person',
              phoneNumbers: [{ address: '(202) 555-0199' }],
              emails: [],
              sourceType: 'duplicate-db-entry',
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const resolution = await resolveBlueBubblesContactRecipient(
      { baseUrl: 'http://bluebubbles.test', password: 'test-secret' },
      'New Person',
    );

    expect(resolution).toEqual({
      state: 'resolved',
      target: {
        chatJid: 'bb:iMessage;-;+12025550199',
        displayName: 'New Person at +12025550199',
        isGroup: false,
        blueBubblesCreateChatAddress: '+12025550199',
      },
    });
    expect(getAllChats()).toEqual([]);
  });

  it('requires an exact address when one contact name has multiple recipients', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                displayName: 'New Person',
                phoneNumbers: [
                  { address: '+12025550199' },
                  { address: '+12025550200' },
                ],
                emails: [{ address: 'new.person@example.com' }],
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const resolution = await resolveBlueBubblesContactRecipient(
      { baseUrl: 'http://bluebubbles.test', password: 'test-secret' },
      'New Person',
    );

    expect(resolution).toMatchObject({
      state: 'ambiguous',
      matches: [
        { displayName: 'New Person at +12025550199' },
        { displayName: 'New Person at +12025550200' },
      ],
    });
    expect(getAllChats()).toEqual([]);
  });

  it('does not use a partial contact-name match for a first message', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                displayName: 'Travis Worsham',
                phoneNumbers: [{ address: '+12025550198' }],
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    await expect(
      resolveBlueBubblesContactRecipient(
        { baseUrl: 'http://bluebubbles.test', password: 'test-secret' },
        'Travis',
      ),
    ).resolves.toEqual({ state: 'missing' });
  });

  it.each([
    ['invalid JSON', 'not-json'],
    ['a non-array data field', JSON.stringify({ data: null })],
  ])(
    'rejects a successful contact response containing %s',
    async (_description, responseBody) => {
      globalThis.fetch = vi.fn(
        async () => new Response(responseBody, { status: 200 }),
      ) as typeof fetch;

      await expect(
        resolveBlueBubblesContactRecipient(
          { baseUrl: 'http://bluebubbles.test', password: 'test-secret' },
          'Travis',
        ),
      ).rejects.toThrow(
        'BlueBubbles contact lookup returned an invalid response shape.',
      );
    },
  );

  it('treats a valid empty contact data array as a normal missing result', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as typeof fetch;

    await expect(
      resolveBlueBubblesContactRecipient(
        { baseUrl: 'http://bluebubbles.test', password: 'test-secret' },
        'Travis',
      ),
    ).resolves.toEqual({ state: 'missing' });
  });

  it('does not overwrite an existing label or choose between conflicting contacts', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-07-15T18:00:00.000Z',
      'Family nickname',
      'bluebubbles',
      false,
    );
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 200,
            data: [
              {
                displayName: 'First Match',
                phoneNumbers: [{ address: '+12025550123' }],
              },
              {
                displayName: 'Second Match',
                phoneNumbers: [{ address: '+12025550123' }],
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const hydrated = await hydrateBlueBubblesRecipientDirectory({
      baseUrl: 'http://bluebubbles.test',
      password: 'test-secret',
    });

    expect(hydrated.matchedChatCount).toBe(0);
    expect(hydrated.updatedChatCount).toBe(0);
    expect(getAllChats()[0]?.name).toBe('Family nickname');
  });

  it('keeps credentials out of contact-lookup errors', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-07-15T18:00:00.000Z',
      undefined,
      'bluebubbles',
      false,
    );
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as typeof fetch;

    const request = hydrateBlueBubblesRecipientDirectory({
      baseUrl: 'http://bluebubbles.test',
      password: 'super-secret-value',
    });
    await expect(request).rejects.toThrow('status 503');
    await expect(request).rejects.not.toThrow('super-secret-value');
  });

  it('replaces transport errors that might expose an authenticated URL', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-07-15T18:00:00.000Z',
      undefined,
      'bluebubbles',
      false,
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error(
        'request failed at http://bluebubbles.test?password=super-secret-value',
      );
    }) as typeof fetch;

    const request = hydrateBlueBubblesRecipientDirectory({
      baseUrl: 'http://bluebubbles.test',
      password: 'super-secret-value',
    });
    await expect(request).rejects.toThrow(
      'BlueBubbles contact lookup transport failed.',
    );
    await expect(request).rejects.not.toThrow('super-secret-value');
  });
});
