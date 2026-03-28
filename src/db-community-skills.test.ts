import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  disableCommunitySkillForGroup,
  enableCommunitySkillForGroup,
  getCommunitySkillById,
  getCommunitySkillByUrl,
  listAllEnabledCommunitySkills,
  listEnabledCommunitySkillsForGroup,
  upsertCommunitySkill,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function seedCommunitySkill(): void {
  upsertCommunitySkill({
    skill_id: 'demo/sample',
    owner: 'demo',
    slug: 'sample',
    display_name: 'Sample Skill',
    source_url: 'https://clawskills.sh/skills/demo-sample',
    canonical_clawhub_url: 'https://clawhub.ai/demo/sample',
    github_tree_url:
      'https://github.com/openclaw/skills/tree/main/skills/demo/sample',
    cache_dir_name: 'openclaw-demo-sample',
    cache_path: '/tmp/cache/demo/sample',
    manifest_path: '/tmp/cache/demo/sample/.nanoclaw-openclaw-market.json',
    cached_at: '2026-03-28T00:00:00.000Z',
    file_count: 3,
    virus_total_status: 'Benign',
    openclaw_status: 'Benign',
    openclaw_summary: 'Looks fine.',
  });
}

describe('community skill accessors', () => {
  it('stores and looks up cached community skills', () => {
    seedCommunitySkill();

    expect(getCommunitySkillById('demo/sample')?.display_name).toBe(
      'Sample Skill',
    );
    expect(
      getCommunitySkillByUrl('https://clawhub.ai/demo/sample')?.cache_dir_name,
    ).toBe('openclaw-demo-sample');
  });

  it('tracks enablement per group and supports disable', () => {
    seedCommunitySkill();
    enableCommunitySkillForGroup(
      'whatsapp_main',
      'demo/sample',
      '2026-03-28T01:00:00.000Z',
    );

    expect(listEnabledCommunitySkillsForGroup('whatsapp_main')).toHaveLength(1);
    expect(listAllEnabledCommunitySkills()).toHaveLength(1);

    disableCommunitySkillForGroup('whatsapp_main', 'demo/sample');

    expect(listEnabledCommunitySkillsForGroup('whatsapp_main')).toHaveLength(0);
    expect(listAllEnabledCommunitySkills()).toHaveLength(0);
  });
});
