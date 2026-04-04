const REQUIRED_MAJOR = 22;
const raw = process.versions.node || '';
const major = Number.parseInt(raw.split('.')[0] || '', 10);
const allowBootstrap =
  process.argv.includes('--allow-bootstrap') && process.platform === 'win32';

if (!Number.isFinite(major) || major !== REQUIRED_MAJOR) {
  if (allowBootstrap) {
    console.warn(
      `NanoClaw setup bootstrap detected Node ${raw || 'unknown'} on Windows. ` +
        `Continuing only so the pinned Node ${REQUIRED_MAJOR}.x runtime can be installed and used.`,
    );
    process.exit(0);
  }
  console.error(
    `NanoClaw requires Node ${REQUIRED_MAJOR}.x. Detected Node ${raw || 'unknown'}.\n` +
      'Switch to Node 22 and reinstall dependencies before running build/test commands.',
  );
  process.exit(1);
}
