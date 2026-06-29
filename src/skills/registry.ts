/**
 * In-memory skill registry.
 *
 * Skills are keyed by `${sourceId}:${name}`. Re-registering a skill with the
 * same id replaces the prior entry — this is how `sync()` updates content
 * after a repo pull. Listings preserve insertion order so personas registered
 * first stay first in the selector's tie-breaker.
 */

import type { Skill, SkillKind, SkillSource } from './types.js';

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly sources = new Map<string, SkillSource>();

  registerSource(source: SkillSource): void {
    this.sources.set(source.id, { ...source });
  }

  upsert(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  remove(id: string): boolean {
    return this.skills.delete(id);
  }

  /** Drop every skill from a given source — used before re-syncing. */
  purgeSource(sourceId: string): number {
    let n = 0;
    for (const [id, s] of this.skills) {
      if (s.sourceId === sourceId) {
        this.skills.delete(id);
        n += 1;
      }
    }
    return n;
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  byName(name: string): Skill | undefined {
    // Returns the first skill whose name matches (case-insensitive). Ties
    // resolve to insertion order, which lets a curated source override a
    // generic one if registered first.
    const lc = name.toLowerCase();
    for (const s of this.skills.values()) {
      if (s.name.toLowerCase() === lc) return s;
    }
    return undefined;
  }

  list(filter?: {
    kind?: SkillKind;
    sourceId?: string;
    tag?: string;
  }): Skill[] {
    const out: Skill[] = [];
    for (const s of this.skills.values()) {
      if (filter?.kind && s.kind !== filter.kind) continue;
      if (filter?.sourceId && s.sourceId !== filter.sourceId) continue;
      if (filter?.tag && !s.tags.includes(filter.tag.toLowerCase())) continue;
      out.push(s);
    }
    return out;
  }

  listSources(): SkillSource[] {
    return [...this.sources.values()];
  }

  getSource(id: string): SkillSource | undefined {
    return this.sources.get(id);
  }

  size(): number {
    return this.skills.size;
  }
}
