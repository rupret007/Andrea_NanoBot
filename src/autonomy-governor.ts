import type {
  ActionIntentType,
  AutonomyDecision,
  AutonomyLevel,
  ControlPlaneChannel,
} from './types.js';

// ---------------------------------------------------------------------------
// v32 Autonomy Governor
//
// Single policy layer that classifies every operation Andrea could take into
// a bounded autonomy level. Levels never weaken existing approval gates: a
// level-5+ classification always requires explicit approval, and level 7 is
// never allowed regardless of approval. This module is deterministic,
// metadata-only, and stores no raw private content.
// ---------------------------------------------------------------------------

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  0: 'answer_only',
  1: 'draft_or_suggest_only',
  2: 'create_local_pending_action',
  3: 'schedule_internal_reminder_or_review',
  4: 'execute_reversible_local_action',
  5: 'external_action_explicit_approval',
  6: 'high_risk_operator_approval',
  7: 'never_allowed',
};

export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  0: 'Answer or explain only. No state changes.',
  1: 'Draft or suggest only. Nothing leaves Andrea.',
  2: 'Create a local pending action that waits for Jeff.',
  3: 'Schedule an internal reminder or review.',
  4: 'Execute a reversible local action (notes, tags, local archives).',
  5: 'External action (send message, write calendar). Requires explicit same-channel approval.',
  6: 'High-risk action (deploy, restart, credentials, deletion, push). Requires explicit approval plus operator context.',
  7: 'Never allowed (bypassing approval gates, disabling safety, impersonation, mass destruction).',
};

interface AutonomyRule {
  ruleId: string;
  level: AutonomyLevel;
  pattern: RegExp;
  rationale: string;
}

// Ordered highest-severity first; first match wins.
const AUTONOMY_RULES: AutonomyRule[] = [
  {
    ruleId: 'never.bypass_safety',
    level: 7,
    pattern:
      /\b(bypass|disable|skip|remove)\b.*\b(approval|safety|critic|gate|guard)\b|\bimpersonat|\bwipe\b.*\b(all|everything)\b|\bmass[-_ ]?delete\b/i,
    rationale:
      'Operations that weaken approval gates or destroy data wholesale are never allowed.',
  },
  {
    ruleId: 'high_risk.operator',
    level: 6,
    pattern:
      /\b(deploy|push|force[-_ ]?push|restart|stop|kill)\b.*\b(service|prod|host|runtime|daemon)\b|\bgit\s+(push|reset|rebase)\b|\bcredential|\bsecret\b.*\b(change|rotate|write)\b|\bdelete\b.*\b(database|account|repo|history)\b|\bland\b.*\bpatch\b|\bmerge\b.*\b(patch|pr|pull request)\b|\buninstall\b/i,
    rationale:
      'Destructive, deployment, credential, or repo-mutating operations need explicit approval plus operator context.',
  },
  {
    ruleId: 'external.approval',
    level: 5,
    pattern:
      /\bsend\b|\btext\b.*\b(to|him|her|them|candace)\b|\breply\b.*\b(thread|message)\b|\bcalendar\b.*\b(create|write|update|move|delete)\b|\bcreate\b.*\bevent\b|\bpurchase|\border\b.*\b(online|amazon)\b|\bemail\b.*\bsend\b|\bpost\b.*\b(public|online)\b/i,
    rationale:
      'Externally visible actions require explicit same-channel approval before execution.',
  },
  {
    ruleId: 'local.reversible',
    level: 4,
    pattern:
      /\b(save|tag|file|archive)\b.*\b(note|idea|thread|library|local)\b|\bupdate\b.*\b(preference|learned default)\b|\brecord\b.*\b(outcome|episode|review)\b/i,
    rationale:
      'Reversible local writes inside Andrea’s own ledgers are allowed once requested.',
  },
  {
    ruleId: 'internal.schedule',
    level: 3,
    pattern:
      /\b(remind me|reminder|follow[-_ ]?up|check back|review later|nudge me)\b|\bschedule\b.*\b(review|internal|check)\b/i,
    rationale:
      'Internal reminders and reviews stay inside Andrea and are easily cancelled.',
  },
  {
    ruleId: 'local.pending',
    level: 2,
    pattern:
      /\b(queue|stage|prepare|set up)\b.*\b(action|bundle|task)\b|\bpending\b.*\baction\b|\bcreate\b.*\b(action intent|pending)\b/i,
    rationale:
      'Creating a local pending action that waits for Jeff’s decision.',
  },
  {
    ruleId: 'draft.only',
    level: 1,
    pattern:
      /\bdraft\b|\bsuggest\b|\bpropose\b|\bcompose\b|\bwrite\b.*\b(message|reply|text|email)\b.*\b(for me|draft|review)?\b/i,
    rationale: 'Drafting and suggesting never leaves Andrea without approval.',
  },
];

