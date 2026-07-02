/**
 * SKILL.md parser.
 *
 * Reads the canonical agent-skills format:
 *
 *   ---
 *   name: skill-name
 *   description: One-paragraph description used by the selector. Use when…
 *   tags: [build, testing]
 *   triggers: [run tests, write tests, tdd]
 *   ---
 *
 *   # Overview
 *   ...
 *
 *   ## When to Use
 *   ...
 *
 *   ## Process
 *   ### 1. Step title
 *   Step body
 *
 *   ### 2. Another step (verify)
 *   Verification step body
 *
 *   ## Rationalizations
 *   | Excuse | Rebuttal |
 *   | --- | --- |
 *   | "I'll add tests later" | Tests later are tests never. |
 *
 *   ## Red Flags
 *   - Skipping the spec phase
 *   - Marking work done without proof
 *
 *   ## Verification
 *   - Tests pass
 *   - Build succeeds
 *
 * The parser is permissive: missing sections are fine, frontmatter is
 * optional (we synthesize defaults), and we never throw — a malformed file
 * yields a usable Skill with whatever we could recover.
 */

import { createHash } from 'node:crypto';
import type {
  Skill,
  SkillKind,
  SkillRationalization,
  SkillStep,
} from './types.js';

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tags?: string[];
  triggers?: string[];
  kind?: SkillKind;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/**
 * Parse a SKILL.md / persona.md / reference.md file body into a Skill.
 *
 * Pure function — does not touch the filesystem. The loader is responsible
 * for finding files and computing the source/path metadata.
 */
export function parseSkillFile(params: {
  raw: string;
  sourceId: string;
  sourcePath: string;
  upstreamUrl?: string;
  kind?: SkillKind;
  fallbackName?: string;
}): Skill {
  const { raw, sourceId, sourcePath, upstreamUrl } = params;
  const fm = extractFrontmatter(raw);
  const body = fm.bodyAfter;

  const name =
    fm.parsed.name?.trim() ||
    params.fallbackName ||
    deriveNameFromPath(sourcePath);

  // Kind precedence: explicit param > frontmatter > path heuristic > "workflow".
  const kind: SkillKind =
    params.kind ??
    fm.parsed.kind ??
    guessKindFromPath(sourcePath) ??
    'workflow';

  const description =
    fm.parsed.description?.trim() ||
    extractFirstParagraph(body) ||
    `${kind} from ${sourceId}:${sourcePath}`;

  const tags = uniq([
    ...(fm.parsed.tags ?? []),
    ...inferTagsFromBody(body),
  ]).map((t) => t.toLowerCase());

  const triggers = uniq([
    ...(fm.parsed.triggers ?? []),
    name.replace(/-/g, ' '),
    ...inferTriggersFromBody(body),
  ]).map((t) => t.toLowerCase());

  const steps = kind === 'workflow' ? extractSteps(body) : [];
  const rationalizations =
    kind === 'workflow' ? extractRationalizations(body) : [];
  const redFlags =
    kind === 'workflow' ? extractBulletSection(body, /red\s*flag/i) : [];
  const verification =
    kind === 'workflow'
      ? extractBulletSection(body, /^verification|^evidence/i)
      : [];

  // Personas use the body as a system prompt, with the leading H1 stripped.
  const systemPrompt =
    kind === 'persona' ? stripLeadingHeader(body) : undefined;

  const fingerprint = createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, 16);

  return {
    id: `${sourceId}:${name}`,
    name,
    description,
    sourceId,
    sourcePath,
    upstreamUrl,
    kind,
    tags,
    triggers,
    steps,
    rationalizations,
    redFlags,
    verification,
    systemPrompt,
    body,
    fingerprint,
    loadedAt: Date.now(),
  };
}

// -- Frontmatter extraction ------------------------------------------------

function extractFrontmatter(raw: string): {
  parsed: ParsedFrontmatter;
  bodyAfter: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { parsed: {}, bodyAfter: raw };
  const fmBody = m[1];
  const after = raw.slice(m[0].length);
  return { parsed: parseSimpleYaml(fmBody), bodyAfter: after };
}

/**
 * Tiny YAML subset parser sufficient for SKILL.md frontmatter:
 *   key: value
 *   key: [a, b, c]
 *   key: |
 *     multi-line block
 *
 * We refuse to pull in a real YAML lib because the AGI core has the
 * "zero new runtime dependencies" rule. This handles every shape used
 * by addyosmani/agent-skills, opencode, and the canonical Claude skills.
 */
