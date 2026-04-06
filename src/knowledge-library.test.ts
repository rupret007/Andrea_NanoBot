import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getKnowledgeSource,
  listKnowledgeChunksForSource,
} from './db.js';
import {
  deleteKnowledgeSourceById,
  disableKnowledgeSourceById,
  importKnowledgeFile,
  reindexKnowledgeSourceById,
  saveKnowledgeSource,
  searchKnowledgeLibrary,
} from './knowledge-library.js';

describe('knowledge library', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    _initTestDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-knowledge-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  it('saves explicit notes, chunks them, and retrieves them with provenance', () => {
    const saved = saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Candace Dinner Notes',
      content:
        'Candace wants to move dinner to Friday after rehearsal. The shared concern is keeping pickup timing simple and not pushing bedtime too late.',
      sourceType: 'manual_reference',
      tags: ['candace', 'dinner'],
      now: new Date('2026-04-05T18:00:00.000Z'),
    });

    expect(saved.ok).toBe(true);
    expect(saved.source?.sourceType).toBe('manual_reference');
    expect(saved.chunkCount).toBeGreaterThan(0);
    expect(
      listKnowledgeChunksForSource(saved.source!.sourceId).length,
    ).toBeGreaterThan(0);

    const search = searchKnowledgeLibrary({
      groupFolder: 'main',
      query: 'What did I save about Candace and dinner timing?',
    });

    expect(search.sources[0]?.title).toBe('Candace Dinner Notes');
    expect(search.hits[0]?.sourceTitle).toBe('Candace Dinner Notes');
    expect(search.hits[0]?.excerpt).toContain('Friday');
    expect(search.hits[0]?.matchReason).toMatch(/matched/);
  });

  it('imports supported local files and can reindex them after the file changes', () => {
    const filePath = path.join(tempDir!, 'band-plan.md');
    fs.writeFileSync(
      filePath,
      '# Band Planning\n\nOriginal note about rehearsal timing and gear load-in.',
      'utf8',
    );

    const imported = importKnowledgeFile({
      groupFolder: 'main',
      filePath,
      now: new Date('2026-04-05T19:00:00.000Z'),
    });

    expect(imported.ok).toBe(true);
    expect(imported.source?.contentRef).toBe(path.resolve(filePath));

    fs.writeFileSync(
      filePath,
      '# Band Planning\n\nUpdated note about drummer travel and gear load-in.',
      'utf8',
    );

    const reindexed = reindexKnowledgeSourceById(imported.source!.sourceId);
    expect(reindexed.ok).toBe(true);

    const search = searchKnowledgeLibrary({
      groupFolder: 'main',
      query: 'What did I save about drummer travel?',
    });

    expect(search.sources[0]?.sourceId).toBe(imported.source?.sourceId);
    expect(search.hits[0]?.excerpt).toContain('drummer travel');
  });

  it('excludes disabled and deleted sources from future retrieval', () => {
    const saved = saveKnowledgeSource({
      groupFolder: 'main',
      title: 'House Project Notes',
      content:
        'The house project note says to price the plumber first and delay tile choices until after the leak is fixed.',
      sourceType: 'manual_reference',
    });

    expect(disableKnowledgeSourceById(saved.source!.sourceId).ok).toBe(true);

    const disabledSearch = searchKnowledgeLibrary({
      groupFolder: 'main',
      query: 'What did I save about the plumber?',
    });
    expect(
      disabledSearch.sources.some(
        (source) => source.sourceId === saved.source!.sourceId,
      ),
    ).toBe(false);

    expect(deleteKnowledgeSourceById(saved.source!.sourceId).ok).toBe(true);
    expect(getKnowledgeSource(saved.source!.sourceId)?.deletedAt).toBeTruthy();
    expect(listKnowledgeChunksForSource(saved.source!.sourceId)).toHaveLength(
      0,
    );
  });
});
