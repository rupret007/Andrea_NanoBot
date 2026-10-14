# Removed assertions and test cases

Alexa removal, October 2026. Original expressions below are quoted from the original branch HEAD. Mixed assertions retain all non-Alexa expectations; only Alexa fields, members, or references were removed or updated. Generic tests using Alexa merely as a sample were retained with supported-channel fixtures and unchanged matcher strength. No skips, relaxed matchers, threshold changes, clock/TZ changes, or test infrastructure configuration changes were introduced.

## Wholly deleted Alexa-named test files

| File | Original test count | Retained shared coverage |
| --- | ---: | --- |
| `src/alexa-bridge.test.ts` | 8 | None; Alexa-specific file |
| `src/alexa-conversation.test.ts` | 8 | 4 pure follow-up tests moved to `src/assistant-conversation.test.ts`; assertions retained with generic helper names |
| `src/alexa-dialogue.test.ts` | 7 | None; Alexa-specific file |
| `src/alexa-identity.test.ts` | 7 | None; Alexa-specific file |
| `src/alexa-v1.test.ts` | 4 | None; Alexa-specific file |
| `src/db-alexa.test.ts` | 9 | 1 profile-fact test moved to `src/db-profile-facts.test.ts`; every assertion retained |

The six files contained 43 tests: 5 shared tests were retained in the files above and 38 Alexa-specific tests were removed.

## setup/verify.test.ts

- Removed Alexa-specific test: `adds the exact Alexa live-proof step when no signed turn is recorded`.

- Removed or updated Alexa-specific assertion component in `replaces generic credential blockers with the exact outward research blocker` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(requirements).toEqual([
      'outward_research_direct_provider_credentials_missing',
      'alexa_live_signed_turn_missing',
    ]);
```

- Removed Alexa-specific test: `marks stale handled Alexa proof separately from missing proof`.

- Removed Alexa-specific test: `upgrades verify Alexa proof from recent field-trial truth after restart`.

## src/capability-self-model-runtime-contract.test.ts

- Removed or updated Alexa-specific assertion component in `marks every runtime-mapped capability unavailable with descriptor-only truth` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(
      report.states.find((state) => state.capabilityId === 'research.web')
        ?.allowedChannels,
    ).toBe('alexa,telegram');
```

## src/command-surface-registry.test.ts

- Removed or updated Alexa-specific assertion component in `represents every taught operator command family in the registry` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(preferredAliases).toEqual(
      new Set([
        '/remote-control',
        '/remote-control-end',
        '/cursor',
        '/cursor-models',
        '/cursor-test',
        '/cursor-jobs',
        '/cursor-create',
        '/cursor-sync',
        '/cursor-select',
        '/cursor-ui',
        '/cursor-stop',
        '/cursor-followup',
        '/cursor-terminal',
        '/cursor-terminal-help',
        '/cursor-terminal-status',
        '/cursor-terminal-log',
        '/cursor-terminal-stop',
        '/cursor-conversation',
        '/cursor-results',
        '/cursor-download',
        '/runtime-status',
        '/runtime-jobs',
        '/runtime-create',
        '/runtime-job',
        '/runtime-followup',
        '/runtime-stop',
        '/runtime-logs',
        '/debug-status',
        '/debug-level',
        '/debug-reset',
        '/debug-logs',
        '/openclaw',
        '/integrations',
        '/alexa-status',
        '/amazon-status',
        '/amazon-search',
        '/purchase-request',
        '/purchase-requests',
        '/purchase-approve',
        '/purchase-cancel',
      ]),
    );
```

- Removed or updated Alexa-specific assertion component in `keeps a practical public command inventory without leading with person-specific prompts` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaSpotlights).toEqual([
      "what's on my calendar tomorrow",
      'remind me to take my pills at 9',
      'what should I say back',
      'help me plan tonight',
      'what am I forgetting',
    ]);
```

- Removed or updated Alexa-specific assertion component in `keeps a practical public command inventory without leading with person-specific prompts` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaSpotlights.join(' ')).not.toContain('Candace');
```

- Removed or updated Alexa-specific assertion component in `keeps a practical public command inventory without leading with person-specific prompts` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaSpotlights.join(' ')).not.toContain('save that');
```

