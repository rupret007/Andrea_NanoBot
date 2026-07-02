# Security model

## Threat model

This is a **personal** assistant — single-user, runs on Jeff's machine, talks to APIs Jeff has accounts on. The threats we model:

1. **Prompt injection** via untrusted text (emails, web pages, message bodies).
2. **Compromised credentials** — a leaked key shouldn't grant unbounded action capacity.
3. **Runaway costs** — a buggy reflection loop or an accidental tight loop running an expensive model.
4. **Confused-deputy** — a low-trust source (background scheduler) tricking the agent into a high-trust action (sending money).
5. **Memory poisoning** — adversarial content sneaking into the long-term memory and resurfacing in future contexts.
6. **Tampered audit log** — post-hoc edits hiding what the agent did.

## Mitigations

| Threat | Mitigation | File |
|---|---|---|
| Prompt injection | Pattern scan + LLM classifier + `<untrusted>` quarantine wrapper | `src/safety/prompt-injection.ts` |
| Compromised creds | Per-integration credential scope; secrets injected at request time only; audit log redacts strings that look like keys | `src/safety/audit-log.ts`, `src/integrations/types.ts` |
| Runaway costs | Per-window USD + call budget meter; router refuses models above per-call budget | `src/safety/budget.ts`, `src/models/router.ts` |
| Confused-deputy | Background-initiated calls auto-deny destructive/external effects | `src/safety/policy.ts` |
| Memory poisoning | Memory writes from untrusted sources are tagged; recall scoring deprioritizes untrusted entries; reflector quarantines `<untrusted>` content | `src/memory/types.ts`, `src/safety/prompt-injection.ts` |
| Tampered audit | Hash-chained append-only log | `src/safety/audit-log.ts` |

## Constitution

The constitution (`src/safety/constitution.ts`) is spliced into every system prompt with a version stamp. Trace records carry the constitution version so behavior is interpretable retroactively. Changing a principle requires bumping the version.

## Reversibility rule

The policy gate's default for `external` and `destructive` tools, when triggered by a direct user message, is **confirm** — not allow. Background tasks default to **deny** for those classes. Override per-tool with the user's allowlist.

## What this does NOT defend against

- A malicious *user* — Jeff trusts himself.
- A compromised model provider — if Anthropic or OpenAI returns a deliberately malicious answer, the constitution and self-critique pass might catch overt cases, but won't defeat targeted attack.
- Side-channel attacks on local disk — the audit log and memory files have OS-level permissions only; full-disk encryption is the user's responsibility.

## Reporting

This is a personal repo. Open an issue or DM Jeff if you find something. Public disclosure is fine — there is no production deployment.
