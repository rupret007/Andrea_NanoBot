/**
 * v14 Phase 1 — parser for the unified ``/job`` (and alias ``/work``)
 * command body.
 *
 * Extracted from ``index.ts`` so the parsing rules are unit-testable.
 * The format is intentionally tiny: an optional ``--lane=<value>`` flag
 * followed by free-form prompt text. Quoted prompts are handled by the
 * shared ``tokenizeCommandArguments`` helper.
 *
 * Lane values:
 *   --lane=cursor   force Cursor cloud
 *   --lane=codex    force Andrea OpenAI/Codex runtime
 *   --lane=auto     defer to the lane-picker heuristic (same as omitting)
 *   (omitted)       same as ``auto``
 */

import { tokenizeCommandArguments } from './cursor-command-parser.js';

export type UnifiedJobLaneOverride = 'cursor' | 'codex' | null;

export interface ParsedUnifiedJobCommand {
  laneOverride: UnifiedJobLaneOverride;
  prompt: string;
  error: string | null;
}

const LANE_FLAG_PATTERN = /^--lane[=:](.*)$/i;

const USAGE_MESSAGE =
  'Usage: /job [--lane=cursor|codex|auto] <prompt>. Example: /job refactor handlers.ts to use async/await';

export function parseUnifiedJobCommand(rawMessage: string): ParsedUnifiedJobCommand {
  const tokens = tokenizeCommandArguments((rawMessage || '').trim());
  // Drop the leading command token (/job, /work, etc.); the dispatcher
  // already validated which command was matched.
  const args = tokens.slice(1);
  let laneOverride: UnifiedJobLaneOverride = null;
  const promptParts: string[] = [];
  for (const token of args) {
    const match = LANE_FLAG_PATTERN.exec(token);
    if (match) {
      const value = match[1].trim().toLowerCase();
      if (value === 'cursor' || value === 'codex') {
        laneOverride = value;
        continue;
      }
      if (value === 'auto' || value === '') {
        laneOverride = null;
        continue;
      }
      return {
        laneOverride: null,
        prompt: '',
        error: `Unknown lane "${value}". Valid values: cursor, codex, auto.`,
      };
    }
    promptParts.push(token);
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    return {
      laneOverride,
      prompt: '',
      error: USAGE_MESSAGE,
    };
  }
  return { laneOverride, prompt, error: null };
}

export const UNIFIED_JOB_USAGE_MESSAGE = USAGE_MESSAGE;
