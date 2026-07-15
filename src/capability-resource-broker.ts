import { createHash } from 'node:crypto';

import {
  getAssistantCapabilityRegistry,
  type AssistantCapabilityDescriptor,
} from './assistant-capabilities.js';
import {
  isDatabaseInitialized,
  listAgentOSToolCards,
  listSkillPlaybooks,
  listToolReliabilityRollups,
} from './db.js';
import {
  durableActionPolicy,
  durableActionRequiresApproval,
  type DurableActionClass,
} from './durable-action-policy.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import { scan } from './safety/prompt-injection.js';
import type {
  AgentOSToolCard,
  CapabilityCostBand,
  CapabilityDataEgressClass,
  CapabilityGapKind,
  CapabilityLatencyBand,
  CapabilityResourceDescriptor,
  CapabilityResourceKind,
  ImprovementRiskLevel,
  SkillPlaybookRecord,
  ToolReliabilityRollup,
} from './types.js';

const RESOURCE_KINDS = new Set<CapabilityResourceKind>([
  'assistant_capability',
  'skill_playbook',
  'agent_os_tool',
  'mission_node',
  'openclaw_tool',
  'local_script',
  'trusted_documentation',
  'knowledge_source',
  'provider',
  'container',
  'code_lane',
  'patch_workbench',
]);
const AUTHORITY_ORDER = {
  none: 0,
  explicit_approval: 1,
  operator_context: 2,
} as const;
const EGRESS_ORDER: Record<CapabilityDataEgressClass, number> = {
  none: 0,
  local_only: 1,
  sanitized_metadata: 2,
  approved_content: 3,
  prohibited: 4,
};
const RISK_ORDER: Record<ImprovementRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const COST_SCORE: Record<Exclude<CapabilityCostBand, 'unknown'>, number> = {
  zero: 1,
  low: 0.8,
  medium: 0.5,
  high: 0.2,
};
const LATENCY_SCORE: Record<
  Exclude<CapabilityLatencyBand, 'unknown'>,
  number
> = {
  instant: 1,
  interactive: 0.8,
  background: 0.5,
  long_running: 0.2,
};
const EXECUTABLE_RESOURCE_KINDS = new Set<CapabilityResourceKind>([
  'assistant_capability',
  'agent_os_tool',
  'mission_node',
  'openclaw_tool',
  'local_script',
  'provider',
  'container',
  'code_lane',
  'patch_workbench',
]);
// Semantic similarity is useful for relevance/ranking, but never constitutes
// exact postcondition coverage for executable selection.
const POSTCONDITION_COVERAGE_THRESHOLD = 0.6;
const STABLE_AGENT_OS_BINDINGS: Readonly<
  Record<
    string,
    {
      actionClass: DurableActionClass;
      taskFamilies: string[];
      operationId: string;
    }
  >
> = {
  'npm:debug:cognition': {
    actionClass: 'local_lookup',
    taskFamilies: ['cognition', 'diagnostics'],
    operationId: 'npm:debug:cognition',
  },
  'npm:debug:council': {
    actionClass: 'council',
    taskFamilies: ['council', 'reasoning', 'diagnostics'],
    operationId: 'npm:debug:council',
  },
  'npm:integrations:status': {
    actionClass: 'read_only_integration',
    taskFamilies: ['integration', 'diagnostics'],
    operationId: 'npm:integrations:status',
  },
  'npm:debug:providers': {
    actionClass: 'read_only_integration',
    taskFamilies: ['provider', 'diagnostics'],
    operationId: 'npm:debug:providers',
  },
  'bluebubbles:send': {
    actionClass: 'send',
    taskFamilies: ['communication', 'bluebubbles'],
    operationId: 'bluebubbles:send',
  },
  'calendar:write': {
    actionClass: 'calendar_write',
    taskFamilies: ['calendar', 'planning'],
    operationId: 'calendar:write',
  },
};

export interface CapabilityResourceInventory {
  assistantCapabilities?: AssistantCapabilityDescriptor[];
  skillPlaybooks?: SkillPlaybookRecord[];
  agentOSToolCards?: AgentOSToolCard[];
  reliabilityRollups?: ToolReliabilityRollup[];
  additionalResources?: CapabilityResourceDescriptor[];
}

export interface ExternalCapabilityDocument {
  sourceId: string;
  title: string;
  content: string;
  citations: string[];
  taskFamilies: string[];
  supportedPostconditions: string[];
  factualMetadata?: Record<string, string | number | boolean>;
  version?: string;
}

export interface SanitizedExternalCapabilityDocument {
  sourceId: string;
  title: string;
  contentDigest: string;
  citations: string[];
  taskFamilies: string[];
  supportedPostconditions: string[];
  factualMetadata: Record<string, string | number | boolean>;
  scannerFlagged: boolean;
  acceptedForDiscovery: boolean;
  rejectionReason?: string;
}

export interface CapabilityBrokerRequest {
  targetOutcome: string;
  postconditions?: string[];
  taskFamily?: string;
  groupFolder?: string | null;
  availableInputs?: string[];
  authorityCeiling?: 'none' | 'explicit_approval' | 'operator_context';
  maxDataEgressClass?: CapabilityDataEgressClass;
  maxRiskLevel?: ImprovementRiskLevel;
  maxResources?: number;
  requiredResourceVersions?: Record<string, string>;
  inventory?: CapabilityResourceInventory;
  externalDocuments?: ExternalCapabilityDocument[];
}

export interface RankedCapabilityResource {
  resource: CapabilityResourceDescriptor;
  score: number;
  coveredPostconditions: string[];
  reasons: string[];
}

export interface RejectedCapabilityResource {
  resourceId: string;
  displayName: string;
  kind?: CapabilityResourceKind;
  rejectionReasons: string[];
}

export interface CapabilityResourceBrokerResult {
  gapKind: CapabilityGapKind;
  taskFamily: string;
  postconditions: string[];
  rankedCandidates: RankedCapabilityResource[];
  selectedResources: RankedCapabilityResource[];
  rejectedResources: RejectedCapabilityResource[];
  externalDocuments: SanitizedExternalCapabilityDocument[];
  missingPostconditions: string[];
  fullyCovered: boolean;
  nextAction: string;
  inventoryErrors: string[];
  inventoryCounts: {
    assistantCapabilities: number;
    skillPlaybooks: number;
    agentOSToolCards: number;
    reliabilityRollups: number;
    additionalResources: number;
    externalDocuments: number;
    viableResources: number;
    rejectedResources: number;
  };
}

export interface CapabilityResourceReuseAssessment {
  reusable: boolean;
  reasons: string[];
}

interface ResourceEnvelope {
  resource: CapabilityResourceDescriptor;
  adapterRejections: string[];
}

interface ResolvedInventory {
  assistantCapabilities: AssistantCapabilityDescriptor[];
  skillPlaybooks: SkillPlaybookRecord[];
  agentOSToolCards: AgentOSToolCard[];
  reliabilityRollups: ToolReliabilityRollup[];
  additionalResources: unknown[];
  errors: string[];
}

function canonicalJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(visit(value)) ?? 'null';
}

