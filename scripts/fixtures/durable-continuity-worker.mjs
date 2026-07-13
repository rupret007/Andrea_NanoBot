import { tsImport } from 'tsx/esm/api';

await tsImport(
  new URL('./durable-continuity-worker.ts', import.meta.url).href,
  import.meta.url,
);
