# Andrea User Guide

This guide is for people who talk to Andrea in chat.
It explains the normal user experience, the small safe command set, and what to expect.

## What Andrea Is

Andrea is one public assistant identity.
Talk to her in normal language first. Use commands only when you want setup or a quick status check.

Andrea is strongest at:

- everyday questions and quick answers
- reminders, follow-ups, and simple task help
- calendar scheduling when your admin enabled that path
- ongoing life-thread continuity for people, household, and work topics
- summaries and light research
- project help in normal language
- fast direct replies for simple prompts, playful questions, and basic math
- optional Alexa Companion Mode if your admin enabled the linked voice channel

## First Five Minutes In Telegram

1. Open a direct message with `@andrea_nanobot`.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/mainchat`.
5. Run `/help` or `/commands`.
6. Send one plain-language request.

`/registermain` should make that same DM Andrea's main control chat. If it says another main chat is already registered, run `/mainchat`; it will show the registered chat, whether this DM is it, and the next step. If you ask something like `What's on my calendar tomorrow?` from a non-main DM, move to the DM shown by `/mainchat` or run `/registermain` in the DM you want to use.

Good first messages:

- `What's the meaning of life?`
- `Remind me tomorrow at 3pm to call Sam`
- `Summarize my tasks for today`
- `Research the best standing desks for a small office`

## Public-Safe Commands

These are the commands normal users should rely on:

- `/start` - quick onboarding
- `/help` - short in-chat guide
- `/commands` - safe command list
- `/features` - short capability overview
- `/ping` - basic health check
- `/chatid` - show the current Telegram chat ID and type
- `/registermain` - register this DM as Andrea's main control chat
- `/mainchat` - show the registered main control chat and recovery steps
- `/thinking` - show smart auto thinking mode plus deep/quick controls
- `/council` - show council quality, calibration, provider reliability, and next proof action
- `/cognition` - show task-engine status, Cognitive Workspace packet, active program, Runtime Spine checkpoints, Supervisor Core blackboard/handoffs, Session Graph continuity clusters, the ranked continuity cockpit, Agency Convergence Loop state, evidence gaps, truth support, World Model proof debt, approval blockers, and next repair action
- `/memory` - show how memory is used and controlled
- `/learning` - show durable learning policy and safety rails
- `/forget` - show how to disable a remembered detail
- `/cursor_status` - safe Cursor readiness check only

Thinking and learning controls:

- Say `ultrathink`, `ultracode`, `think harder`, `use all models`, `max IQ`, or `deep dive` when a request deserves the protected multi-model council.
- Say `quick answer` or `keep it simple` when you want the fast path.
- Andrea may show a concise council verdict, but not hidden reasoning or provider debate transcripts.
- Use `/council`, `council status`, or `council tasks` to inspect the redacted council quality ledger, task-ease drills, and next repair action.
- Use `/cognition`, `cognition status`, `cognitive workspace status`, `agency loop status`, `convergence status`, `runtime spine status`, `agent runtime status`, `supervisor status`, `blackboard status`, `session graph status`, `continuity status`, `what sessions are connected?`, `what belongs together?`, `why did you choose that?`, `why do you believe that?`, `why is that true?`, `what supports that?`, `what could be wrong?`, `how certain are you?`, `what are the alternatives?`, `what's missing?`, `what's most useful next?`, `what changed?`, `what is stale?`, `what do you know for sure?`, `what's true right now?`, `is text messaging working?`, `what's broken right now?`, `what should you verify next?`, `what is most useful now?`, `what evidence supports this?`, `what goals are active?`, `what are we trying to accomplish?`, `show me the plan`, `what is blocking this?`, `what is the safest next step?`, `what if we do nothing?`, `stop suggesting that`, or `run the safe checks` to inspect the Cognitive Workspace packet, safe task graph, Agent OS episode, Runtime Spine checkpoints, Supervisor Core blackboard/handoffs, Session Graph continuity clusters, continuity cockpit action queue, Agency Convergence selected action, Logic Kernel claims, Truth Engine support, World Model proof debt, Reality Grounding observations/beliefs, Hierarchical Goal Planner, uncertainty, approval blockers, and useful next action. Use `that is stale`, `mark that current`, or `resolve that` only when you are intentionally correcting Andrea's belief state.
- Say `what did you learn?`, `what do you remember about me`, `what skills have you learned`, `forget that`, `don't use that skill`, `make that my default`, `always ask first`, or `reset that pattern` to inspect or steer memory and learned playbooks.

