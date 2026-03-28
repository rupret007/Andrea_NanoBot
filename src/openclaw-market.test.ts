import { describe, expect, it } from 'vitest';

import {
  extractClawHubMetadata,
  extractClawHubUrlFromClawSkillsHtml,
  formatGitHubSkillNotFoundError,
  installDirNameForSkill,
  normalizeOpenClawSkillUrl,
  normalizeRelativeSkillPath,
  parseGitHubSkillTreeUrl,
  validateDownloadedSkillFiles,
} from './openclaw-market.js';

describe('normalizeOpenClawSkillUrl', () => {
  it('normalizes supported skill registry URLs', () => {
    expect(
      normalizeOpenClawSkillUrl(
        'https://www.clawhub.ai/Gonzih/amai-id#section',
      ),
    ).toBe('https://clawhub.ai/Gonzih/amai-id');
    expect(
      normalizeOpenClawSkillUrl(
        'clawskills.sh/skills/staratheris-arya-model-router?x=1',
      ),
    ).toBe('https://clawskills.sh/skills/staratheris-arya-model-router');
    expect(
      normalizeOpenClawSkillUrl(
        'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id?tab=readme#overview',
      ),
    ).toBe(
      'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id',
    );
  });
});

describe('extractClawHubUrlFromClawSkillsHtml', () => {
  it('finds the canonical ClawHub link in a ClawSkills page', () => {
    const html = `
      <a href="https://github.com/openclaw/skills/tree/main/skills/staratheris/arya-model-router">View on GitHub</a>
      <a href="https://clawhub.ai/staratheris/arya-model-router">View on ClawHub</a>
    `;

    expect(extractClawHubUrlFromClawSkillsHtml(html)).toBe(
      'https://clawhub.ai/staratheris/arya-model-router',
    );
  });
});

describe('extractClawHubMetadata', () => {
  it('extracts owner, slug, and security signals from ClawHub HTML', () => {
    const html = `
      <link rel="canonical" href="https://clawhub.ai/gonzih/amai-id"/>
      <title>AMAI ID — ClawHub</title>
      <div class="scan-result-scanner-name">VirusTotal</div>
      <div class="scan-result-status scan-status-clean">Benign</div>
      <div class="scan-result-scanner-name">OpenClaw</div>
      <div class="scan-result-status scan-status-clean">Benign</div>
      <span class="analysis-summary-text">Looks consistent but exercise caution.</span>
    `;

    expect(
      extractClawHubMetadata(html, 'https://clawhub.ai/gonzih/amai-id'),
    ).toEqual({
      owner: 'gonzih',
      slug: 'amai-id',
      displayName: 'AMAI ID',
      sourceUrl: 'https://clawhub.ai/gonzih/amai-id',
      canonicalClawHubUrl: 'https://clawhub.ai/gonzih/amai-id',
      githubTreeUrl:
        'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id',
      security: {
        virusTotalStatus: 'Benign',
        openClawStatus: 'Benign',
        openClawSummary: 'Looks consistent but exercise caution.',
      },
    });
  });

  it('rejects invalid canonical owner/slug coordinates', () => {
    const html = `
      <link rel="canonical" href="https://clawhub.ai/-invalid/amai-id"/>
      <title>AMAI ID - ClawHub</title>
    `;

    expect(() =>
      extractClawHubMetadata(html, 'https://clawhub.ai/gonzih/amai-id'),
    ).toThrow('Invalid skill coordinates');
  });
});

describe('parseGitHubSkillTreeUrl', () => {
  it('parses official openclaw skill tree URLs', () => {
    expect(
      parseGitHubSkillTreeUrl(
        'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id',
      ),
    ).toEqual({
      owner: 'gonzih',
      slug: 'amai-id',
      githubTreeUrl:
        'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id',
    });
  });

  it('parses official openclaw skill blob URLs and normalizes to tree URL', () => {
    expect(
      parseGitHubSkillTreeUrl(
        'https://github.com/openclaw/skills/blob/main/skills/gonzih/amai-id/SKILL.md',
      ),
    ).toEqual({
      owner: 'gonzih',
      slug: 'amai-id',
      githubTreeUrl:
        'https://github.com/openclaw/skills/tree/main/skills/gonzih/amai-id',
    });
  });

  it('rejects malformed or unsafe github skill coordinates', () => {
    expect(
      parseGitHubSkillTreeUrl(
        'https://github.com/openclaw/skills/tree/main/skills/%2e%2e/amai-id',
      ),
    ).toBeNull();
  });
});

describe('skill file validation', () => {
  it('requires SKILL.md and safe relative paths', () => {
    expect(() =>
      validateDownloadedSkillFiles([
        {
          relativePath: 'README.md',
          content: Buffer.from('hello'),
        },
      ]),
    ).toThrow('Skill is missing SKILL.md');

    expect(() => normalizeRelativeSkillPath('../SKILL.md')).toThrow(
      'Unsafe skill file path',
    );
  });
});

describe('installDirNameForSkill', () => {
  it('creates deterministic install folder names', () => {
    expect(installDirNameForSkill('StarAtheris', 'arya-model-router')).toBe(
      'openclaw-staratheris-arya-model-router',
    );
  });
});

describe('formatGitHubSkillNotFoundError', () => {
  it('maps official repo 404 errors to an actionable message', () => {
    const err = new Error(
      'Request failed for https://api.github.com/repos/openclaw/skills/contents/skills/martok9803/ci-whisperer: 404',
    );
    const mapped = formatGitHubSkillNotFoundError(
      err,
      'martok9803',
      'ci-whisperer',
    );
    expect(mapped?.message).toContain(
      'not found in the official openclaw/skills repository',
    );
  });

  it('does not rewrite unrelated errors', () => {
    const err = new Error('Request failed for https://api.github.com: 500');
    expect(formatGitHubSkillNotFoundError(err, 'demo', 'sample')).toBeNull();
  });
});