- Removed or updated Alexa-specific assertion component in `keeps discovery truth classes aligned with the current host story` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(truthById.get('alexa_voice_surface')).toBe('live_proven');
```

- Removed or updated Alexa-specific assertion component in `keeps public-facing command docs free of operator-only command leakage` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(publicGuide).not.toContain('/alexa-status');
```

- Removed or updated Alexa-specific assertion component in `keeps host-proof docs status-led for BlueBubbles` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaGuide).toContain('core_ready_with_manual_surface_sync');
```

- Removed or updated Alexa-specific assertion component in `keeps host-proof docs status-led for BlueBubbles` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaGuide).toContain('alexa-model-sync mark-synced');
```

- Removed or updated Alexa-specific assertion component in `keeps host-proof docs status-led for BlueBubbles` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaGuide).toContain('services:status');
```

- Removed or updated Alexa-specific assertion component in `keeps host-proof docs status-led for BlueBubbles` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(alexaGuide).not.toContain('Alexa is now live-proven on this host');
```

- Removed or updated Alexa-specific assertion component in `keeps host-proof docs status-led for BlueBubbles` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(runbook).toContain(
      'if you changed `docs/alexa/interaction-model.en-US.json`, finish the console import/build and then run `npm run setup -- --step alexa-model-sync mark-synced`',
    );
```

- Removed or updated Alexa-specific assertion component in `keeps the command reference truth labels aligned with current host status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(commandReference).toMatch(
      /\|\s*Planning and next steps\s*\|\s*Telegram, Alexa\s*\|\s*`near_live_only`\s*\|/,
    );
```

- Removed or updated Alexa-specific assertion component in `keeps the command reference truth labels aligned with current host status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(commandReference).toMatch(
      /\|\s*Communication and reply help\s*\|\s*Telegram, Alexa, BlueBubbles\s*\|\s*`live_proven`\s*\|/,
    );
```

- Removed or updated Alexa-specific assertion component in `keeps the command reference truth labels aligned with current host status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(commandReference).toMatch(
      /\|\s*Compare, explain, and saved context\s*\|\s*Telegram, Alexa\s*\|\s*`degraded_but_usable`\s*\|/,
    );
```

## src/debug-control.test.ts

- Removed or updated Alexa-specific assertion component in `shows serving commit drift in debug status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(status).toContain('Alexa last signed request: none');
```

- Removed or updated Alexa-specific assertion component in `shows serving commit drift in debug status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(status).toContain('Alexa proof kind: none');
```

- Removed or updated Alexa-specific assertion component in `shows serving commit drift in debug status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(status).toContain('Alexa proof freshness: none');
```

- Removed or updated Alexa-specific assertion component in `shows serving commit drift in debug status` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(status).toContain('Alexa confirm command: npm run services:status');
```

## src/field-trial-readiness.test.ts

- Removed Alexa-specific test: `reduces Alexa to one exact next step when no signed turn is recorded`.

- Removed Alexa-specific test: `folds the pending Alexa model sync step into the exact next action when no signed turn is recorded`.

- Removed Alexa-specific test: `keeps LaunchRequest-only Alexa proof below live_proven`.

- Removed Alexa-specific test: `requires a handled fresh IntentRequest before Alexa becomes live_proven`.

- Removed Alexa-specific test: `keeps Alexa live-proven when a later signed request follows an earlier handled proof intent`.

- Removed Alexa-specific test: `keeps Alexa live-proven from a recent successful pilot journey when restart cleared the signed-request file`.

## src/host-control.test.ts

- Removed Alexa-specific test: `reads Alexa proof from the canonical runtime marker path`.

- Removed Alexa-specific test: `promotes a legacy backslash Alexa proof marker to the canonical path`.

- Removed Alexa-specific test: `treats a missing signed request as near-live only`.

- Removed Alexa-specific test: `treats a LaunchRequest as partial proof only`.

- Removed Alexa-specific test: `requires a handled response source for live proof`.

- Removed Alexa-specific test: `counts a fresh handled IntentRequest as live proof`.

- Removed Alexa-specific test: `treats an old handled IntentRequest as stale near-live proof`.

- Removed Alexa-specific test: `keeps a fresh handled proof turn even when a later SessionEndedRequest is recorded`.

- Removed Alexa-specific test: `keeps a fresh handled proof turn even when a later fallback intent is recorded`.

