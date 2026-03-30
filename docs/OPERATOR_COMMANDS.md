# Operator Commands

These commands are intended for Andrea's main control chat only.

## Available

- `/runtime-status`
  - Shows current runtime configuration and readiness hints.

- `/runtime-jobs`
  - Shows active or queued runtime jobs.

- `/runtime-followup GROUP_FOLDER TEXT`
  - Queues a follow-up turn against a specific group folder.

- `/runtime-stop GROUP_FOLDER`
  - Requests a stop for the active runtime job in that group.

- `/runtime-logs GROUP_FOLDER [LINES]`
  - Returns the tail of the latest runtime log for that group.

## Disabled

- `/remote-control`
- `/remote-control-end`

Reason:

- this repo does not expose the old Claude remote-control bridge
- operator control is now service-native instead of tied to a Claude UI bridge

## Truthfulness Rules

What these commands do well today:

- runtime status
- job visibility
- targeted follow-up dispatch
- stop requests
- latest log tail retrieval

What they do not claim today:

- artifact browsing
- historical replay beyond current logs/state
- a live-validated Telegram operator walkthrough from this pass

## Validation State

Validated in focused tests:

- command gating
- main-control-only restrictions
- disabled remote-control messaging

Not live-driven through Telegram in this pass:

- a full operator chat flow against a connected real channel