const ACTION_TYPE_MINIMUM_LEVEL: Partial<
  Record<ActionIntentType, AutonomyLevel>
> = {
  message_send: 5,
  calendar_write: 5,
  household: 5,
  patch: 6,
  repair: 4,
  experiment: 2,
  reminder: 3,
  research: 0,
  status: 0,
};

export interface ClassifyAutonomyInput {
  operationSummary: string;
  actionType?: ActionIntentType;
  channel?: ControlPlaneChannel;
}

export function classifyOperationAutonomy(
  input: ClassifyAutonomyInput,
): AutonomyDecision {
  const summary = (input.operationSummary || 'unknown operation')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
  let level: AutonomyLevel = 0;
  let matchedRule = 'default.answer_only';
  let rationale = 'No state-changing pattern detected; answer-only.';

  // Drafting intent dominates external-action verbs ("draft a reply to the
  // thread" is L1, not L5) — unless the text also asks to actually execute.
  const draftish = /\b(draft|suggest|propose|compose)\b/i.test(summary);
  const executish =
    /\b(send|push|deploy|restart|delete|purchase|order|wipe|bypass|disable)\b/i.test(
      summary,
    );

  for (const rule of AUTONOMY_RULES) {
    if (rule.ruleId === 'external.approval' && draftish && !executish) {
      continue;
    }
    if (rule.pattern.test(summary)) {
      level = rule.level;
      matchedRule = rule.ruleId;
      rationale = rule.rationale;
      break;
    }
  }

  const typeMinimum = input.actionType
    ? ACTION_TYPE_MINIMUM_LEVEL[input.actionType]
    : undefined;
  if (typeMinimum !== undefined && typeMinimum > level && level !== 7) {
    level = typeMinimum;
    matchedRule = `action_type.${input.actionType}`;
    rationale = `Action type ${input.actionType} carries a minimum autonomy level of ${typeMinimum}.`;
  }

  return {
    level,
    levelLabel: AUTONOMY_LEVEL_LABELS[level],
    operationSummary: summary,
    matchedRule,
    allowed: level !== 7,
    requiresExplicitApproval: level >= 5,
    requiresOperatorContext: level >= 6,
    rationale,
  };
}

export function approvalRequirementForLevel(
  level: AutonomyLevel,
): 'none' | 'explicit_approval' | 'operator_context' {
  if (level >= 6) return 'operator_context';
  if (level >= 5) return 'explicit_approval';
  return 'none';
}

export function formatAutonomyPolicyReport(): string {
  const lines: string[] = ['*Autonomy Governor Policy*'];
  for (let level = 0 as AutonomyLevel; level <= 7; level++) {
    const l = level as AutonomyLevel;
    lines.push(
      `L${l} ${AUTONOMY_LEVEL_LABELS[l]}: ${AUTONOMY_LEVEL_DESCRIPTIONS[l]}`,
    );
  }
  lines.push('');
  lines.push(
    'Every action intent, tool, repair playbook, patch attempt, and proactive opportunity maps to one level. Levels 5+ always require explicit approval. Level 7 is never executed.',
  );
  return lines.join('\n');
}

export function isAutonomyNaturalRequest(text: string): boolean {
  return /\b(autonomy|what (can|are) you (allowed|permitted) to do|how much can you do (on your own|without me|by yourself)|what do you need (my )?approval for)\b/i.test(
    text || '',
  );
}

export function formatAutonomyNaturalResponse(): string {
  return [
    'Here is how much I can do on my own:',
    '- Answer, explain, draft, and suggest freely.',
    '- Queue pending actions and internal reminders that wait for you.',
    '- Make reversible local updates to my own notes and ledgers.',
    '- Anything external — sending messages, writing to your calendar, purchases — always waits for your explicit approval.',
    '- High-risk operations (deploys, restarts, credentials, deletions) need approval plus the operator surface.',
    '- I never bypass approval gates, and some operations are never allowed at all.',
  ].join('\n');
}