## Lifelong Learning And Skills

Andrea can now distill repeated metadata evidence into reviewable learned facts and skill playbooks. This is not a new autonomous feature family: learned skills are bounded playbooks that orchestrate existing reminders, lists, missions, communication help, repair playbooks, research, and outcome review while preserving approval gates.

Learning stays inspectable:

- `/memory` shows memory policy plus learned facts, pending confirmations, and repeated friction.
- `/learning` shows durable learning policy plus suggested, active, paused, and retired skill playbooks.
- Suggested or sensitive facts stay pending until confirmed.
- Skills can be paused, reset, forgotten, or retired.

Safety boundaries do not change. Andrea may learn safer defaults and better routes, but sends, calendar writes, deletes, service changes, commits, pushes, purchases, and other side effects still require the existing confirmation/proof path.

## Cognitive Executive

The Cognitive Executive is Andrea's everyday routing loop for high-value asks like `what should I do next`, `what am I forgetting`, `help me plan tonight`, `what's still open`, `what should I say back`, `save that for later`, list readouts, and ambiguous `handle this for me` requests.

It does not replace reminders, missions, follow-through reviews, life threads, communication help, or the Cognitive Workspace. It sits above them, builds a small current-world snapshot, picks the narrowest useful existing capability, preserves approval gates, records the outcome, and keeps one short explanation for later.

Useful explanation asks:

- `why did you suggest that?`
- `what are you using to decide this?`
- `why didn't you add it to my calendar?`
- `why are you bringing that up?`
- `what's the current focus?`

Boundaries stay the same: Andrea can answer, plan, draft, save, remind, and stage approvals through existing systems, but sends, calendar writes, deletes, service changes, commits, pushes, purchases, and other side effects still require the appropriate confirmation/proof path.

## Hierarchical Goals And Proactive Suggestions

Andrea can now turn durable, multi-step asks into compact proposed goals instead of scattering them across reminders, missions, skills, proof debt, and improvement notes. The planner is deliberately bounded:

- multi-step asks start as `proposed` goals unless you explicitly say `make this a goal`
- goals decompose into a few milestones and practical steps, not a full project-management system
- causal beliefs explain why Andrea drafts instead of sends when Messages proof is stale, asks for a missing time before calendar writes, or falls back when a provider is quota-blocked
- counterfactual asks like `what if we do nothing?` compare doing nothing, verifying first, and taking one safe next step
- proactive suggestions are reply-coupled only: Andrea may show one relevant suggestion in a normal answer, but it does not background nag

Useful controls:

- `what goals are active?`
- `what are we trying to accomplish?`
- `show me the plan`
- `simplify the plan`
- `what is blocking this?`
- `what is the safest next step?`
- `what if we do nothing?`
- `pause that goal`
- `mark that done`
- `stop suggesting that`
- `do not bring this up unless I ask`

Operator checks:

- `npm run debug:goals`
- `npm run debug:planner`
- `npm run debug:opportunities`
- `npm run debug:working-memory`
- `npm run debug:metacognition`
- `npm run debug:deliberation`

This is bounded goal-directed reasoning, not AGI or autonomous control. Goals and opportunities stage or suggest work through existing systems; they do not bypass approval gates.

## Metacognitive Reasoning

Andrea keeps a compact working-memory frame for high-value turns so it can decide what context matters, how hard to reason, how confident to sound, and when to clarify or verify first.

Useful natural controls:

