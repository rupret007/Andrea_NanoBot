import fs from 'fs';
import path from 'path';

export const ANDREA_STARTUP_TASK_NAME = 'Andrea-All-Services';
export const LEGACY_NANOCLAW_TASK_NAME = 'NanoClaw';
export const PENDING_BOOT_ALERT_FILE = 'andrea-boot-alert-pending.json';

export type StartupVerificationStatus = 'healthy' | 'degraded' | 'failed';

export interface PendingBootAlert {
  alertId: string;
  createdAt: string;
  status: StartupVerificationStatus;
  dedupeKey: string;
  message: string;
}

export interface StartupAlertComponent {
  id: string;
  label: string;
  status: StartupVerificationStatus;
  detail?: string;
  nextAction?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj|api|ant|cp)?-[A-Za-z0-9_-]{12,}\b/gi,
  /\bghp_[A-Za-z0-9_]{12,}\b/gi,
  /\bcrsr_[A-Za-z0-9_]{12,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBSA-[A-Za-z0-9_-]{8,}\b/g,
  /\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g,
  /([?&](?:secret|password|token|key)=)[^&\s]+/gi,
  /\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s|]+/gi,
];

function runtimeDir(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'runtime');
}

export function getPendingBootAlertPath(projectRoot = process.cwd()): string {
  return path.join(runtimeDir(projectRoot), PENDING_BOOT_ALERT_FILE);
}

export function redactStartupText(value: string): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) =>
      prefix && /^[?&]/.test(prefix) ? `${prefix}***` : '***',
    );
  }
  return output;
}

function summarizeAlertField(
  value: string | undefined,
  maxLength = 240,
): string {
  const redacted = redactStartupText(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildStartupTaskActionArgument(projectRoot: string): string {
  const startupScript = path.join(projectRoot, 'scripts', 'andrea-startup.ps1');
  return `-NoProfile -ExecutionPolicy Bypass -File "${startupScript}" boot`;
}

export function buildBootAlertMessage(params: {
  status: StartupVerificationStatus;
  generatedAt: string;
  components: StartupAlertComponent[];
}): string {
  const blockers = params.components.filter(
    (component) => component.status !== 'healthy',
  );
  const lines = [
    'Andrea boot summary',
    `Status: ${params.status}`,
    `Checked: ${params.generatedAt}`,
  ];

  for (const component of params.components) {
    const detail = summarizeAlertField(component.detail);
    lines.push(
      `${component.label}: ${component.status}${detail ? ` - ${detail}` : ''}`,
    );
  }

  if (blockers.length > 0) {
    lines.push('Next actions:');
    for (const blocker of blockers.slice(0, 5)) {
      lines.push(
        `- ${blocker.label}: ${
          summarizeAlertField(blocker.nextAction || blocker.detail) ||
          'Review startup status.'
        }`,
      );
    }
  } else {
    lines.push('Next actions: none');
  }

  return redactStartupText(lines.join('\n'));
}

function isPendingBootAlert(value: unknown): value is PendingBootAlert {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PendingBootAlert>;
  return (
    typeof candidate.alertId === 'string' &&
    candidate.alertId.length > 0 &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.dedupeKey === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.status === 'healthy' ||
      candidate.status === 'degraded' ||
      candidate.status === 'failed')
  );
}

export function readPendingBootAlert(
  projectRoot = process.cwd(),
): PendingBootAlert | null {
  const filePath = getPendingBootAlertPath(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!isPendingBootAlert(parsed)) return null;
    return {
      ...parsed,
      message: redactStartupText(parsed.message),
    };
  } catch {
    return null;
  }
}

export function clearPendingBootAlert(
  alertId: string,
  projectRoot = process.cwd(),
): boolean {
  const alert = readPendingBootAlert(projectRoot);
  if (!alert || alert.alertId !== alertId) return false;
  fs.rmSync(getPendingBootAlertPath(projectRoot), { force: true });
  return true;
}
