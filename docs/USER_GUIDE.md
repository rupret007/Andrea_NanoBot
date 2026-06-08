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
- Use `/cognition`, `cognition status`, `cognitive workspace status`, `agency loop status`, `convergence status`, `runtime spine status`, `agent runtime status`, `supervisor status`, `blackboard status`, `session graph status`, `continuity status`, `what sessions are connected?`, `what belongs together?`, `why did you choose that?`, `why do you believe that?`, `why is that true?`, `what supports that?`, `what could be wrong?`, `how certain are you?`, `what are the alternatives?`, `what's missing?`, `what's most useful next?`, `what changed?`, `what is stale?`, `what do you know for sure?`, `what should you verify next?`, `what is most useful now?`, `what evidence supports this?`, `show the plan first`, or `run the safe checks` to inspect the Cognitive Workspace packet, safe task graph, Agent OS episode, Runtime Spine checkpoints, Supervisor Core blackboard/handoffs, Session Graph continuity clusters, continuity cockpit action queue, Agency Convergence selected action, Logic Kernel claims, Truth Engine support, World Model proof debt, uncertainty, approval blockers, and useful next action. Use `that is stale`, `mark that current`, or `resolve that` only when you are intentionally correcting Andrea's belief state.
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

It does not replace reminders, missions, action bundles, life threads, communication help, or the Cognitive Workspace. It sits above them, builds a small current-world snapshot, picks the narrowest useful existing capability, preserves approval gates, records the outcome, and keeps one short explanation for later.

Useful explanation asks:

- `why did you suggest that?`
- `what are you using to decide this?`
- `why didn't you add it to my calendar?`
- `why are you bringing that up?`
- `what's the current focus?`

Boundaries stay the same: Andrea can answer, plan, draft, save, remind, and stage approvals through existing systems, but sends, calendar writes, deletes, service changes, commits, pushes, purchases, and other side effects still require the appropriate confirmation/proof path.

## Repair Status And Tool Reliability

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
