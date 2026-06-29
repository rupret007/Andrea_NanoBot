/**
 * Skills subsystem composition root.
 *
 * Wires the registry, loader, git-sync, selector, executor, and command
 * router together as one object the runtime can hold. Bootstraps the
 * default manifest on `init()`.
 *
 * Usage from agi-runtime:
 *
 *   const skills = await SkillsSubsystem.create({
 *     cacheDir: join(stateDir, "skills-cache"),
 *     autoSync: env.ANDREA_SKILLS_AUTOSYNC === "true",
 *   });
 *
 *   // In ask():
 *   const cmd = skills.resolveSlashCommand(text);
 *   if (cmd) return skills.executeCommand(cmd, modelClient, ...);
 *
 *   // Or, in the cognitive core's strategy classifier:
 *   const match = skills.bestMatch(goal);
 *   if (match && match.score > 0.5) return skills.execute(match.skill, ...);
 */

import { GitSync, GitSyncError } from './git-sync.js';
import { loadSkillsFromDirectory } from './loader.js';
import { DEFAULT_SKILL_MANIFEST } from './manifest.js';
import {
  BUILTIN_SKILL_SOURCE,
  createBuiltinWorkflowSkills,
} from './builtin.js';
import { SkillRegistry } from './registry.js';
import { bestSkill, selectSkill, type SelectOptions } from './selector.js';
import { resolveSlashCommand, type ResolvedCommand } from './commands.js';
import { executeSkill, type SkillExecutorModel } from './executor.js';
import type {
  Skill,
  SkillEpisode,
  SkillExecutionResult,
  SkillSource,
} from './types.js';

export * from './types.js';
export { SkillRegistry } from './registry.js';
export { selectSkill, bestSkill } from './selector.js';
export { executeSkill, type SkillExecutorModel } from './executor.js';
export {
  resolveSlashCommand,
  SLASH_COMMANDS,
  type ResolvedCommand,
} from './commands.js';
export { DEFAULT_SKILL_MANIFEST } from './manifest.js';
export {
  BUILTIN_SKILL_SOURCE,
  createBuiltinWorkflowSkills,
} from './builtin.js';
export { loadSkillsFromDirectory } from './loader.js';
export { GitSync, GitSyncError } from './git-sync.js';

export interface SkillsSubsystemOptions {
  /** Where to cache cloned repos. */
  cacheDir: string;
  /** Override the default manifest (defaults to DEFAULT_SKILL_MANIFEST). */
  manifest?: SkillSource[];
  /** Auto-clone the manifest on init(). Defaults to false. */
  autoSync?: boolean;
  /**
   * Optional callback invoked after every skill execution. The runtime
   * wires this to the reflector so failed verifications become candidate
   * lessons.
   */
  onEpisode?: (episode: SkillEpisode) => void | Promise<void>;
  /** Allowlisted hosts for git-sync. */
  allowedHosts?: string[];
}

export class SkillsSubsystem {
  readonly registry = new SkillRegistry();
  private readonly git: GitSync;
  private readonly opts: SkillsSubsystemOptions;
  /** When the most recent sync attempt finished. */
  lastSyncedAt: number | undefined;
  /** Per-source last-sync errors, keyed by source id. */
  readonly syncErrors = new Map<string, string>();

  private constructor(opts: SkillsSubsystemOptions) {
    this.opts = opts;
    this.git = new GitSync({
      cacheDir: opts.cacheDir,
      allowedHosts: opts.allowedHosts,
    });
  }

  static async create(opts: SkillsSubsystemOptions): Promise<SkillsSubsystem> {
    const sub = new SkillsSubsystem(opts);
    const manifest = opts.manifest ?? DEFAULT_SKILL_MANIFEST;
    for (const source of manifest) {
      sub.registry.registerSource(source);
    }
    if (opts.autoSync) {
      await sub.syncAll();
    } else {
      await sub.loadCachedSources();
    }
    sub.ensureBuiltinFallbacks();
    return sub;
  }

