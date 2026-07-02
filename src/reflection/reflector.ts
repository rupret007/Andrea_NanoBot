/**
 * Reflection loop — Andrea's "good night, journal" pass.
 *
 * Runs on a schedule (default: nightly). Reads the day's episodic log,
 * scores each interaction on outcome quality, distills durable lessons into
 * the semantic store, updates the knowledge graph, and proposes prompt /
 * skill updates as PR drafts.
 *
 * Three sub-passes:
 *
 *   1. Distill — for each conversation, write a one-paragraph summary +
 *      candidate facts to the semantic store with provenance. Recency
 *      and importance are estimated by the model.
 *
 *   2. Critique — flag any interactions where the agent demonstrably
 *      failed (user expressed frustration, agent retried > 3 times,
 *      tool errors went unhandled). Write a feedback memory describing
 *      what to do differently.
 *
 *   3. Propose — synthesize the day's critiques into a small patch:
 *      adjusted persona prompts, new skill ideas, deprecation candidates.
 *      Output is a Markdown PR draft for human review — never auto-merged.
 *
 * The "never auto-merge" rule is deliberate: self-modification at the
 * reasoning-prompt layer is the kind of feedback loop that needs a human in
 * it until alignment guarantees catch up.
 */

import type { Message } from '../agi-core/types.js';
import type { Episode } from '../memory/episodic.js';
import type { MemoryFacade } from '../memory/index.js';

export interface ReflectorModel {
  complete(params: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

export interface ReflectionPatch {
  date: string;
  summary: string;
  /** Markdown body suitable for opening as a PR description. */
  proposal: string;
  /** Specific files the proposal would touch. */
  touches: string[];
}

export interface ReflectorOptions {
  /**
   * IANA timezone string used when stamping the daily date. Defaults to
   * `process.env.TZ` if set, otherwise `Intl.DateTimeFormat().resolvedOptions().timeZone`.
   * Pass an explicit value when running reflections for a user in a
   * different timezone than the host process.
   */
  tz?: string;
}

/** Cap on transcript-slice length we pass to the model. Most-recent wins. */
const TRANSCRIPT_CAP = 30_000;
/** Cap on the propose() body before code-fence wrapping. */
const PROPOSAL_BODY_CAP = 8000;

export class Reflector {
  private readonly tz: string;

  constructor(
    private readonly model: ReflectorModel,
    private readonly memory: MemoryFacade,
    opts: ReflectorOptions = {},
  ) {
    this.tz =
      opts.tz ??
      process.env.TZ ??
      (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
          return 'UTC';
        }
      })();
  }

  async runDaily(
    scope: string,
    dayStartMs: number,
    dayEndMs: number,
  ): Promise<ReflectionPatch> {
    const episodes = await this.memory.episodes.readWindow({
      since: dayStartMs,
      until: dayEndMs,
      scope,
    });

    const date = formatLocalDate(dayStartMs, this.tz);

    if (episodes.length === 0) {
      // Empty-day short-circuit — no model calls, no semantic writes.
      return {
        date,
        summary: 'No activity.',
        proposal: '_No interactions today._',
        touches: [],
      };
    }

    // Pass 1 — Distill
    const distilled = await this.distill(episodes);
    for (const fact of distilled.facts) {
      await this.memory.remember({
        kind: 'semantic',
        content: fact.text,
        scope,
        importance: fact.importance,
        observedAt: dayEndMs,
        lastAccessed: dayEndMs,
        tags: ['distilled', ...(fact.tags ?? [])],
        source: `reflection:${dayEndMs}`,
      });
    }

    // Pass 2 — Critique
    const critiques = await this.critique(episodes);
    for (const c of critiques) {
      await this.memory.remember({
        kind: 'procedural',
        content: c,
        scope,
        importance: 0.9,
        observedAt: dayEndMs,
        lastAccessed: dayEndMs,
        tags: ['feedback'],
        source: `reflection:${dayEndMs}`,
      });
    }

    // Pass 3 — Propose
    const proposal = await this.propose(distilled.summary, critiques);

    return {
      date,
      summary: distilled.summary,
      proposal: proposal.body,
      touches: proposal.touches,
    };
  }