function parseSimpleYaml(s: string): ParsedFrontmatter {
  const out: ParsedFrontmatter = {};
  const lines = s.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1].toLowerCase();
    const rest = m[2];
    if (rest === '' || rest === '|' || rest === '>') {
      // Multi-line block — gather indented lines.
      const block: string[] = [];
      i += 1;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        block.push(lines[i].replace(/^\s+/, ''));
        i += 1;
      }
      assignFm(out, key, block.join(' '));
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1);
      const items = inner
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      assignFm(out, key, items);
      i += 1;
      continue;
    }
    assignFm(out, key, rest.replace(/^["']|["']$/g, ''));
    i += 1;
  }
  return out;
}

function assignFm(
  out: ParsedFrontmatter,
  key: string,
  value: string | string[],
): void {
  if (key === 'name' && typeof value === 'string') out.name = value;
  else if (key === 'description' && typeof value === 'string')
    out.description = value;
  else if (key === 'tags') {
    out.tags = Array.isArray(value)
      ? value
      : value.split(/[,;]\s*/).filter(Boolean);
  } else if (key === 'triggers' || key === 'trigger') {
    out.triggers = Array.isArray(value)
      ? value
      : value.split(/[,;]\s*/).filter(Boolean);
  } else if (key === 'kind' && typeof value === 'string') {
    if (value === 'workflow' || value === 'persona' || value === 'reference') {
      out.kind = value;
    }
  }
}

// -- Step extraction -------------------------------------------------------

/**
 * Pull steps out of common workflow sections. Upstream skill repos are not
 * perfectly consistent: the same idea may be called Process, Steps,
 * Workflow, Cycle, or Checklist. Each ### heading or numbered list item
 * under the selected section is one step.
 */
function extractSteps(body: string): SkillStep[] {
  const section =
    extractSection(
      body,
      /^(?:the\s+)?(?:.+\s+)?(?:process|steps?|workflow|cycle|checklist)$/i,
    ) ?? extractSection(body, /process|steps?|workflow|cycle|checklist/i);
  if (!section) return [];
  const steps: SkillStep[] = [];
  // Match either ### N. Title \n body... or numbered list items "1. Title — body".
  const headingRe = /^###\s+(.+?)\s*$/gm;
  const matches = [...section.matchAll(headingRe)];
  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const startBody = m.index! + m[0].length;
      const endBody =
        i + 1 < matches.length ? matches[i + 1].index! : section.length;
      const title = stripLeadingNumber(m[1]).trim();
      const stepBody = section.slice(startBody, endBody).trim();
      steps.push({
        index: i + 1,
        title,
        body: stepBody,
        verification: /verif|prove|gate|check/i.test(title),
      });
    }
    return steps;
  }
  // Fallback: numbered list items.
  const itemRe = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let it: RegExpExecArray | null;
  let idx = 0;
  while ((it = itemRe.exec(section)) !== null) {
    idx += 1;
    const title = it[2]
      .split(/[—:.]\s/)[0]
      .slice(0, 120)
      .trim();
    steps.push({
      index: idx,
      title,
      body: it[2].trim(),
      verification: /verif|prove|gate|check/i.test(it[2]),
    });
  }
  return steps;
}

// -- Rationalization table extraction --------------------------------------

function extractRationalizations(body: string): SkillRationalization[] {
  const section = extractSection(body, /rationaliz|excuse|anti-pattern/i);
  if (!section) return [];
  const out: SkillRationalization[] = [];
  for (const line of section.split(/\r?\n/)) {
    // Markdown table row: | excuse | rebuttal |
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const left = m[1].trim();
    const right = m[2].trim();
    // Skip header / separator rows.
    if (/^[-:|\s]+$/.test(left) || /^excuse$/i.test(left)) continue;
    if (!left || !right) continue;
    out.push({ excuse: stripBackticks(left), rebuttal: stripBackticks(right) });
  }
  return out;
}

// -- Generic helpers -------------------------------------------------------

function extractSection(body: string, headingRe: RegExp): string | null {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (headingRe.test(m[2])) {
        start = i + 1;
        startLevel = m[1].length;
      }
    } else if (m[1].length <= startLevel) {
      // Next same-or-higher heading ends the section.
      return lines.slice(start, i).join('\n');
    }
  }
  if (start === -1) return null;
  return lines.slice(start).join('\n');
}

function extractBulletSection(body: string, headingRe: RegExp): string[] {
  const section = extractSection(body, headingRe);
  if (!section) return [];
  const out: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (m) out.push(stripBackticks(m[1]).trim());
  }
  return out;
}

function extractFirstParagraph(body: string): string {
  const stripped = stripLeadingHeader(body).trim();
  const firstBlank = stripped.indexOf('\n\n');
  const para = firstBlank > -1 ? stripped.slice(0, firstBlank) : stripped;
  return para.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function stripLeadingHeader(body: string): string {
  return body.replace(/^#{1,6}\s+.+?\s*\r?\n+/, '');
}

function stripLeadingNumber(s: string): string {
  return s.replace(/^\s*(?:\d+[.)]|step\s+\d+[:.])\s*/i, '');
}

function stripBackticks(s: string): string {
  return s.replace(/`+/g, '').trim();
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function inferTagsFromBody(body: string): string[] {
  const tags: string[] = [];
  const phaseMatch = /(define|plan|build|verify|review|ship)/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = phaseMatch.exec(body)) !== null) {
    const t = m[1].toLowerCase();
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
    if (tags.length >= 3) break;
  }
  return tags;
}

function inferTriggersFromBody(body: string): string[] {
  // Pull short imperative phrases from "use when" or the description body.
  const useWhen = extractSection(body, /^when to use|^use when/i);
  if (!useWhen) return [];
  const lines = useWhen
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l && l.length < 120);
  return lines.slice(0, 6);
}

function deriveNameFromPath(path: string): string {
  // /skills/test-driven-development/SKILL.md → test-driven-development
  const parts = path.split(/[\\/]+/).filter(Boolean);
  // Drop trailing SKILL.md if present.
  const last = parts[parts.length - 1] ?? '';
  if (/^skill\.md$/i.test(last) || /\.md$/i.test(last)) {
    if (parts.length >= 2) return parts[parts.length - 2].toLowerCase();
    return last.replace(/\.md$/i, '').toLowerCase();
  }
  return last.toLowerCase();
}

function guessKindFromPath(path: string): SkillKind | undefined {
  const lower = path.toLowerCase();
  if (
    /(^|[\\/])personas?[\\/]/.test(lower) ||
    /(^|[\\/])agents?[\\/]/.test(lower)
  )
    return 'persona';
  if (
    /(^|[\\/])references?[\\/]/.test(lower) ||
    /(^|[\\/])checklist/.test(lower)
  )
    return 'reference';
  if (/skill\.md$/i.test(lower)) return 'workflow';
  return undefined;
}