- Removed Alexa-specific test: `formats Alexa proof age labels compactly`.

## src/integration-recovery.test.ts

- Removed Alexa-specific test: `classifies stale Alexa signed proof as manual proof work`.

- Removed or updated Alexa-specific assertion component in `records checklist-only apply attempts for manual and external recovery paths` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(text).toContain('Recorded recovery checklist for Alexa');
```

## src/pilot-mode.test.ts

- Removed Alexa-specific test: `builds a lightweight Alexa utterance review digest from pilot journey events`.

## src/runtime-capability-production-surfaces.test.ts

- Removed or updated Alexa-specific assertion component in `composes only real production functions and keeps dispatch ownership truthful` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(registry.getToolSurface('research.web')?.sourceChannels).toEqual([
      'alexa',
      'telegram',
    ]);
```

## src/runtime-capability-registry.test.ts

- Removed or updated Alexa-specific assertion component in `reuses the same evaluation for read actions without write authorization` (original quoted below; shared non-Alexa expectations remain):

```ts
expect(
      productionRegistry.evaluate(
        {
          capabilityId: 'research.web',
          action: 'search',
          sourceChannel: 'alexa',
        },
        {
          ...READY_FACTS,
          writePermission: 'missing',
          confirmation: 'missing',
        },
      ),
    ).toMatchObject({
      state: 'available',
      action: { id: 'search', effect: 'read' },
    });
```

## src/andrea-pulse.test.ts

- Removed test: `builds a short Alexa-safe Pulse reply`

## src/assistant-capabilities.test.ts

- Removed Alexa-only `safeForAlexa: false` field from assertion:
```ts
expect(getAssistantCapability('work.current_logs')).toMatchObject({
      operatorOnly: true,
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: false,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('capture.add_item')).toMatchObject({
      category: 'capture',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('pulse.surprise_me')).toMatchObject({
      category: 'pulse',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('knowledge.save_source')).toMatchObject({
      category: 'knowledge',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('rituals.configure')).toMatchObject({
      category: 'rituals',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(
      getAssistantCapability('communication.understand_message'),
    ).toMatchObject({
      category: 'communication',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: false` field from assertion:
