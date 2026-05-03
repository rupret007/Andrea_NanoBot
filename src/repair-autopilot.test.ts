import { describe, expect, it } from 'vitest';

import {
  buildRepairVerificationBundle,
  deriveRepairNextLegalAction,
  parseRepairApprovalScopeFromText,
  parseRepairWorkerResult,
} from './repair-autopilot.js';

describe('repair autopilot worker result contract', () => {
  it('parses a verified worker result and builds final verification evidence', () => {
    const result = parseRepairWorkerResult(`
      Here is the closure payload:
      \`\`\`json
      {
        "repairWorkerResult": {
          "status": "verified",
          "changedFiles": ["src/calendar-assistant.ts"],
          "testsRun": ["npm run typecheck", "npm test"],
          "testsPassed": true,
          "patchArtifact": "artifact://patch-1",
          "commitSha": "",
          "blockerClass": "",
          "needsLocalApply": false,
          "verificationSummary": "Focused calendar wording tests passed.",
          "nextLegalAction": "Record verification evidence."
        }
      }
      \`\`\`
    `);

    expect(result).toMatchObject({
      status: 'verified',
      changedFiles: ['src/calendar-assistant.ts'],
      testsRun: ['npm run typecheck', 'npm test'],
      testsPassed: true,
      needsLocalApply: false,
      verificationSummary: 'Focused calendar wording tests passed.',
    });

    const evidence = buildRepairVerificationBundle(result, {
      feedbackId: 'feedback-1',
      repairPlanId: 'repair-plan-1',
      executionId: 'execution-1',
      workerId: 'cursor_cloud',
      laneId: 'cursor',
      jobId: 'cursor-job-1',
    });
    expect(evidence).toMatchObject({
      evidenceKind: 'test',
      passed: true,
      command: 'npm run typecheck; npm test',
      metadata: {
        feedbackId: 'feedback-1',
        workerResultStatus: 'verified',
        testsPassed: 'true',
        verificationFinal: 'true',
      },
    });
  });

  it('keeps malformed or missing results in waiting state instead of verified', () => {
    expect(parseRepairWorkerResult('Looks good to me.')).toMatchObject({
      status: 'waiting_for_cloud_result',
      testsPassed: null,
      nextLegalAction: 'Wait for the cloud worker result or refresh the job.',
    });
    expect(
      parseRepairWorkerResult(
        JSON.stringify({
          repairWorkerResult: {
            status: 'verified',
            testsPassed: false,
            verificationSummary: 'Tests failed.',
          },
        }),
      ),
    ).toMatchObject({
      status: 'failed_tests',
      testsPassed: false,
    });
  });

  it('redacts secret-like fragments from worker result fields', () => {
    const result = parseRepairWorkerResult(
      JSON.stringify({
        repairWorkerResult: {
          status: 'blocked_external',
          changedFiles: ['src/provider.ts'],
          testsRun: ['npm test'],
          testsPassed: false,
          verificationSummary:
            'Provider rejected sk-proj-abcdefghijklmnopqrstuvwxyz1234567890.',
          blockerClass: 'auth_failed',
          nextLegalAction: 'Rotate the key manually.',
        },
      }),
    );

    expect(result.secretRedacted).toBe(true);
    expect(result.verificationSummary).toContain('[redacted-secret]');
    expect(result.verificationSummary).not.toContain(
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('splits execution-only approval from explicit landing approval', () => {
    expect(parseRepairApprovalScopeFromText('Ok you have my approval')).toBe(
      'execution_only',
    );
    expect(parseRepairApprovalScopeFromText('repair and land it')).toBe(
      'execution_and_landing',
    );
    expect(
      deriveRepairNextLegalAction(
        'needs_local_landing',
        true,
        'execution_only',
      ),
    ).toContain('explicit landing approval');
  });
});
