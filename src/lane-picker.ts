/**
 * v14 Phase 1 — auto-select a backend lane from prompt content.
 *
 * This is a deterministic heuristic, not an LLM call. The platform's
 * deliberation layer will replace it in v14 Phase 2 with capability-profile
 * scoring. For now, the goal is just: a single ``/job`` command on every
 * chat surface that picks the right lane often enough that the auto path
 * is useful, and falls back to ``ambiguous`` (which surfaces a clarifying
 * question) when it can't tell.
 *
 * The lane choices today are ``cursor`` (Cursor cloud agent — best at
 * repo-aware multi-file edits, refactors, PR generation) and ``codex``
 * (Andrea's local OpenAI/Codex runtime — best at deterministic bash/python
 * execution, build/test loops, tool-use traces).
 *
 * The heuristic is intentionally small: no NLP, no model. It scans the
 * prompt for verb + filetype patterns and returns one of three verdicts:
 * ``cursor``, ``codex``, ``ambiguous``. Ambiguous prompts surface to the
 * user as a clarifying question rather than guessing. We'd rather ask
 * once than route to the wrong lane and burn 10 minutes of cloud cost.
 */

export type LanePick = 'cursor' | 'codex' | 'ambiguous';

export interface LanePickResult {
  lane: LanePick;
  reason: string;
  matchedTokens: string[];
}

const CURSOR_VERB_PATTERN =
  /\b(refactor|rename|extract|inline|edit|change|fix|update|rewrite|modify|patch|implement|add|remove|delete|migrate|port|cleanup|simplify|reorganize|reorganise|restructure|split|merge|combine)\b/i;

const CURSOR_NOUN_PATTERN =
  /\b(file|files|module|class|function|method|component|controller|model|view|test|tests|spec|specs|repo|repository|branch|pr|pull[\s-]?request|interface|type|schema)\b/i;

const CURSOR_FILETYPE_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|scala|sql|md|json|ya?ml|toml|html|css|scss)\b/i;

const CODEX_VERB_PATTERN =
  /\b(run|execute|exec|build|compile|test|check|lint|format|install|setup|configure|deploy|ship|release|push|pull|fetch|clone|invoke|trigger|kick(?:\s|-)?off|spin[\s-]?up|tear[\s-]?down)\b/i;

const CODEX_TOOL_PATTERN =
  /\b(npm|pnpm|yarn|pip|poetry|cargo|go\s+(?:run|build|test)|make|bash|shell|terminal|cli|docker|kubectl|ssh|scp|curl|wget|gh\b|git(?:\s|-)?(?:push|pull|status|log|diff|merge|rebase|cherry-pick))\b/i;

const SHELL_HINT_PATTERN = /(?:^|\s)\$\s|(?:^|\s)`[^`]+`/;

/**
 * Pick a lane for a prompt. Pure: same input → same output, always.
 * Returns ``ambiguous`` when neither pattern set fires, the prompt is too
 * short, or both fire equally — caller is expected to surface a
 * clarifying question.
 */
export function pickLaneForPrompt(prompt: string): LanePickResult {
  const text = prompt.trim();
  if (text.length < 8) {
    return {
      lane: 'ambiguous',
      reason: 'prompt_too_short',
      matchedTokens: [],
    };
  }

  const matched: string[] = [];
  const cursorVerb = CURSOR_VERB_PATTERN.exec(text);
  if (cursorVerb) matched.push(`cursor_verb:${cursorVerb[0].toLowerCase()}`);
  const cursorNoun = CURSOR_NOUN_PATTERN.exec(text);
  if (cursorNoun) matched.push(`cursor_noun:${cursorNoun[0].toLowerCase()}`);
  const cursorFiletype = CURSOR_FILETYPE_PATTERN.exec(text);
  if (cursorFiletype)
    matched.push(`cursor_filetype:${cursorFiletype[0].toLowerCase()}`);

  const codexVerb = CODEX_VERB_PATTERN.exec(text);
  if (codexVerb) matched.push(`codex_verb:${codexVerb[0].toLowerCase()}`);
  const codexTool = CODEX_TOOL_PATTERN.exec(text);
  if (codexTool) matched.push(`codex_tool:${codexTool[0].toLowerCase()}`);
  const shellHint = SHELL_HINT_PATTERN.exec(text);
  if (shellHint) matched.push('codex_shell_hint');

  // Score each lane. Tool/filetype hits are worth more than verbs alone
  // because they are less likely to false-positive on conversational
  // prompts ("change of plans" matches CURSOR_VERB but doesn't deserve
  // routing to Cursor by itself).
  let cursorScore = 0;
  if (cursorVerb) cursorScore += 1;
  if (cursorNoun) cursorScore += 1;
  if (cursorFiletype) cursorScore += 2;

  let codexScore = 0;
  if (codexVerb) codexScore += 1;
  if (codexTool) codexScore += 2;
  if (shellHint) codexScore += 2;

  if (cursorScore === 0 && codexScore === 0) {
    return {
      lane: 'ambiguous',
      reason: 'no_pattern_matched',
      matchedTokens: matched,
    };
  }
  if (cursorScore === codexScore) {
    return {
      lane: 'ambiguous',
      reason: 'tie_between_lanes',
      matchedTokens: matched,
    };
  }
  if (cursorScore > codexScore) {
    return {
      lane: 'cursor',
      reason: `cursor_score_${cursorScore}_vs_codex_${codexScore}`,
      matchedTokens: matched,
    };
  }
  return {
    lane: 'codex',
    reason: `codex_score_${codexScore}_vs_cursor_${cursorScore}`,
    matchedTokens: matched,
  };
}

/**
 * Format a clarifying question for ambiguous prompts. Called by the
 * dispatch handler when ``pickLaneForPrompt`` returns ``ambiguous``.
 */
export function formatLaneClarificationPrompt(
  rawPrompt: string,
  result: LanePickResult,
): string {
  const trimmed = rawPrompt.trim();
  const snippet =
    trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  return [
    `I can't tell whether to send this to Cursor (repo-aware code edits) or`,
    `Codex (local execution / build / test). Reply with one of:`,
    ``,
    `  /job --lane=cursor ${snippet}`,
    `  /job --lane=codex ${snippet}`,
    ``,
    `(reason: ${result.reason})`,
  ].join('\n');
}
