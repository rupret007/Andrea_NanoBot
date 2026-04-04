import type {
  BackendLaneId,
  BackendJobDetails,
  BackendJobSummary,
} from './backend-lanes/types.js';
import type { CursorAgentView } from './cursor-jobs.js';
import type { FlattenedCursorJobEntry } from './cursor-operator-context.js';
import { formatRuntimeJobCard } from './andrea-runtime/commands.js';
import {
  formatCursorDisplayId,
  formatCursorJobCard,
} from './cursor-operator-context.js';
import {
  formatCurrentFocusLabel,
  formatTaskContinuationGuidance,
  formatTaskReplyRoutingGuidance,
  formatHumanTaskStatus,
  formatOpaqueTaskId,
} from './task-presentation.js';
import type { ChannelInlineAction } from './types.js';

export const CURSOR_DASHBOARD_PAGE_SIZE = 6;
export const CURSOR_DASHBOARD_EXPIRED_MESSAGE =
  'This Andrea work panel expired. Run `/cursor` again.';

export type CursorDashboardViewKind =
  | 'home'
  | 'status'
  | 'jobs'
  | 'work_current'
  | 'current'
  | 'runtime'
  | 'runtime_jobs'
  | 'runtime_current'
  | 'desktop'
  | 'help'
  | 'wizard_repo'
  | 'wizard_prompt'
  | 'wizard_confirm';

export interface CursorDashboardWizardState {
  sourceRepository?: string | null;
  promptText?: string | null;
}

export interface CursorDashboardState {
  kind: CursorDashboardViewKind;
  page?: number;
  wizard?: CursorDashboardWizardState | null;
}

export interface CursorDashboardRender {
  text: string;
  inlineActionRows: ChannelInlineAction[][];
  selectedAgentId?: string | null;
}

export function parseCursorDashboardState(
  payload: Record<string, unknown> | null | undefined,
): CursorDashboardState | null {
  if (!payload) return null;
  const kind = payload.kind;
  if (
    kind !== 'home' &&
    kind !== 'status' &&
    kind !== 'jobs' &&
    kind !== 'work_current' &&
    kind !== 'current' &&
    kind !== 'runtime' &&
    kind !== 'runtime_jobs' &&
    kind !== 'runtime_current' &&
    kind !== 'desktop' &&
    kind !== 'help' &&
    kind !== 'wizard_repo' &&
    kind !== 'wizard_prompt' &&
    kind !== 'wizard_confirm'
  ) {
    return null;
  }

  const page =
    typeof payload.page === 'number' && Number.isFinite(payload.page)
      ? Math.max(0, Math.floor(payload.page))
      : undefined;
  const wizardRaw =
    payload.wizard &&
    typeof payload.wizard === 'object' &&
    !Array.isArray(payload.wizard)
      ? (payload.wizard as Record<string, unknown>)
      : null;
  const wizard = wizardRaw
    ? {
        sourceRepository:
          typeof wizardRaw.sourceRepository === 'string'
            ? wizardRaw.sourceRepository
            : wizardRaw.sourceRepository === null
              ? null
              : undefined,
        promptText:
          typeof wizardRaw.promptText === 'string'
            ? wizardRaw.promptText
            : wizardRaw.promptText === null
              ? null
              : undefined,
      }
    : null;

  return {
    kind,
    ...(page !== undefined ? { page } : {}),
    ...(wizard ? { wizard } : {}),
  };
}

export function formatCursorDashboardState(
  state: CursorDashboardState,
): Record<string, unknown> {
  return {
    kind: state.kind,
    ...(state.page !== undefined ? { page: state.page } : {}),
    ...(state.wizard ? { wizard: state.wizard } : {}),
  };
}

function buildHomeRows(): ChannelInlineAction[][] {
  return [
    [
      { label: 'Status', actionId: '/cursor-ui status' },
      { label: 'Jobs', actionId: '/cursor-ui jobs' },
    ],
    [
      { label: 'Current Work', actionId: '/cursor-ui work-current' },
      { label: 'New Cloud Job', actionId: '/cursor-ui new' },
    ],
    [
      { label: 'Current Job', actionId: '/cursor-ui current' },
      { label: 'Codex/OpenAI', actionId: '/cursor-ui runtime' },
    ],
    [
      { label: 'Desktop', actionId: '/cursor-ui desktop' },
      { label: 'Help', actionId: '/cursor-ui help' },
    ],
  ];
}

