import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import { analyzeMetacognitiveTurn } from './metacognition.js';

const NOW = '2026-06-09T20:20:00.000Z';

function analyze(rawAsk: string, channel: 'telegram' | 'alexa' = 'telegram') {
  return analyzeMetacognitiveTurn({
    rawAsk,
    channel,
    groupFolder: 'main',
    now: NOW,
    persist: false,
  });
}

describe('metacognition strategy routing', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('routes weekend preparation asks to stepwise planning', () => {
    const result = analyze(
      'help me get ready for this weekend - we have the show and family visiting',
    );

    expect(result.mode).toBe('plan_stepwise');
  });

  it('keeps read-only Alexa calendar questions out of action verification', () => {
    const result = analyze('what is on my calendar today?', 'alexa');

    expect(['fast_direct', 'retrieve_grounded']).toContain(result.mode);
    expect(result.mode).not.toBe('verify_then_act');
  });

  it('routes explicit dinner versus practice tradeoffs to comparison', () => {
    const result = analyze(
      'should we do the early dinner before practice or push practice and eat after? compare the options',
    );

    expect(result.mode).toBe('compare_counterfactuals');
    expect(
      result.warnings.some(
        (warning) => warning.warningKind === 'high_risk_action',
      ),
    ).toBe(false);
  });

  it('keeps real send and code push actions approval-gated', () => {
    const result = analyze('send the calendar update and push the fix');

    expect(result.mode).toBe('verify_then_act');
    expect(result.calibration.actionAllowed).toBe('approval_only');
    expect(
      result.warnings.some(
        (warning) => warning.warningKind === 'high_risk_action',
      ),
    ).toBe(true);
  });
});
