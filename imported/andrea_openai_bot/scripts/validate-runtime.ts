import {
  ensureContainerRuntimeRunning,
  getContainerRuntimeStatus,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { runContainerAgent } from '../src/container-runner.js';
import type { AgentRuntimeName } from '../src/types.js';

function parseArgs(args: string[]): {
  runtime: AgentRuntimeName;
  prompt: string;
  route: 'local_required' | 'cloud_allowed' | 'cloud_preferred';
} {
  let runtime: AgentRuntimeName = 'codex_local';
  let route: 'local_required' | 'cloud_allowed' | 'cloud_preferred' =
    'local_required';
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runtime' && args[i + 1]) {
      const next = args[i + 1] as AgentRuntimeName;
      if (
        next === 'codex_local' ||
        next === 'openai_cloud' ||
        next === 'claude_legacy'
      ) {
        runtime = next;
      }
      i++;
      continue;
    }
    if (arg === '--route' && args[i + 1]) {
      const next = args[i + 1];
      if (
        next === 'local_required' ||
        next === 'cloud_allowed' ||
        next === 'cloud_preferred'
      ) {
        route = next;
      }
      i++;
      continue;
    }
    promptParts.push(arg);
  }

  const defaultPrompt =
    runtime === 'codex_local'
      ? 'Reply with exactly: Andrea Codex local ok'
      : 'Summarize why this runtime is in fallback mode in one short sentence.';

  return {
    runtime,
    route,
    prompt: promptParts.join(' ').trim() || defaultPrompt,
  };
}

async function main(): Promise<void> {
  const { runtime, route, prompt } = parseArgs(process.argv.slice(2));
  const containerRuntime = resolveContainerRuntimeName();
  const containerRuntimeStatus = getContainerRuntimeStatus(containerRuntime);

  ensureContainerRuntimeRunning();

  const folder = `runtime-validation-${runtime}`;
  const output = await runContainerAgent(
    {
      name: `Runtime Validation (${runtime})`,
      folder,
      trigger: '@Andrea',
      added_at: new Date().toISOString(),
      isMain: true,
    },
    {
      prompt,
      groupFolder: folder,
      chatJid: `tg:${folder}`,
      isMain: true,
      preferredRuntime: runtime,
      runtimeRoute: route,
      requestPolicy: {
        route: 'direct_assistant',
        reason: 'manual runtime validation',
        builtinTools: ['Read'],
        mcpTools: [],
        guidance: 'Keep the reply concise and literal.',
      },
    },
    () => {},
  );

  console.log(
    JSON.stringify(
      {
        requestedRuntime: runtime,
        containerRuntime,
        containerRuntimeStatus,
        prompt,
        output,
      },
      null,
      2,
    ),
  );

  if (output.status === 'error') {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
