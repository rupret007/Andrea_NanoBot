const REQUIRED_MAJOR = 22;
const raw = process.versions.node || '';
const major = Number.parseInt(raw.split('.')[0] || '', 10);

if (!Number.isFinite(major) || major !== REQUIRED_MAJOR) {
  console.error(
    `NanoClaw requires Node ${REQUIRED_MAJOR}.x. Detected Node ${raw || 'unknown'}.\n` +
      'Switch to Node 22 and reinstall dependencies before running build/test commands.',
  );
  process.exit(1);
}