```ts
expect(
      getAssistantCapability('communication.review_recent_texts'),
    ).toMatchObject({
      category: 'communication',
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: false` field from assertion:
```ts
expect(
      getAssistantCapability('communication.manage_identity_links'),
    ).toMatchObject({
      category: 'communication',
      requiresConfirmation: false,
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('staff.prioritize')).toMatchObject({
      category: 'staff',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed Alexa-only `safeForAlexa: true` field from assertion:
```ts
expect(getAssistantCapability('missions.propose')).toMatchObject({
      category: 'missions',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
```

- Removed test: `blocks operator-only capabilities on Alexa while keeping them registered`

- Removed assertion:
```ts
expect(alexa.replyText).toContain('Want');
```

- Removed assertion:
```ts
expect(alexa.researchResult?.routeExplanation).toContain('local context');
```

- Removed assertion:
```ts
expect(alexa.followupActions).toEqual(
      expect.arrayContaining([
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
        'save_for_later',
        'draft_follow_up',
      ]),
    );
```

- Removed assertion:
```ts
expect(alexa.handoffPayload?.kind).toBe('message');
```

- Removed assertion:
```ts
expect(alexa.replyText).toContain('saved material');
```

- Removed assertion:
```ts
expect(alexa.researchResult?.supportingSources?.[0]?.title).toBeTruthy();
```

- Removed assertion:
```ts
expect(alexa.replyText).toContain('I would use');
```

- Removed assertion:
```ts
expect((alexa.replyText || '').toLowerCase()).toContain(
      'friday dinner after rehearsal',
    );
```

- Removed assertion:
```ts
expect(alexaFollowthrough.handled).toBe(true);
```

- Removed assertion:
```ts
expect(alexaFollowthrough.replyText).not.toContain('- ');
```

## src/assistant-capability-router.test.ts

- Removed test: `maps core Alexa intents into shared capabilities`

- Removed test: `maps broad Alexa intent families into shared capabilities when carrier phrases are strong`

- Removed test: `leaves broad Alexa local voice asks for the Alexa dialogue layer`

- Removed test: `continues the active capability for Alexa follow-ups when context is strong`

- Removed test: `continues the active mission context for blocker and execution follow-ups`

- Removed test: `keeps Pulse follow-ups on the active capability`

- Removed test: `keeps research explainability follow-ups on the active capability`

- Removed test: `keeps chief-of-staff follow-ups on the active planning capability`

- Removed test: `keeps knowledge follow-ups on the active capability`

- Removed test: `keeps communication follow-ups on the shared communication capability family`

- Removed assertion:
```ts
expect(
      continueAssistantCapabilityFromAlexaState('yes', {
        flowKey: 'communication_open_loops',
        subjectKind: 'communication_thread',
        subjectData: {
          activeCapabilityId: 'communication.open_loops',
        },
        summaryText: 'You owe Bob a reply.',
        supportedFollowups: ['draft_follow_up'],
        styleHints: {
          channelMode: 'alexa_companion',
          responseSource: 'local_companion',
        },
      }),
    ).toBeNull();
```

- Removed assertion:
```ts
expect(
      continueAssistantCapabilityFromAlexaState('remind me later', {
        flowKey: 'communication_open_loops',
        subjectKind: 'communication_thread',
        subjectData: {
          activeCapabilityId: 'communication.open_loops',
          namedMessagesSummaryTargetJson: bobSeedJson,
          namedOpenLoopRemindOffered: true,
        },
        summaryText: 'You owe Bob a reply.',
        supportedFollowups: ['create_reminder', 'draft_follow_up'],
        styleHints: {
          channelMode: 'alexa_companion',
          responseSource: 'local_companion',
        },
      }),
    ).toMatchObject({
      capabilityId: 'communication.manage_tracking',
      continuation: true,
    });
```

- Removed assertion:
```ts
expect(
      continueAssistantCapabilityFromAlexaState('yes', {
        flowKey: 'communication_open_loops',
        subjectKind: 'communication_thread',
        subjectData: {
          activeCapabilityId: 'communication.open_loops',
          namedMessagesSummaryTargetJson: bobSeedJson,
          namedOpenLoopDraftOffered: true,
          namedOpenLoopRemindOffered: true,
        },
        summaryText: 'You owe Bob a reply.',
        supportedFollowups: ['draft_follow_up'],
        styleHints: {
          channelMode: 'alexa_companion',
          responseSource: 'local_companion',
        },
      }),
    ).toBeNull();
```

- Removed assertion:
```ts
expect(
      continueAssistantCapabilityFromAlexaState('save under thread', {
        flowKey: 'communication_open_loops',
        subjectKind: 'communication_thread',
        subjectData: {
          activeCapabilityId: 'communication.open_loops',
          namedMessagesSummaryTargetJson: bobSeedJson,
          namedOpenLoopSaveOffered: true,
        },
        summaryText: 'You owe Bob a reply.',
        supportedFollowups: ['save_for_later', 'draft_follow_up'],
        styleHints: {
          channelMode: 'alexa_companion',
          responseSource: 'local_companion',
        },
      }),
    ).toMatchObject({
      capabilityId: 'communication.manage_tracking',
      continuation: true,
    });
```

- Removed assertion:
```ts
expect(
      continueAssistantCapabilityFromAlexaState('look at that', {
        flowKey: 'communication_open_loops',
        subjectKind: 'communication_thread',
        subjectData: {
          activeCapabilityId: 'communication.open_loops',
          namedMessagesSummaryTargetJson: bobSeedJson,
          namedOpenLoopMediaOffered: true,
        },
        summaryText: 'You owe Bob a reply.',
        supportedFollowups: ['draft_follow_up'],
        styleHints: {
          channelMode: 'alexa_companion',
          responseSource: 'local_companion',
        },
      }),
    ).toMatchObject({
      capabilityId: 'communication.open_loops',
      continuation: true,
    });
```

- Removed test: `leaves explicit handoff and completion follow-ups to the Alexa action layer`

## src/assistant-personalization.test.ts

- Removed Alexa guidance assertion:
```ts
expect(prompt).toContain('Alexa Companion Mode');
```

- Removed Alexa guidance assertion:
```ts
expect(prompt).toContain('main thing that matters most');
```

- Removed Alexa guidance assertion:
```ts
expect(prompt).toContain('Avoid sounding like a command menu');
```

## src/assistant-presentation.test.ts

- Removed assertion:
```ts
expect(renderAssistantPresentation(presentation, 'alexa')).not.toContain(
      '\n',
    );
```

## src/communication-companion.test.ts

- Removed test: `strips programmatic open-loop phrasing out of Alexa-safe draft topics`

- Removed test: `normalizes lowercase person names into cleaner Alexa-safe draft speech`

## src/conversational-core.test.ts

- Removed assertion:
```ts
expect(alexaReply).not.toContain(
      'saved material or help narrow the question',
    );
```

## src/daily-companion.test.ts

- Removed assertion:
```ts
expect(telegram?.grounded?.currentFocus.reason).toBe(
      alexa?.grounded?.currentFocus.reason,
    );
```

- Removed assertion:
```ts
expect(alexa?.reply).not.toContain('- ');
```

- Removed assertion:
```ts
expect((alexa?.reply.split('\n').length || 0) <= 3).toBe(true);
```

- Removed assertion:
```ts
expect(alexa?.reply).not.toContain('Reminder:');
```

- Removed assertion:
```ts
expect(alexa?.reply).not.toContain('Thread:');
```

- Removed test: `makes Alexa anything-else follow-ups add a new point before recapping`

- Removed test: `prefers thread context over keep-in-view phrasing for Alexa follow-ups`

## src/everyday-capture.test.ts

- Removed test: `keeps Alexa list readout concise and offers Telegram when the slice is long`

## src/media-generation.test.ts

- Removed test: `keeps Alexa image requests at the handoff layer`

## src/named-open-loop.test.ts

- Removed assertion:
```ts
expect(
      appendGenericOpenLoopNoCrawlNotice('alexa', 'Nothing is open.', true),
    ).toBe(
      "Nothing is open. I did not crawl unnamed inbox threads. Name one person and ask what's still open with them.",
    );
```

- Removed test: `keeps Alexa named-open-loop next step off yes-to-draft`

- Removed assertion:
```ts
expect(
      appendNamedOpenLoopDraftCreatedNotice(
        'alexa',
        'I drafted a reply.',
        'Bob',
      ),
    ).toBe(
      'I drafted a reply. This draft for Bob stays unsent. Yes will not send.',
    );
```

- Removed assertion:
```ts
expect(
      appendNamedOpenLoopRemindCreatedNotice(
        'alexa',
        "Okay. I'll remind you tonight to reply to Bob.",
        'Bob',
      ),
    ).toBe(
      "Okay. I'll remind you tonight to reply to Bob. I did not send anything. Say draft Bob when you want an unsent draft.",
    );
```

- Removed assertion:
```ts
expect(
      appendNamedOpenLoopSaveCreatedNotice(
        'alexa',
        'Okay. I saved that under Bob.',
        'Bob',
      ),
    ).toBe(
      'Okay. I saved that under Bob. I did not send anything. Say draft Bob when you want an unsent draft.',
    );
```

## src/research-orchestrator.test.ts

- Removed Alexa speech assertion:
```ts
expect(result.spokenText).toContain('saved material');
```

- Removed Alexa speech assertion:
```ts
expect(result.spokenText).not.toContain('Backup Dinner Summary');
```

- Removed Alexa speech assertion:
```ts
expect(result.spokenText).not.toContain('\n');
```

## scripts/test-action-preflight.ts

```ts
assert.equal(alexaSend.verdict, 'offer_fallback');
```

## scripts/test-action-lifecycle.ts

```ts
assert.ok(!voice.includes('\n'));
```

## scripts/test-blackboard.ts

```ts
assert.match(optionalVoiceDebt.toolReliabilitySummary, /optional\/manual/);
```

```ts
assert.doesNotMatch(optionalVoiceDebt.recommendedNextStep, /alexa/i);
```

```ts
assert.match(optionalVoiceDebt.recommendedNextStep, /Nothing urgent/i);
```

```ts
assert.ok(!voice.includes('\n'));
```

```ts
assert.ok(voice.length < 240);
```

## scripts/test-reality-grounding.ts

```ts
assert.notEqual(
  optionalAlexaOnlyReport.snapshot.status,
  'externally_blocked',
  'optional Alexa proof debt should not make daily-core reality externally blocked',
);
```

```ts
assert.ok(
  optionalAlexaOnlyReport.verificationNeeds.some((need) =>
    /Alexa signed IntentRequest proof/.test(need.question),
  ),
  'optional Alexa proof debt should remain visible as a verification need',
);
```

## scripts/test-capabilities.ts

```ts
assert.equal(
  getDailyCoreAttentionStates(coreReadyOptionalVoiceReport).length,
  0,
);
```

```ts
assert.equal(coreReadyOptionalVoiceReport.dailyCore.needsAttention, 0);
```

```ts
assert.equal(coreReadyOptionalVoiceReport.optionalSurfaces.needsAttention, 1);
```

```ts
assert.match(
  formatCapabilityReport(coreReadyOptionalVoiceReport),
  /Daily core: \d+\/\d+ ready \(0 need attention\)/,
);
```

```ts
assert.match(formatCapabilityReport(coreReadyOptionalVoiceReport), /OPTIONAL/);
```

## scripts/test-goal-planning.ts

```ts
assert.doesNotMatch(tonight.response, /Alexa Developer Console|real device/);
```

The following Alexa-specific expression was replaced with the same assertion
using `/BlueBubbles same-thread proof/i`; reconciliation coverage remains.

```ts
assert.ok(
  reconciledReport.planSteps.some((step) =>
    /Alexa signed device proof/i.test(step.nextAction),
  ),
);
```

## scripts/test-proof-gauntlet.ts

```ts
assert.equal(
  byName.get('Alexa signed IntentRequest proof')?.status,
  'externally_blocked',
);
```

```ts
assert.equal(report.optionalProofDebtCount, 1);
```

## scripts/test-dogfood-gauntlet.ts

```ts
assert.equal(report.consistency.alexaSignedProofPending, true);
```

## src/agi-lab-readiness.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(
      report.gates.find((gate) => gate.gateId === 'integration_health'),
    ).toMatchObject({
      label: 'Integration operability',
      status: 'warn',
      score: 0.75,
      summary:
        '3/4 integrations operationally available; 1 action-needed; 2 evidence-limited.',
      nextAction: 'Complete the Alexa checklist.',
    });
```

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(
      report.gates.find((gate) => gate.gateId === 'live_proof'),
    ).toMatchObject({
      status: 'warn',
      nextAction: 'Refresh Alexa and BlueBubbles proof evidence.',
    });
```

## src/channels/telegram.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(help).not.toContain('/alexa_status');
```

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(commands).not.toContain('/alexa_status');
```

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(features).toContain(
      'Alexa is concise voice help for schedule, reminders, list capture and readout, planning, and quick reply help',
    );
```

## src/council-quality.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(report.evidenceGaps).toEqual([
      'integration_alexa_manual_action_required',
    ]);
