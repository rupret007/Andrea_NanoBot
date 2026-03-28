---
name: openclaw-market
description: Discover and enable curated community OpenClaw skills from the bundled VoltAgent catalog while keeping activation isolated per chat.
---

# Community Skill Marketplace

Use this skill when the user wants a new capability that NanoClaw does not already have.

## What to do

1. Search first.
   Use `mcp__nanoclaw__search_openclaw_skills` with a short query describing the capability.

2. Present a shortlist.
   Show 3-5 relevant matches with:
   - skill name
   - category
   - one-sentence description
   - the registry URL

3. Wait for explicit approval.
   Do not install a community skill until the user clearly chooses one or directly asks you to install it.

4. Enable with MCP.
   Use `mcp__nanoclaw__enable_openclaw_skill` with the chosen URL.

5. Inspect or remove later.
   Use `mcp__nanoclaw__list_enabled_openclaw_skills` to see what is already active.
   Use `mcp__nanoclaw__disable_openclaw_skill` when the user wants to remove one from this chat.

## Safety rules

- Treat community skills as untrusted until proven otherwise.
- Prefer the most specific, least-privileged skill that solves the user's request.
- Never enable multiple skills at once unless the user explicitly asks.
- Enablement is isolated to the current chat unless the main chat intentionally targets another registered group.
- A newly enabled skill becomes available on the next message, not mid-turn.

## Good examples

- "Find a community skill for browsing GitHub issues."
- "Search for a browser automation skill."
- "Enable this exact ClawSkills result for this chat."
