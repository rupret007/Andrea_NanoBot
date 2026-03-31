import { afterEach, describe, expect, it } from 'vitest';

import {
  getLogControlConfig,
  isLogLevelEnabled,
  sanitizeLogString,
  setLogControlConfig,
} from './logger.js';

const DEFAULT_CONFIG = getLogControlConfig();

afterEach(() => {
  setLogControlConfig(DEFAULT_CONFIG);
});

describe('logger log control', () => {
  it('applies a global debug level immediately', () => {
    setLogControlConfig({
      globalLevel: 'debug',
      scopedOverrides: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });

    expect(isLogLevelEnabled('debug')).toBe(true);
    expect(isLogLevelEnabled('trace')).toBe(false);
  });

  it('lets scoped chat overrides beat the global level', () => {
    setLogControlConfig({
      globalLevel: 'info',
      scopedOverrides: {
        'chat:tg:123': {
          level: 'trace',
          expiresAt: null,
          updatedAt: new Date().toISOString(),
          updatedBy: 'test',
        },
      },
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });

    expect(
      isLogLevelEnabled('trace', { chatJid: 'tg:123', component: 'assistant' }),
    ).toBe(true);
    expect(
      isLogLevelEnabled('trace', { chatJid: 'tg:456', component: 'assistant' }),
    ).toBe(false);
  });

  it('drops expired overrides on read', () => {
    setLogControlConfig({
      globalLevel: 'info',
      scopedOverrides: {
        'component:container': {
          level: 'trace',
          expiresAt: '2000-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
          updatedBy: 'test',
        },
      },
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });

    expect(isLogLevelEnabled('trace', { component: 'container' })).toBe(false);
    expect(Object.keys(getLogControlConfig().scopedOverrides)).toEqual([]);
  });

  it('still redacts secrets in verbose-capable mode helpers', () => {
    expect(sanitizeLogString('OPENAI_API_KEY=sk-live-secret-token')).toBe(
      'OPENAI_API_KEY=***',
    );
  });
});
