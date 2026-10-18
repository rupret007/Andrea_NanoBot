---
published: false
---

# Review record: `@andrea` front-door design

Date: 2026-10-17. Review target: [at-andrea-front-door.md](at-andrea-front-door.md), pre-final draft plus a source-excerpt packet. The required command piped the document and selected source excerpts to `claude -p --model sonnet`; tools, MCP servers and hooks were disabled and session persistence was off. The reviewer could not browse or inspect additional files. No real messages, databases or credentials were provided. The critique below is preserved as returned; dispositions distinguish confirmed source facts from the reviewer's evidence limits.

## Applied fixes and dispositions

| Finding | Disposition and evidence |
| --- | --- |
| 1: M3 approval-path conflation | **Fixed the plan ambiguity.** Local Andrea replies use the existing trusted-owner/message-action path. A compatible client plus independent challenge adapter is additionally required only when selecting remote Web Bob bridge dispatch. Architecture and protocol notes now distinguish these paths. The review's abbreviated authorization expression omits the external-target ternary: `executeSendOperationUnlocked` requires fresh `hasExplicitUserApproval` for `external_thread`; persisted approval/trust metadata is considered only for the non-external branch. We did not adopt a metadata-based external-send interpretation. |
| 2: Telegram contact ingress | **Fixed scope.** V1 explicitly covers BlueBubbles contact/group threads. Telegram is an existing owner-review surface, not an audited equivalent contact ingress. Other channels require their own audit and admission tests. |
| 3: challenge delivery circularity | **Fixed.** Added OPEN DECISION D8 for authenticated independent owner-only delivery if the remote bridge is selected. Added tests for bearer/contact/model isolation, failed/partial/wrong-destination/circular delivery, revoked credentials and no persistent draft/action on challenge failure. No live adapter or policy was selected. |
| 4: legacy trust labels | **Fixed with narrower source wording.** `executeSendOperationUnlocked`'s non-external branch can consider `schedule_send`/`delegated_safe_send`; this does not imply those labels are globally limited to one data model or authorize contact sends. D6 now explicitly forbids treating them as a standing contact grant. |
| 5: group memory boundary | **Fixed.** Added the independent owner-context exclusion for Telegram group IDs and BlueBubbles non-self threads. This privacy boundary stays intact when group send fences are extended; it is not a send fence to remove. Outbound staging is also included in the send-fence inventory. |
| 6: parity checklist | **Verified independently, not downgraded.** The root audit read `bob-brain/config/parity-checklist.json` at `bda64de5…`; its exact scenarios match the table. The reviewer lacked this excerpt. Source pins and current/historical/proposed labels remain; no deployed parity is claimed. |
| Reviewer evidence-limit questions | **Checked against source.** Protocol 1 claims were audited from named `webchat/` Git objects at `1b077b4c…`; sender wildcard fallback from `loadSenderAllowlist`; five-minute `TTL` from `web-bob-bridge.ts`; delivery/pause from their cited functions; Karen exclusion from `isNeverAuthorizeSendCaller`; broad missing-recipient refresh from `resolveRefreshedContextBoundRecipient`. These are source-verified audit findings, though not independently visible to the tool-disabled reviewer. No live deployment is inferred. |

Additional source-audit corrections incorporated before publication: identified protocol-1/protocol-2 incompatibility and the shipped disabled owner-challenge adapter; corrected a nonexistent message-action function name and endpoint shorthand; narrowed historical `provider_view` to marked-turn filtering rather than a general sensitive-data detector; clarified that `queue_draft` does not itself bound raw requests; bound parity evidence to an integration manifest containing both repository SHAs and adapter/schema versions; retained honest provider-submission versus handset-delivery distinctions. Gemini's incorrect project identities and three 404 links were rejected using primary sources.

The review's phrase “acceptable to merge as a DRAFT docs PR” is a model recommendation, not merge authorization. This work opens a draft PR only. Jeff's decisions remain open; no runtime, send, deployment or parity activation is approved by this review.

## Validation after fixes

- Required local `npm run test:major:ci` passed on the unchanged source baseline with pinned Node 22.22.2: 306 files / 4,374 tests, formatting, typecheck, lint, synthetic certification and build. Live verification was not run (the repository CI command uses its documented `--skip-live-verify` mode).
- `npm run docs:check` and `git diff --check` passed after documentation corrections.
- Only the design and this critique record are changed; the bob-brain checkout remains read-only and clean.
- Existing tests do not prove the proposed front door. New functionality and live acceptance remain the design's future milestone gates.

## Original Sonnet critique

# Critique: `@andrea` conversational front door (docs-only)

Method note: this review is confined to the document text and the supplied source excerpts. Any source file referenced by the document but not included in the excerpts (e.g. `channel-delivery.ts`, `bluebubbles-proof-reconciliation.ts`, `trusted-owner-review-surface.ts`, `sender-allowlist.ts`, `bluebubbles-outbound-request.ts`, `context-bound-messages-history.ts`, `config/parity-checklist.json`, historical `webchat/texting.py`) is treated as **unverifiable**, not confirmed, regardless of how confidently the document cites it.