  /**
   * Sync every registered source. Errors on individual sources are caught
   * and recorded in `syncErrors` — one bad repo never blocks the others.
   */
  async syncAll(): Promise<void> {
    this.syncErrors.clear();
    for (const source of this.registry.listSources()) {
      try {
        await this.syncSource(source.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.syncErrors.set(source.id, msg);
      }
    }
    this.lastSyncedAt = Date.now();
  }

  async syncSource(sourceId: string): Promise<Skill[]> {
    const source = this.registry.getSource(sourceId);
    if (!source) {
      throw new GitSyncError(`unknown source ${sourceId}`, sourceId);
    }
    const skills = await this.git.sync(source);
    this.registry.purgeSource(sourceId);
    for (const s of skills) this.registry.upsert(s);
    this.registry.registerSource({ ...source, lastSyncedAt: Date.now() });
    return skills;
  }

  async loadCachedSources(): Promise<void> {
    this.syncErrors.clear();
    for (const source of this.registry.listSources()) {
      try {
        const skills = await this.git.loadCached(source);
        this.registry.purgeSource(source.id);
        for (const s of skills) this.registry.upsert(s);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.syncErrors.set(source.id, msg);
      }
    }
  }

  /** Add an in-repo vendored library (no network — direct fs load). */
  async loadVendored(params: {
    root: string;
    source: SkillSource;
  }): Promise<Skill[]> {
    const skills = await loadSkillsFromDirectory(params);
    this.registry.registerSource(params.source);
    this.registry.purgeSource(params.source.id);
    for (const s of skills) this.registry.upsert(s);
    return skills;
  }

  bestMatch(goal: string, opts?: SelectOptions) {
    return bestSkill(this.registry, goal, opts);
  }

  matches(goal: string, opts?: SelectOptions) {
    return selectSkill(this.registry, goal, opts);
  }

  resolveSlashCommand(text: string): ResolvedCommand | undefined {
    return resolveSlashCommand(this.registry, text);
  }

  private ensureBuiltinFallbacks(): void {
    this.registry.registerSource(BUILTIN_SKILL_SOURCE);
    for (const skill of createBuiltinWorkflowSkills()) {
      if (!this.registry.byName(skill.name)) {
        this.registry.upsert(skill);
      }
    }
  }

  /**
   * Run a skill against a goal and emit an episode for the reflector.
   * The runtime's modelClient is plumbed in here so all skill executions
   * go through the same router and budget meter as everything else.
   */
  async execute(params: {
    skill: Skill;
    goal: string;
    scope: string;
    model: SkillExecutorModel;
    system?: string;
    history?: { role: 'user' | 'assistant' | 'system'; content: string }[];
    maxOutputTokens?: number;
  }): Promise<SkillExecutionResult> {
    const result = await executeSkill(params.model, {
      skill: params.skill,
      goal: params.goal,
      system: params.system,
      history: params.history?.map((h) => ({
        role: h.role,
        content: h.content,
      })),
      maxOutputTokens: params.maxOutputTokens,
    });
    if (this.opts.onEpisode) {
      const episode: SkillEpisode = {
        id: `${params.scope}-${Date.now()}-${result.skillId}`,
        scope: params.scope,
        skillId: result.skillId,
        goal: result.goal,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        outcome: result.outcome,
        stepsTotal: result.trace.length,
        stepsSatisfied: result.trace.filter((s) => s.satisfied).length,
        notes:
          result.outcome === 'completed'
            ? undefined
            : (result.failureReason ?? 'incomplete'),
      };
      try {
        await this.opts.onEpisode(episode);
      } catch {
        // Reflector hook is best-effort. Never block the response.
      }
    }
    return result;
  }

  /** Format a citation block the runtime can append to skill answers. */
  static formatCitations(result: SkillExecutionResult): string {
    if (!result.citations.length) return '';
    const lines = result.citations.map((c) =>
      c.upstreamUrl
        ? `- [${c.sourceId}/${c.sourcePath}](${c.upstreamUrl})`
        : `- ${c.sourceId}/${c.sourcePath}`,
    );
    return `\n\n---\n_Skill workflow used:_\n${lines.join('\n')}`;
  }
}
