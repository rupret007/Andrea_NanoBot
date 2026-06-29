/**
 * Multi-model council.
 *
 * For high-stakes questions, ask several frontier models the same question,
 * have each propose an answer, then have each model VOTE on the candidate
 * answers (without knowing which one is theirs). Aggregate by confidence-
 * weighted plurality. Disagreement is a signal — when the council can't agree,
 * `synthesize` is called to merge instead of pick.
 *
 * This idea is older than LLMs (Hong et al.'s MetaGPT, the Society of Mind,
 * mixture-of-experts, debate setups). The wins compound when the panel is
 * heterogeneous (Claude + GPT + Gemini + a local Llama) because their failure
 * modes are uncorrelated.
 */

import type { CouncilVote } from './types.js';

export interface CouncilCandidate {
  /** Free-form id — typically the model name that produced it. */
  id: string;
  answer: string;
}

export interface VoteFn {
  (params: {
    voter: string;
    question: string;
    candidates: CouncilCandidate[];
  }): Promise<CouncilVote>;
}

export interface SynthesizeFn {
  (params: {
    question: string;
    candidates: CouncilCandidate[];
    votes: CouncilVote[];
  }): Promise<string>;
}

export interface CouncilOutcome {
  winner?: CouncilCandidate;
  votes: CouncilVote[];
  /** Plurality margin (0..1). */
  margin: number;
  synthesized?: string;
  unanimous: boolean;
}

/**
 * Run a council vote. If margin < `synthesisThreshold`, call `synthesize` to
 * merge candidates rather than declaring a winner.
 */
export async function runCouncil(params: {
  question: string;
  candidates: CouncilCandidate[];
  voters: string[];
  vote: VoteFn;
  synthesize: SynthesizeFn;
  synthesisThreshold?: number;
}): Promise<CouncilOutcome> {
  const { question, candidates, voters, vote, synthesize } = params;
  const synthesisThreshold = params.synthesisThreshold ?? 0.34;

  if (candidates.length === 0) {
    return { votes: [], margin: 0, unanimous: false };
  }
  if (candidates.length === 1) {
    return {
      winner: candidates[0],
      votes: [],
      margin: 1,
      unanimous: true,
    };
  }

  const votes: CouncilVote[] = await Promise.all(
    voters.map((v) => vote({ voter: v, question, candidates })),
  );

  // Confidence-weighted tally.
  const tally = new Array(candidates.length).fill(0);
  let validVoteCount = 0;
  for (const v of votes) {
    if (v.candidate < 0 || v.candidate >= candidates.length) continue;
    const conf = Number(v.confidence);
    const safeConf = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0;
    tally[v.candidate] += safeConf;
    validVoteCount += 1;
  }
  const totalScore = tally.reduce((a, b) => a + b, 0);
  const sorted = tally
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const runnerUp = sorted[1] ?? { score: 0, idx: -1 };

  // No real consensus signal: no voters at all, no in-range candidates voted
  // for, or the entire confidence-weighted tally is zero. Synthesize instead
  // of pretending we have a winner.
  if (votes.length === 0 || validVoteCount === 0 || totalScore <= 0) {
    const synthesized = await synthesize({
      question,
      candidates,
      votes,
    });
    return {
      winner: undefined,
      votes,
      margin: 0,
      synthesized,
      unanimous: false,
    };
  }

  const margin = (top.score - runnerUp.score) / totalScore;
  const unanimous =
    validVoteCount > 0 &&
    votes.every(
      (v) =>
        v.candidate === top.idx &&
        v.candidate >= 0 &&
        v.candidate < candidates.length,
    );

  if (margin < synthesisThreshold) {
    const synthesized = await synthesize({
      question,
      candidates,
      votes,
    });
    return {
      winner: undefined,
      votes,
      margin,
      synthesized,
      unanimous: false,
    };
  }

  return {
    winner: candidates[top.idx],
    votes,
    margin,
    unanimous,
  };
}
