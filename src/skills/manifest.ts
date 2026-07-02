/**
 * Curated skill-source manifest.
 *
 * Each entry is a SkillSource the runtime auto-syncs on bootstrap (when
 * git is available and `ANDREA_SKILLS_AUTOSYNC=true`). New rounds of
 * "here's a useful repo" become one new entry here.
 *
 * To add a new repo:
 *   1. Append to `DEFAULT_SKILL_MANIFEST` below.
 *   2. List the in-repo paths that contain skills / personas / references.
 *   3. Optionally pin a ref. Otherwise we follow the default branch HEAD.
 *
 * The skill loader will silently skip paths that don't exist, so it's safe
 * to over-specify here for forward-compatibility with upstream renames.
 */

import type { SkillSource } from './types.js';

export const DEFAULT_SKILL_MANIFEST: SkillSource[] = [
  {
    id: 'addyosmani/agent-skills',
    name: 'Production engineering skills',
    description:
      '20 production-grade engineering workflows + 3 specialist personas + 4 reference checklists. ' +
      'Encodes Google-style senior-engineer process: spec-driven development, TDD, code review, ' +
      'security hardening, performance, deprecation, shipping.',
    url: 'https://github.com/addyosmani/agent-skills',
    license: 'MIT',
    paths: {
      skills: ['skills'],
      personas: ['agents'],
      references: ['references'],
    },
  },
];
