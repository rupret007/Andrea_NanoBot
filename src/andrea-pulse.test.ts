import { describe, expect, it } from 'vitest';

import {
  buildAndreaPulseReply,
  getDefaultPulsePreference,
  resolvePulseMode,
} from './andrea-pulse.js';

describe('Andrea Pulse', () => {
  it('defaults to request-only mode instead of behaving like a health check', () => {
    const preference = getDefaultPulsePreference();

    expect(resolvePulseMode(preference)).toBe('request_only');
    expect(preference.scheduledDeliveryEnabled).toBe(false);
  });

  it('builds a short Alexa-safe Pulse reply', () => {
    const result = buildAndreaPulseReply({
      channel: 'alexa',
      query: 'Andrea Pulse',
      now: new Date('2026-04-05T12:00:00.000Z'),
    });

    expect(result.replyText).toContain(result.item.summary);
    expect(result.replyText.split('\n').length).toBeLessThanOrEqual(3);
    expect(result.cooldown.lastTextureKind).toBe('pulse');
  });

  it('keeps say more on the same item and expands the detail', () => {
    const first = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'tell me something interesting',
      now: new Date('2026-04-05T12:00:00.000Z'),
    });
    const followup = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'say more',
      now: new Date('2026-04-05T12:00:10.000Z'),
      previousSummary: first.summaryText,
    });

    expect(followup.item.id).toBe(first.item.id);
    expect(followup.replyText).toContain(first.item.detail);
  });

  it('uses anything else to move to a different Pulse item when possible', () => {
    const first = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'surprise me',
      now: new Date('2026-04-05T12:00:00.000Z'),
    });
    const next = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'anything else',
      now: new Date('2026-04-05T12:00:10.000Z'),
      previousSummary: first.summaryText,
    });

    expect(next.item.id).not.toBe(first.item.id);
  });

  it('makes shorter/direct Pulse follow-ups stay on the same item without extra texture', () => {
    const first = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'Andrea Pulse',
      now: new Date('2026-04-05T12:00:00.000Z'),
      toneProfile: 'warmer',
    });
    const shorter = buildAndreaPulseReply({
      channel: 'telegram',
      query: 'be a little more direct',
      now: new Date('2026-04-05T12:00:10.000Z'),
      toneProfile: 'warmer',
      previousSummary: first.summaryText,
    });

    expect(shorter.item.id).toBe(first.item.id);
    expect(shorter.replyText).toBe(first.item.summary);
  });
});