- `are you sure?`
- `what are you basing that on?`
- `what context are you using?`
- `what are you unsure about?`
- `what would make you more confident?`
- `think harder`
- `keep it simple`
- `don't overthink it`
- `use only what you know for sure`
- `reset current focus`

This is bounded metacognition, not hidden chain-of-thought exposure. Andrea may show a concise decision summary, confidence reason, context summary, or verification path, but it does not store or reveal raw private bodies, prompts, provider debates, hidden reasoning, secrets, or raw tool output.

## General Intelligence Control Plane (v32)

Andrea is not AGI, and this layer does not make it AGI. The control plane is a bounded, testable, approval-governed architecture that makes Andrea's existing subsystems behave like one coherent assistant. Jeff stays in control of every external action.

What it adds:

- **Unified Action Lifecycle.** Every meaningful action — message sends, calendar writes, reminders, plan steps, repairs, patch work — is tracked as one action intent moving through explicit statuses (proposed → needs approval → approved → attempted → succeeded/failed → reviewed). Existing systems keep doing the work; the lifecycle mirrors them so nothing is invisible.
- **Action Preflight.** Before any durable or external action, ten consistent checks run: object clarity, required info, reality/proof freshness, tool reliability, approval, channel fit, safer fallback, duplicates, contradictions, and risk. The strictest signal wins, and the verdict is one of proceed / clarify / verify / request approval / defer / block / offer fallback.
- **Cognitive Blackboard.** A bounded snapshot of what matters right now — active goal, plan step, focus, reality, proof debt, tool health, approval needs — with exactly one recommended next step. Assembled from the systems of record, never free-written.
- **Reflective Episodic Memory.** Compact, redacted episode summaries (never raw transcripts): what you asked, what Andrea did, what you corrected, what was learned. Sensitive episodes are flagged and kept only 7 days; standard episodes 90 days.
- **Capability Self-Model.** Andrea knows what it can and cannot do right now, grounded in live proof, reliability, and config presence (config is checked by name only — values are never stored). Missing setup stays classified as external/config debt, never as a repo bug.
- **Autonomy Governor.** Every operation maps to a level from 0 (answer only) to 7 (never allowed). Levels 5+ always require your explicit approval; level 6 adds the operator surface; level 7 never executes. Nothing in v32 weakens an existing gate.
- **AGI-Readiness Gauntlet.** A ten-scenario benchmark that scores Andrea as a whole assistant — calendar pressure, ambiguous asks, broken tools, planning, self-improvement, memory corrections, confidence challenges, recovery, cross-channel handoff, and safety. The score measures bounded readiness on synthetic scenarios; it is explicitly not an intelligence claim.

Natural asks that now work:

- `what are you doing right now?`
- `what is waiting on me?`
- `what can you actually do today?`
- `can you send texts?`
- `what is broken?` / `what needs setup?`
- `what did you try?` / `what failed?`
- `what did you learn?`
- `what should we do next?`
- `why didn't you do that?`
- `what do you need approval for?`

Telegram is the rich management surface; Alexa answers stay short; BlueBubbles stays calm and bounded; `debug:*` surfaces stay exact and operator-only.



Andrea now tracks a small reliability ledger for the routes, tools, providers, and integrations it depends on. That lets the Cognitive Executive lower confidence, choose a fallback, or explain a blocker when BlueBubbles, Alexa, Calendar, provider quota, or a work lane is degraded.

Repair status is bounded. Andrea can diagnose, record cooldowns, refresh safe metadata, and tell you the exact next proof step. It does not secretly send messages, change calendar events, restart services, commit code, push branches, or make purchases.

Operator checks:

- `npm run debug:executive -- --refresh`
- `npm run debug:repair`
- `npm run debug:improvement`
- `npm run integrations:heal -- --id bluebubbles --dry-run`
- `npm run debug:agentic`

## Autonomous Improvement Lab

