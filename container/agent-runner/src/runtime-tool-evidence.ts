import { createHash, randomUUID } from 'node:crypto';

export const RUNTIME_TOOL_ACTION_CLASSES = [
  'repository_read',
  'repository_state',
  'repository_write',
  'verification_test',
  'verification_typecheck',
  'verification_build',
  'verification_lint',
  'verification_format',
  'web_research',
  'delegation',
  'external_side_effect',
  'workflow_control',
  'other',
] as const;

export type RuntimeToolActionClass =
  (typeof RUNTIME_TOOL_ACTION_CLASSES)[number];

export interface RuntimeToolActionEvidence {
  class: RuntimeToolActionClass;
  observed: number;
  succeeded: number;
  failed: number;
  unresolved: number;
  succeededAfterLastRepositoryWrite: number;
  lastOutcome: 'succeeded' | 'failed' | 'unresolved' | 'none';
  recovered: boolean;
}

export interface RuntimeToolEvidenceV1 {
  version: 1;
  evidenceId: string;
  cumulative: true;
  attempts: number;
  collectorStatus: 'complete' | 'partial';
  calls: {
    observed: number;
    succeeded: number;
    failed: number;
    unresolved: number;
  };
  actions: RuntimeToolActionEvidence[];
  state: {
    preStateFingerprint: string | null;
    postStateFingerprint: string | null;
    repositoryHeadFingerprint: string | null;
  };
  privacy: {
    metadataOnly: true;
    rawInputsStored: false;
    resultBodiesStored: false;
    toolUseIdsStored: false;
  };
}

type CallStatus = 'pending' | 'succeeded' | 'failed';
type RepositoryStateProbeKind = 'git_status_short';

interface CallRecord {
  classes: RuntimeToolActionClass[];
  status: CallStatus;
  observedOrder: number;
  lastEventOrder: number;
  resultOrder: number | null;
  resultFingerprint: string | null;
  repositoryHeadQuery: boolean;
  repositoryStateProbeKind: RepositoryStateProbeKind | null;
}

const MAX_TRANSIENT_COMMAND_CHARS = 4_096;
const MAX_TRANSIENT_RESULT_CHARS = 65_536;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEvidenceId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
  return normalized || randomUUID();
}