## Confirmed Defects

**1. M3 conflates two independent approval mechanisms (High).**
Locator: *"Implement and verify the missing independent owner-challenge delivery adapter; extend current action/approval presentation... use existing direct bridge and transport fences."* (§9, M3)

The supplied `message-actions.ts` excerpt shows `executeSendOperationUnlocked` already derives `hasDispatchAuthorization` from `hasExplicitUserApproval || action.approvedAt || action.sendStatus === 'approved' || trustLevel === 'schedule_send' || trustLevel === 'delegated_safe_send'` — none of which depend on `WebBobDispatchApproval`/`OwnerChallengeDelivery`. `WebBobDispatchApproval` (`web-bob-approval.ts`) is only minted inside `WebBobBridge.confirm()`, gated to `presentationChatJid` starting with `webbob:` — i.e. it is an *additional*, bridge-specific capability layered on top of the generic flow, not a prerequisite for it. The document's own §1 row states the bridge is *"outbound owner texting, not an inbound conversational brain endpoint."* M3 nonetheless makes fixing `DisabledOwnerChallengeDelivery` a stated exit condition for ordinary front-door direct replies, which already have a working approval path (`trusted-owner-review-surface.ts` + `approvedAt`/`sendStatus`) per the document's own §1 table.

**Correction:** M3 should route conversational-reply approval through the existing trusted-owner-review-surface/message-action flow (already used for Andrea's existing contact-thread sends) and treat `OwnerChallengeDelivery` as relevant only if/when a future design decision explicitly routes `@andrea` traffic through `WebBobBridge` itself (e.g., for literal Web Bob parity). As written, M3 risks directing engineering effort at fixing a component that may not be on the critical path for this feature.

**Evidence limit:** `trusted-owner-review-surface.ts` itself is not in the excerpts, so the full approval contract cannot be independently confirmed — only that `message-actions.ts` does not require `isWebBobDispatchApproval` for non-bridge sends.

## Design Gaps

**2. Telegram-side ingress fence is unaddressed (Medium).**
Locator: *"People texting Jeff should be able to address Andrea..."* (intro); §1 "Contact ingress" row cites only `isBlueBubblesDataOnlyContactThread`.

That function is hard-scoped: `params.channelName === 'bluebubbles'`. The document frames `@andrea` as a general front door and CLAUDE.md lists Telegram as an equally bundled surface, but no Telegram-equivalent passive-contact fence is cited or discussed. If Telegram contact (non-owner) threads lack an analogous `passive_contact_sync` boundary, the whole ingress-policy argument in §1/§6 does not transfer to that channel.

**Correction:** Either scope the document explicitly to BlueBubbles-only for v1, or add a row showing the Telegram equivalent of `applyBlueBubblesIngressPolicy` before claiming the mention gate is channel-agnostic.

**3. `OwnerChallengeDelivery` transport/circularity is unspecified (Medium-High).**
Locator: *"A future implementation must deliver the secret and exact summary only to Jeff, independently of bearer callers"* (`owner-challenge-delivery.ts` comment, quoted implicitly via M3).

The document never specifies what channel will carry the challenge, nor addresses the circularity risk if that channel is the same contact-facing surface being approved. Given invariant 6 ("the model never receives raw bridge credentials... or an unrestricted send API") and the explicit "independently of bearer callers" requirement in source, out-of-band delivery design is a prerequisite, not a detail — yet it's absent from D1–D7 and from M3's test list.

**Correction:** Add an explicit decision point (or extend D7) for the challenge-delivery transport and its independence from the thread under approval.

**4. Existing `trustLevel` precedent (`schedule_send`, `delegated_safe_send`) is not cross-referenced against D6 (Medium).**
Locator: D6, *"Choose whether any standing assistant-only class is permitted... Held pending decision."*

`message-actions.ts` shows the codebase already implements two standing-authorization trust levels for self-thread sends. These are presumably scoped to Jeff's own companion thread (not "on behalf of Jeff to a contact"), so they likely don't pre-empt D6 as currently framed — but the document should say so explicitly and cite this prior art, since it is directly relevant precedent for whatever standing-class mechanism Jeff eventually picks.

**Correction:** Add a note in D6 (or §1) that `trustLevel: schedule_send/delegated_safe_send` exist today for self-thread sends and must be distinguished from any new contact-facing standing-reply class, so the two are not accidentally merged during implementation.

**5. Group ingress-vs-ownership-scope cross-check is incomplete (Low-Medium).**
Locator: §5, *"all three current fences—bridge, message action and transport—exclude it."*

The three-fence claim checks out against the supplied excerpts (`parseDraftScope` single-address requirement; `isGroupExternalMessageTarget` in `message-actions.ts`; `isGroup` check in `channels/bluebubbles.ts`). However, `shared-assistant-context.ts` shows a *fourth*, independent group exclusion (Telegram group chat IDs `tg:-*` are rejected from owner-context scope) that the document doesn't cite in §5's fence inventory, even though it's directly relevant to "shared brain, not shared memory" for groups.

**Correction:** Add `resolveSharedAssistantOwnerContextScope`'s group exclusion as a fourth fence in the inventory, since it's germane to the privacy argument as much as the send argument.

**6. Parity-checklist specificity exceeds supplied evidence (Low).**
Locator: §8 rows for `browser_desktop`, `voice_memos`, `widgets_decisions` — *"checklist requires isolated sessions, exact window and owner permissions"* etc.

`parity-gate.md` only establishes that `config/parity-checklist.json`'s *default* is empty/NOT RUN; the granular per-capability requirement language attributed to the checklist is not present in any supplied excerpt. This may well be accurate, but as written it reads as settled fact rather than cited-but-unverified content.

**Correction:** Mark these specific requirement descriptions as "per checklist, not independently verified in this audit" or supply the checklist excerpt.

## Questions / Evidence Limits (not defects — cannot be resolved from supplied material)

- **Protocol 1 specifics** (§1 "Known protocol incompatibility"): claims about `Andrea.deliver` posting "full caller scope plus confirmation metadata" describe `H-texting` at `1b077b4c`, which is not in the supplied excerpts. The protocol-2 side (disabled delivery, token-only confirm) *is* confirmed by `owner-challenge-delivery.ts`/`web-bob-bridge.ts`. The protocol-1 characterization should be treated as sourced-but-unverified-here.
- **Sender-allowlist fail-open claim** (§1): *"Missing/invalid config falls back to wildcard allow in trigger mode."* This is a significant security claim (fail-open rather than fail-closed) used to justify a core design principle ("Do not inherit wildcard fallback"), but `sender-allowlist.ts` is not in the excerpts. If this claim is wrong, the stated correction ("reuse parsing primitives... fail-closed") needs re-justifying on different grounds.
- **Draft TTL value**: §1 states "five-minute draft TTL"; only the 30-second `APPROVAL_TTL_MS` is visible in `web-bob-approval.ts`. The draft-TTL constant itself is not in the excerpts.
- **Delivery-truth machinery** (§4 invariant 7, §1 "Delivery evidence" row): `channel-delivery.ts`, `messaging-outbound-pause.ts`, `bluebubbles-proof-reconciliation.ts` are cited for "rejected before dispatch / uncertain / verified sent" states, but none are in the excerpts. The only directly visible evidence of a pre-dispatch persistence pattern is `web-bob-bridge.ts confirm()`'s `state = 'consumed', dispatchInFlight = 1` update *before* calling `sendToTarget` — which does support the "persist before transport call" invariant, but only for the bridge path, not the general channel-delivery claim.
- **Karen vs. Jeff separation at the Andrea layer**: `trusted-owner-review-surface.ts` (`isNeverAuthorizeSendCaller`, etc.) is cited as the mechanism preventing Karen/QA surfaces from authorizing sends, but isn't supplied. The *Python* side (`pr_ops.py`) does clearly separate `record_verdict` (reviewer must literally equal `"karen"`) from `merge_readiness` (`verify_jeff`), which is solid, directly-verified evidence for the Web Bob side of this claim — the Andrea-side claim remains unverified.
- **`primeRecentHistory` fallback risk** (§6): cited from `context-bound-messages-history.ts`, not supplied — cannot confirm the fallback exists or behaves as described.

## Overall readiness

This is a well-hedged, internally cross-referenced draft that is unusually careful about separating current (**C**), historical (**H**), and proposed (**P**) evidence, and it correctly keeps all contact-facing output in held-draft state pending Jeff's D1–D7 decisions — appropriate for a no-activation design doc. Where it cites supplied excerpts directly (disabled challenge adapter, single-address bridge scope, group fences in `message-actions.ts`/`channels/bluebubbles.ts`, Karen/Jeff separation in `pr_ops.py`, the `83623dd8` ownership pin, the 14-capability parity gate), its claims check out accurately against the source.

The one confirmed defect (M3's conflation of the generic message-action approval with the bridge-specific `OwnerChallengeDelivery`) is a real engineering-risk issue that should be fixed before this becomes a milestone plan anyone starts coding against, since it would misdirect M3's actual prerequisite work. The design gaps (Telegram ingress parity, challenge-delivery transport/circularity, trustLevel precedent, the fourth group fence) are worth a revision pass but don't block merging a **draft** doc. The evidence-limited items should be explicitly tagged in the doc as "cited, not verified in this audit" rather than left to read as settled fact, particularly the sender-allowlist fail-open claim given how much policy rests on it.

**Recommendation: acceptable to merge as a DRAFT docs PR** after (a) fixing the M3 conflation, and (b) adding one line distinguishing "cited" from "verified in this audit" for the evidence-limited items above. Not ready, and not represented as ready, for any runtime activation — which the document itself states correctly throughout.