function summarizeJobButton(record: FlattenedCursorJobEntry): string {
  const prefix = record.provider === 'cloud' ? 'Cloud' : 'Desktop';
  return `${record.ordinal}. ${prefix} ${formatCursorDisplayId(record.id)}`;
}

function summarizeCurrentJob(
  record: CursorAgentView | null | undefined,
): string | null {
  if (!record) return null;
  return `${record.provider === 'cloud' ? 'Cloud' : 'Desktop'} ${formatCursorDisplayId(record.id)} [${formatHumanTaskStatus(record.status)}]`;
}

function summarizeRuntimeTask(
  record: BackendJobDetails | null | undefined,
): string | null {
  if (!record) return null;
  const runtime =
    typeof record.metadata?.selectedRuntime === 'string'
      ? record.metadata.selectedRuntime
      : null;
  return `${formatOpaqueTaskId(record.handle.jobId)} [${formatHumanTaskStatus(record.status)}]${runtime ? ` via ${runtime}` : ''}`;
}

function summarizeCurrentWork(params: {
  currentFocusLaneId?: BackendLaneId | null;
  currentJob?: CursorAgentView | null;
  currentRuntimeTask?: BackendJobDetails | null;
}): string {
  if (params.currentFocusLaneId === 'andrea_runtime' && params.currentRuntimeTask) {
    return `Codex/OpenAI runtime ${summarizeRuntimeTask(params.currentRuntimeTask)}`;
  }
  if (params.currentFocusLaneId === 'cursor' && params.currentJob) {
    return `Cursor ${summarizeCurrentJob(params.currentJob)}`;
  }
  return 'none selected yet';
}

