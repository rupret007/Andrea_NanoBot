import { tsImport } from 'tsx/esm/api';

await tsImport(
  new URL('./production-capability-hard-kill-worker.ts', import.meta.url).href,
  import.meta.url,
);
