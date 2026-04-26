import {
  getTasksForGroup,
  listKnowledgeSourcesForGroup,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
  listRitualProfilesForGroup,
} from './db.js';
import { buildMemoryIntelligenceReport } from './assistant-memory-intelligence.js';

export type AndreaMemoryTierId = 'working' | 'semantic' | 'procedural';

export interface AndreaMemoryTierDescriptor {
  id: AndreaMemoryTierId;
  label: string;
  includes: string[];
  storageAuthority: string;
  freshnessRule: string;
}

export interface AndreaTaskStateDescriptor {
  state: 'active' | 'waiting' | 'someday' | 'done';
  mapsTo: string;
  summary: string;
}

export interface AndreaCapabilityPackage {
  id:
    | 'chief_of_staff'
    | 'meeting_prep'
    | 'repo_standup'
    | 'reply_help'
    | 'what_changed'
    | 'life_threads'
    | 'idea_capture'
    | 'watchlist_research';
  label: string;
  examplePrompts: string[];
  supportingCapabilities: string[];
}

export type AndreaIntegrationStatus =
  | 'live_proven'
  | 'degraded_but_usable'
  | 'near_live_only'
  | 'externally_blocked';

export interface AndreaIntegrationCapability {
  id:
    | 'google_calendar'
    | 'messages_threads'
    | 'github_repo_context'
    | 'gmail_inbox_triage'
    | 'google_drive_context'
    | 'live_research_watchlist';
  label: string;
  status: AndreaIntegrationStatus;
  journeys: string[];
  requiredAuth: string[];
  degradedWording: string;
  proofCriteria: string;
}

export interface AndreaRitualManifestEntry {
  id:
    | 'morning_brief'
    | 'midday_reground'
    | 'evening_reset'
    | 'open_guidance'
    | 'thread_followthrough'
    | 'household_checkin'
    | 'transition_prompt';
  label: string;
  trigger: string;
  inputs: string[];
  outputShape: string;
  proofTarget: string;
  blockerState: string;
}

export interface AndreaPlatformConfigSnapshotInput {
  component: string;
  configName: string;
  snapshot: Record<string, unknown>;
}

export const ANDREA_MEMORY_PROFILE_PACK: readonly AndreaMemoryTierDescriptor[] = [
  {
    id: 'working',
    label: 'Working memory',
    includes: [
      'active session context',
      'current priorities',
      'current open loops',
      'current mode and recent continuity',
    ],
    storageAuthority: 'chat/session state plus open-loop context in Andrea_NanoBot',
    freshnessRule: 'refresh every live turn; never treated as permanent memory on its own',
  },
  {
    id: 'semantic',
    label: 'Semantic memory',
    includes: [
      'people',
      'projects',
      'domains and context',
      'life threads',
      'knowledge library entries',
      'glossary and canonical terms',
    ],
    storageAuthority: 'profile subjects/facts, life threads, and knowledge library records',
    freshnessRule: 'updated on accepted facts, saved sources, and life-thread changes',
  },
  {
    id: 'procedural',
    label: 'Procedural memory',
    includes: [
      'delegation rules',
      'playbooks',
      'rituals',
      'preferences',
      'decision patterns',
      'outcome-review learnings',
    ],
    storageAuthority: 'ritual profiles, operating preferences, and review-oriented rules',
    freshnessRule: 'changes only when Andrea behavior, preferences, or review learnings actually change',
  },
] as const;

export const ANDREA_TASK_STATE_MODEL: readonly AndreaTaskStateDescriptor[] = [
  {
    state: 'active',
    mapsTo: 'current focus, running follow-through, or immediately actionable open loop',
    summary: 'Keep this in the day picture and surface it proactively when it matters.',
  },
  {
    state: 'waiting',
    mapsTo: 'pending reply, blocked follow-up, or deferred dependency',
    summary: 'Track it, but surface it as waiting instead of pretending it is ready to execute.',
  },
  {
    state: 'someday',
    mapsTo: 'backlog idea, future project, or later follow-through',
    summary: 'Store it cleanly so it can come back without crowding today.',
  },
  {
    state: 'done',
    mapsTo: 'closed loop, archived decision, or completed outcome',
    summary: 'Move it out of the active picture and keep the learnings in outcome review.',
  },
] as const;

