/**
 * Slash-command map.
 *
 * The 7 canonical engineering-lifecycle commands from addyosmani/agent-skills,
 * plus /ask-tech for force-routing technical questions through skill mode.
 *
 * Resolution order, tried in turn:
 *   1. Exact slash-command match (e.g. /spec).
 *   2. Skill name match (e.g. /test-driven-development).
 *
 * Returning `undefined` lets the runtime fall through to its normal cognitive
 * core path. Returning a `command` tells the runtime to invoke the skill
 * directly with the remaining text as the goal.
 */

import type { SkillRegistry } from './registry.js';
import { bestSkill } from './selector.js';
import type { Skill } from './types.js';

export interface ResolvedCommand {
  command: string;
  skill: Skill;
  goal: string;
  /** True if user invoked /ask-tech — we should cite sources prominently. */
  citeSources: boolean;
}

/**
 * Map of /command → preferred skill name. The selector still runs as a
 * fallback so a command can pick a near-match if the canonical skill
 * isn't loaded yet.
 */
const COMMAND_TO_SKILL: Record<string, string> = {
  spec: 'spec-driven-development',
  plan: 'planning-and-task-breakdown',
  build: 'incremental-implementation',
  test: 'test-driven-development',
  review: 'code-review-and-quality',
  ship: 'shipping-and-launch',
  'code-simplify': 'code-simplification',
};

const TECH_PREFIX = 'ask-tech';

/**
 * Parse the leading slash command from a message. Returns the resolved
 * command + the goal text that follows it, or undefined if the message
 * doesn't start with a recognized command.
 */
export function resolveSlashCommand(
  registry: SkillRegistry,
  text: string,
): ResolvedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const m = /^\/([A-Za-z0-9-]+)\s*([\s\S]*)$/.exec(trimmed);
  if (!m) return undefined;
  const cmd = m[1].toLowerCase();
  const rest = m[2].trim();

  if (cmd === TECH_PREFIX) {
    if (!rest) return undefined;
    const match = bestSkill(registry, rest, { kind: 'workflow' });
    if (!match) return undefined;
    return { command: cmd, skill: match.skill, goal: rest, citeSources: true };
  }

  const target = COMMAND_TO_SKILL[cmd];
  if (target) {
    const skill =
      registry.byName(target) ??
      bestSkill(registry, rest || target, { kind: 'workflow' })?.skill;
    if (!skill) return undefined;
    return { command: cmd, skill, goal: rest || target, citeSources: false };
  }

  // Generic /skill-name resolution.
  const direct = registry.byName(cmd);
  if (direct)
    return { command: cmd, skill: direct, goal: rest, citeSources: false };
  return undefined;
}

export const SLASH_COMMANDS = [
  ...Object.keys(COMMAND_TO_SKILL).map((c) => `/${c}`),
  `/${TECH_PREFIX}`,
];