function commandSegments(command: string): string[] {
  return command
    .slice(0, MAX_TRANSIENT_COMMAND_CHARS)
    .split(/(?:&&|\|\||[;\n|])/)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function stripCommandPreamble(segment: string): string {
  let value = segment;
  value = value.replace(
    /^(?:(?:[a-z_][a-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+))\s+)*/i,
    '',
  );
  value = value.replace(/^(?:sudo\s+|env\s+)+/i, '');
  return value.trim();
}

// Fingerprints are trusted only when the tool ran the canonical command in its
// inherited repository context, without a wrapper that could redirect it.
function isExactStandaloneShellCommand(
  input: unknown,
  expected: 'git status --short' | 'git rev-parse head',
): boolean {
  const command = record(input)?.command;
  if (
    typeof command !== 'string' ||
    command.length > MAX_TRANSIENT_COMMAND_CHARS ||
    /[\r\n;&|]/.test(command)
  ) {
    return false;
  }

  const normalized = command
    .replace(/^[ \t]+|[ \t]+$/g, '')
    .replace(/[ \t]+/g, ' ')
    .toLowerCase();
  return normalized === expected;
}

function startsPackageScript(segment: string, script: RegExp): boolean {
  return new RegExp(
    `^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${script.source}(?:\\s|$)`,
    script.flags,
  ).test(segment);
}

function classifyShellSegment(segment: string): RuntimeToolActionClass[] {
  const command = stripCommandPreamble(segment);
  const classes = new Set<RuntimeToolActionClass>();

  if (/^(?:cd|pwd|true|false)(?:\s|$)/i.test(command)) {
    classes.add('workflow_control');
  }

  if (
    startsPackageScript(command, /(?:test|test:[a-z0-9:_-]+)/i) ||
    /^(?:npx\s+|pnpm\s+exec\s+|bunx\s+)?(?:vitest|jest|mocha|ava)(?:\s|$)/i.test(
      command,
    ) ||
    /^(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)/i.test(command) ||
    /^(?:node|nodejs)\s+--check(?:\s|$)/i.test(command) ||
    /^(?:go\s+test|cargo\s+test|mvn(?:w)?\s+test|\.\/gradlew\s+test|gradle\s+test)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('verification_test');
  }

  if (
    startsPackageScript(command, /(?:typecheck|type-check|check:types?)/i) ||
    /^(?:npx\s+|pnpm\s+exec\s+|bunx\s+)?tsc(?:\s|$)/i.test(command) ||
    /^(?:mypy|pyright)(?:\s|$)/i.test(command)
  ) {
    classes.add('verification_typecheck');
  }

  if (
    startsPackageScript(command, /(?:build|compile|package)/i) ||
    /^(?:cargo\s+build|go\s+build|mvn(?:w)?\s+package|\.\/gradlew\s+build|gradle\s+build)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('verification_build');
  }

  if (
    startsPackageScript(command, /(?:lint|check:lint)/i) ||
    /^(?:npx\s+|pnpm\s+exec\s+|bunx\s+)?(?:eslint|stylelint|ruff|pylint)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('verification_lint');
  }

  if (
    startsPackageScript(command, /(?:format|format:check|check:format)/i) ||
    /^(?:npx\s+|pnpm\s+exec\s+|bunx\s+)?(?:prettier|biome\s+format|black)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('verification_format');
  }

  if (
    /^(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)|rg|grep|find|ls|cat|head|tail|sed\s+-n)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('repository_state');
  }

  if (
    /^(?:apply_patch|git\s+(?:apply|add|commit|restore|checkout|switch)|touch|mkdir|rm|mv|cp|sed\s+-i|perl\s+-pi)(?:\s|$)/i.test(
      command,
    )
  ) {
    classes.add('repository_write');
  }

  if (
    /^(?:git\s+(?:push|commit|restore|checkout|switch)|gh\s+(?:pr\s+(?:create|merge|close)|issue\s+(?:create|edit|close)|release\s+create|workflow\s+run)|npm\s+(?:publish|install|uninstall)|pnpm\s+(?:add|remove|install)|yarn\s+(?:add|remove|install)|bun\s+(?:add|remove|install)|rm|launchctl\s+(?:kickstart|bootstrap|bootout|enable|disable|load|unload)|systemctl\s+(?:start|stop|restart|reload|enable|disable)|docker\s+(?:push|restart|stop|start|rm)|kubectl\s+(?:apply|create|delete|patch|replace|rollout|scale|set)|(?:vercel|netlify|fly|railway)\s+deploy)(?:\s|$)/i.test(
      command,
    ) ||
    (/^curl(?:\s|$)/i.test(command) &&
      (/(?:^|\s)-(?:x|-request)\s*(?:post|put|patch|delete)(?:\s|$)/i.test(
        command,
      ) ||
        /(?:^|\s)(?:-d|--data|--data-raw|--data-binary)(?:\s|=)/i.test(
          command,
        )))
  ) {
    classes.add('external_side_effect');
  }

  return [...classes];
}

function classifyBashInput(input: unknown): RuntimeToolActionClass[] {
  const command = record(input)?.command;
  if (typeof command !== 'string' || !command.trim()) return ['other'];
  const classes = new Set<RuntimeToolActionClass>();
  for (const segment of commandSegments(command)) {
    const segmentClasses = classifyShellSegment(segment);
    if (segmentClasses.length === 0) classes.add('other');
    for (const actionClass of segmentClasses) {
      classes.add(actionClass);
    }
  }
  return classes.size > 0 ? [...classes] : ['other'];
}