export const ANDREA_CAPABILITY_PACKAGES: readonly AndreaCapabilityPackage[] = [
  {
    id: 'chief_of_staff',
    label: 'Chief-of-staff guidance',
    examplePrompts: ['what matters today', 'help me plan tonight'],
    supportingCapabilities: ['staff.prioritize', 'staff.plan_horizon'],
  },
  {
    id: 'meeting_prep',
    label: 'Meeting prep',
    examplePrompts: ['prep me for my next meeting', 'what matters before my next meeting'],
    supportingCapabilities: ['staff.prepare'],
  },
  {
    id: 'repo_standup',
    label: 'Repo standup and work cockpit',
    examplePrompts: ["what's on deck for my repos", "show me what's running right now"],
    supportingCapabilities: ['work.current_summary'],
  },
  {
    id: 'reply_help',
    label: 'Reply help and inbox triage',
    examplePrompts: ['what should I say back', 'what do I owe people'],
    supportingCapabilities: [
      'communication.draft_reply',
      'communication.open_loops',
      'communication.manage_tracking',
    ],
  },
  {
    id: 'what_changed',
    label: 'What changed and what matters',
    examplePrompts: ['what changed today', 'what changed'],
    supportingCapabilities: ['daily.whats_next'],
  },
  {
    id: 'life_threads',
    label: 'Life threads and open loops',
    examplePrompts: ['what life threads are open', 'what threads do I have open'],
    supportingCapabilities: ['threads.list_open', 'threads.explicit_lookup'],
  },
  {
    id: 'idea_capture',
    label: 'Idea capture and memory saves',
    examplePrompts: ['capture this idea', 'save this to my library'],
    supportingCapabilities: ['knowledge.save_source', 'capture.add_item'],
  },
  {
    id: 'watchlist_research',
    label: 'Watchlists and research',
    examplePrompts: ['what changed today', 'what should I know before deciding'],
    supportingCapabilities: ['research.topic', 'research.compare', 'research.recommend'],
  },
] as const;

export const ANDREA_INTEGRATION_CAPABILITY_REGISTRY: readonly AndreaIntegrationCapability[] = [
  {
    id: 'google_calendar',
    label: 'Google Calendar',
    status: 'live_proven',
    journeys: [
      'calendar reads and writes',
      'meeting prep',
      'before-next-meeting guidance',
      'schedule follow-through',
    ],
    requiredAuth: ['Google Calendar OAuth'],
    degradedWording:
      'Calendar help should say exactly what is blocked and fall back to planning guidance instead of pretending a write succeeded.',
    proofCriteria:
      'One read plus one create/move/cancel chain on this host with truthful cleanup.',
  },
  {
    id: 'messages_threads',
    label: 'Messages / thread context',
    status: 'live_proven',
    journeys: [
      'reply help',
      'message summary',
      'open communication loops',
      'same-thread send or defer decisions',
    ],
    requiredAuth: ['BlueBubbles bridge for Messages'],
    degradedWording:
      'When the bridge is unhealthy, Andrea should keep reply help bounded and point people back to Telegram as the dependable lane.',
    proofCriteria:
      'One thread summary plus one draft/defer follow-up chain with same-thread continuity.',
  },
  {
    id: 'github_repo_context',
    label: 'GitHub and repo context',
    status: 'degraded_but_usable',
    journeys: [
      'repo standup',
      'project status',
      'what changed in active repos',
      'coding/work readiness',
    ],
    requiredAuth: ['GitHub connector or operator-visible repo context'],
    degradedWording:
      'Repo standups should fall back to current work, active jobs, and explicit GitHub state instead of claiming a richer repo view than Andrea really has.',
    proofCriteria:
      'Operator-visible repo or work snapshot with grounded status and no fabricated repository detail.',
  },
  {
    id: 'gmail_inbox_triage',
    label: 'Inbox triage',
    status: 'near_live_only',
    journeys: [
      'inbox triage',
      'owed replies',
      'drafting from connected mail context',
    ],
    requiredAuth: ['Gmail connector'],
    degradedWording:
      'If Gmail is not connected, Andrea should still offer reply strategy from pasted context, but clearly say inbox triage is not live on this host yet.',
    proofCriteria:
      'Connected inbox search, thread brief, and one grounded draft recommendation.',
  },
  {
    id: 'google_drive_context',
    label: 'Google Drive document context',
    status: 'near_live_only',
    journeys: [
      'document-backed meeting prep',
      'Drive context in project briefs',
      'saved material follow-through',
    ],
    requiredAuth: ['Google Drive connector'],
    degradedWording:
      'When Drive is not connected, Andrea should ask for pasted material or fall back to saved local knowledge instead of implying document access.',
    proofCriteria:
      'One meeting or project brief that cites connected Drive material truthfully.',
  },
  {
    id: 'live_research_watchlist',
    label: 'Live research and watchlists',
    status: 'externally_blocked',
    journeys: [
      'what changed',
      'watchlists',
      'market scans',
      'recommend/compare with live facts',
    ],
    requiredAuth: ['provider-backed research lane'],
    degradedWording:
      'Provider-backed research should say when the lane is quota-blocked and keep the answer grounded in saved context instead of bluffing.',
    proofCriteria:
      'One live lookup or watchlist brief with recent sources and explicit citations.',
  },
] as const;

