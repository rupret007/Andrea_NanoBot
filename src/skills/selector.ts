/**
 * Skill selector — given a user goal, pick the best matching skill.
 *
 * Two-pass scoring:
 *
 *   1. Cheap keyword pass — score every skill by token overlap between the
 *      goal and the skill's triggers/tags/description/name. This runs in
 *      microseconds and is what most queries hit. No model call.
 *
 *   2. Optional re-rank — if the registry has an embedder, re-rank the top
 *      N candidates by cosine similarity. Off by default; the cognitive
 *      core opts in for /ask-tech.
 *
 * The selector returns a confidence score so the cognitive core can decide
 * whether to commit to skill-driven execution (high confidence) or fall back
 * to its default strategy mix (low confidence).
 */

import type { Skill, SkillKind, SkillSelectorMatch } from './types.js';
import type { SkillRegistry } from './registry.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'you',
  'your',
  'we',
  'our',
  'us',
  'they',
  'them',
  'their',
  'what',
  'how',
  'do',
  'does',
  'can',
  'should',
  'would',
  'if',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function scoreSkill(
  goal: string,
  skill: Skill,
): { score: number; reasons: string[] } {
  const goalTokens = tokenize(goal);
  const reasons: string[] = [];
  let score = 0;

  // Name and trigger phrases are the strongest signal — heavy weight.
  for (const trigger of skill.triggers) {
    const tt = tokenize(trigger);
    const j = jaccard(goalTokens, tt);
    if (j > 0) {
      score += j * 0.45;
      reasons.push(`trigger "${trigger}" overlap=${j.toFixed(2)}`);
    }
  }

  // Direct substring of skill name in the goal — strong.
  const nameLc = skill.name.toLowerCase();
  if (goal.toLowerCase().includes(nameLc.replace(/-/g, ' '))) {
    score += 0.5;
    reasons.push(`name "${skill.name}" present in goal`);
  }

  // Description token overlap — moderate.
  const descTokens = tokenize(skill.description);
  const descJ = jaccard(goalTokens, descTokens);
  if (descJ > 0) {
    score += descJ * 0.25;
    reasons.push(`description overlap=${descJ.toFixed(2)}`);
  }

  // Tag overlap — light.
  for (const tag of skill.tags) {
    if (goalTokens.includes(tag)) {
      score += 0.05;
      reasons.push(`tag "${tag}"`);
    }
  }

  // Cap at 1.0 so downstream confidence checks have a stable scale.
  return { score: Math.min(1, score), reasons };
}

export interface SelectOptions {
  /** Restrict to a kind (e.g. workflow). */
  kind?: SkillKind;
  /** How many top matches to return. */
  topK?: number;
  /** Minimum score to count as a match (0..1). Default 0.15. */
  minScore?: number;
}

export function selectSkill(
  registry: SkillRegistry,
  goal: string,
  opts: SelectOptions = {},
): SkillSelectorMatch[] {
  const minScore = opts.minScore ?? 0.15;
  const topK = opts.topK ?? 3;
  const kind = opts.kind ?? 'workflow';

  const candidates = registry.list({ kind });
  const scored: SkillSelectorMatch[] = [];
  for (const skill of candidates) {
    const { score, reasons } = scoreSkill(goal, skill);
    if (score < minScore) continue;
    scored.push({ skill, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Convenience: pick a single best match or undefined if no skill clears
 * the confidence threshold. Used by the cognitive core's classifier.
 */
export function bestSkill(
  registry: SkillRegistry,
  goal: string,
  opts: SelectOptions = {},
): SkillSelectorMatch | undefined {
  const matches = selectSkill(registry, goal, { ...opts, topK: 1 });
  return matches[0];
}
