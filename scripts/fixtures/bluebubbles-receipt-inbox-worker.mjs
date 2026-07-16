import { tsImport } from 'tsx/esm/api';

await tsImport(
  new URL('./bluebubbles-receipt-inbox-worker.ts', import.meta.url).href,
  import.meta.url,
);