function digest(value: unknown): string {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(input).digest('hex');
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boundedStringArray(
  value: unknown,
  maxItems = 40,
  maxLength = 240,
): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map((item) => bounded(item, maxLength));
  if (items.some((item) => !item)) return null;
  return Array.from(new Set(items));
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseJsonStringArray(value: string): string[] | null {
  return boundedStringArray(parseJson(value));
}

function parseRequiredContext(value: string): string[] | null {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return boundedStringArray(parsed);
  if (!parsed || typeof parsed !== 'object') return null;
  return boundedStringArray((parsed as Record<string, unknown>).required);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function validFiniteScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function tokens(value: string): Set<string> {
  const ignored = new Set([
    'a',
    'an',
    'and',
    'for',
    'in',
    'of',
    'on',
    'the',
    'to',
    'with',
  ]);
  return new Set(
    normalize(value)
      .split(' ')
      .filter((token) => token.length > 1 && !ignored.has(token)),
  );
}

function semanticSimilarity(left: string, right: string): number {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return 0.9;
  }
  const leftTokens = tokens(normalizedLeft);
  const rightTokens = tokens(normalizedRight);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function taskFamilyFit(requested: string, candidates: string[]): number {
  const wanted = normalize(requested);
  let best = 0;
  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) continue;
    if (normalizedCandidate === wanted) best = Math.max(best, 1);
    else if (
      ['general', 'universal', 'cross domain'].includes(normalizedCandidate)
    ) {
      best = Math.max(best, 0.6);
    } else {
      best = Math.max(
        best,
        semanticSimilarity(wanted, normalizedCandidate) * 0.8,
      );
    }
  }
  return best;
}

function coveredPostconditions(
  resource: CapabilityResourceDescriptor,
  requested: string[],
): string[] {
  return requested.filter((postcondition) =>
    resource.supportedPostconditions.some(
      (supported) => normalize(postcondition) === normalize(supported),
    ),
  );
}

function inferTaskFamily(targetOutcome: string): string {
  const target = normalize(targetOutcome);
  if (/calendar|schedule|meeting|appointment/.test(target)) return 'calendar';
  if (/message|reply|text|telegram|bluebubbles|email/.test(target)) {
    return 'communication';
  }
  if (/research|investigate|compare|source|evidence/.test(target))
    return 'research';
  if (/repository|code|test|build|implement|debug/.test(target))
    return 'coding';
  if (/remember|memory|forget|profile/.test(target)) return 'memory';
  if (/image|video|media/.test(target)) return 'media';
  if (/mission|deep work/.test(target)) return 'deep_work';
  if (/daily|brief|today|next/.test(target)) return 'daily';
  return 'general';
}

function reliabilityBySubject(
  rollups: ToolReliabilityRollup[],
  subjectIds: string[],
): ToolReliabilityRollup | undefined {
  const wanted = new Set(subjectIds.map(normalize));
  return rollups.find((rollup) => wanted.has(normalize(rollup.subjectId)));
}

function hasActiveCooldown(
  cooldownUntil: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!cooldownUntil) return false;
  const parsed = Date.parse(cooldownUntil);
  return !Number.isFinite(parsed) || parsed > now;
}

function stableVersion(prefix: string, value: unknown): string {
  return `${prefix}:${digest(value)}`;
}

function assistantActionClass(
  descriptor: AssistantCapabilityDescriptor,
): DurableActionClass {
  const id = descriptor.id;
  if (/delete|forget/.test(id)) return 'delete';
  if (/draft/.test(id)) return 'draft';
  if (
    /remember|save|capture|configure|update|manage|reindex|disable/.test(id)
  ) {
    return 'local_save';
  }
  if (id === 'missions.execute') return 'operator_change';
  if (descriptor.category === 'research') return 'research_collect';
  if (descriptor.category === 'media') return 'provider_primary';
  return 'local_lookup';
}

function assistantTaskFamilies(
  descriptor: AssistantCapabilityDescriptor,
): string[] {
  const aliases: Partial<
    Record<AssistantCapabilityDescriptor['category'], string[]>
  > = {
    daily: ['daily_assistant', 'planning'],
    household: ['personal_assistant'],
    followthrough: ['workflow', 'capture'],
    threads: ['communication', 'personal_assistant'],
    memory: ['personal_context'],
    pulse: ['daily_assistant'],
    rituals: ['workflow'],
    knowledge: ['research'],
    communication: ['messages'],
    missions: ['deep_work'],
    staff: ['planning'],
    work: ['coding', 'repository', 'deep_work'],
    capture: ['personal_context'],
  };
  return Array.from(
    new Set([
      descriptor.category,
      descriptor.id.split('.')[0] || descriptor.category,
      ...(aliases[descriptor.category] || []),
    ]),
  );
}

function adaptAssistantCapability(
  descriptor: AssistantCapabilityDescriptor,
  rollups: ToolReliabilityRollup[],
): ResourceEnvelope {
  const requiredInputs = boundedStringArray(
    descriptor?.requiredInputs,
    50,
    180,
  );
  const optionalInputs = boundedStringArray(
    descriptor?.optionalInputs,
    50,
    180,
  );
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(descriptor.id || '') ||
    !bounded(descriptor.label, 240) ||
    !bounded(descriptor.category, 120) ||
    !requiredInputs ||
    !optionalInputs ||
    !['local', 'research', 'backend_lane', 'edge_only'].includes(
      descriptor.handlerKind,
    ) ||
    typeof descriptor.requiresLinkedAccount !== 'boolean' ||
    typeof descriptor.requiresConfirmation !== 'boolean' ||
    typeof descriptor.operatorOnly !== 'boolean'
  ) {
    return invalidAdaptedResource(
      `assistant:${bounded(descriptor?.id, 140) || 'invalid'}`,
      descriptor?.label || 'Invalid assistant capability',
      'assistant_capability',
      'Assistant capability registry metadata is malformed.',
    );
  }
  const rejections: string[] = [];
  const actionClass = assistantActionClass(descriptor);
  const policy = durableActionPolicy(actionClass);
  const version = stableVersion('assistant', {
    id: descriptor.id,
    label: descriptor.label,
    category: descriptor.category,
    requiredInputs,
    optionalInputs,
    requiresLinkedAccount: descriptor.requiresLinkedAccount,
    requiresConfirmation: descriptor.requiresConfirmation,
    operatorOnly: descriptor.operatorOnly,
    handlerKind: descriptor.handlerKind,
    availabilityNote: descriptor.availabilityNote || null,
  });
  const reliability = reliabilityBySubject(rollups, [
    descriptor.id,
    `assistant:${descriptor.id}`,
    `assistant-category:${descriptor.category}`,
    `assistant-handler:${descriptor.handlerKind}`,
  ]);
  const dependencyBound =
    descriptor.requiresLinkedAccount || descriptor.handlerKind !== 'local';
  let healthState: CapabilityResourceDescriptor['healthState'] = dependencyBound
    ? 'unknown'
    : 'healthy';
  let reliabilityScore = dependencyBound ? 0 : 0.78;
  if (reliability) {
    healthState = reliability.currentHealth;
    reliabilityScore = Math.min(
      reliability.reliabilityScore,
      reliability.confidenceCap,
    );
    if (hasActiveCooldown(reliability.cooldownUntil)) {
      healthState = 'blocked';
      rejections.push(
        'Reliability evidence has an active or malformed cooldown.',
      );
    }
  } else if (dependencyBound) {
    rejections.push(
      'Dependency-bound capability has no current reliability evidence.',
    );
  }
  if (typeof descriptor.execute !== 'function') {
    healthState = 'blocked';
    rejections.push('Assistant capability has no executable registry binding.');
  }
  if (
    /\b(unavailable|disabled|not available)\b/i.test(
      descriptor.availabilityNote || '',
    )
  ) {
    healthState = 'blocked';
    rejections.push(
      'Assistant capability registry marks the capability unavailable.',
    );
  }
  let authorityRequirement: CapabilityResourceDescriptor['authorityRequirement'] =
    descriptor.operatorOnly
      ? 'operator_context'
      : descriptor.requiresConfirmation
        ? 'explicit_approval'
        : 'none';
  if (
    durableActionRequiresApproval(actionClass) &&
    authorityRequirement === 'none'
  ) {
    authorityRequirement =
      actionClass === 'operator_change'
        ? 'operator_context'
        : 'explicit_approval';
  }
  const readOnly = policy?.allowedEffects.includes('read_only') ?? false;
  return {
    resource: {
      resourceId: `assistant:${descriptor.id}`,
      kind: 'assistant_capability',
      displayName: descriptor.label,
      taskFamilies: assistantTaskFamilies(descriptor),
      capabilityIds: [descriptor.id],
      supportedPostconditions: [
        descriptor.label,
        descriptor.id.replace(/[._]/g, ' '),
        `complete ${descriptor.label}`,
      ],
      requiredInputs,
      available: healthState === 'healthy' || healthState === 'degraded',
      healthState,
      verificationStrength: reliability ? reliability.confidenceCap : 0.65,
      reliabilityScore,
      authorityRequirement,
      riskLevel:
        authorityRequirement === 'operator_context'
          ? 'high'
          : authorityRequirement === 'explicit_approval'
            ? 'medium'
            : 'low',
      dataEgressClass: descriptor.requiresLinkedAccount
        ? 'approved_content'
        : descriptor.handlerKind === 'local'
          ? 'local_only'
          : 'approved_content',
      reversible: !durableActionRequiresApproval(actionClass),
      expectedCostBand: descriptor.handlerKind === 'local' ? 'zero' : 'low',
      expectedLatencyBand:
        descriptor.handlerKind === 'local' ? 'instant' : 'interactive',
      version,
      sourceRefs: [`assistant-capability:${descriptor.id}`],
      maintenanceBurden: descriptor.handlerKind === 'local' ? 'low' : 'medium',
      bindingRefs: [
        {
          bindingId: `assistant:${descriptor.id}`,
          operationId: `assistant-capability:${descriptor.id}`,
          evaluatorId: `postcondition:${descriptor.id}`,
          executorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'executor',
            implementationId: `assistant-capability:${descriptor.handlerKind}:${descriptor.id}`,
            version,
          }),
          evaluatorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'evaluator',
            implementationId: `assistant-postcondition:${descriptor.id}`,
            version,
          }),
          actionClass,
          version,
          readOnly,
        },
      ],
    },
    adapterRejections: rejections,
  };
}