function summarizeJobLine(record: FlattenedCursorJobEntry): string {
  const prefix = record.provider === 'cloud' ? 'Cloud' : 'Desktop';
  const summary =
    record.sourceRepository ||
    record.targetUrl ||
    record.targetPrUrl ||
    record.summary;
  const updatedAt = record.updatedAt || record.lastSyncedAt || record.createdAt;
  return [
    `${record.ordinal}. ${prefix} ${formatCursorDisplayId(record.id)} ${formatHumanTaskStatus(record.status)}`,
    summary ? `   ${summary}` : null,
    updatedAt ? `   updated ${updatedAt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function buildCursorDashboardHome(params: {
  cloudLine: string;
  desktopLine: string;
  runtimeRouteLine: string;
  codexRuntimeLine: string;
  currentJob?: CursorAgentView | null;
  currentRuntimeTask?: BackendJobDetails | null;
  currentFocusLaneId?: BackendLaneId | null;
}): CursorDashboardRender {
  return {
    text: [
      '*Andrea Work Cockpit*',
      '',
      '- Cursor Cloud, Cursor Desktop, and Codex/OpenAI runtime share one work shell here.',
      '- Lane-specific ids and controls stay authoritative even when Andrea shows one current-work view.',
      '- Desktop bridge stays operator-only for machine control.',
      '',
      `- Cursor Cloud: ${params.cloudLine}`,
      `- Desktop bridge: ${params.desktopLine}`,
      `- Codex/OpenAI runtime: ${params.codexRuntimeLine}`,
      `- Cursor-backed runtime route: ${params.runtimeRouteLine}`,
      `- Current work: ${summarizeCurrentWork(params)}`,
      params.currentJob
        ? `- Current Cursor task: ${summarizeCurrentJob(params.currentJob)}`
        : '- Current Cursor task: none selected yet',
      params.currentRuntimeTask
        ? `- Current Codex/OpenAI task: ${summarizeRuntimeTask(params.currentRuntimeTask)}`
        : '- Current Codex/OpenAI task: none selected yet',
      `- Current focus: ${formatCurrentFocusLabel(params.currentFocusLaneId)}`,
      '',
      formatTaskReplyRoutingGuidance(),
      '',
      'Tap `Current Work` to stay with the selected item, or browse `Jobs` and `Codex/OpenAI` to switch lanes.',
    ].join('\n'),
    inlineActionRows: buildHomeRows(),
    selectedAgentId: params.currentJob?.id || null,
  };
}

export function buildCursorDashboardStatus(
  summaryText: string,
): CursorDashboardRender {
  return {
    text: `*Cursor Status*\n\n${summaryText}`,
    inlineActionRows: [
      [
        { label: 'Refresh', actionId: '/cursor-ui status' },
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
      ],
      [{ label: 'Back', actionId: '/cursor-ui home' }],
    ],
  };
}

export function buildCursorDashboardJobs(params: {
  entries: FlattenedCursorJobEntry[];
  page: number;
  pageSize?: number;
  selectedAgentId?: string | null;
}): CursorDashboardRender {
  const pageSize = params.pageSize || CURSOR_DASHBOARD_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(params.entries.length / pageSize));
  const clampedPage = Math.max(0, Math.min(params.page, pageCount - 1));
  const start = clampedPage * pageSize;
  const visible = params.entries.slice(start, start + pageSize);

  const text =
    visible.length === 0
      ? [
          '*Cursor Jobs*',
          '',
          'No active or recoverable Cursor Cloud jobs or desktop bridge sessions were found for this workspace.',
          '',
          'Use `New Cloud Job` to start safe queued work, or return to Home.',
        ].join('\n')
      : [
          '*Cursor Jobs*',
          '',
          `Page ${clampedPage + 1} of ${pageCount}. Tap a job to make it current.`,
          params.selectedAgentId
            ? `Current selection: ${formatCursorDisplayId(params.selectedAgentId)}`
            : 'Current selection: none',
          '',
          visible.map((entry) => summarizeJobLine(entry)).join('\n\n'),
        ].join('\n');

  const rows: ChannelInlineAction[][] = [];
  for (const [index, entry] of visible.entries()) {
    rows.push([
      {
        label: summarizeJobButton(entry),
        actionId: `/cursor-ui select ${index + 1}`,
      },
    ]);
  }
  if (pageCount > 1) {
    rows.push([
      ...(clampedPage > 0
        ? [{ label: 'Prev', actionId: `/cursor-ui jobs ${clampedPage}` }]
        : []),
      ...(clampedPage < pageCount - 1
        ? [{ label: 'Next', actionId: `/cursor-ui jobs ${clampedPage + 2}` }]
        : []),
    ]);
  }
  rows.push([
    { label: 'Refresh', actionId: `/cursor-ui jobs ${clampedPage + 1}` },
  ]);
  rows.push([{ label: 'Back', actionId: '/cursor-ui home' }]);

  return {
    text,
    inlineActionRows: rows.filter((row) => row.length > 0),
    selectedAgentId: params.selectedAgentId || null,
  };
}

export function buildCursorDashboardCurrentJob(
  record: CursorAgentView,
  resultCount = 0,
): CursorDashboardRender {
  const isCloud = record.provider === 'cloud';
  const rows: ChannelInlineAction[][] = isCloud
    ? [
        [
          { label: 'Refresh', actionId: '/cursor-ui sync' },
          { label: 'View Output', actionId: '/cursor-ui text' },
        ],
        [
          { label: 'Results', actionId: '/cursor-ui files' },
          ...(record.targetUrl
            ? [{ label: 'Open in Cursor', url: record.targetUrl }]
            : []),
        ],
        [
          { label: 'Continue', actionId: '/cursor-ui followup' },
          { label: 'Stop Run', actionId: '/cursor-ui stop' },
        ],
        [{ label: 'Back', actionId: '/cursor-ui jobs' }],
      ]
    : [
        [
          { label: 'Refresh', actionId: '/cursor-ui sync' },
          { label: 'View Output', actionId: '/cursor-ui text' },
        ],
        [
          { label: 'Terminal Status', actionId: '/cursor-ui terminal-status' },
          { label: 'Terminal Log', actionId: '/cursor-ui terminal-log' },
        ],
        [{ label: 'Terminal Help', actionId: '/cursor-ui terminal-help' }],
        [{ label: 'Back', actionId: '/cursor-ui jobs' }],
      ];

  return {
    text: [
      isCloud ? '*Current Task*' : '*Current Session*',
      '',
      formatCursorJobCard(record, resultCount),
      '',
      formatTaskContinuationGuidance({
        lane: isCloud ? 'cursor_cloud' : 'cursor_desktop',
      }),
    ].join('\n'),
    inlineActionRows: rows.map((row) =>
      row.filter((action) => Boolean(action.label)),
    ),
    selectedAgentId: record.id,
  };
}

export function buildCursorDashboardCurrentJobEmpty(): CursorDashboardRender {
  return {
    text: [
      '*Current Task*',
      '',
      'No current task is selected in the Cursor lane.',
      '',
      'Open `Jobs`, then tap a task to make it current. Buttons are the main path. Slash commands and raw ids still work if you want an explicit fallback.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
        { label: 'Home', actionId: '/cursor-ui home' },
      ],
    ],
  };
}

export function buildCursorDashboardWorkCurrent(params: {
  currentFocusLaneId?: BackendLaneId | null;
  currentJob?: CursorAgentView | null;
  currentRuntimeTask?: BackendJobDetails | null;
  executionEnabled: boolean;
  currentJobResultCount?: number;
}): CursorDashboardRender {
  if (params.currentFocusLaneId === 'andrea_runtime' && params.currentRuntimeTask) {
    const rows: ChannelInlineAction[][] = [
      [
        { label: 'Refresh', actionId: '/cursor-ui runtime-refresh' },
        { label: 'View Output', actionId: '/cursor-ui runtime-output' },
      ],
      [
        ...(params.executionEnabled
          ? [{ label: 'Continue', actionId: '/cursor-ui runtime-followup' }]
          : []),
        ...(params.executionEnabled &&
        (params.currentRuntimeTask.status === 'queued' ||
          params.currentRuntimeTask.status === 'running')
          ? [{ label: 'Stop Run', actionId: '/cursor-ui runtime-stop' }]
          : []),
      ],
      [{ label: 'Back', actionId: '/cursor-ui home' }],
    ];

    return {
      text: [
        '*Current Work*',
        '',
        formatRuntimeJobCard(params.currentRuntimeTask),
        '',
        formatTaskContinuationGuidance({
          lane: 'codex_runtime',
          canReplyContinue: params.executionEnabled,
        }),
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      inlineActionRows: rows.filter((row) => row.length > 0),
      selectedAgentId: params.currentRuntimeTask.handle.jobId,
    };
  }

  if (params.currentFocusLaneId === 'cursor' && params.currentJob) {
    const isCloud = params.currentJob.provider === 'cloud';
    const rows: ChannelInlineAction[][] = isCloud
      ? [
          [
            { label: 'Refresh', actionId: '/cursor-ui sync' },
            { label: 'View Output', actionId: '/cursor-ui text' },
          ],
          [
            { label: 'Results', actionId: '/cursor-ui files' },
            ...(params.currentJob.targetUrl
              ? [{ label: 'Open in Cursor', url: params.currentJob.targetUrl }]
              : []),
          ],
          [
            { label: 'Continue', actionId: '/cursor-ui followup' },
            { label: 'Stop Run', actionId: '/cursor-ui stop' },
          ],
          [{ label: 'Back', actionId: '/cursor-ui home' }],
        ]
      : [
          [
            { label: 'Refresh', actionId: '/cursor-ui sync' },
            { label: 'View Output', actionId: '/cursor-ui text' },
          ],
          [
            { label: 'Terminal Status', actionId: '/cursor-ui terminal-status' },
            { label: 'Terminal Log', actionId: '/cursor-ui terminal-log' },
          ],
          [{ label: 'Terminal Help', actionId: '/cursor-ui terminal-help' }],
          [{ label: 'Back', actionId: '/cursor-ui home' }],
        ];

    return {
      text: [
        '*Current Work*',
        '',
        formatCursorJobCard(params.currentJob, params.currentJobResultCount || 0),
        '',
        formatTaskContinuationGuidance({
          lane: isCloud ? 'cursor_cloud' : 'cursor_desktop',
        }),
      ].join('\n'),
      inlineActionRows: rows.map((row) =>
        row.filter((action) => Boolean(action.label)),
      ),
      selectedAgentId: params.currentJob.id,
    };
  }

  return {
    text: [
      '*Current Work*',
      '',
      'No current work is selected in this chat yet.',
      '',
      'Open `Jobs` or `Codex/OpenAI` -> `Recent Work`, then tap a task to make it current. Explicit ids, `current`, and lane-specific slash commands still work when you want an explicit fallback.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
        { label: 'Codex/OpenAI', actionId: '/cursor-ui runtime' },
      ],
      [{ label: 'Home', actionId: '/cursor-ui home' }],
    ],
  };
}

export function buildCursorDashboardDesktop(
  detailText: string,
): CursorDashboardRender {
  return {
    text: `*Desktop Bridge*\n\n${detailText}`,
    inlineActionRows: [
      [
        { label: 'Current Job', actionId: '/cursor-ui current' },
        { label: 'Home', actionId: '/cursor-ui home' },
      ],
    ],
  };
}

export function buildCursorDashboardHelp(): CursorDashboardRender {
  return {
    text: [
      '*Andrea Work Help*',
      '',
      '1. Check `/cursor_status` if you want a full readiness readout.',
      '2. Open `Current Work` when you want Andrea to stay with the selected item in this chat.',
      '3. Open `Jobs` or `Codex/OpenAI` -> `Recent Work`, then tap a task to make it current.',
      '4. Use `Refresh`, `View Output`, and lane-specific actions from the current-work view.',
      '5. Reply with plain text when you want Andrea to continue a fresh task card.',
      '6. Use `Desktop` only for the operator-only machine-control lane.',
      '',
      formatTaskReplyRoutingGuidance(),
      '',
      'Buttons are the main operator path now. Slash commands still work if you want an explicit fallback.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Current Work', actionId: '/cursor-ui work-current' },
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
      ],
      [
        { label: 'Codex/OpenAI', actionId: '/cursor-ui runtime' },
        { label: 'New Cloud Job', actionId: '/cursor-ui new' },
      ],
      [{ label: 'Home', actionId: '/cursor-ui home' }],
    ],
  };
}

function formatRuntimeJobLine(job: BackendJobSummary, ordinal: number): string {
  const updatedAt = job.updatedAt || job.createdAt;
  return [
    `${ordinal}. ${formatOpaqueTaskId(job.handle.jobId)} [${formatHumanTaskStatus(job.status)}]`,
    job.summary ? `   ${job.summary}` : null,
    updatedAt ? `   updated ${updatedAt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function buildCursorDashboardRuntime(params: {
  executionEnabled: boolean;
  readinessLine: string;
  currentTask?: BackendJobDetails | null;
}): CursorDashboardRender {
  return {
    text: [
      '*Codex/OpenAI Runtime*',
      '',
      "Andrea's Codex/OpenAI runtime lane lives inside the same work cockpit as Cursor.",
      `- Host execution: ${params.executionEnabled ? 'ready on this host' : 'disabled on this host'}`,
      `- Readiness: ${params.readinessLine}`,
      params.currentTask
        ? `- Current task: ${summarizeRuntimeTask(params.currentTask)}`
        : '- Current task: none selected yet',
      '',
      params.executionEnabled
        ? 'Use this lane when you want Andrea to continue deeper Codex/OpenAI work in the current workspace.'
        : 'You can still review existing runtime work here. New runtime execution remains unavailable until this host is validated.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Recent Work', actionId: '/cursor-ui runtime-jobs' },
        { label: 'Current Task', actionId: '/cursor-ui runtime-current' },
      ],
      [
        { label: 'Current Work', actionId: '/cursor-ui work-current' },
        { label: 'Back', actionId: '/cursor-ui home' },
      ],
    ],
  };
}

export function buildCursorDashboardRuntimeJobs(params: {
  jobs: BackendJobSummary[];
  page: number;
  pageSize?: number;
  selectedJobId?: string | null;
}): CursorDashboardRender {
  const pageSize = params.pageSize || CURSOR_DASHBOARD_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(params.jobs.length / pageSize));
  const clampedPage = Math.max(0, Math.min(params.page, pageCount - 1));
  const start = clampedPage * pageSize;
  const visible = params.jobs.slice(start, start + pageSize);

  const text =
    visible.length === 0
      ? [
          '*Codex/OpenAI Work*',
          '',
          'No recent Codex/OpenAI tasks were found for this workspace.',
          '',
          'Open `Current Task` if you already have one selected, or return to the main work panel.',
        ].join('\n')
      : [
          '*Codex/OpenAI Work*',
          '',
          `Page ${clampedPage + 1} of ${pageCount}. Tap a task to make it current.`,
          params.selectedJobId
            ? `Current selection: ${formatOpaqueTaskId(params.selectedJobId)}`
            : 'Current selection: none',
          '',
          visible
            .map((job, index) => formatRuntimeJobLine(job, start + index + 1))
            .join('\n\n'),
        ].join('\n');

  const rows: ChannelInlineAction[][] = [];
  for (const [index, job] of visible.entries()) {
    rows.push([
      {
        label: `${start + index + 1}. ${formatOpaqueTaskId(job.handle.jobId)}`,
        actionId: `/cursor-ui runtime-select ${index + 1}`,
      },
    ]);
  }
  if (pageCount > 1) {
    rows.push([
      ...(clampedPage > 0
        ? [
            {
              label: 'Prev',
              actionId: `/cursor-ui runtime-jobs ${clampedPage}`,
            },
          ]
        : []),
      ...(clampedPage < pageCount - 1
        ? [
            {
              label: 'Next',
              actionId: `/cursor-ui runtime-jobs ${clampedPage + 2}`,
            },
          ]
        : []),
    ]);
  }
  rows.push([
    {
      label: 'Refresh',
      actionId: `/cursor-ui runtime-jobs ${clampedPage + 1}`,
    },
  ]);
  rows.push([{ label: 'Back', actionId: '/cursor-ui runtime' }]);

  return {
    text,
    inlineActionRows: rows.filter((row) => row.length > 0),
    selectedAgentId: params.selectedJobId || null,
  };
}