Andrea can now mine existing pilot, repair, reliability, learning, skill, executive, harness, and feedback metadata into improvement hypotheses. This is bounded self-improvement infrastructure, not autonomous self-modification.

The lab produces:

- hypotheses about repeated friction or missing proof,
- simulation-first experiments,
- candidate patch plans for human review,
- outcomes and lessons for future dogfooding.

It intentionally separates external proof debt from repo bugs. Missing Telegram user-session credentials, Alexa signed `IntentRequest` proof, and BlueBubbles same-thread proof may appear as high-priority operator items, but the lab will not pretend a code patch can complete those live steps.

Safety boundaries stay firm. The lab does not create branches, apply product-behavior patches, restart services, send messages, write calendars, change credentials, commit, push, or mutate live channels automatically. Patch output is plans only unless you explicitly ask for implementation.

### Shadow-Mode Improvement Runner

Andrea can also run a shadow-mode improvement loop over those hypotheses. Shadow mode runs a synthetic-user gauntlet, compares baseline behavior against candidate patch plans, and reports whether a low-risk plan looks improved, neutral, regressed, or inconclusive.

Shadow mode is still Plan + Eval only:

- It may select low-risk repo-side candidates.
- It may generate before/after scorecards and patch reports.
- It may flag regressions before anyone edits code.
- It does not apply patches, create worktrees, restart services, send messages, write calendars, change credentials, commit, push, or mutate live integrations.

Operator checks:

- `npm run debug:improvement -- --shadow`
- `npm run debug:agentic`
- `npm run test:synthetic-gauntlet`
- `npm run test:shadow-improvement`

### Approval-Gated Patch Workbench And Live Proof Gauntlet

Andrea can now turn a shadow improvement report into a patch-workbench review. The default path is still dry-run: it records candidate workspaces, patch attempts, safety decisions, and review notes without changing main.

The workbench may only prepare an isolated local candidate branch/worktree when explicitly invoked, and the first allowlisted recipe is limited to proof-debt/report clarity. It cannot merge, push, restart services, send messages, write calendars, change credentials, alter approval gates, or mutate live integrations.

Live proof is tracked separately from repo bugs. The proof gauntlet reports Telegram user-session config, Telegram bot proof, Alexa signed `IntentRequest`, BlueBubbles same-thread message-action proof, Google Calendar live write proof, research/provider proof, and image generation proof with exact next steps.

Operator checks:

- `npm run debug:improvement -- --workbench`
- `npm run debug:proof-gauntlet`
- `npm run dogfood:live`
- `npm run improvement:patch-plan`
- `npm run improvement:patch-dry-run`
- `npm run improvement:patch-review`
- `npm run test:dogfood-gauntlet`
- `npm run test:patch-workbench`
- `npm run test:proof-gauntlet`

This is bounded self-improvement infrastructure, not AGI, autonomous deployment, or uncontrolled self-modification. Mainline changes remain human-governed.

### Live Dogfood Gauntlet

Andrea can now run an operator-safe dogfood pass over natural requests such as `what should I do next?`, `what am I forgetting?`, `is text messaging working?`, `help me plan tonight`, `what should I say back?`, `add that to my calendar`, `fix yourself`, and `are you sure?`.

This is not background autonomy and it is not live proof by itself. The dogfood pass uses existing proof, capability, reality, blackboard, planner, preflight, metacognition, improvement, and pilot surfaces to classify what would happen. It may record metadata-only pilot outcomes, but it does not send messages, write calendars, restart services, push code, change credentials, mutate integrations, or mark manual proof debt complete.

## Reality Grounding And Active Perception

Reality Grounding is Andrea's compact "what is true right now" layer. It separates direct observations, beliefs, stale proof, contradictions, missing config, external blockers, and repo-side repair candidates before Andrea answers or stages an action.

Use it when you want a grounded status answer:

- `what's true right now?`
- `is text messaging working?`
- `what's broken right now?`
- `what should you verify next?`

