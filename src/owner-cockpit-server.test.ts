import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createOwnerCockpitHttpServer,
  resolveOwnerCockpitConfig,
  type OwnerCockpitConfig,
} from './owner-cockpit-server.js';

const config: OwnerCockpitConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 4320,
  secret: 'a-test-secret-that-is-long-enough',
  sessionMinutes: 30,
  groupFolder: 'main',
};

const servers: ReturnType<typeof createOwnerCockpitHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function start() {
  const server = createOwnerCockpitHttpServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe('owner cockpit security', () => {
  it('rejects non-loopback configuration', () => {
    expect(() =>
      resolveOwnerCockpitConfig({
        ANDREA_OWNER_COCKPIT_ENABLED: 'true',
        ANDREA_OWNER_COCKPIT_HOST: '0.0.0.0',
      }),
    ).toThrow('loopback');
  });

  it('keeps snapshots private and sets defensive headers', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/snapshot`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('uses a POST login and HttpOnly strict session cookie', async () => {
    const base = await start();
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.secret }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie') || '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain(config.secret);
  });

  it('rejects authenticated mutations without same-origin CSRF proof', async () => {
    const base = await start();
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.secret }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${base}/api/v1/reversible-state`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'thread', id: 'thread-1', state: 'paused' }),
    });
    expect(response.status).toBe(403);
  });

  it('does not accept a cockpit secret in a URL', async () => {
    const base = await start();
    const response = await fetch(
      `${base}/?token=${encodeURIComponent(config.secret)}`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });
});