export function buildCursorDashboardRuntimeCurrent(
  job: BackendJobDetails,
  executionEnabled: boolean,
): CursorDashboardRender {
  const rows: ChannelInlineAction[][] = [
    [
      { label: 'Refresh', actionId: '/cursor-ui runtime-refresh' },
      { label: 'View Output', actionId: '/cursor-ui runtime-output' },
    ],
    [
      ...(executionEnabled
        ? [{ label: 'Continue', actionId: '/cursor-ui runtime-followup' }]
        : []),
      ...(executionEnabled &&
      (job.status === 'queued' || job.status === 'running')
        ? [{ label: 'Stop Run', actionId: '/cursor-ui runtime-stop' }]
        : []),
    ],
    [{ label: 'Back', actionId: '/cursor-ui runtime' }],
  ];

  return {
    text: [
      '*Current Task*',
      '',
      formatRuntimeJobCard(job),
      '',
      formatTaskContinuationGuidance({
        lane: 'codex_runtime',
        canReplyContinue: executionEnabled,
      }),
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    inlineActionRows: rows.filter((row) => row.length > 0),
    selectedAgentId: job.handle.jobId,
  };
}

export function buildCursorDashboardRuntimeCurrentEmpty(): CursorDashboardRender {
  return {
    text: [
      '*Current Task*',
      '',
      'No current task is selected in the Codex/OpenAI lane.',
      '',
      "Open `Recent Work`, then tap a task to keep working in Andrea's Codex/OpenAI lane. Buttons are the main path. `/runtime-jobs` still works if you want an explicit fallback.",
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Recent Work', actionId: '/cursor-ui runtime-jobs' },
        { label: 'Back', actionId: '/cursor-ui runtime' },
      ],
    ],
  };
}