Active Perception is request-coupled, not always-on polling. Andrea may plan safe read-only checks such as proof/status reads, tool reliability reads, repair-state reads, or existing authorized readiness checks. Manual proof steps, missing credentials, and external device actions stay explicit.

Reality Grounding differs from memory: memory stores user-confirmed or reviewable facts and skills; Reality Grounding decides whether current evidence is fresh enough to trust before a reply, send, calendar write, repair, or work action.

Important Cursor rule:

- `/cursor_status` is safe to use.
- Deeper Cursor work, result-file retrieval, and terminal controls are operator-only and live in the admin guide.

Surface shorthand:

- Telegram is the richest surface for normal day-to-day use.
- Alexa stays shorter and voice-first when it is enabled.
- BlueBubbles is the bounded personal messaging surface and stays mention-required.

## Best Ways To Ask

Andrea works best when your request includes the outcome you want.

Examples:

- `Remind me Friday at 2pm to check on the demo`
- `Summarize the last week of discussion and list the next three actions`
- `Research the best ergonomic keyboards under $150`
- `What is 1,234 plus 99?`

For short greetings, playful prompts, and basic math, Andrea may answer immediately through a fast direct-reply path. That is normal.

## What Andrea Can Do Right Now

- hold a normal conversation
- answer quick factual questions
- handle reminders and recurring follow-ups
- summarize notes, chats, and lightweight research
- help with project work in normal language
- show `/cursor_status` as a safe readiness check when the coding/integration path matters

If your admin enabled Alexa, Andrea can also answer short spoken questions like:

- `what should I know about today`
- `anything else`
- `what about Candace`
- `remind me before that`

Those voice features stay linked-account only and use explicit personalization controls.

If your admin enabled the work cockpit, Andrea can also keep one chat-scoped current work item across Cursor and Codex/OpenAI. That selection is operator-facing convenience only; explicit job or task ids still win whenever an admin uses them.

## Life Threads

Andrea can keep a small set of active **life threads** so she can remember what is still open without turning every chat into a giant memory blob.

Think of threads like:

- Candace
- family logistics
- band
- house stuff
- school follow-up
- health or routine carryover

What threads are for:

- active ongoing matters that may come back over several days
- thread-aware daily guidance like `What am I forgetting?`
- follow-up prompts like `What's still open with Candace?`
- save-for-later continuity like `save this under the band thread`

What threads are not:

- not a full project manager
- not hidden long-term memory
- not a replacement for reminders

Useful thread prompts:

- `What threads do I have open?`
- `What's active right now?`
- `What's still open with Candace?`
- `Save this under the family thread`
- `What do you know about this thread?`
- `Why do you think this is still open?`
- `Don't bring this up automatically`
- `Forget that thread`

Important trust rules:

- explicit save/track requests create or update a thread directly
- sensitive topics are not silently persisted just because they came up in conversation
- inferred thread suggestions are confirmation-first
- `forget that thread` deletes the thread; `close` or `pause` keeps history without surfacing it as active

## What To Expect From `/cursor_status`

`/cursor_status` is not a job launcher.
It is a safe readiness check that shows:

- whether Cursor Cloud heavy-lift jobs are ready
- whether desktop bridge terminal control is ready
- whether local desktop agent execution is still conditional
- whether optional Cursor-backed runtime routing is configured

If something says `unavailable`, send the exact output and timestamp to your admin.

## What Not To Expect

Normal users should not expect:

- deep Cursor job control commands
- desktop bridge terminal commands
- Amazon ordering flows
- Alexa admin setup
- marketplace skill management

Those are operator-managed extras, not the baseline user surface.

## If Something Feels Off

1. Run `/ping`.
2. Run `/mainchat` and confirm this DM is the registered main chat.
3. Run `/help`.
4. Retry the plain-language ask.
5. Run `/cursor_status` if the coding/status path seems off.
6. Send your admin the exact command, reply, and approximate time.

## One-Line Mental Model

Andrea is conversation-first.
Talk naturally, use the small safe command set when needed, and leave deeper operator workflows to your admin.