  private async distill(episodes: Episode[]): Promise<{
    summary: string;
    facts: { text: string; importance: number; tags?: string[] }[];
  }> {
    const transcript = episodes
      .map((e) => `[${new Date(e.at).toISOString()}] ${e.actor}: ${e.content}`)
      .join('\n');
    const out = await this.model.complete({
      system:
        "You are an introspective journal. Read today's transcript and produce JSON: " +
        '{"summary": "...", "facts": [{"text": "...", "importance": 0..1, "tags": ["..."]}]}. ' +
        'Facts must be standalone (not requiring transcript context to interpret). ' +
        'Importance 1.0 = will matter for years; 0.1 = ephemeral.',
      // Keep the tail (most recent) of the transcript — head-truncation
      // would bias toward stale activity at the start of the day.
      messages: [{ role: 'user', content: transcript.slice(-TRANSCRIPT_CAP) }],
      temperature: 0,
      maxTokens: 2000,
    });
    return safeParse(out.text, {
      summary: out.text.slice(0, 200),
      facts: [],
    });
  }

  private async critique(episodes: Episode[]): Promise<string[]> {
    const transcript = episodes
      .map((e) => `${e.actor}: ${e.content}`)
      .join('\n');
    const out = await this.model.complete({
      system:
        'Find moments where the agent could do better. Return JSON {"lessons": ["..."]}. ' +
        'Each lesson should be a generalizable rule, not just a description of what went wrong.',
      // Keep the tail of the transcript — recent failures are the ones
      // actionable lessons should be drawn from.
      messages: [{ role: 'user', content: transcript.slice(-TRANSCRIPT_CAP) }],
      temperature: 0,
      maxTokens: 1200,
    });
    const parsed = safeParse<{ lessons?: unknown }>(out.text, { lessons: [] });
    return Array.isArray(parsed.lessons) ? parsed.lessons.map(String) : [];
  }

  private async propose(
    summary: string,
    lessons: string[],
  ): Promise<{ body: string; touches: string[] }> {
    if (lessons.length === 0) {
      return {
        body: `# Daily reflection\n\n${summary}\n\n_No improvements suggested._`,
        touches: [],
      };
    }
    const out = await this.model.complete({
      system:
        'Draft a PR description proposing concrete prompt or behavior changes derived from these lessons. ' +
        'Return JSON {"body": "<markdown>", "touches": ["src/persona/..."]}. ' +
        "Be conservative. Don't propose self-modifying tool wiring; only prompt or persona text.",
      messages: [
        {
          role: 'user',
          content:
            `Summary: ${summary}\n\nLessons:\n` +
            lessons.map((l, i) => `${i + 1}. ${l}`).join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 2000,
    });
    // Try to parse strict JSON; if that fails, fall back to wrapping the
    // raw model output in a code fence so any prompt-injection attempt
    // inside it can't masquerade as PR markdown that humans skim past.
    const parsed = safeParse<{ body: string; touches: string[] } | null>(
      out.text,
      null,
    );
    if (parsed && typeof parsed.body === 'string') {
      const body = capWithMarker(parsed.body, PROPOSAL_BODY_CAP);
      const touches = Array.isArray(parsed.touches)
        ? parsed.touches.map(String)
        : [];
      return { body, touches };
    }
    const fenced =
      '```md\n' + capWithMarker(out.text, PROPOSAL_BODY_CAP) + '\n```';
    return { body: fenced, touches: [] };
  }
}

function capWithMarker(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const marker = '\n… [truncated]';
  return s.slice(0, Math.max(0, cap - marker.length)) + marker;
}

function formatLocalDate(ms: number, tz: string): string {
  // YYYY-MM-DD in the requested IANA timezone. en-CA gives us ISO date
  // ordering directly without manual rebuilding.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
  } catch {
    // Bad tz string — fall back to UTC rather than throwing during a
    // nightly reflection.
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    const m = s.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : s) as T;
  } catch {
    return fallback;
  }
}