export function buildCursorDashboardWizardRepo(params: {
  selectedRepo?: string | null;
}): CursorDashboardRender {
  const rows: ChannelInlineAction[][] = [];
  if (params.selectedRepo) {
    rows.push([
      {
        label: 'Use Selected Repo',
        actionId: '/cursor-ui wizard repo-selected',
      },
    ]);
  }
  rows.push([{ label: 'No Repo', actionId: '/cursor-ui wizard repo-none' }]);
  rows.push([
    { label: 'Back', actionId: '/cursor-ui home' },
    { label: 'Cancel', actionId: '/cursor-ui home' },
  ]);

  return {
    text: [
      '*New Cursor Cloud Job*',
      '',
      params.selectedRepo
        ? `Selected repo: ${params.selectedRepo}`
        : 'No repo is preselected right now.',
      '',
      'Tap a repo choice below, or reply to this dashboard with a GitHub URL or `owner/repo` target.',
    ].join('\n'),
    inlineActionRows: rows,
  };
}

export function buildCursorDashboardWizardPrompt(params: {
  sourceRepository?: string | null;
}): CursorDashboardRender {
  return {
    text: [
      '*New Cursor Cloud Job*',
      '',
      `Repo: ${params.sourceRepository || 'none'}`,
      '',
      'Reply to this dashboard with the Cloud job prompt you want Andrea to send to Cursor.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Back', actionId: '/cursor-ui wizard edit-repo' },
        { label: 'Cancel', actionId: '/cursor-ui home' },
      ],
    ],
  };
}

export function buildCursorDashboardWizardConfirm(params: {
  sourceRepository?: string | null;
  promptText: string;
}): CursorDashboardRender {
  const preview =
    params.promptText.length > 280
      ? `${params.promptText.slice(0, 280)}...`
      : params.promptText;
  return {
    text: [
      '*Confirm New Cursor Cloud Job*',
      '',
      `Repo: ${params.sourceRepository || 'none'}`,
      'Prompt:',
      preview,
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Create', actionId: '/cursor-ui wizard create' },
        { label: 'Edit Repo', actionId: '/cursor-ui wizard edit-repo' },
      ],
      [{ label: 'Cancel', actionId: '/cursor-ui home' }],
    ],
  };
}