```

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(formatted).toContain('integration_alexa_manual_action_required');
```

## src/helper-boundary.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(source).toContain(
      'const followup = resolveAlexaConversationFollowup(lastContent, state);',
    );
```

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(source).toContain('completeAssistantActionFromAlexa(');
```

## src/intelligence-progress.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(report.criticalRegressions.join(' ')).not.toMatch(/Alexa/);
```

## src/metacognition-routing.test.ts

- Removed Alexa-specific test: `keeps read-only Alexa calendar questions out of action verification`.

## src/shadow-improvement-runner.test.ts

Original removed or revised Alexa assertion (generic coverage and matcher strength retained where revised):

```ts
expect(
      report.results.map((result) => [
        result.scenarioId,
        result.capabilityId,
        result.status,
      ]),
    ).toEqual([
      ['busy_household_night', 'staff.prioritize', 'passed'],
      ['messaging_followthrough', 'communication.draft_reply', 'passed'],
      ['household_command_center', 'household.family_open_loops', 'passed'],
      ['research_provider_blocked', 'knowledge.summarize_saved', 'passed'],
      ['alexa_concise_voice_flow', 'daily.loose_ends', 'passed'],
    ]);
```

## src/user-facing-fallback.test.ts

- Removed Alexa-specific test: `shapes direct fallback more concisely for Alexa ordinary chat`.


## src/send-path-blob-identity.test.ts

No assertion or test case was removed or weakened. Updated only the pinned SHA-256 for `src/message-actions.ts` after its three Alexa-only type edits. Its runtime implementation is unchanged; the exact source-hash matcher and every send-authorization fence assertion remain. All five other pinned source hashes remain unchanged.