export const ANDREA_RITUAL_MANIFEST: readonly AndreaRitualManifestEntry[] = [
  {
    id: 'morning_brief',
    label: 'Morning brief',
    trigger: 'scheduled weekdays at 07:15 local',
    inputs: ['calendar', 'reminders', 'life_threads', 'current_work', 'profile_facts'],
    outputShape: 'day brief with priorities and blockers',
    proofTarget: 'daily guidance freshness',
    blockerState: 'degraded if calendar or reminder signals are missing',
  },
  {
    id: 'midday_reground',
    label: 'Midday re-ground',
    trigger: 'scheduled weekdays at 12:30 local',
    inputs: ['calendar', 'reminders', 'life_threads', 'current_work'],
    outputShape: 'short midday reset',
    proofTarget: 'grounded next-step guidance',
    blockerState: 'degraded if schedule or open-loop context is stale',
  },
  {
    id: 'evening_reset',
    label: 'Evening reset',
    trigger: 'scheduled daily at 19:30 local',
    inputs: ['calendar', 'reminders', 'life_threads', 'knowledge_library'],
    outputShape: 'tonight/before-bed reset',
    proofTarget: 'evening follow-through guidance',
    blockerState: 'degraded if follow-through context is stale',
  },
  {
    id: 'open_guidance',
    label: 'Open guidance',
    trigger: 'on request',
    inputs: ['calendar', 'reminders', 'life_threads', 'current_work', 'knowledge_library'],
    outputShape: 'what matters / what changed / what next brief',
    proofTarget: 'flagship chief-of-staff guidance',
    blockerState: 'near-live if deeper context is missing but grounded guidance still works',
  },
  {
    id: 'thread_followthrough',
    label: 'Thread follow-through',
    trigger: 'scheduled weekdays at 18:30 local',
    inputs: ['life_threads', 'reminders', 'knowledge_library'],
    outputShape: 'communication and follow-up review',
    proofTarget: 'owed replies and open-thread hygiene',
    blockerState: 'degraded if thread context is stale',
  },
  {
    id: 'household_checkin',
    label: 'Household check-in',
    trigger: 'scheduled daily at 18:00 local',
    inputs: ['life_threads', 'calendar', 'knowledge_library'],
    outputShape: 'household follow-through review',
    proofTarget: 'home-context continuity',
    blockerState: 'degraded if household context is missing',
  },
  {
    id: 'transition_prompt',
    label: 'Transition prompt',
    trigger: 'scheduled weekdays at 16:30 local',
    inputs: ['calendar', 'reminders', 'life_threads', 'current_work'],
    outputShape: 'before-you-leave prep',
    proofTarget: 'leave-transition readiness',
    blockerState: 'degraded if the work or calendar picture is stale',
  },
] as const;