function invalidAdaptedResource(
  id: string,
  displayName: string,
  kind: CapabilityResourceKind,
  reason: string,
): ResourceEnvelope {
  return {
    resource: {
      resourceId: bounded(id, 160) || `invalid:${digest(id).slice(0, 16)}`,
      kind,
      displayName: bounded(displayName, 240) || 'Invalid resource record',
      taskFamilies: ['invalid'],
      capabilityIds: ['invalid'],
      supportedPostconditions: ['invalid'],
      requiredInputs: [],
      available: false,
      healthState: 'blocked',
      verificationStrength: 0,
      reliabilityScore: 0,
      authorityRequirement: 'operator_context',
      riskLevel: 'critical',
      dataEgressClass: 'prohibited',
      reversible: false,
      expectedCostBand: 'unknown',
      expectedLatencyBand: 'unknown',
      version: 'invalid',
      sourceRefs: ['invalid-record'],
      maintenanceBurden: 'high',
      bindingRefs: [],
    },
    adapterRejections: [reason],
  };
}

function adaptSkillPlaybook(
  skill: SkillPlaybookRecord,
  cards: AgentOSToolCard[],
  rollups: ToolReliabilityRollup[],
): ResourceEnvelope {
  const requiredInputs = parseRequiredContext(skill.requiredContextJson);
  const allowed = parseJsonStringArray(skill.allowedActionsJson);
  const disallowed = parseJsonStringArray(skill.disallowedActionsJson);
  const expectedTools = parseJsonStringArray(skill.expectedToolsJson);
  const successCriteria = parseJsonStringArray(skill.successCriteriaJson);
  const evalScenarios = parseJsonStringArray(skill.evalScenariosJson);
  const approvals = parseJson(skill.approvalRequirementsJson);
  const privacy = parseJsonObject(skill.privacyJson);
  const approvalsValid =
    Array.isArray(approvals) ||
    (approvals !== null && typeof approvals === 'object');
  if (
    skill.status !== 'active' ||
    !requiredInputs ||
    !allowed ||
    !disallowed ||
    !expectedTools ||
    !successCriteria ||
    successCriteria.length === 0 ||
    !evalScenarios ||
    !approvalsValid ||
    !privacy ||
    !validFiniteScore(skill.reliabilityScore)
  ) {
    return invalidAdaptedResource(
      `skill:${skill.skillId}`,
      skill.title,
      'skill_playbook',
      'Skill playbook is inactive or contains malformed policy/evidence JSON.',
    );
  }
  const cardSubjects = new Map<string, AgentOSToolCard>();
  for (const card of cards) {
    cardSubjects.set(normalize(card.sourceToolId), card);
    cardSubjects.set(normalize(card.toolCardId), card);
  }
  const unavailableTools: string[] = [];
  for (const tool of expectedTools) {
    const reliability = reliabilityBySubject(rollups, [tool]);
    const card = cardSubjects.get(normalize(tool));
    const health = reliability?.currentHealth || card?.healthState || 'unknown';
    if (
      health === 'blocked' ||
      health === 'unknown' ||
      hasActiveCooldown(reliability?.cooldownUntil)
    ) {
      unavailableTools.push(tool);
    }
  }
  const approvalText = canonicalJson(approvals);
  const authorityRequirement = /operator/i.test(approvalText)
    ? 'operator_context'
    : (Array.isArray(approvals) && approvals.length > 0) ||
        (!Array.isArray(approvals) &&
          Object.keys(approvals as object).length > 0)
      ? 'explicit_approval'
      : 'none';
  const version = stableVersion('skill', {
    skillId: skill.skillId,
    title: skill.title,
    triggerPattern: skill.triggerPattern,
    taskFamily: skill.taskFamily,
    requiredInputs,
    allowed,
    disallowed,
    approvals,
    expectedTools,
    fallbackPlan: skill.fallbackPlan,
    successCriteria,
    evalScenarios,
    privacy,
  });
  const requestedEgress = (privacy as Record<string, unknown>).dataEgressClass;
  const dataEgressClass =
    typeof requestedEgress === 'string' && requestedEgress in EGRESS_ORDER
      ? (requestedEgress as CapabilityDataEgressClass)
      : 'local_only';
  return {
    resource: {
      resourceId: `skill:${skill.skillId}`,
      kind: 'skill_playbook',
      displayName: skill.title,
      taskFamilies: [skill.taskFamily],
      capabilityIds: [`skill:${skill.skillId}`],
      supportedPostconditions: successCriteria,
      requiredInputs,
      available: unavailableTools.length === 0,
      healthState:
        unavailableTools.length > 0
          ? 'blocked'
          : skill.reliabilityScore >= 0.8
            ? 'healthy'
            : 'degraded',
      verificationStrength: Math.min(
        0.9,
        0.45 + Math.min(evalScenarios.length, 5) * 0.08,
      ),
      reliabilityScore: skill.reliabilityScore,
      authorityRequirement,
      riskLevel: authorityRequirement === 'none' ? 'low' : 'medium',
      dataEgressClass,
      reversible: true,
      expectedCostBand: 'zero',
      expectedLatencyBand: 'instant',
      version,
      sourceRefs: [
        `skill-playbook:${skill.skillId}`,
        ...(skill.sourceDistillationId
          ? [`distillation:${skill.sourceDistillationId}`]
          : []),
      ],
      maintenanceBurden: 'medium',
      bindingRefs: [],
    },
    adapterRejections:
      unavailableTools.length > 0
        ? [
            `Skill dependencies are unavailable or unknown: ${unavailableTools.join(', ')}.`,
          ]
        : [],
  };
}

