import { tsImport } from 'tsx/esm/api';

await tsImport(
  new URL('./acquisition-worker.ts', import.meta.url).href,
  import.meta.url,
);
