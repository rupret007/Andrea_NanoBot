import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasGoogleCalendarCredentialMaterial,
  runGoogleCalendarProof,
} from './google-calendar-proof.js';
import { readProviderProofState } from './provider-proof-state.js';

describe('google calendar proof', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-google-proof-'));
    process.chdir(tempDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T13:30:00.000Z'));
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('detects when calendar credential material is present', () => {
    expect(
      hasGoogleCalendarCredentialMaterial({
        accessToken: null,
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        calendarIds: ['primary'],
      }),
    ).toBe(false);

    expect(
      hasGoogleCalendarCredentialMaterial({
        accessToken: 'token',
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        calendarIds: ['primary'],
      }),
    ).toBe(true);
  });

  it('marks missing config as externally blocked and persists that truth', async () => {
    const result = await runGoogleCalendarProof({
      projectRoot: tempDir,
      config: {
        accessToken: null,
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        calendarIds: ['primary'],
      },
    });

    expect(result.surface.proofState).toBe('externally_blocked');
    expect(result.failureKind).toBe('missing_config');

    const persisted = readProviderProofState(tempDir);
    expect(persisted?.googleCalendar?.proofState).toBe('externally_blocked');
  });

  it('marks Google Calendar live-proven after validate, create, read-back, and cleanup succeed', async () => {
    let eventsGetCount = 0;

    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method || 'GET';

        if (method === 'GET' && url.includes('/users/me/calendarList')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'primary',
                  summary: 'Jeff',
                  primary: true,
                  accessRole: 'owner',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (method === 'GET' && url.includes('/calendars/primary/events')) {
          eventsGetCount += 1;
          if (eventsGetCount >= 3) {
            return new Response(
              JSON.stringify({
                summary: 'Jeff',
                items: [
                  {
                    id: 'proof-event-1',
                    summary: 'Andrea calendar proof 2026-04-09T13-30-00-000Z',
                    start: { dateTime: '2026-04-10T16:00:00.000Z' },
                    end: { dateTime: '2026-04-10T16:15:00.000Z' },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              summary: 'Jeff',
              items: [],
            }),
            { status: 200 },
          );
        }

        if (method === 'POST' && url.endsWith('/calendars/primary/events')) {
          return new Response(
            JSON.stringify({
              id: 'proof-event-1',
              summary: 'Andrea calendar proof 2026-04-09T13-30-00-000Z',
              htmlLink: 'https://calendar.google.com/proof-event-1',
              organizer: { displayName: 'Jeff' },
              start: { dateTime: '2026-04-10T16:00:00.000Z' },
              end: { dateTime: '2026-04-10T16:15:00.000Z' },
            }),
            { status: 200 },
          );
        }

        if (method === 'DELETE' && url.includes('/calendars/primary/events/')) {
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unhandled fetch call: ${method} ${url}`);
      },
    );

    const result = await runGoogleCalendarProof({
      projectRoot: tempDir,
      config: {
        accessToken: 'token',
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        calendarIds: ['primary'],
      },
      cleanup: true,
    });

    expect(result.surface.proofState).toBe('live_proven');
    expect(result.readHealthy).toBe(true);
    expect(result.writeHealthy).toBe(true);
    expect(result.verifiedByReadBack).toBe(true);
    expect(result.cleanupStatus).toBe('deleted');
    expect(result.createdEvent?.calendarId).toBe('primary');

    const persisted = readProviderProofState(tempDir);
    expect(persisted?.googleCalendar?.proofState).toBe('live_proven');
    expect(persisted?.googleCalendar?.detail).toContain('live-proven');
  });
});