function parseCooldownArray(value: string): {
  valid: boolean;
  active: boolean;
} {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return { valid: false, active: false };
  let active = false;
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, active: false };
    }
    const cooldownUntil = (item as Record<string, unknown>).cooldownUntil;
    if (typeof cooldownUntil !== 'string') {
      return { valid: false, active: false };
    }
    const parsedTime = Date.parse(cooldownUntil);
    if (!Number.isFinite(parsedTime)) return { valid: false, active: false };
    if (parsedTime > Date.now()) active = true;
  }
  return { valid: true, active };
}

function adaptAgentOSToolCard(
  card: AgentOSToolCard,
  rollups: ToolReliabilityRollup[],
): ResourceEnvelope {
  const evidence = parseJsonStringArray(card.evidenceProducedJson);
  const sourceRefs = parseJsonStringArray(card.sourceRefsJson);
  const privacy = parseJsonObject(card.privacyJson);
  const cooldown = parseCooldownArray(card.cooldownJson);
  const stableBinding = STABLE_AGENT_OS_BINDINGS[card.sourceToolId];
  if (
    !evidence ||
    evidence.length === 0 ||
    !sourceRefs ||
    sourceRefs.length === 0 ||
    !privacy ||
    !cooldown.valid ||
    !stableBinding ||
    card.policyClass === 'forbidden'
  ) {
    return invalidAdaptedResource(
      `agent-os:${card.toolCardId}`,
      card.displayName,
      'agent_os_tool',
      !stableBinding
        ? 'Agent OS record has no canonical stable execution binding.'
        : 'Agent OS record contains malformed policy, evidence, cooldown, or privacy data.',
    );
  }
  const reliability = reliabilityBySubject(rollups, [
    card.sourceToolId,
    card.toolCardId,
  ]);
  let healthState = reliability?.currentHealth || card.healthState;
  const adapterRejections: string[] = [];
  if (cooldown.active || hasActiveCooldown(reliability?.cooldownUntil)) {
    healthState = 'blocked';
    adapterRejections.push(
      'Agent OS resource has an active reliability cooldown.',
    );
  }
  if (healthState === 'blocked' || healthState === 'unknown') {
    adapterRejections.push('Agent OS health is blocked or unknown.');
  }
  if (
    card.approvalPolicy === 'forbidden' ||
    (durableActionRequiresApproval(stableBinding.actionClass) &&
      card.approvalPolicy !== 'explicit_approval')
  ) {
    healthState = 'blocked';
    adapterRejections.push(
      'Agent OS approval policy does not satisfy the action policy.',
    );
  }
  const version = stableVersion('agent-os', {
    sourceToolId: card.sourceToolId,
    capabilityKind: card.capabilityKind,
    policyClass: card.policyClass,
    riskLevel: card.riskLevel,
    approvalPolicy: card.approvalPolicy,
    evidence,
    sourceRefs,
    privacy,
    binding: stableBinding,
  });
  const actionPolicy = durableActionPolicy(stableBinding.actionClass);
  const authorityRequirement =
    card.approvalPolicy === 'explicit_approval' ? 'explicit_approval' : 'none';
  return {
    resource: {
      resourceId: `agent-os:${card.toolCardId}`,
      kind: 'agent_os_tool',
      displayName: card.displayName,
      taskFamilies: stableBinding.taskFamilies,
      capabilityIds: [card.capabilityKind, card.sourceToolId],
      supportedPostconditions: [...evidence, card.displayName],
      requiredInputs: [],
      available: healthState === 'healthy' || healthState === 'degraded',
      healthState,
      verificationStrength: reliability?.confidenceCap ?? 0.7,
      reliabilityScore:
        reliability === undefined
          ? healthState === 'healthy'
            ? 0.75
            : 0.5
          : Math.min(reliability.reliabilityScore, reliability.confidenceCap),
      authorityRequirement,
      riskLevel: card.riskLevel,
      dataEgressClass:
        stableBinding.actionClass === 'local_lookup'
          ? 'local_only'
          : 'approved_content',
      reversible: !durableActionRequiresApproval(stableBinding.actionClass),
      expectedCostBand:
        stableBinding.actionClass === 'council' ? 'medium' : 'zero',
      expectedLatencyBand:
        stableBinding.actionClass === 'council' ? 'background' : 'instant',
      version,
      sourceRefs: [...sourceRefs, `agent-os-card:${card.toolCardId}`],
      maintenanceBurden: 'low',
      bindingRefs: [
        {
          bindingId: `agent-os:${card.sourceToolId}`,
          operationId: stableBinding.operationId,
          evaluatorId: `agent-os-evidence:${card.sourceToolId}`,
          executorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'executor',
            implementationId: `agent-os:${card.sourceToolId}:${stableBinding.operationId}`,
            version,
          }),
          evaluatorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'evaluator',
            implementationId: `agent-os-evidence:${card.sourceToolId}`,
            version,
          }),
          actionClass: stableBinding.actionClass,
          version,
          readOnly: actionPolicy?.allowedEffects.includes('read_only') ?? false,
        },
      ],
    },
    adapterRejections,
  };
}

