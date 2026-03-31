import type { CursorAgentView } from './cursor-jobs.js';
import type { FlattenedCursorJobEntry } from './cursor-operator-context.js';
import {
  formatCursorDisplayId,
  formatCursorJobCard,
} from './cursor-operator-context.js';
import type { ChannelInlineAction } from './types.js';

export const CURSOR_DASHBOARD_PAGE_SIZE = 6;
export const CURSOR_DASHBOARD_EXPIRED_MESSAGE =
  'This Cursor control panel expired. Run `/cursor` again.';

export type CursorDashboardViewKind =
  | 'home'
  | 'status'
  | 'jobs'
  | 'current'
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
    kind !== 'current' &&
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
      { label: 'New Cloud Job', actionId: '/cursor-ui new' },
      { label: 'Current Job', actionId: '/cursor-ui current' },
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
  return `${record.provider === 'cloud' ? 'Cloud' : 'Desktop'} ${formatCursorDisplayId(record.id)} [${record.status}]`;
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
    `${record.ordinal}. ${prefix} ${formatCursorDisplayId(record.id)} [${record.status}]`,
    summary ? `   ${summary}` : null,
    updatedAt ? `   updated ${updatedAt}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function buildCursorDashboardHome(params: {
  cloudLine: string;
  desktopLine: string;
  runtimeLine: string;
  currentJob?: CursorAgentView | null;
}): CursorDashboardRender {
  return {
    text: [
      '*Cursor Control Panel*',
      '',
      '- Cursor Cloud is the heavy-work lane.',
      '- Desktop bridge is the operator-only machine-control lane.',
      '',
      `- Cloud: ${params.cloudLine}`,
      `- Desktop: ${params.desktopLine}`,
      `- Runtime route: ${params.runtimeLine}`,
      params.currentJob
        ? `- Current job: ${summarizeCurrentJob(params.currentJob)}`
        : '- Current job: none selected yet',
      '',
      'Tap a tile to browse jobs, inspect the current job, or start a new Cloud task.',
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
          { label: 'Sync', actionId: '/cursor-ui sync' },
          { label: 'Text', actionId: '/cursor-ui text' },
        ],
        [
          { label: 'Files', actionId: '/cursor-ui files' },
          ...(record.targetUrl
            ? [{ label: 'Open', url: record.targetUrl }]
            : []),
        ],
        [
          { label: 'Follow Up', actionId: '/cursor-ui followup' },
          { label: 'Stop', actionId: '/cursor-ui stop' },
        ],
        [{ label: 'Back', actionId: '/cursor-ui jobs' }],
      ]
    : [
        [
          { label: 'Sync', actionId: '/cursor-ui sync' },
          { label: 'Messages', actionId: '/cursor-ui text' },
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
      isCloud
        ? '*Current Cursor Cloud Job*'
        : '*Current Desktop Bridge Session*',
      '',
      formatCursorJobCard(record, resultCount),
      '',
      isCloud
        ? 'Tap a control below, or reply to this dashboard with plain text to continue the current Cloud job.'
        : 'Tap a control below for session refresh, conversation, or machine-side terminal control.',
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
      '*Current Job*',
      '',
      'No Cursor job is selected right now.',
      '',
      'Open `Jobs`, then tap a job to make it current. You can still use raw ids in slash commands if you want to.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
        { label: 'Home', actionId: '/cursor-ui home' },
      ],
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
      '*Cursor Help*',
      '',
      '1. Check `/cursor_status` if you want a full readiness readout.',
      '2. Open `Jobs` and tap a job to make it current.',
      '3. Use `Sync`, `Text`, and `Files` from the current-job view.',
      '4. Reply with plain text to the current Cloud job when you want to continue it.',
      '5. Use `Desktop` only for the operator-only machine-control lane.',
      '',
      'Slash commands still work for power users, but the dashboard is the main path now.',
    ].join('\n'),
    inlineActionRows: [
      [
        { label: 'Jobs', actionId: '/cursor-ui jobs' },
        { label: 'New Cloud Job', actionId: '/cursor-ui new' },
      ],
      [{ label: 'Home', actionId: '/cursor-ui home' }],
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
