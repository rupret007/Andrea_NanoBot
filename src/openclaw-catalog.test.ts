import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildOpenClawCatalogFromCategories,
  parseAwesomeCategoryMarkdown,
} from './openclaw-catalog.js';

describe('parseAwesomeCategoryMarkdown', () => {
  it('parses catalog entries and normalizes registry URLs', () => {
    const markdown = `# Security & Passwords

[← Back to main list](../README.md#table-of-contents)

**2 skills**

- [1password](https://clawskills.sh/skills/steipete-1password) - Set up and use 1Password CLI (op).
- [amai-id](https://www.clawhub.ai/Gonzih/amai-id) - Soul-Bound Keys and Soulchain for persistent.
`;

    const parsed = parseAwesomeCategoryMarkdown(
      markdown,
      'security-and-passwords',
    );

    expect(parsed.category).toEqual({
      name: 'Security & Passwords',
      slug: 'security-and-passwords',
      count: 2,
    });
    expect(parsed.skills).toEqual([
      {
        name: '1password',
        description: 'Set up and use 1Password CLI (op).',
        category: 'Security & Passwords',
        categorySlug: 'security-and-passwords',
        url: 'https://clawskills.sh/skills/steipete-1password',
        registry: 'clawskills',
      },
      {
        name: 'amai-id',
        description: 'Soul-Bound Keys and Soulchain for persistent.',
        category: 'Security & Passwords',
        categorySlug: 'security-and-passwords',
        url: 'https://clawhub.ai/Gonzih/amai-id',
        registry: 'clawhub',
      },
    ]);
  });
});

describe('buildOpenClawCatalogFromCategories', () => {
  it('builds a deduplicated catalog from category files', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-openclaw-catalog-'),
    );

    fs.writeFileSync(
      path.join(tempDir, 'git-and-github.md'),
      `# Git & GitHub

- [gh](https://clawskills.sh/skills/trumppo-gh) - GitHub CLI helpers.
- [shared](https://clawskills.sh/skills/demo-shared) - Shared item.
`,
    );

    fs.writeFileSync(
      path.join(tempDir, 'security-and-passwords.md'),
      `# Security & Passwords

- [shared](https://clawskills.sh/skills/demo-shared) - Shared item.
- [bitwarden](https://clawskills.sh/skills/asleep123-bitwarden) - Access and manage Bitwarden securely.
`,
    );

    const catalog = buildOpenClawCatalogFromCategories(
      tempDir,
      '2026-03-28T00:00:00.000Z',
    );

    expect(catalog.version).toBe(1);
    expect(catalog.generatedAt).toBe('2026-03-28T00:00:00.000Z');
    expect(catalog.categories).toEqual([
      { name: 'Git & GitHub', slug: 'git-and-github', count: 2 },
      {
        name: 'Security & Passwords',
        slug: 'security-and-passwords',
        count: 2,
      },
    ]);
    expect(catalog.skills.map((skill) => skill.url)).toEqual([
      'https://clawskills.sh/skills/trumppo-gh',
      'https://clawskills.sh/skills/demo-shared',
      'https://clawskills.sh/skills/asleep123-bitwarden',
    ]);
  });
});