function safeCitation(value: unknown): string | null {
  const candidate = bounded(value, 500);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Citations are provenance pointers, not request replays. Preserve only the
    // stable public location so embedded credentials and query-bound tokens can
    // never enter acquisition evidence or a compiled resource contract.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 500);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function sanitizeExternalDocument(document: ExternalCapabilityDocument): {
  sanitized: SanitizedExternalCapabilityDocument;
  envelope: ResourceEnvelope;
} {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    const contentDigest = digest('');
    const sanitized: SanitizedExternalCapabilityDocument = {
      sourceId: `external-${contentDigest.slice(0, 16)}`,
      title: `External source ${contentDigest.slice(0, 12)}`,
      contentDigest,
      citations: [],
      taskFamilies: [],
      supportedPostconditions: [],
      factualMetadata: {},
      scannerFlagged: false,
      acceptedForDiscovery: false,
      rejectionReason: 'External document record is malformed.',
    };
    return {
      sanitized,
      envelope: invalidAdaptedResource(
        `external-document:${sanitized.sourceId}`,
        sanitized.title,
        'knowledge_source',
        'External document record is malformed.',
      ),
    };
  }
  const content = typeof document.content === 'string' ? document.content : '';
  const contentDigest = digest(content);
  const assessment = scan(content);
  const titleAssessment = scan(
    typeof document.title === 'string' ? document.title : '',
  );
  const scannerFlagged =
    assessment.risk > 0 ||
    assessment.treatAsData ||
    assessment.looksLikeBase64 ||
    titleAssessment.risk > 0 ||
    titleAssessment.treatAsData ||
    titleAssessment.looksLikeBase64;
  const sourceId =
    typeof document.sourceId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(document.sourceId)
      ? document.sourceId
      : `external-${contentDigest.slice(0, 16)}`;
  const title = scannerFlagged
    ? `External source ${contentDigest.slice(0, 12)}`
    : bounded(document.title, 180) ||
      `External source ${contentDigest.slice(0, 12)}`;
  const citations = Array.from(
    new Set(
      (Array.isArray(document.citations) ? document.citations : [])
        .slice(0, 8)
        .map(safeCitation)
        .filter((citation): citation is string => Boolean(citation)),
    ),
  );
  const taskFamilies = boundedStringArray(document.taskFamilies, 12, 100) || [];
  const supportedPostconditions =
    boundedStringArray(document.supportedPostconditions, 20, 240) || [];
  const factualMetadata: Record<string, string | number | boolean> = {};
  const metadata = document.factualMetadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 12)) {
      const key = bounded(rawKey, 80);
      if (!/^[A-Za-z][A-Za-z0-9_. -]{0,79}$/.test(key)) continue;
      if (
        typeof rawValue !== 'string' &&
        typeof rawValue !== 'number' &&
        typeof rawValue !== 'boolean'
      ) {
        continue;
      }
      const safeValue =
        typeof rawValue === 'string' ? bounded(rawValue, 240) : rawValue;
      const metadataAssessment = scan(`${key}: ${String(safeValue)}`);
      if (
        !safeValue ||
        metadataAssessment.risk > 0 ||
        metadataAssessment.looksLikeBase64
      ) {
        continue;
      }
      factualMetadata[key] = safeValue;
    }
  }
  const acceptedForDiscovery =
    !scannerFlagged &&
    content.length > 0 &&
    citations.length > 0 &&
    taskFamilies.length > 0 &&
    supportedPostconditions.length > 0;
  const rejectionReason = scannerFlagged
    ? 'External content was rejected by the prompt-injection scanner.'
    : !acceptedForDiscovery
      ? 'External content lacks bounded citations, task families, or postconditions.'
      : undefined;
  const sanitized: SanitizedExternalCapabilityDocument = {
    sourceId,
    title,
    contentDigest,
    citations,
    taskFamilies,
    supportedPostconditions,
    factualMetadata,
    scannerFlagged,
    acceptedForDiscovery,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
  const version = `content-sha256:${contentDigest}`;
  return {
    sanitized,
    envelope: {
      resource: {
        resourceId: `external-document:${sourceId}`,
        kind: 'knowledge_source',
        displayName: title,
        taskFamilies: taskFamilies.length > 0 ? taskFamilies : ['invalid'],
        capabilityIds: ['external-knowledge'],
        supportedPostconditions:
          supportedPostconditions.length > 0
            ? supportedPostconditions
            : ['invalid'],
        requiredInputs: [],
        available: acceptedForDiscovery,
        healthState: acceptedForDiscovery ? 'degraded' : 'blocked',
        verificationStrength: 0.3,
        reliabilityScore: 0.35,
        authorityRequirement: 'none',
        riskLevel: 'low',
        dataEgressClass: 'sanitized_metadata',
        reversible: true,
        expectedCostBand: 'zero',
        expectedLatencyBand: 'instant',
        version,
        sourceRefs:
          citations.length > 0 ? citations : [`digest:${contentDigest}`],
        maintenanceBurden: 'medium',
        bindingRefs: [],
      },
      adapterRejections: rejectionReason ? [rejectionReason] : [],
    },
  };
}

function safeUnknownResource(value: unknown): ResourceEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidAdaptedResource(
      'additional:invalid',
      'Invalid additional resource',
      'knowledge_source',
      'Additional resource is not an object.',
    );
  }
  const record = value as Partial<CapabilityResourceDescriptor>;
  const resourceId = bounded(record.resourceId, 160) || 'additional:invalid';
  const displayName =
    bounded(record.displayName, 240) || 'Invalid additional resource';
  if (!record.kind || !RESOURCE_KINDS.has(record.kind)) {
    return invalidAdaptedResource(
      resourceId,
      displayName,
      'knowledge_source',
      'Additional resource has an unknown kind.',
    );
  }
  return {
    resource: record as CapabilityResourceDescriptor,
    adapterRejections: [],
  };
}

