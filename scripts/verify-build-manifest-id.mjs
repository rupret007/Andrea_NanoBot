import fs from 'node:fs';

const [manifestPath, expectedGitCommit] = process.argv.slice(2);

if (!manifestPath || !/^[0-9a-f]{40,64}$/iu.test(expectedGitCommit || '')) {
  process.stderr.write(
    'Usage: verify-build-manifest-id.mjs <manifest-path> <git-commit>\n',
  );
  process.exitCode = 1;
} else {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      value.version !== 1 ||
      value.gitCommit !== expectedGitCommit ||
      value.gitDirtyPathCount !== 0 ||
      !/^[0-9a-f]{64}$/iu.test(value.artifactSha256 || '')
    ) {
      throw new Error(
        'build manifest is not for the exact clean current Git commit',
      );
    }
    process.stdout.write(`${value.gitCommit}:${value.artifactSha256}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid manifest';
    process.stderr.write(`Build manifest verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
