import { execFile, spawn } from 'child_process';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

type AgentRuntimeName = 'codex_local' | 'openai_cloud' | 'claude_legacy';
type RuntimeRoute = 'local_required' | 'cloud_allowed' | 'cloud_preferred';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  preferredRuntime?: AgentRuntimeName;
  fallbackRuntime?: AgentRuntimeName;
  runtimeRoute?: RuntimeRoute;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  requestPolicy?: {
    route: string;
    reason: string;
    builtinTools: string[];
    mcpTools: string[];
    guidance: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  runtime?: AgentRuntimeName;
  error?: string;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const COMPATIBILITY_BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;
const COMPATIBILITY_MCP_TOOLS = [
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__enable_openclaw_skill',
  'mcp__nanoclaw__install_openclaw_skill',
  'mcp__nanoclaw__disable_openclaw_skill',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__search_amazon_products',
  'mcp__nanoclaw__request_amazon_purchase',
  'mcp__nanoclaw__list_amazon_purchase_requests',
  'mcp__nanoclaw__approve_amazon_purchase_request',
  'mcp__nanoclaw__cancel_amazon_purchase_request',
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
  'mcp__nanoclaw__register_group',
] as const;

function dedupeTools(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}

function normalizeRequestPolicy(
  policy: ContainerInput['requestPolicy'],
): NonNullable<ContainerInput['requestPolicy']> {
  if (policy) {
    return {
      route: policy.route,
      reason: policy.reason,
      builtinTools: dedupeTools([...policy.builtinTools, 'ToolSearch']),
      mcpTools: dedupeTools(policy.mcpTools),
      guidance: policy.guidance,
    };
  }

  return {
    route: 'code_plane',
    reason: 'compatibility fallback',
    builtinTools: dedupeTools(COMPATIBILITY_BUILTIN_TOOLS),
    mcpTools: dedupeTools(COMPATIBILITY_MCP_TOOLS),
    guidance:
      'Andrea is the only public assistant identity. Keep internal helper and orchestration details out of user-facing replies.',
  };
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function tryReadTextFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function resolveSdkModel(): string | undefined {
  const explicitModel =
    process.env.NANOCLAW_AGENT_MODEL ||
    process.env.CLAUDE_CODE_MODEL ||
    process.env.CLAUDE_MODEL;
  if (explicitModel) return explicitModel;

  const usingOpenAiCompatGateway = Boolean(
    process.env.ANTHROPIC_BASE_URL && process.env.OPENAI_API_KEY,
  );
  if (usingOpenAiCompatGateway) {
    return 'claude-3-5-sonnet-latest';
  }

  return undefined;
}

function resolveCodexModel(): string | undefined {
  const explicit =
    process.env.CODEX_LOCAL_MODEL ||
    process.env.NANOCLAW_AGENT_MODEL ||
    process.env.CLAUDE_CODE_MODEL;
  return explicit?.trim() || undefined;
}

function resolveOpenAiCloudModel(): string {
  return (process.env.OPENAI_MODEL_FALLBACK || 'gpt-5.4').trim() || 'gpt-5.4';
}

function resolvePreferredRuntime(containerInput: ContainerInput): AgentRuntimeName {
  return (
    containerInput.preferredRuntime ||
    ((process.env.AGENT_RUNTIME_DEFAULT as AgentRuntimeName | undefined) ??
      'codex_local')
  );
}

function resolveFallbackRuntime(
  containerInput: ContainerInput,
): AgentRuntimeName | undefined {
  return (
    containerInput.fallbackRuntime ||
    (process.env.AGENT_RUNTIME_FALLBACK as AgentRuntimeName | undefined)
  );
}

function canRouteToCloud(route: RuntimeRoute | undefined): boolean {
  return route !== 'local_required';
}

function shouldUseCodexLocal(): boolean {
  return process.env.CODEX_LOCAL_ENABLED !== 'false';
}

function buildRuntimeInstructionBlock(containerInput: ContainerInput): string {
  const requestPolicy = normalizeRequestPolicy(containerInput.requestPolicy);
  return [
    'Andrea is the only public assistant identity in this runtime.',
    requestPolicy.guidance,
    `Route classification: ${requestPolicy.route}.`,
    `Runtime route: ${containerInput.runtimeRoute || 'local_required'}.`,
    requestPolicy.builtinTools.length > 0
      ? `Allowed builtin tool classes: ${requestPolicy.builtinTools.join(', ')}.`
      : 'No builtin tool classes are allowed for this turn.',
    requestPolicy.mcpTools.length > 0
      ? `Allowed Andrea MCP tools: ${requestPolicy.mcpTools.join(', ')}.`
      : 'No Andrea MCP tools are allowed for this turn.',
  ].join('\n');
}

function syncCodexOverlay(containerInput: ContainerInput): void {
  const overlayPath = '/workspace/group/AGENTS.md';
  const sections = [
    '# Andrea Runtime Overlay',
    '',
    buildRuntimeInstructionBlock(containerInput),
  ];

  const globalMemory = tryReadTextFile('/workspace/global/CLAUDE.md');
  if (!containerInput.isMain && globalMemory?.trim()) {
    sections.push('', '## Global CLAUDE.md', '', globalMemory.trim());
  }

  const groupMemory = tryReadTextFile('/workspace/group/CLAUDE.md');
  if (groupMemory?.trim()) {
    sections.push('', '## Group CLAUDE.md', '', groupMemory.trim());
  }

  const content = `${sections.join('\n')}\n`;
  if (tryReadTextFile(overlayPath) === content) return;
  fs.writeFileSync(overlayPath, content);
}

function buildCodexPrompt(containerInput: ContainerInput, prompt: string): string {
  return [
    'Follow AGENTS.md and CLAUDE.md files in the workspace as canonical memory.',
    buildRuntimeInstructionBlock(containerInput),
    'User request:',
    prompt,
  ].join('\n\n');
}

function buildOpenAiCloudPrompt(
  containerInput: ContainerInput,
  prompt: string,
): string {
  return [
    'You are Andrea running in openai_cloud fallback mode.',
    buildRuntimeInstructionBlock(containerInput),
    'Cloud fallback limitations:',
    '- Do not claim to edit local files or run local shell commands.',
    '- Focus on research, summaries, planning, drafting, and other cloud-safe work.',
    'User request:',
    prompt,
  ].join('\n\n');
}

function buildCodexConfigArgs(
  containerInput: ContainerInput,
  mcpServerPath: string,
): string[] {
  const requestPolicy = normalizeRequestPolicy(containerInput.requestPolicy);
  if (requestPolicy.mcpTools.length === 0) {
    return [];
  }

  return [
    '-c',
    `mcp_servers.nanoclaw.command=${JSON.stringify('node')}`,
    '-c',
    `mcp_servers.nanoclaw.args=${JSON.stringify([mcpServerPath])}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_CHAT_JID=${JSON.stringify(containerInput.chatJid)}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_GROUP_FOLDER=${JSON.stringify(containerInput.groupFolder)}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_IS_MAIN=${JSON.stringify(containerInput.isMain ? '1' : '0')}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_REQUEST_ROUTE=${JSON.stringify(requestPolicy.route)}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_REQUEST_REASON=${JSON.stringify(requestPolicy.reason)}`,
    '-c',
    `mcp_servers.nanoclaw.env.NANOCLAW_ALLOWED_MCP_TOOLS=${JSON.stringify(JSON.stringify(requestPolicy.mcpTools))}`,
  ];
}

async function ensureCodexAuthenticated(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn('codex', ['login', '--with-api-key'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: process.env.HOME || '/home/node',
        CODEX_HOME: process.env.CODEX_HOME || '/home/node/.codex',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `codex login failed with exit code ${code}: ${stderr.trim() || 'unknown error'}`,
        ),
      );
    });
    child.stdin.write(`${apiKey}\n`);
    child.stdin.end();
  });
}

