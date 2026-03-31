# Operator Commands

These commands are intended for Andrea's main control chat only.

## Available

- `/runtime-status`
  - Shows current runtime configuration and readiness hints.

- `/runtime-jobs`
  - Shows active or queued runtime jobs.

- `/runtime-followup GROUP_FOLDER TEXT`
  - Queues a follow-up turn against a specific group folder.
  - Uses the internal orchestration service instead of a chat-only follow-up path.

- `/runtime-stop GROUP_FOLDER`
  - Requests a stop for the active runtime job in that group.
  - Uses the orchestration service when an Andrea job record is available, then falls back to the live group runtime if needed.

- `/runtime-logs GROUP_FOLDER [LINES]`
  - Returns the tail of the latest runtime log for that group.
  - Prefers the latest known orchestration job log when one exists, then falls back to the latest group log.

## Legacy Unsupported Commands

- `/remote-control`
- `/remote-control-end`

Reason:

- this repo does not expose the old Claude remote-control bridge
- operator control is now service-native instead of tied to a provider-specific UI bridge

## Truthfulness Rules

What these commands do well today:

- runtime status
- job visibility
- targeted follow-up dispatch
- stop requests
- latest log tail retrieval
- thin operator access to the same orchestration backend NanoClaw can later call

What they do not claim today:

- artifact browsing
- historical replay beyond current logs/state
- a live-validated Telegram operator walkthrough from this pass

## Validation State

Validated in focused tests:

- command gating
- main-control-only restrictions
- legacy remote-control rejection messaging
- runtime status, jobs, follow-up, stop, and logs dispatch behavior

Not live-driven through Telegram in this pass:

- a full operator chat flow against a connected real channel
