import { describe, expect, it } from 'vitest';

import {
  parseGoogleInstalledClientSecretJson,
  resolveCalendarSelection,
} from './google-calendar.js';

describe('parseGoogleInstalledClientSecretJson', () => {
  it('reads an installed-app Google OAuth client secret file', () => {
    const parsed = parseGoogleInstalledClientSecretJson(
      JSON.stringify({
        installed: {
          client_id: 'client-id',
          client_secret: 'client-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      }),
    );

    expect(parsed.clientId).toBe('client-id');
    expect(parsed.clientSecret).toBe('client-secret');
    expect(parsed.authUri).toContain('accounts.google.com');
    expect(parsed.tokenUri).toContain('oauth2.googleapis.com/token');
  });
});

describe('resolveCalendarSelection', () => {
  const calendars = [
    {
      id: 'primary',
      summary: 'Jeff',
      primary: true,
      accessRole: 'owner',
      writable: true,
    },
    {
      id: 'family@group.calendar.google.com',
      summary: 'Family',
      primary: false,
      accessRole: 'writer',
      writable: true,
    },
  ];

  it('supports selecting all readable calendars', () => {
    expect(resolveCalendarSelection('all', calendars)).toEqual([
      'primary',
      'family@group.calendar.google.com',
    ]);
  });

  it('supports numbered selection', () => {
    expect(resolveCalendarSelection('2', calendars)).toEqual([
      'family@group.calendar.google.com',
    ]);
  });

  it('supports summary-name selection', () => {
    expect(resolveCalendarSelection('Family', calendars)).toEqual([
      'family@group.calendar.google.com',
    ]);
  });
});
