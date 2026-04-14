import { describe, expect, it } from 'vitest';

import {
  buildOpenBubblesFeasibilityReport,
  getOpenBubblesOfficialReferences,
} from './openbubbles-feasibility.js';

describe('buildOpenBubblesFeasibilityReport', () => {
  it('keeps OpenBubbles partially ready but not shippable until Andrea has a supported Windows observation and reply surface', () => {
    const report = buildOpenBubblesFeasibilityReport({
      nowIso: '2026-04-12T21:00:00.000Z',
      detectedInstallPaths: ['C:\\Users\\rupret\\AppData\\Local\\Programs\\OpenBubbles'],
    });

    expect(report.providerName).toBe('openbubbles');
    expect(report.verdict).toBe('partially_ready_but_not_shippable');
    expect(report.summary).toContain('Telegram remains the dependable main path');
    expect(report.detectedInstallPaths).toHaveLength(1);
    expect(
      report.criteria.find((criterion) => criterion.id === 'mac_offline_runtime')
        ?.status,
    ).toBe('pass');
    expect(
      report.criteria.find((criterion) => criterion.id === 'windows_surface')
        ?.status,
    ).toBe('unproven');
    expect(
      report.criteria.find((criterion) => criterion.id === 'inbound_observation')
        ?.status,
    ).toBe('blocked');
    expect(
      report.criteria.find((criterion) => criterion.id === 'outbound_reply')
        ?.status,
    ).toBe('blocked');
  });

  it('reports blocked_for_now when Andrea has no install footprint or supported Windows surface on this PC', () => {
    const report = buildOpenBubblesFeasibilityReport({
      nowIso: '2026-04-12T20:00:00.000Z',
      detectedInstallPaths: [],
    });

    expect(report.verdict).toBe('blocked_for_now');
    expect(report.summary).toContain('blocked for now');
    expect(
      report.criteria.find((criterion) => criterion.id === 'windows_surface')?.status,
    ).toBe('blocked');
  });

  it('keeps the official reference list anchored to OpenBubbles docs', () => {
    expect(getOpenBubblesOfficialReferences()).toEqual([
      'https://openbubbles.app/',
      'https://openbubbles.app/quickstart.html',
      'https://openbubbles.app/docs/faq.html',
      'https://openbubbles.app/docs/renewal.html',
      'https://openbubbles.app/extensions/extension-service.html',
    ]);
  });

  it('can graduate to ready when a supported Windows surface and reply path are explicitly proven', () => {
    const report = buildOpenBubblesFeasibilityReport({
      nowIso: '2026-04-12T22:15:00.000Z',
      detectedInstallPaths: ['C:\\Users\\rupret\\AppData\\Local\\Programs\\OpenBubbles'],
      supportedWindowsSurfaceDetected: true,
      inboundObservationSupported: true,
      outboundReplySupported: true,
    });

    expect(report.verdict).toBe('ready_for_provider');
    expect(report.summary).toContain('ready to become an Andrea Messages bridge provider');
    expect(report.supportedWindowsSurfaceDetected).toBe(true);
    expect(
      report.criteria.find((criterion) => criterion.id === 'windows_surface')?.status,
    ).toBe('pass');
    expect(
      report.criteria.find((criterion) => criterion.id === 'inbound_observation')?.status,
    ).toBe('pass');
    expect(
      report.criteria.find((criterion) => criterion.id === 'outbound_reply')?.status,
    ).toBe('pass');
  });
});
