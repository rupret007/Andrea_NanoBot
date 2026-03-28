import fs from 'fs';
import path from 'path';
import process from 'process';

import { buildOpenClawCatalogFromCategories } from '../src/openclaw-catalog.js';

function resolveSourceDir(repoRoot: string): string {
  const explicit = process.argv[2] || process.env.OPENCLAW_CATALOG_SOURCE;
  if (explicit) return path.resolve(repoRoot, explicit);
  return path.resolve(repoRoot, '..', 'awesome-openclaw-skills', 'categories');
}

function main(): void {
  const repoRoot = process.cwd();
  const sourceDir = resolveSourceDir(repoRoot);
  const outputPath = path.resolve(
    repoRoot,
    'container',
    'skills',
    'openclaw-market',
    'catalog.json',
  );

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source categories directory not found: ${sourceDir}`);
  }

  const catalog = buildOpenClawCatalogFromCategories(sourceDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(catalog, null, 2) + '\n');

  console.log(
    `Wrote ${catalog.skills.length} skills across ${catalog.categories.length} categories to ${outputPath}`,
  );
}

main();
