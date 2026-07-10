import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const markdownFiles = [path.join(repoRoot, 'README.md')];

function collectMarkdownFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      markdownFiles.push(entryPath);
    }
  }
}

collectMarkdownFiles(path.join(repoRoot, 'docs'));

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
}

const failures = [];
for (const filePath of markdownFiles) {
  const relativeFile = path.relative(repoRoot, filePath);
  const contents = fs.readFileSync(filePath, 'utf8');
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of contents.matchAll(linkPattern)) {
    const target = match[1].replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
    if (!target || isExternalTarget(target)) continue;
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!fs.existsSync(resolved)) {
      failures.push(`${relativeFile}: missing local link ${target}`);
    }
  }

  const commandPattern = /\bnpm run ([a-zA-Z0-9:_*-]+)/g;
  for (const match of contents.matchAll(commandPattern)) {
    const command = match[1];
    const exists = command.includes('*')
      ? Object.keys(packageJson.scripts || {}).some((script) =>
          script.startsWith(command.replace('*', '')),
        )
      : Boolean(packageJson.scripts?.[command]);
    if (!exists) {
      failures.push(`${relativeFile}: missing package script npm run ${command}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Documentation check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation check passed for ${markdownFiles.length} Markdown file(s).`);
