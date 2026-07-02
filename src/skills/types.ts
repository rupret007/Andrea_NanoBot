/**
 * Skills subsystem types.
 *
 * A "skill" is a structured, agent-followable workflow encoded as a Markdown
 * file with frontmatter (the SKILL.md format used by Claude skills,
 * addyosmani/agent-skills, OpenCode, Gemini CLI, etc.). Skills give Andrea
 * battle-tested process knowledge — when to write a spec, what to test, how
 * to review — that the cognitive core can actually FOLLOW, not just cite.
 *
 * Design intent:
 *   - Skills are first-class data, not text dumped into a prompt. The
 *     cognitive core's "skill-driven" strategy reads the structured fields
 *     (steps, verification, anti-rationalizations) and walks them.
 *   - Skills come from named "sources" (a github repo, a local folder, an
 *     uploaded zip). Each source can be re-synced; the registry merges by
 *     stable id.
 *   - Personas are skills with a "persona" kind — they're loaded into the
 *     council when convened by name.
 *   - References are skills with a "reference" kind — passive context, not
 *     a workflow.
 */

export type SkillKind = 'workflow' | 'persona' | 'reference';

export interface SkillStep {
  /** 1-based step number as it appears in SKILL.md. */
  index: number;
  /** Short title of the step. */
  title: string;
  /** Body of the step — instructions to follow. */
  body: string;
  /** Whether this step is a verification gate (must produce evidence). */
  verification: boolean;
}

export interface SkillRationalization {
  excuse: string;
  rebuttal: string;
}

export interface Skill {
  /** Stable id: `${sourceId}:${name}`. */
  id: string;
  /** The skill name from frontmatter (lowercase-hyphen). */
  name: string;
  /** Description used by the selector to match queries. */
  description: string;
  /** Where this skill came from (source id + path inside source). */
  sourceId: string;
  sourcePath: string;
  /** Optional URL pointing back at the original file. */
  upstreamUrl?: string;
  /** Workflow / persona / reference. */
  kind: SkillKind;
  /** Anchor tags used to filter by category (e.g. ["build","testing"]). */
  tags: string[];
  /** Free-form trigger phrases the selector uses for keyword matching. */
  triggers: string[];
  /** Parsed step list (workflows only). Empty for personas / references. */
  steps: SkillStep[];
  /** Anti-rationalization table (workflows only). */
  rationalizations: SkillRationalization[];
  /** Red-flag patterns the executor watches for. */
  redFlags: string[];
  /** Verification requirements summarized as bullet points. */
  verification: string[];
  /** Optional system-prompt body (personas use this directly). */
  systemPrompt?: string;
  /** Full raw body, for fallback / display / RAG. */
  body: string;
  /** Hash of the body — used to detect upstream changes. */
  fingerprint: string;
  /** When this skill was last loaded. */
  loadedAt: number;
}

export interface SkillSource {
  /** Stable source id, e.g. "addyosmani/agent-skills". */
  id: string;
  /** Display name. */
  name: string;
  /** Repository URL (https only — for safety). */
  url: string;
  /** Path inside the repo where SKILL.md / persona / reference files live. */
  paths: {
    /** Folders containing SKILL.md (one per subdirectory). */
    skills?: string[];
    /** Folders containing persona .md files (one persona per file). */
    personas?: string[];
    /** Folders containing reference .md files. */
    references?: string[];
  };
  /** Optional commit/branch pin. Defaults to the default branch HEAD. */
  ref?: string;
  /** When this source was last synced. */
  lastSyncedAt?: number;
  /** Description used in /skills listings. */
  description?: string;
  /** License (informational — we don't redistribute, we link). */
  license?: string;
}

export interface SkillSelectorMatch {
  skill: Skill;
  /** Combined score 0..1. */
  score: number;
  /** Why this skill matched — surfaced to the user. */
  reasons: string[];
}

export interface SkillExecutionStep {
  step: SkillStep;
  startedAt: number;
  finishedAt?: number;
  /** What the agent thought / did at this step. */
  output: string;
  /** Whether the agent considered the step satisfied. */
  satisfied: boolean;
  /** Optional evidence string (test output, link, file diff). */
  evidence?: string;
}

export interface SkillExecutionResult {
  skillId: string;
  goal: string;
  startedAt: number;
  finishedAt: number;
  /** Final synthesized answer the user sees. */
  answer: string;
  /** Step-by-step trace for the audit log + reflector. */
  trace: SkillExecutionStep[];
  /** Citations: { sourceId, sourcePath, upstreamUrl }. */
  citations: { sourceId: string; sourcePath: string; upstreamUrl?: string }[];
  /** Did the workflow run to completion or bail mid-way. */
  outcome: 'completed' | 'incomplete' | 'aborted';
  /** Optional failure reason if outcome != "completed". */
  failureReason?: string;
}

/**
 * A skill-execution episode — what the reflector consumes to learn.
 */
export interface SkillEpisode {
  id: string;
  scope: string;
  skillId: string;
  goal: string;
  startedAt: number;
  finishedAt: number;
  outcome: SkillExecutionResult['outcome'];
  /** Step-level pass/fail counts. */
  stepsTotal: number;
  stepsSatisfied: number;
  /** Surface-level user feedback if any (thumbs, "no that's wrong", etc.). */
  userFeedback?: 'positive' | 'negative';
  /** Optional follow-up reflection when outcome was bad. */
  notes?: string;
}

/** Anchor for the skill-driven strategy in the cognitive core. */
export interface SkillRouterDecision {
  match?: SkillSelectorMatch;
  /** Reason the router decided not to use a skill (e.g. "no match", "low confidence"). */
  abstainReason?: string;
}
