import {
  getActiveOperatingProfile,
  listEverydayListGroups,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
} from './db.js';
import {
  buildAgiLeapReadinessReport,
  formatAgiLeapReadinessReport,
  type AgiLeapReadinessReport,
} from './agi-leap-readiness.js';
import {
  handleEverydayCaptureCommand,
  type EverydayCaptureCommandResult,
} from './everyday-capture.js';

export interface SetupDogfoodAnswerSet {
  people: string;
  tracking: string;
  rhythm: string;
  style: string;
  integrations: string;
  privacy: string;
  outcomes: string;
}

export interface SetupDogfoodInput {
  groupFolder: string;
  channel?: 'telegram' | 'bluebubbles' | 'alexa';
  chatJid?: string;
  now?: Date;
  answers?: Partial<SetupDogfoodAnswerSet>;
  apply?: boolean;
}

export interface SetupDogfoodStep {
  command: string;
  handled: boolean;
  mode?: string;
  summaryText?: string;
  replyPreview?: string;
}

export interface SetupDogfoodResult {
  generatedAt: string;
  mode: 'preview' | 'apply';
  groupFolder: string;
  before: AgiLeapReadinessReport;
  after: AgiLeapReadinessReport;
  activeProfile: boolean;
  acceptedSetupFacts: number;
  lifeThreads: number;
  listGroups: number;
  answeredSetupAreas: string[];
  steps: SetupDogfoodStep[];
  privacy: {
    localOnly: true;
    liveMessagesSent: false;
    calendarWrites: false;
    credentialChanges: false;
    rawIdentifiersReturned: false;
  };
  nextAction: string;
}

const DEFAULT_ANSWERS: SetupDogfoodAnswerSet = {
  people:
    'Candace, Travis, close family, school contacts, and work teammates Andrea should understand carefully.',
  tracking:
    'Texts needing replies, family logistics, bills, groceries, errands, meals, and loose ends.',
  rhythm:
    'Morning check-in, afternoon loose-ends check, and Sunday weekly planning.',
  style:
    'Warm, concise, practical, and careful about promises or sensitive context.',
  integrations:
    'Telegram for rich control, BlueBubbles texts for message review, Google Calendar for schedule awareness, and reminders for follow-through.',
  privacy:
    'Ask before surfacing sensitive relationship, health, legal, money, or conflict details.',
  outcomes:
    'Help me reply to important texts, keep family logistics from slipping, and prepare for each day.',
};

function clip(value: string | null | undefined, max = 220): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function redact(value: string): string {
  return clip(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
    .replace(/\bbb:[^\s"']+/gi, '[chat]')
    .replace(/\b(?:iMessage|SMS);[^\s"']+/gi, '[chat]')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]');
}

function serializeStep(
  command: string,
  result: EverydayCaptureCommandResult,
): SetupDogfoodStep {
  return {
    command: redact(command),
    handled: result.handled,
    mode: result.mode,
    summaryText: result.summaryText ? redact(result.summaryText) : undefined,
    replyPreview: result.replyText ? redact(result.replyText) : undefined,
  };
}

export async function runSetupDogfood(
  input: SetupDogfoodInput,
): Promise<SetupDogfoodResult> {
  const now = input.now || new Date();
  const channel = input.channel || 'telegram';
  const chatJid =
    input.chatJid || `setup-dogfood:${input.groupFolder}:${now.getTime()}`;
  const answers: SetupDogfoodAnswerSet = {
    ...DEFAULT_ANSWERS,
    ...(input.answers || {}),
  };
  const before = buildAgiLeapReadinessReport({
    groupFolder: input.groupFolder,
    now,
  });
  const commands = [
    'help me set this up',
    answers.people,
    answers.tracking,
    answers.rhythm,
    answers.style,
    answers.integrations,
    answers.privacy,
    answers.outcomes,
    'approve that',
  ];
  const steps: SetupDogfoodStep[] = [];
  for (const command of commands) {
    const result = await handleEverydayCaptureCommand({
      channel,
      groupFolder: input.groupFolder,
      chatJid,
      text: command,
      now,
    });
    steps.push(serializeStep(command, result));
  }
  const after = buildAgiLeapReadinessReport({
    groupFolder: input.groupFolder,
    now,
  });
  const acceptedSetupFacts = listProfileFactsForGroup(input.groupFolder, [
    'accepted',
  ]).filter((fact) => fact.factKey.startsWith('setup.')).length;
  const activeProfile = Boolean(getActiveOperatingProfile(input.groupFolder));
  return {
    generatedAt: now.toISOString(),
    mode: input.apply ? 'apply' : 'preview',
    groupFolder: input.groupFolder,
    before,
    after,
    activeProfile,
    acceptedSetupFacts,
    lifeThreads: listLifeThreadsForGroup(input.groupFolder, [
      'active',
      'paused',
    ]).length,
    listGroups: listEverydayListGroups(input.groupFolder).filter(
      (group) => !group.archivedAt,
    ).length,
    answeredSetupAreas: after.profilePack.setupCompleteness.answeredSetupAreas,
    steps,
    privacy: {
      localOnly: true,
      liveMessagesSent: false,
      calendarWrites: false,
      credentialChanges: false,
      rawIdentifiersReturned: false,
    },
    nextAction:
      'Use the preview to tune setup wording; apply only when intentionally dogfooding local setup memory.',
  };
}

export function formatSetupDogfoodResult(result: SetupDogfoodResult): string {
  return [
    `Andrea Setup Dogfood (${result.mode})`,
    '',
    `Group: ${result.groupFolder}`,
    `Setup score: ${Math.round(result.before.setupCompletenessScore * 100)}% -> ${Math.round(
      result.after.setupCompletenessScore * 100,
    )}%`,
    `Memory score: ${Math.round(result.before.memoryQualityScore * 100)}% -> ${Math.round(
      result.after.memoryQualityScore * 100,
    )}%`,
    `Context graph: ${Math.round(result.before.contextGraphScore * 100)}% -> ${Math.round(
      result.after.contextGraphScore * 100,
    )}%`,
    `Active profile: ${result.activeProfile ? 'yes' : 'no'}`,
    `Accepted setup facts: ${result.acceptedSetupFacts}`,
    `Life threads: ${result.lifeThreads}`,
    `List groups: ${result.listGroups}`,
    `Answered areas: ${result.answeredSetupAreas.join(', ') || 'none'}`,
    '',
    'Steps',
    ...result.steps.map(
      (step, index) =>
        `${index + 1}. ${step.command} -> ${step.handled ? 'handled' : 'miss'}${step.summaryText ? ` (${step.summaryText})` : ''}`,
    ),
    '',
    'Readiness after setup',
    formatAgiLeapReadinessReport(result.after),
    '',
    'Privacy: local-only; no live messages, calendar writes, credential changes, raw identifiers, or proof closure.',
    `Next: ${result.nextAction}`,
  ].join('\n');
}