function extractCodexMessageText(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as {
    text?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (typeof candidate.text === 'string' && candidate.text.trim()) {
    return candidate.text.trim();
  }
  if (!Array.isArray(candidate.content)) return null;
  const text = candidate.content
    .filter((part) => part.type === 'output_text' || part.type === 'text')
    .map((part) => part.text || '')
    .join('')
    .trim();
  return text || null;
}

async function runCodexTurn(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<{ output: ContainerOutput; closedDuringTurn: boolean }> {
  syncCodexOverlay(containerInput);

  const model = resolveCodexModel();
  const configArgs = buildCodexConfigArgs(containerInput, mcpServerPath);
  const commandArgs = sessionId
    ? [
        'exec',
        'resume',
        ...configArgs,
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        ...(model ? ['--model', model] : []),
        sessionId,
        '-',
      ]
    : [
        'exec',
        ...configArgs,
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        ...(model ? ['--model', model] : []),
        '-',
      ];

  return new Promise((resolve, reject) => {
    const child = spawn('codex', commandArgs, {
      cwd: '/workspace/group',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: process.env.HOME || '/home/node',
        CODEX_HOME: process.env.CODEX_HOME || '/home/node/.codex',
      },
    });

    let stdoutBuffer = '';
    let stderr = '';
    let threadId = sessionId;
    let finalMessage: string | null = null;
    let eventError: string | null = null;
    let closedDuringTurn = false;

    const poller = setInterval(() => {
      if (!shouldClose()) return;
      closedDuringTurn = true;
      child.kill('SIGTERM');
    }, IPC_POLL_MS);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          message?: string;
          error?: string;
          item?: { type?: string; text?: string; content?: unknown[] };
        };

        if (typeof event.thread_id === 'string' && event.thread_id) {
          threadId = event.thread_id;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          finalMessage = extractCodexMessageText(event.item) || finalMessage;
        }
        if (event.type === 'error') {
          eventError = event.error || event.message || 'Codex emitted an error event';
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        handleLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearInterval(poller);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(poller);
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer.trim());
      }

      if (closedDuringTurn) {
        resolve({
          output: {
            status: 'success',
            result: null,
            newSessionId: threadId,
            runtime: 'codex_local',
          },
          closedDuringTurn: true,
        });
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            eventError || stderr.trim() || `codex exec failed with exit code ${code}`,
          ),
        );
        return;
      }

      resolve({
        output: {
          status: 'success',
          result: finalMessage,
          newSessionId: threadId,
          runtime: 'codex_local',
        },
        closedDuringTurn: false,
      });
    });

    child.stdin.write(buildCodexPrompt(containerInput, prompt));
    child.stdin.end();
  });
}

