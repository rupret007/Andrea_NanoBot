# Evaluation strategy

A personal assistant lives or dies by whether it actually helps. "Helps" is subjective, so the eval pipeline mixes objective benchmarks with reproducible personal task replays.

## Three eval tiers

### Tier 1 — Subsystem unit tests

Live in `tests/`. Run on every PR via the existing vitest harness. They check that:

- Tree-of-thoughts terminates, prunes correctly, and respects budget.
- Council aggregation produces synthesis when margin < threshold.
- Self-refine never returns a worse-rated draft than its input.
- Vector store recall scoring is monotone in (similarity × recency × importance).
- Knowledge graph neighborhood expansion is bounded and finite.
- Policy gate denies background-initiated destructive calls.
- Audit log is hash-chained.
- Prompt-injection scanner flags the OWASP LLM01 corpus at >95% recall.

### Tier 2 — Capability benchmarks

Run weekly via `npm run eval:bench`. Replays standardized benchmarks against the routed primary model:

| Suite | What it measures | Target |
|---|---|---|
| MMLU-Pro (sample) | Broad knowledge | ≥ 78% |
| GPQA Diamond | Frontier reasoning | ≥ 50% |
| HumanEval+ | Code | ≥ 92% |
| GSM8K | Arithmetic | ≥ 95% |
| Needle-in-haystack 1M | Long context | 100% |
| ToolBench | Tool selection accuracy | ≥ 85% |
| Internal injection corpus | Refusal rate | ≥ 99% |

The numbers above are *targets the system has to clear before a strategy change ships* — they are the floor, not aspirational ceilings.

### Tier 3 — Personal task replay

The most important eval. Saved interactions where Jeff explicitly thumbed-up or corrected the assistant become a regression suite. Each release replays them and the council scores whether the new system's answer is "as good or better" than the previous one. Regressions block merge.

This is the eval that catches reflection-loop drift: if the system's prompts evolve in a way that improves benchmark numbers but makes Jeff's actual answers worse, Tier 3 catches it before Tier 2 misses it.

## Comparing strategies

When in doubt about whether a code change improves the system, run:

```bash
npm run eval:strategy -- --baseline main --candidate HEAD --suite jeff-replay
```

This replays the personal task suite under both branches and reports per-task winners with effect sizes. It is **expensive** (one council run per task per branch) so use it on architectural changes, not typo fixes.

## Things this eval does NOT measure

- Latency under real-world internet conditions. (We have a separate latency budget.)
- The actual usefulness of memory over months. (You only learn that by living with it for months.)
- Aesthetic / tone preferences. (Subjective; judged by Jeff.)

## When to ignore the eval

The eval is a heuristic. If the system feels worse but the numbers say it's better, *trust the feel*. The numbers are downstream of taste; we cannot fully formalize what "good" means.
