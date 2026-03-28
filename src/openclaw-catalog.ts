import fs from 'fs';
import path from 'path';

export interface OpenClawCatalogEntry {
  name: string;
  description: string;
  category: string;
  categorySlug: string;
  url: string;
  registry: 'clawhub' | 'clawskills';
}

export interface OpenClawCatalogCategory {
  name: string;
  slug: string;
  count: number;
}

export interface OpenClawCatalog {
  version: 1;
  generatedAt: string;
  sourceRepo: string;
  categories: OpenClawCatalogCategory[];
  skills: OpenClawCatalogEntry[];
}

const SKILL_LINE_PATTERN = /^- \[(.+?)\]\((https?:\/\/[^)]+)\) - (.+)$/;

function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());

  if (url.hostname === 'www.clawhub.ai') {
    url.hostname = 'clawhub.ai';
  }

  if (url.hostname === 'www.clawskills.sh') {
    url.hostname = 'clawskills.sh';
  }

  url.hash = '';
  return url.toString();
}

function getRegistry(url: string): 'clawhub' | 'clawskills' {
  const { hostname } = new URL(url);
  if (hostname === 'clawhub.ai') return 'clawhub';
  return 'clawskills';
}

export function parseAwesomeCategoryMarkdown(
  markdown: string,
  fallbackCategorySlug: string,
): {
  category: OpenClawCatalogCategory;
  skills: OpenClawCatalogEntry[];
} {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((line) => line.startsWith('# '));
  const categoryName = heading?.slice(2).trim() || fallbackCategorySlug;
  const skills: OpenClawCatalogEntry[] = [];

  for (const line of lines) {
    const match = line.match(SKILL_LINE_PATTERN);
    if (!match) continue;

    const [, name, rawUrl, description] = match;
    const url = normalizeUrl(rawUrl);
    skills.push({
      name: name.trim(),
      description: description.trim(),
      category: categoryName,
      categorySlug: fallbackCategorySlug,
      url,
      registry: getRegistry(url),
    });
  }

  return {
    category: {
      name: categoryName,
      slug: fallbackCategorySlug,
      count: skills.length,
    },
    skills,
  };
}

export function buildOpenClawCatalogFromCategories(
  categoriesDir: string,
  generatedAt = new Date().toISOString(),
): OpenClawCatalog {
  const categoryFiles = fs
    .readdirSync(categoriesDir)
    .filter((file) => file.endsWith('.md'))
    .sort();

  const categories: OpenClawCatalogCategory[] = [];
  const skills: OpenClawCatalogEntry[] = [];
  const seenUrls = new Set<string>();

  for (const file of categoryFiles) {
    const categorySlug = path.basename(file, '.md');
    const markdown = fs.readFileSync(path.join(categoriesDir, file), 'utf8');
    const parsed = parseAwesomeCategoryMarkdown(markdown, categorySlug);

    categories.push(parsed.category);

    for (const skill of parsed.skills) {
      if (seenUrls.has(skill.url)) continue;
      seenUrls.add(skill.url);
      skills.push(skill);
    }
  }

  skills.sort((a, b) => {
    const categoryOrder = a.category.localeCompare(b.category);
    if (categoryOrder !== 0) return categoryOrder;
    return a.name.localeCompare(b.name);
  });

  return {
    version: 1,
    generatedAt,
    sourceRepo: 'https://github.com/VoltAgent/awesome-openclaw-skills',
    categories,
    skills,
  };
}