function safeLatestTimestamp(
  current: number,
  value: string | null | undefined,
): number {
  if (!value) return current;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > current ? parsed : current;
}

function safeGroupFolders(groupFolders: readonly string[]): string[] {
  return [...new Set(groupFolders.map((value) => value.trim()).filter(Boolean))];
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

export function buildAndreaCapabilityPackagingLine(): string {
  return 'schedule moves, reminders and save-for-later, meeting prep, quick reply help, what changed, repo check-ins, life threads, and idea capture';
}

export function getAndreaCapabilityDiscoveryPrompts(): string[] {
  return [
    'what matters today',
    'prep me for my next meeting',
    "what's on deck for my repos",
    'what should I say back',
    'what life threads are open',
    'capture this idea',
  ];
}

export function buildAndreaMemoryFreshnessRollup(
  groupFolders: readonly string[],
): Record<string, string> {
  const groups = safeGroupFolders(groupFolders);
  let latestTouched = 0;
  let profileSubjects = 0;
  let profileFacts = 0;
  let activeLifeThreads = 0;
  let knowledgeSources = 0;
  let ritualProfiles = 0;
  let scheduledTasks = 0;

  for (const groupFolder of groups) {
    const subjects = safeList(() => listProfileSubjectsForGroup(groupFolder)).filter(
      (subject) => !subject.disabledAt,
    );
    const facts = safeList(() => listProfileFactsForGroup(groupFolder)).filter(
      (fact) => fact.state !== 'rejected' && fact.state !== 'disabled',
    );
    const threads = safeList(() => listLifeThreadsForGroup(groupFolder, ['active']));
    const sources = safeList(() => listKnowledgeSourcesForGroup(groupFolder)).filter(
      (source) => !source.deletedAt && !source.disabledAt,
    );
    const rituals = safeList(() => listRitualProfilesForGroup(groupFolder));
    const tasks = safeList(() => getTasksForGroup(groupFolder)).filter(
      (task) => task.status !== 'completed',
    );

    profileSubjects += subjects.length;
    profileFacts += facts.length;
    activeLifeThreads += threads.length;
    knowledgeSources += sources.length;
    ritualProfiles += rituals.length;
    scheduledTasks += tasks.length;

    for (const subject of subjects) {
      latestTouched = safeLatestTimestamp(latestTouched, subject.updatedAt);
    }
    for (const fact of facts) {
      latestTouched = safeLatestTimestamp(latestTouched, fact.updatedAt);
    }
    for (const thread of threads) {
      latestTouched = safeLatestTimestamp(latestTouched, thread.lastUpdatedAt);
    }
    for (const source of sources) {
      latestTouched = safeLatestTimestamp(latestTouched, source.updatedAt);
    }
    for (const ritual of rituals) {
      latestTouched = safeLatestTimestamp(latestTouched, ritual.updatedAt);
    }
    for (const task of tasks) {
      latestTouched = safeLatestTimestamp(latestTouched, task.created_at);
    }
  }

  return {
    groupsTracked: String(groups.length),
    workingMemory: `${activeLifeThreads} active life threads and ${scheduledTasks} live follow-through tasks`,
    semanticMemory: `${profileSubjects} subjects, ${profileFacts} accepted facts, ${knowledgeSources} saved knowledge sources`,
    proceduralMemory: `${ritualProfiles} configured ritual profiles plus explicit preference/delegation rules`,
    latestTouchedAt:
      latestTouched > 0 ? new Date(latestTouched).toISOString() : 'not_yet_indexed',
    indexStatus: 'seeded_profile_pack_and_db_backed',
    changelogStatus: 'append_only',
    arbitrationStatus: 'active_memory_intelligence',
    semanticPromotionPolicy: 'grounded_or_confirmed_only',
    proceduralPromotionPolicy: 'repeated_success_or_outcome_review',
    ownership: 'raw memory stays in the product layer; platform only sees freshness metadata',
    taskStates:
      'active=current focus/open loops; waiting=blocked follow-up; someday=backlog; done=outcome reviewed',
  };
}

export function buildAndreaIntegrationHealthRollup(): Record<string, string> {
  const counts = {
    live_proven: 0,
    degraded_but_usable: 0,
    near_live_only: 0,
    externally_blocked: 0,
  };

  const statuses = Object.fromEntries(
    ANDREA_INTEGRATION_CAPABILITY_REGISTRY.map((entry) => {
      counts[entry.status] += 1;
      return [entry.id, entry.status];
    }),
  );

  return {
    ...statuses,
    liveProven: String(counts.live_proven),
    degradedButUsable: String(counts.degraded_but_usable),
    nearLiveOnly: String(counts.near_live_only),
    externallyBlocked: String(counts.externally_blocked),
    packaging:
      'Calendar is live, communication is strong, repo context is usable, and Gmail/Drive stay honest about not being fully connected yet.',
  };
}

export function buildAndreaRitualStatusRollup(
  groupFolders: readonly string[],
): Record<string, string> {
  const groups = safeGroupFolders(groupFolders);
  let configuredProfiles = 0;
  let enabledCount = 0;
  let scheduledCount = 0;
  let suggestedCount = 0;
  let onRequestCount = 0;
  let latestTouched = 0;

  for (const groupFolder of groups) {
    const rituals = safeList(() => listRitualProfilesForGroup(groupFolder));
    configuredProfiles += rituals.length;
    for (const ritual of rituals) {
      if (ritual.enabled) enabledCount += 1;
      if (ritual.triggerStyle === 'scheduled') scheduledCount += 1;
      if (ritual.triggerStyle === 'suggested') suggestedCount += 1;
      if (ritual.triggerStyle === 'on_request') onRequestCount += 1;
      latestTouched = safeLatestTimestamp(latestTouched, ritual.updatedAt);
    }
  }

  return {
    manifestSize: String(ANDREA_RITUAL_MANIFEST.length),
    groupsTracked: String(groups.length),
    configuredProfiles: String(configuredProfiles),
    enabled: String(enabledCount),
    scheduled: String(scheduledCount),
    suggested: String(suggestedCount),
    onRequest: String(onRequestCount),
    latestTouchedAt:
      latestTouched > 0 ? new Date(latestTouched).toISOString() : 'not_yet_configured',
    proofModel: 'ritual outcomes live in product truth and roll up into platform metadata',
  };
}

export function buildAndreaPlatformConfigSnapshots(
  groupFolders: readonly string[],
): AndreaPlatformConfigSnapshotInput[] {
  return [
    {
      component: 'andrea.memory',
      configName: 'memory_profile_pack',
      snapshot: {
        tiers: ANDREA_MEMORY_PROFILE_PACK,
        taskStateModel: ANDREA_TASK_STATE_MODEL,
      },
    },
    {
      component: 'andrea.memory',
      configName: 'memory_freshness_rollup',
      snapshot: buildAndreaMemoryFreshnessRollup(groupFolders),
    },
    {
      component: 'andrea.memory',
      configName: 'memory_intelligence_report',
      snapshot: buildMemoryIntelligenceReport(groupFolders),
    },
    {
      component: 'andrea.integrations',
      configName: 'integration_capability_registry',
      snapshot: {
        integrations: ANDREA_INTEGRATION_CAPABILITY_REGISTRY,
      },
    },
    {
      component: 'andrea.integrations',
      configName: 'integration_health_rollup',
      snapshot: buildAndreaIntegrationHealthRollup(),
    },
    {
      component: 'andrea.rituals',
      configName: 'ritual_manifest',
      snapshot: {
        rituals: ANDREA_RITUAL_MANIFEST,
      },
    },
    {
      component: 'andrea.rituals',
      configName: 'ritual_status_rollup',
      snapshot: buildAndreaRitualStatusRollup(groupFolders),
    },
  ];
}
