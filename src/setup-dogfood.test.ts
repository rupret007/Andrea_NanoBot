import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveOperatingProfile,
  listProfileFactsForGroup,
  _initTestDatabase,
} from './db.js';
import { runSetupDogfood } from './setup-dogfood.js';

const now = new Date('2026-06-18T12:00:00.000Z');

describe('setup dogfood', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANDREA_PROFILE_SETUP_CLOUD', 'disabled');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('previews guided setup into trusted local memory without live side effects', async () => {
    const result = await runSetupDogfood({
      groupFolder: 'dogfood-user',
      channel: 'telegram',
      now,
    });
    const serialized = JSON.stringify(result);

    expect(result.mode).toBe('preview');
    expect(result.before.setupCompletenessScore).toBe(0);
    expect(result.after.setupCompletenessScore).toBeGreaterThan(0);
    expect(result.after.memoryQualityScore).toBeGreaterThan(0);
    expect(result.after.contextGraphScore).toBeGreaterThan(0);
    expect(result.activeProfile).toBe(true);
    expect(getActiveOperatingProfile('dogfood-user')?.status).toBe('active');
    expect(result.acceptedSetupFacts).toBeGreaterThanOrEqual(6);
    expect(result.answeredSetupAreas).toEqual(
      expect.arrayContaining([
        'people',
        'tracking',
        'rhythm',
        'style',
        'integrations',
        'privacy',
        'outcomes',
      ]),
    );
    expect(
      listProfileFactsForGroup('dogfood-user', ['accepted']).map(
        (fact) => fact.factKey,
      ),
    ).toEqual(
      expect.arrayContaining([
        'setup.tracking_priorities',
        'setup.communication_style',
        'setup.privacy_comfort',
        'setup.first_outcomes',
      ]),
    );
    expect(result.privacy.liveMessagesSent).toBe(false);
    expect(result.privacy.calendarWrites).toBe(false);
    expect(result.privacy.credentialChanges).toBe(false);
    expect(serialized).not.toMatch(/\+1\d{10}/);
    expect(serialized).not.toMatch(/\bbb:|iMessage;|SMS;/i);
    expect(serialized).not.toMatch(/sk-|AIza|TOKEN=/i);
  });

  it('normalizes provider-shaped setup plans into readable memory labels', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('ANDREA_PROFILE_SETUP_CLOUD', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary:
                'Support reply triage, daily preparation, and family logistics.',
              trackedAreas: [
                { title: 'Texts needing replies' },
                { name: 'Family logistics' },
              ],
              defaultGroups: [
                {
                  title: 'Replies',
                  kind: 'general',
                  scope: 'personal',
                  purpose: 'Track important text replies.',
                },
              ],
              routines: [
                { title: 'Morning check-in' },
                { label: 'Sunday weekly planning' },
              ],
              reminderSuggestions: [
                { text: 'Surface reply follow-through during planning.' },
              ],
              richerSurface: 'telegram',
              desiredIntegrations: [
                {
                  name: 'BlueBubbles',
                  readiness: 'missing_manual',
                  note: 'Use for text review.',
                },
              ],
              learningPolicy: 'suggest_then_confirm',
            }),
          }),
          { status: 200 },
        );
      }),
    );

    const result = await runSetupDogfood({
      groupFolder: 'dogfood-cloud-shape',
      channel: 'telegram',
      now,
    });
    const serialized = JSON.stringify(result.after.profilePack);

    expect(serialized).toContain('Texts needing replies');
    expect(serialized).toContain('Morning check-in');
    expect(serialized).not.toContain('[object Object]');
  });
});