function resolveInventory(request: CapabilityBrokerRequest): ResolvedInventory {
  const supplied = request.inventory || {};
  const errors: string[] = [];
  let assistantCapabilities: AssistantCapabilityDescriptor[] = [];
  let skillPlaybooks: SkillPlaybookRecord[] = [];
  let agentOSToolCards: AgentOSToolCard[] = [];
  let reliabilityRollups: ToolReliabilityRollup[] = [];
  if (supplied.assistantCapabilities !== undefined) {
    if (Array.isArray(supplied.assistantCapabilities)) {
      assistantCapabilities = supplied.assistantCapabilities;
    } else {
      errors.push('Supplied assistant capability inventory is malformed.');
    }
  } else {
    try {
      assistantCapabilities = getAssistantCapabilityRegistry();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push('Assistant capability registry could not be read.');
    }
  }
  const databaseReady = isDatabaseInitialized();
  if (supplied.skillPlaybooks !== undefined) {
    if (Array.isArray(supplied.skillPlaybooks)) {
      skillPlaybooks = supplied.skillPlaybooks;
    } else {
      errors.push('Supplied skill playbook inventory is malformed.');
    }
  } else if (databaseReady) {
    try {
      skillPlaybooks = listSkillPlaybooks({
        groupFolder: request.groupFolder || null,
        statuses: ['active'],
        taskFamily: request.taskFamily,
        limit: 500,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push('Skill playbook inventory could not be read.');
    }
  }
  if (supplied.agentOSToolCards !== undefined) {
    if (Array.isArray(supplied.agentOSToolCards)) {
      agentOSToolCards = supplied.agentOSToolCards;
    } else {
      errors.push('Supplied Agent OS tool inventory is malformed.');
    }
  } else if (databaseReady) {
    try {
      agentOSToolCards = listAgentOSToolCards({ limit: 500 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push('Agent OS tool inventory could not be read.');
    }
  }
  if (supplied.reliabilityRollups !== undefined) {
    if (Array.isArray(supplied.reliabilityRollups)) {
      reliabilityRollups = supplied.reliabilityRollups;
    } else {
      errors.push('Supplied reliability inventory is malformed.');
    }
  } else if (databaseReady) {
    try {
      reliabilityRollups = listToolReliabilityRollups({ limit: 500 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push('Tool reliability inventory could not be read.');
    }
  }
  return {
    assistantCapabilities,
    skillPlaybooks,
    agentOSToolCards,
    reliabilityRollups,
    additionalResources: Array.isArray(supplied.additionalResources)
      ? supplied.additionalResources
      : [],
    errors,
  };
}

function validateBinding(
  binding: CapabilityResourceDescriptor['bindingRefs'][number],
): string[] {
  const reasons: string[] = [];
  if (
    !binding ||
    !bounded(binding.bindingId, 180) ||
    !bounded(binding.operationId, 180) ||
    !bounded(binding.evaluatorId, 180) ||
    !/^[a-f0-9]{64}$/.test(binding.executorImplementationDigest) ||
    !/^[a-f0-9]{64}$/.test(binding.evaluatorImplementationDigest) ||
    !bounded(binding.version, 180) ||
    typeof binding.readOnly !== 'boolean'
  ) {
    reasons.push('Resource contains a malformed stable binding.');
    return reasons;
  }
  const policy = durableActionPolicy(binding.actionClass);
  if (!policy) reasons.push('Resource binding uses an unknown action class.');
  else if (binding.readOnly && !policy.allowedEffects.includes('read_only')) {
    reasons.push(
      'Resource binding falsely marks a side-effecting action read-only.',
    );
  }
  return reasons;
}

function validateResource(
  resource: CapabilityResourceDescriptor,
  request: {
    taskFamily: string;
    postconditions: string[];
    availableInputs: Set<string>;
    authorityCeiling: keyof typeof AUTHORITY_ORDER;
    maxDataEgressClass: CapabilityDataEgressClass;
    maxRiskLevel: ImprovementRiskLevel;
    requiredResourceVersions: Record<string, string>;
  },
): string[] {
  const reasons: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(resource.resourceId || '')) {
    reasons.push('Resource ID is missing or malformed.');
  }
  if (!bounded(resource.displayName, 240))
    reasons.push('Resource display name is missing.');
  if (!RESOURCE_KINDS.has(resource.kind))
    reasons.push('Resource kind is unknown.');
  const taskFamilies = boundedStringArray(resource.taskFamilies, 30, 120);
  const capabilityIds = boundedStringArray(resource.capabilityIds, 50, 180);
  const postconditions = boundedStringArray(
    resource.supportedPostconditions,
    50,
    300,
  );
  const requiredInputs = boundedStringArray(resource.requiredInputs, 50, 180);
  const sourceRefs = boundedStringArray(resource.sourceRefs, 50, 500);
  if (!taskFamilies?.length)
    reasons.push('Resource task-family metadata is missing or malformed.');
  if (!capabilityIds?.length)
    reasons.push('Resource capability metadata is missing or malformed.');
  if (!postconditions?.length)
    reasons.push('Resource postconditions are missing or malformed.');
  if (!requiredInputs) reasons.push('Resource input metadata is malformed.');
  if (!sourceRefs?.length)
    reasons.push('Resource provenance is missing or malformed.');
  if (!resource.available) reasons.push('Resource is marked unavailable.');
  if (
    resource.healthState === 'blocked' ||
    resource.healthState === 'unknown'
  ) {
    reasons.push('Resource health is blocked or unknown.');
  }
  if (
    !['healthy', 'degraded', 'blocked', 'unknown'].includes(
      resource.healthState,
    )
  ) {
    reasons.push('Resource health value is malformed.');
  }
  if (!validFiniteScore(resource.verificationStrength)) {
    reasons.push('Resource verification strength is malformed.');
  }
  if (!validFiniteScore(resource.reliabilityScore)) {
    reasons.push('Resource reliability score is malformed.');
  }
  if (!(resource.authorityRequirement in AUTHORITY_ORDER)) {
    reasons.push('Resource authority requirement is unknown.');
  } else if (
    AUTHORITY_ORDER[resource.authorityRequirement] >
    AUTHORITY_ORDER[request.authorityCeiling]
  ) {
    reasons.push('Resource exceeds the request authority ceiling.');
  }
  if (!(resource.dataEgressClass in EGRESS_ORDER)) {
    reasons.push('Resource data-egress class is unknown.');
  } else if (
    resource.dataEgressClass === 'prohibited' ||
    EGRESS_ORDER[resource.dataEgressClass] >
      EGRESS_ORDER[request.maxDataEgressClass]
  ) {
    reasons.push('Resource exceeds the request data-egress ceiling.');
  }
  if (!(resource.riskLevel in RISK_ORDER))
    reasons.push('Resource risk level is unknown.');
  else if (RISK_ORDER[resource.riskLevel] > RISK_ORDER[request.maxRiskLevel]) {
    reasons.push('Resource exceeds the request risk ceiling.');
  }
  if (
    resource.expectedCostBand === 'unknown' ||
    !(resource.expectedCostBand in COST_SCORE)
  ) {
    reasons.push('Resource cost is unavailable or unknown.');
  }
  if (
    resource.expectedLatencyBand === 'unknown' ||
    !(resource.expectedLatencyBand in LATENCY_SCORE)
  ) {
    reasons.push('Resource latency is unavailable or unknown.');
  }
  if (!['low', 'medium', 'high'].includes(resource.maintenanceBurden)) {
    reasons.push('Resource maintenance burden is unknown.');
  }
  if (
    !bounded(resource.version, 180) ||
    /^(unknown|latest|unversioned|invalid)$/i.test(resource.version)
  ) {
    reasons.push('Resource version is unavailable or unstable.');
  }
  const requiredVersion = request.requiredResourceVersions[resource.resourceId];
  if (requiredVersion && resource.version !== requiredVersion) {
    reasons.push('Resource version does not match the pinned request version.');
  }
  if (taskFamilies && taskFamilyFit(request.taskFamily, taskFamilies) < 0.55) {
    reasons.push('Resource belongs to a materially different task family.');
  }
  if (
    postconditions &&
    !request.postconditions.some((postcondition) =>
      postconditions.some(
        (supported) =>
          semanticSimilarity(postcondition, supported) >=
          POSTCONDITION_COVERAGE_THRESHOLD,
      ),
    )
  ) {
    reasons.push('Resource does not support a requested postcondition.');
  }
  if (requiredInputs) {
    const missingInputs = requiredInputs.filter(
      (input) => !request.availableInputs.has(normalize(input)),
    );
    if (missingInputs.length > 0) {
      reasons.push(
        `Resource is missing required inputs: ${missingInputs.join(', ')}.`,
      );
    }
  }
  if (!Array.isArray(resource.bindingRefs)) {
    reasons.push('Resource stable bindings are malformed.');
  } else {
    if (
      EXECUTABLE_RESOURCE_KINDS.has(resource.kind) &&
      resource.bindingRefs.length === 0
    ) {
      reasons.push('Executable resource has no stable binding.');
    }
    for (const binding of resource.bindingRefs) {
      reasons.push(...validateBinding(binding));
      if (
        durableActionRequiresApproval(binding.actionClass) &&
        resource.authorityRequirement === 'none'
      ) {
        reasons.push(
          'Resource binding requires approval but declares no authority requirement.',
        );
      }
    }
  }
  return Array.from(new Set(reasons));
}

function rankResource(
  resource: CapabilityResourceDescriptor,
  taskFamily: string,
  postconditions: string[],
): RankedCapabilityResource {
  const covered = coveredPostconditions(resource, postconditions);
  const postconditionScore =
    postconditions.reduce((total, postcondition) => {
      const best = Math.max(
        0,
        ...resource.supportedPostconditions.map((supported) =>
          semanticSimilarity(postcondition, supported),
        ),
      );
      return total + best;
    }, 0) / postconditions.length;
  const taskScore = taskFamilyFit(taskFamily, resource.taskFamilies);
  const healthScore = resource.healthState === 'healthy' ? 1 : 0.55;
  const authorityScore =
    resource.authorityRequirement === 'none'
      ? 1
      : resource.authorityRequirement === 'explicit_approval'
        ? 0.65
        : 0.35;
  const privacyScore = {
    none: 1,
    local_only: 0.95,
    sanitized_metadata: 0.7,
    approved_content: 0.4,
    prohibited: 0,
  }[resource.dataEgressClass];
  const maintenanceScore = {
    low: 1,
    medium: 0.55,
    high: 0.2,
  }[resource.maintenanceBurden];
  const score =
    taskScore * 0.2 +
    postconditionScore * 0.22 +
    resource.verificationStrength * 0.12 +
    healthScore * 0.1 +
    resource.reliabilityScore * 0.1 +
    authorityScore * 0.08 +
    privacyScore * 0.07 +
    (resource.reversible ? 1 : 0.15) * 0.04 +
    COST_SCORE[
      resource.expectedCostBand as Exclude<CapabilityCostBand, 'unknown'>
    ] *
      0.03 +
    LATENCY_SCORE[
      resource.expectedLatencyBand as Exclude<CapabilityLatencyBand, 'unknown'>
    ] *
      0.02 +
    maintenanceScore * 0.02;
  return {
    resource,
    score: Number(score.toFixed(6)),
    coveredPostconditions: covered,
    reasons: [
      `task-family fit ${taskScore.toFixed(2)}`,
      `postcondition fit ${postconditionScore.toFixed(2)}`,
      `verification ${resource.verificationStrength.toFixed(2)}`,
      `health ${resource.healthState}`,
      `reliability ${resource.reliabilityScore.toFixed(2)}`,
      `authority ${resource.authorityRequirement}`,
      `egress ${resource.dataEgressClass}`,
      `cost ${resource.expectedCostBand}`,
      `latency ${resource.expectedLatencyBand}`,
      `maintenance ${resource.maintenanceBurden}`,
    ],
  };
}

function chooseSmallestSufficientSet(
  candidates: RankedCapabilityResource[],
  postconditions: string[],
  maxResources: number,
): RankedCapabilityResource[] {
  const pool = candidates.slice(0, 20);
  const wanted = new Set(postconditions);
  const coversAll = (selection: RankedCapabilityResource[]): boolean => {
    const covered = new Set(
      selection.flatMap((candidate) => candidate.coveredPostconditions),
    );
    return Array.from(wanted).every((postcondition) =>
      covered.has(postcondition),
    );
  };
  for (let size = 1; size <= Math.min(maxResources, pool.length); size += 1) {
    let best: RankedCapabilityResource[] | null = null;
    let bestScore = -1;
    const visit = (
      start: number,
      selection: RankedCapabilityResource[],
    ): void => {
      if (selection.length === size) {
        if (!coversAll(selection)) return;
        const score = selection.reduce(
          (total, candidate) => total + candidate.score,
          0,
        );
        const identity = selection
          .map((candidate) => candidate.resource.resourceId)
          .sort()
          .join('|');
        const bestIdentity = (best || [])
          .map((candidate) => candidate.resource.resourceId)
          .sort()
          .join('|');
        if (
          score > bestScore ||
          (score === bestScore && identity < bestIdentity)
        ) {
          best = [...selection];
          bestScore = score;
        }
        return;
      }
      for (let index = start; index < pool.length; index += 1) {
        selection.push(pool[index]!);
        visit(index + 1, selection);
        selection.pop();
      }
    };
    visit(0, []);
    if (best) return best;
  }
  return [];
}

export function classifyCapabilityGap(params: {
  targetOutcome: string;
  taskFamily: string;
  fullyCovered: boolean;
  selectedResources: RankedCapabilityResource[];
  rankedCandidates: RankedCapabilityResource[];
  rejectedResources: RejectedCapabilityResource[];
}): CapabilityGapKind {
  if (params.fullyCovered) {
    return params.selectedResources.length === 1 ? 'known' : 'composable';
  }
  const rejectionText = params.rejectedResources
    .flatMap((resource) => resource.rejectionReasons)
    .join(' ')
    .toLowerCase();
  const target = normalize(`${params.targetOutcome} ${params.taskFamily}`);
  if (/authority|approval|operator/.test(rejectionText)) return 'authority_gap';
  if (/credential|linked account|access/.test(rejectionText)) {
    return 'credential_or_access_gap';
  }
  if (
    /provider/.test(target) ||
    params.rankedCandidates.some(
      (candidate) => candidate.resource.kind === 'provider',
    )
  ) {
    return 'provider_gap';
  }
  if (/code|coding|repository|implement|adapter|build|test/.test(target)) {
    return 'implementation_gap';
  }
  if (
    /integration|calendar|bluebubbles|telegram|alexa/.test(target) ||
    params.rankedCandidates.some((candidate) =>
      ['agent_os_tool', 'openclaw_tool'].includes(candidate.resource.kind),
    )
  ) {
    return 'integration_gap';
  }
  if (
    /workflow|routine|skill|playbook/.test(target) ||
    params.rankedCandidates.some(
      (candidate) => candidate.resource.kind === 'skill_playbook',
    )
  ) {
    return 'workflow_gap';
  }
  if (/tool|command|script/.test(target)) return 'tool_usage_gap';
  if (
    /research|knowledge|source|fact|document/.test(target) ||
    params.rankedCandidates.some((candidate) =>
      ['trusted_documentation', 'knowledge_source'].includes(
        candidate.resource.kind,
      ),
    )
  ) {
    return 'knowledge_gap';
  }
  return 'fundamental_or_external_blocker';
}

function nextActionForGap(
  gapKind: CapabilityGapKind,
  selected: RankedCapabilityResource[],
): string {
  if (gapKind === 'known') {
    return `Use the existing ${selected[0]?.resource.displayName || 'resource'} through its normal policy-gated path; the broker does not execute it.`;
  }
  if (gapKind === 'composable') {
    return 'Design a bounded composition from the selected version-pinned resources, then verify every postcondition before execution.';
  }
  const actions: Record<
    Exclude<CapabilityGapKind, 'known' | 'composable'>,
    string
  > = {
    knowledge_gap:
      'Acquire cited factual evidence as untrusted data, then rerun discovery.',
    tool_usage_gap:
      'Add or verify a bounded tool-use playbook before retrying discovery.',
    integration_gap:
      'Verify integration health and a stable policy binding before retrying.',
    workflow_gap:
      'Design a reviewable workflow candidate and deterministic replay; do not execute it yet.',
    implementation_gap:
      'Scope a repository change with tests and owner review; discovery cannot synthesize execution authority.',
    authority_gap:
      'Request the exact missing approval or reduce the requested authority; do not bypass the boundary.',
    credential_or_access_gap:
      'Resolve the named access prerequisite outside the broker, then refresh health evidence.',
    provider_gap:
      'Restore or substitute a provider with fresh health and provenance evidence.',
    fundamental_or_external_blocker:
      'Report the unsupported postconditions honestly and ask for a narrower or externally supplied prerequisite.',
  };
  return actions[gapKind];
}

export function brokerCapabilityResources(
  request: CapabilityBrokerRequest,
): CapabilityResourceBrokerResult {
  const targetOutcome = bounded(request.targetOutcome, 600);
  if (!targetOutcome) {
    throw new Error('Capability broker targetOutcome must be non-empty.');
  }
  const taskFamily =
    bounded(request.taskFamily, 120) || inferTaskFamily(targetOutcome);
  const requestedPostconditions = boundedStringArray(
    request.postconditions?.length ? request.postconditions : [targetOutcome],
    30,
    300,
  );
  if (!requestedPostconditions?.length) {
    throw new Error(
      'Capability broker postconditions must be bounded non-empty strings.',
    );
  }
  const availableInputs = new Set(
    (boundedStringArray(request.availableInputs || [], 100, 180) || []).map(
      normalize,
    ),
  );
  const authorityCeiling = request.authorityCeiling || 'explicit_approval';
  const maxDataEgressClass = request.maxDataEgressClass || 'approved_content';
  const maxRiskLevel = request.maxRiskLevel || 'critical';
  const maxResources = Math.max(1, Math.min(request.maxResources || 4, 8));
  const requiredResourceVersions = request.requiredResourceVersions || {};
  const inventory = resolveInventory(request);
  const envelopes: ResourceEnvelope[] = [
    ...inventory.assistantCapabilities.map((descriptor) =>
      adaptAssistantCapability(descriptor, inventory.reliabilityRollups),
    ),
    ...inventory.skillPlaybooks.map((skill) =>
      adaptSkillPlaybook(
        skill,
        inventory.agentOSToolCards,
        inventory.reliabilityRollups,
      ),
    ),
    ...inventory.agentOSToolCards.map((card) =>
      adaptAgentOSToolCard(card, inventory.reliabilityRollups),
    ),
    ...inventory.additionalResources.map(safeUnknownResource),
  ];
  const sanitizedDocuments: SanitizedExternalCapabilityDocument[] = [];
  for (const document of request.externalDocuments || []) {
    const external = sanitizeExternalDocument(document);
    sanitizedDocuments.push(external.sanitized);
    envelopes.push(external.envelope);
  }
  const idCounts = new Map<string, number>();
  for (const envelope of envelopes) {
    const id = normalize(envelope.resource.resourceId);
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }
  const rankedCandidates: RankedCapabilityResource[] = [];
  const rejectedResources: RejectedCapabilityResource[] = [];
  for (const envelope of envelopes) {
    const duplicate =
      (idCounts.get(normalize(envelope.resource.resourceId)) || 0) > 1;
    const validationReasons = validateResource(envelope.resource, {
      taskFamily,
      postconditions: requestedPostconditions,
      availableInputs,
      authorityCeiling,
      maxDataEgressClass,
      maxRiskLevel,
      requiredResourceVersions,
    });
    const rejectionReasons = Array.from(
      new Set([
        ...envelope.adapterRejections,
        ...(duplicate
          ? ['Resource ID is duplicated in the current inventory.']
          : []),
        ...validationReasons,
      ]),
    );
    if (rejectionReasons.length > 0) {
      rejectedResources.push({
        resourceId:
          bounded(envelope.resource.resourceId, 180) || 'invalid-resource',
        displayName:
          bounded(envelope.resource.displayName, 240) || 'Invalid resource',
        ...(RESOURCE_KINDS.has(envelope.resource.kind)
          ? { kind: envelope.resource.kind }
          : {}),
        rejectionReasons,
      });
      continue;
    }
    rankedCandidates.push(
      rankResource(envelope.resource, taskFamily, requestedPostconditions),
    );
  }
  rankedCandidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.resource.resourceId.localeCompare(right.resource.resourceId),
  );
  rejectedResources.sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  const selectedResources = chooseSmallestSufficientSet(
    rankedCandidates,
    requestedPostconditions,
    maxResources,
  );
  const selectedCoverage = new Set(
    selectedResources.flatMap((candidate) => candidate.coveredPostconditions),
  );
  const missingPostconditions = requestedPostconditions.filter(
    (postcondition) => !selectedCoverage.has(postcondition),
  );
  const fullyCovered =
    selectedResources.length > 0 && missingPostconditions.length === 0;
  const gapKind = classifyCapabilityGap({
    targetOutcome,
    taskFamily,
    fullyCovered,
    selectedResources,
    rankedCandidates,
    rejectedResources,
  });
  return {
    gapKind,
    taskFamily,
    postconditions: requestedPostconditions,
    rankedCandidates,
    selectedResources,
    rejectedResources,
    externalDocuments: sanitizedDocuments,
    missingPostconditions,
    fullyCovered,
    nextAction: nextActionForGap(gapKind, selectedResources),
    inventoryErrors: inventory.errors,
    inventoryCounts: {
      assistantCapabilities: inventory.assistantCapabilities.length,
      skillPlaybooks: inventory.skillPlaybooks.length,
      agentOSToolCards: inventory.agentOSToolCards.length,
      reliabilityRollups: inventory.reliabilityRollups.length,
      additionalResources: inventory.additionalResources.length,
      externalDocuments: sanitizedDocuments.length,
      viableResources: rankedCandidates.length,
      rejectedResources: rejectedResources.length,
    },
  };
}

export function assessCapabilityResourceReuse(params: {
  priorTaskFamily: string;
  currentTaskFamily: string;
  priorResources: CapabilityResourceDescriptor[];
  currentResources: CapabilityResourceDescriptor[];
  currentPostconditions: string[];
}): CapabilityResourceReuseAssessment {
  const reasons: string[] = [];
  const priorTaskFamily = normalize(params.priorTaskFamily);
  const currentTaskFamily = normalize(params.currentTaskFamily);
  if (!priorTaskFamily || priorTaskFamily !== currentTaskFamily) {
    reasons.push(
      'Task family changed materially; semantic reuse is not allowed.',
    );
  }
  const currentById = new Map(
    params.currentResources.map((resource) => [resource.resourceId, resource]),
  );
  const currentIdCounts = new Map<string, number>();
  const priorIdCounts = new Map<string, number>();
  for (const resource of params.currentResources) {
    currentIdCounts.set(
      resource.resourceId,
      (currentIdCounts.get(resource.resourceId) || 0) + 1,
    );
  }
  for (const resource of params.priorResources) {
    priorIdCounts.set(
      resource.resourceId,
      (priorIdCounts.get(resource.resourceId) || 0) + 1,
    );
  }
  for (const [resourceId, count] of currentIdCounts) {
    if (count > 1)
      reasons.push(`Current resource ${resourceId} is duplicated.`);
  }
  for (const [resourceId, count] of priorIdCounts) {
    if (count > 1) reasons.push(`Prior resource ${resourceId} is duplicated.`);
  }
  for (const prior of params.priorResources) {
    const current = currentById.get(prior.resourceId);
    if (!current) {
      reasons.push(`Resource ${prior.resourceId} is no longer present.`);
      continue;
    }
    if (
      !prior.version ||
      !current.version ||
      prior.version !== current.version ||
      /^(unknown|latest|unversioned|invalid)$/i.test(current.version)
    ) {
      reasons.push(`Resource ${prior.resourceId} has version drift.`);
    }
    if (
      !current.available ||
      current.healthState === 'blocked' ||
      current.healthState === 'unknown'
    ) {
      reasons.push(
        `Resource ${prior.resourceId} is not currently healthy and available.`,
      );
    }
    if (
      !current.taskFamilies.some(
        (family) => normalize(family) === currentTaskFamily,
      )
    ) {
      reasons.push(
        `Resource ${prior.resourceId} lacks an exact current task-family binding.`,
      );
    }
  }
  const requestedPostconditions = boundedStringArray(
    params.currentPostconditions,
    30,
    300,
  );
  if (!requestedPostconditions?.length) {
    reasons.push('Current postconditions are missing or malformed.');
  } else {
    const priorCoverage = new Set(
      params.priorResources.flatMap((resource) =>
        coveredPostconditions(resource, requestedPostconditions),
      ),
    );
    for (const postcondition of requestedPostconditions) {
      if (!priorCoverage.has(postcondition)) {
        reasons.push(
          `Prior resources do not cover postcondition: ${postcondition}.`,
        );
      }
    }
  }
  return {
    reusable: reasons.length === 0,
    reasons,
  };
}
