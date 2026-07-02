/**
 * Self-critique / self-refine.
 *
 * After producing an answer, the agent generates a critique of its own draft
 * (using a separate prompt that asks specifically for FAILURE modes), then
 * rewrites if the critique surfaces problems. This catches a meaningful
 * fraction of hallucinations and missed constraints — especially when the
 * critic is run with a stricter "find what's wrong" prompt rather than a
 * sycophantic "rate this answer" prompt.
 *
 * Reference: Madaan et al. 2023, "Self-Refine: Iterative Refinement with
 * Self-Feedback".
 */

export interface CritiqueOutcome {
  acceptable: boolean;
  issues: string[];
  /** Severity of the worst issue (0 = none, 1 = block-shipping). */
  severity: number;
  /** A focused fix prompt the rewriter can use. */
  fixPrompt?: string;
  tokens: number;
}

export type CriticFn = (params: {
  question: string;
  draft: string;
}) => Promise<CritiqueOutcome>;

export type RewriterFn = (params: {
  question: string;
  draft: string;
  critique: CritiqueOutcome;
}) => Promise<{ revised: string; tokens: number }>;

export interface RefineResult {
  finalAnswer: string;
  iterations: Array<{ draft: string; critique: CritiqueOutcome }>;
  tokens: number;
}

/**
 * Iteratively refine a draft. Stops when the critic is satisfied or
 * `maxIterations` is reached. Each iteration must STRICTLY reduce the
 * severity score — if it doesn't, we accept the previous draft to prevent
 * thrashing into worse versions.
 */
export async function refine(params: {
  question: string;
  draft: string;
  critic: CriticFn;
  rewrite: RewriterFn;
  maxIterations?: number;
  acceptThreshold?: number;
}): Promise<RefineResult> {
  const maxIterations = params.maxIterations ?? 2;
  const acceptThreshold = params.acceptThreshold ?? 0.2;

  let current = params.draft;
  let tokens = 0;
  const iterations: RefineResult['iterations'] = [];

  // The critique for the *current* draft. On the first pass we have to ask
  // the critic; on subsequent iterations we can reuse the recheck result
  // from the previous rewrite (which was a critique of the same draft).
  let pendingCritique: CritiqueOutcome | undefined;

  for (let i = 0; i < maxIterations; i++) {
    let critique: CritiqueOutcome;
    if (pendingCritique) {
      critique = pendingCritique;
      pendingCritique = undefined;
      iterations.push({ draft: current, critique });
    } else {
      critique = await params.critic({
        question: params.question,
        draft: current,
      });
      tokens += critique.tokens;
      iterations.push({ draft: current, critique });
    }

    if (critique.acceptable || critique.severity <= acceptThreshold) {
      return { finalAnswer: current, iterations, tokens };
    }

    const rewritten = await params.rewrite({
      question: params.question,
      draft: current,
      critique,
    });
    tokens += rewritten.tokens;

    // Guardrail against thrashing: only accept the rewrite if the critic
    // would now rate it less severe.
    const recheck = await params.critic({
      question: params.question,
      draft: rewritten.revised,
    });
    tokens += recheck.tokens;
    if (recheck.severity < critique.severity) {
      current = rewritten.revised;
      // Reuse the recheck on the next iteration instead of re-critiquing.
      pendingCritique = recheck;
    } else {
      // The rewrite made things worse — keep the previous draft.
      iterations.push({ draft: rewritten.revised, critique: recheck });
      break;
    }
  }

  return { finalAnswer: current, iterations, tokens };
}
