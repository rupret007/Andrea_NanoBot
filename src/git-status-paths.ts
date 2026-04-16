export function parseGitStatusPath(line: string): string | null {
  const normalized = line.replace(/\r$/, '');
  if (!normalized.trim()) return null;

  let rawPath: string;
  if (normalized.length >= 4 && normalized[2] === ' ') {
    rawPath = normalized.slice(3);
  } else if (normalized.length >= 3 && normalized[1] === ' ') {
    // Be defensive if a caller trimmed the full output and stripped the first
    // leading status-space from the first line.
    rawPath = normalized.slice(2);
  } else {
    rawPath = normalized.trim();
  }

  const trimmedPath = rawPath.trim();
  if (!trimmedPath) return null;
  if (trimmedPath.includes(' -> ')) {
    return trimmedPath.split(' -> ').at(-1)?.trim() || null;
  }
  return trimmedPath;
}

export function parseGitDirtyPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => parseGitStatusPath(line))
    .filter((path): path is string => Boolean(path));
}