async function runOpenAiCloudTurn(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ output: ContainerOutput; closedDuringTurn: boolean }> {
  const client = new OpenAI({
    apiKey:
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      'openai-placeholder',
    baseURL: process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL,
  });

  const response = await client.responses.create({
    model: resolveOpenAiCloudModel(),
    input: buildOpenAiCloudPrompt(containerInput, prompt),
    ...(sessionId ? { previous_response_id: sessionId } : {}),
  });

  return {
    output: {
      status: 'success',
      result: response.output_text || null,
      newSessionId: response.id,
      runtime: 'openai_cloud',
    },
    closedDuringTurn: false,
  };
}

async function runClaudeTurn(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
): Promise<{ output: ContainerOutput; closedDuringTurn: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  let closedDuringTurn = false;
  const pollIpcDuringQuery = () => {
    if (shouldClose()) {
      closedDuringTurn = true;
      stream.end();
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  const requestPolicy = normalizeRequestPolicy(containerInput.requestPolicy);
  let newSessionId = sessionId;
  let finalMessage: string | null = null;

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      resume: sessionId,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: buildRuntimeInstructionBlock(containerInput),
      },
      env: process.env,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: resolveSdkModel(),
      mcpServers:
        requestPolicy.mcpTools.length > 0
          ? {
              nanoclaw: {
                command: 'node',
                args: [mcpServerPath],
                env: {
                  NANOCLAW_CHAT_JID: containerInput.chatJid,
                  NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
                  NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
                  NANOCLAW_REQUEST_ROUTE: requestPolicy.route,
                  NANOCLAW_REQUEST_REASON: requestPolicy.reason,
                  NANOCLAW_ALLOWED_MCP_TOOLS: JSON.stringify(
                    requestPolicy.mcpTools,
                  ),
                },
              },
            }
          : undefined,
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }
    if (message.type === 'result') {
      finalMessage =
        'result' in message ? (message as { result?: string }).result || null : null;
    }
  }

  return {
    output: {
      status: 'success',
      result: finalMessage,
      newSessionId,
      runtime: 'claude_legacy',
    },
    closedDuringTurn,
  };
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          resolve(null);
          return;
        }
        try {
          const result = JSON.parse(lastLine);
          resolve(
            typeof result.wakeAgent === 'boolean'
              ? (result as ScriptResult)
              : null,
          );
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function resolveFallbackForError(
  currentRuntime: AgentRuntimeName,
  containerInput: ContainerInput,
): AgentRuntimeName | undefined {
  const fallback = resolveFallbackRuntime(containerInput);
  if (!fallback || fallback === currentRuntime) return undefined;
  if (fallback === 'openai_cloud' && !canRouteToCloud(containerInput.runtimeRoute)) {
    return undefined;
  }
  return fallback;
}

async function runRuntimeLoop(
  initialPrompt: string,
  initialSessionId: string | undefined,
  containerInput: ContainerInput,
  mcpServerPath: string,
): Promise<void> {
  let prompt = initialPrompt;
  let sessionId = initialSessionId;
  let currentRuntime = resolvePreferredRuntime(containerInput);
  let codexAuthenticated = false;

  while (true) {
    try {
      if (currentRuntime === 'codex_local') {
        if (!shouldUseCodexLocal()) {
          throw new Error('codex_local is disabled by CODEX_LOCAL_ENABLED=false');
        }
        if (!codexAuthenticated) {
          await ensureCodexAuthenticated();
          codexAuthenticated = true;
        }
      }

      const turn =
        currentRuntime === 'codex_local'
          ? await runCodexTurn(prompt, sessionId, mcpServerPath, containerInput)
          : currentRuntime === 'openai_cloud'
            ? await runOpenAiCloudTurn(prompt, sessionId, containerInput)
            : await runClaudeTurn(prompt, sessionId, mcpServerPath, containerInput);

      const output: ContainerOutput = {
        ...turn.output,
        runtime: currentRuntime,
      };

      if (output.newSessionId) {
        sessionId = output.newSessionId;
      }

      writeOutput(output);

      if (output.status === 'error' || turn.closedDuringTurn) {
        break;
      }

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        runtime: currentRuntime,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        break;
      }
      prompt = nextMessage;
    } catch (err) {
      const fallback = resolveFallbackForError(currentRuntime, containerInput);
      if (!fallback) {
        throw err;
      }
      log(
        `Runtime ${currentRuntime} failed before completion, falling back to ${fallback}: ${err instanceof Error ? err.message : String(err)}`,
      );
      currentRuntime = fallback;
    }
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      // ignore
    }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(
      scriptResult.data,
      null,
      2,
    )}\n\nInstructions:\n${containerInput.prompt}`;
  }

  try {
    await runRuntimeLoop(prompt, sessionId, containerInput, mcpServerPath);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      runtime: resolvePreferredRuntime(containerInput),
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();