function isSeparateRepositoryHeadQuery(input: unknown): boolean {
  return isExactStandaloneShellCommand(input, 'git rev-parse head');
}

/**
 * Canonical repository-state fingerprint contract. General reads such as
 * `git diff`, `ls`, and compound shell commands remain action evidence, but
 * never become before/after state evidence. The bounded kind is transient and
 * only proves that both fingerprints came from the same stable probe family.
 */
function repositoryStateProbeKind(
  input: unknown,
): RepositoryStateProbeKind | null {
  return isExactStandaloneShellCommand(input, 'git status --short')
    ? 'git_status_short'
    : null;
}

function normalizeToolResultContent(content: unknown): string | null {
  let combined = '';
  const append = (value: string) => {
    if (combined.length >= MAX_TRANSIENT_RESULT_CHARS) return;
    const remaining = MAX_TRANSIENT_RESULT_CHARS - combined.length;
    combined += value.slice(0, remaining);
  };

  if (typeof content === 'string') {
    append(content);
  } else if (Array.isArray(content)) {
    for (
      let index = 0;
      index < content.length && combined.length < MAX_TRANSIENT_RESULT_CHARS;
      index += 1
    ) {
      const item = content[index];
      if (typeof item === 'string') {
        append(item);
        continue;
      }
      const block = record(item);
      if (block?.type === 'text' && typeof block.text === 'string') {
        append(block.text);
      }
    }
  } else {
    return null;
  }

  return combined
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function fingerprintToolResultContent(content: unknown): string | null {
  const normalized = normalizeToolResultContent(content);
  if (normalized === null) return null;
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function classifyTool(
  toolName: string,
  input: unknown,
): RuntimeToolActionClass[] {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === 'bash') return classifyBashInput(input);
  if (['read', 'glob', 'grep'].includes(normalized)) {
    return ['repository_read'];
  }
  if (['write', 'edit', 'notebookedit'].includes(normalized)) {
    return ['repository_write'];
  }
  if (['websearch', 'webfetch'].includes(normalized)) {
    return ['web_research'];
  }
  if (
    [
      'task',
      'taskoutput',
      'taskstop',
      'teamcreate',
      'teamdelete',
      'sendmessage',
    ].includes(normalized)
  ) {
    return ['delegation'];
  }
  if (['todowrite', 'toolsearch', 'skill'].includes(normalized)) {
    return ['workflow_control'];
  }
  if (normalized.startsWith('mcp__')) {
    if (
      /(?:search_|web|fetch|research|list_enabled|list_cursor|list_amazon)/i.test(
        normalized,
      )
    ) {
      return ['web_research'];
    }
    if (
      /(?:send_message|schedule_task|pause_task|resume_task|cancel_task|update_task|register_group|enable_|install_|disable_|create_cursor|followup_cursor|stop_cursor|request_amazon_purchase|approve_amazon_purchase|cancel_amazon_purchase)/i.test(
        normalized,
      )
    ) {
      return ['external_side_effect'];
    }
    return ['other'];
  }
  return ['other'];
}

function sameClasses(
  left: RuntimeToolActionClass[],
  right: RuntimeToolActionClass[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((item) => expected.has(item));
}

/**
 * Captures only bounded, derived execution metadata. Raw tool inputs, output
 * bodies, paths, commands, and SDK tool-use identifiers never leave this
 * collector and are never included in snapshots.
 */
export class RuntimeToolEvidenceCollector {
  private readonly calls = new Map<string, CallRecord>();
  private attempts = 0;
  private partial = false;
  private eventOrder = 0;
  readonly evidenceId: string;

  constructor(evidenceId: string = randomUUID()) {
    this.evidenceId = normalizeEvidenceId(evidenceId);
  }

  beginAttempt(): void {
    this.attempts += 1;
  }

  markPartial(): void {
    this.partial = true;
  }

  observeSdkMessage(message: unknown): void {
    try {
      const envelope = record(message);
      if (!envelope) return;
      if (envelope.isReplay === true) return;
      if (envelope.type !== 'assistant' && envelope.type !== 'user') return;

      const sdkMessage = record(envelope.message);
      if (!sdkMessage) {
        this.partial = true;
        return;
      }
      const content = sdkMessage.content;
      if (!Array.isArray(content)) {
        if (envelope.type === 'assistant') this.partial = true;
        return;
      }

      for (const rawBlock of content) {
        const block = record(rawBlock);
        if (!block) continue;
        if (envelope.type === 'assistant' && block.type === 'tool_use') {
          this.observeToolUse(block);
        } else if (envelope.type === 'user' && block.type === 'tool_result') {
          this.observeToolResult(block);
        }
      }
    } catch {
      // Evidence collection must never alter or interrupt tool execution.
      this.partial = true;
    }
  }

  snapshot(): RuntimeToolEvidenceV1 {
    const actionCounts = new Map<
      RuntimeToolActionClass,
      RuntimeToolActionEvidence
    >();
    let succeeded = 0;
    let failed = 0;
    let unresolved = 0;

    const orderedCalls = [...this.calls.values()].sort(
      (left, right) => left.observedOrder - right.observedOrder,
    );
    const repositoryWrites = orderedCalls.filter((call) =>
      call.classes.includes('repository_write'),
    );
    const firstRepositoryWrite = repositoryWrites.at(0);
    const lastRepositoryWrite = repositoryWrites.at(-1);

    for (const call of this.calls.values()) {
      if (call.status === 'succeeded') succeeded += 1;
      else if (call.status === 'failed') failed += 1;
      else unresolved += 1;

      for (const actionClass of call.classes) {
        const counts = actionCounts.get(actionClass) || {
          class: actionClass,
          observed: 0,
          succeeded: 0,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'none' as const,
          recovered: false,
        };
        counts.observed += 1;
        if (call.status === 'succeeded') counts.succeeded += 1;
        else if (call.status === 'failed') counts.failed += 1;
        else counts.unresolved += 1;
        if (
          call.status === 'succeeded' &&
          lastRepositoryWrite?.resultOrder !== null &&
          lastRepositoryWrite?.resultOrder !== undefined &&
          call.observedOrder > lastRepositoryWrite.resultOrder
        ) {
          counts.succeededAfterLastRepositoryWrite += 1;
        }
        actionCounts.set(actionClass, counts);
      }
    }

    for (const actionClass of RUNTIME_TOOL_ACTION_CLASSES) {
      const counts = actionCounts.get(actionClass);
      if (!counts) continue;
      const calls = [...this.calls.values()]
        .filter((call) => call.classes.includes(actionClass))
        .sort((left, right) => left.lastEventOrder - right.lastEventOrder);
      const latest = calls.at(-1);
      counts.lastOutcome = latest
        ? latest.status === 'pending'
          ? 'unresolved'
          : latest.status
        : 'none';
      counts.recovered = Boolean(
        latest?.status === 'succeeded' &&
        calls.some(
          (call) =>
            call.status === 'failed' &&
            call.lastEventOrder < latest.lastEventOrder,
        ),
      );
    }

    const successfulStateCalls = orderedCalls.filter(
      (call) =>
        call.status === 'succeeded' &&
        call.resultFingerprint !== null &&
        call.classes.includes('repository_state') &&
        !call.classes.includes('repository_write') &&
        !call.repositoryHeadQuery &&
        call.repositoryStateProbeKind !== null,
    );
    const preState = firstRepositoryWrite
      ? successfulStateCalls
          .filter(
            (call) =>
              call.observedOrder < firstRepositoryWrite.observedOrder &&
              (call.resultOrder || Number.POSITIVE_INFINITY) <
                firstRepositoryWrite.observedOrder,
          )
          .at(-1)
      : null;
    const postState = lastRepositoryWrite
      ? successfulStateCalls
          .filter(
            (call) =>
              call.observedOrder >
                (lastRepositoryWrite.resultOrder ?? Number.POSITIVE_INFINITY) &&
              (!preState ||
                call.repositoryStateProbeKind ===
                  preState.repositoryStateProbeKind),
          )
          .at(-1)
      : null;
    const repositoryHead = orderedCalls
      .filter(
        (call) =>
          call.repositoryHeadQuery &&
          call.status === 'succeeded' &&
          call.resultFingerprint !== null &&
          (!firstRepositoryWrite ||
            (call.observedOrder < firstRepositoryWrite.observedOrder &&
              (call.resultOrder ?? Number.POSITIVE_INFINITY) <
                firstRepositoryWrite.observedOrder)),
      )
      .at(-1);

    return {
      version: 1,
      evidenceId: this.evidenceId,
      cumulative: true,
      attempts: this.attempts,
      collectorStatus:
        this.partial || unresolved > 0 || this.attempts === 0
          ? 'partial'
          : 'complete',
      calls: {
        observed: this.calls.size,
        succeeded,
        failed,
        unresolved,
      },
      actions: RUNTIME_TOOL_ACTION_CLASSES.flatMap((actionClass) => {
        const counts = actionCounts.get(actionClass);
        return counts ? [counts] : [];
      }),
      state: {
        preStateFingerprint: preState?.resultFingerprint || null,
        postStateFingerprint: postState?.resultFingerprint || null,
        repositoryHeadFingerprint: repositoryHead?.resultFingerprint || null,
      },
      privacy: {
        metadataOnly: true,
        rawInputsStored: false,
        resultBodiesStored: false,
        toolUseIdsStored: false,
      },
    };
  }

  private observeToolUse(block: Record<string, unknown>): void {
    const toolUseId = block.id;
    const toolName = block.name;
    if (
      typeof toolUseId !== 'string' ||
      !toolUseId ||
      typeof toolName !== 'string' ||
      !toolName
    ) {
      this.partial = true;
      return;
    }
    const classes = classifyTool(toolName, block.input);
    const normalizedToolName = toolName.trim().toLowerCase();
    const repositoryHeadQuery =
      normalizedToolName === 'bash' &&
      isSeparateRepositoryHeadQuery(block.input);
    const stateProbeKind =
      normalizedToolName === 'bash'
        ? repositoryStateProbeKind(block.input)
        : null;
    const existing = this.calls.get(toolUseId);
    if (existing) {
      if (
        !sameClasses(existing.classes, classes) ||
        existing.repositoryHeadQuery !== repositoryHeadQuery ||
        existing.repositoryStateProbeKind !== stateProbeKind
      ) {
        this.partial = true;
      }
      return;
    }
    const observedOrder = ++this.eventOrder;
    this.calls.set(toolUseId, {
      classes,
      status: 'pending',
      observedOrder,
      lastEventOrder: observedOrder,
      resultOrder: null,
      resultFingerprint: null,
      repositoryHeadQuery,
      repositoryStateProbeKind: stateProbeKind,
    });
  }

  private observeToolResult(block: Record<string, unknown>): void {
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== 'string' || !toolUseId) {
      this.partial = true;
      return;
    }
    const existing = this.calls.get(toolUseId);
    if (!existing) {
      this.partial = true;
      return;
    }
    const status: CallStatus = block.is_error === true ? 'failed' : 'succeeded';
    if (existing.status !== 'pending' && existing.status !== status) {
      this.partial = true;
      return;
    }
    if (existing.status === 'pending') {
      existing.status = status;
      const resultOrder = ++this.eventOrder;
      existing.lastEventOrder = resultOrder;
      existing.resultOrder = resultOrder;
      if (
        status === 'succeeded' &&
        (existing.repositoryHeadQuery ||
          existing.repositoryStateProbeKind !== null)
      ) {
        existing.resultFingerprint = fingerprintToolResultContent(
          block.content,
        );
        if (existing.resultFingerprint === null) this.partial = true;
      }
    }
  }
}
