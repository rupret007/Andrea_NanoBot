import { tsImport } from 'tsx/esm/api';

await tsImport(
  new URL('./bluebubbles-message-action-worker.ts', import.meta.url).href,
  import.meta.url,
);
