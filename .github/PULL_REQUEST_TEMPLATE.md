<!-- contributing-guide: v2 -->

## Type of Change

- [ ] **Feature/capability** - adds or changes Andrea product behavior
- [ ] **Feature skill** - adds an optional channel or integration workflow
- [ ] **Utility skill** - adds a standalone tool (code files in `.claude/skills/<name>/`, no source changes)
- [ ] **Operational/container skill** - adds a workflow or agent skill (SKILL.md only, no source changes)
- [ ] **Fix** - bug fix or security fix to source code
- [ ] **Reliability/security** - hardens runtime, validation, or trust boundaries
- [ ] **Simplification** - reduces or simplifies source code
- [ ] **Documentation** - docs, README, or CONTRIBUTING changes only

## Description

Explain the problem, the smallest complete solution, behavior or security
boundaries affected, and any intentionally deferred work.

## Validation

- [ ] I ran focused tests for the changed behavior
- [ ] `npm run docs:check` passes when docs or command surfaces changed
- [ ] `npm run test:major:ci` passes, or I documented why it is not applicable
- [ ] I reviewed the diff for generated files, secrets, personal identifiers,
      unsafe shortcuts, and unrelated changes
- [ ] I listed any live, platform-specific, paid, or operator proof still needed

## For Skills

- [ ] SKILL.md contains instructions, not inline code (code goes in separate files)
- [ ] SKILL.md is under 500 lines
- [ ] I tested this skill on a fresh clone
