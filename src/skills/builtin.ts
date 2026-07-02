import { createHash } from 'node:crypto';
import type { Skill, SkillSource, SkillStep } from './types.js';

export const BUILTIN_SKILL_SOURCE: SkillSource = {
  id: 'andrea/builtin-skills',
  name: 'Andrea built-in workflow skills',
  description:
    'Offline fallback workflows that keep slash commands usable before the external skills cache is synced.',
  url: 'builtin://andrea/workflow-skills',
  paths: { skills: [] },
};

interface BuiltinWorkflow {
  name: string;
  description: string;
  tags: string[];
  triggers: string[];
  steps: Omit<SkillStep, 'index'>[];
  rationalizations?: { excuse: string; rebuttal: string }[];
  redFlags?: string[];
  verification?: string[];
}

export function createBuiltinWorkflowSkills(now = Date.now()): Skill[] {
  return WORKFLOWS.map((workflow) => {
    const steps = workflow.steps.map((step, index) => ({
      ...step,
      index: index + 1,
    }));
    const body = [
      `# ${workflow.name}`,
      '',
      workflow.description,
      '',
      ...steps.map(
        (step) =>
          `## Step ${step.index}: ${step.title}\n${step.body}\n\nVerification: ${step.verification ? 'required' : 'not required'}`,
      ),
    ].join('\n');
    return {
      id: `${BUILTIN_SKILL_SOURCE.id}:${workflow.name}`,
      name: workflow.name,
      description: workflow.description,
      sourceId: BUILTIN_SKILL_SOURCE.id,
      sourcePath: `builtin/${workflow.name}/SKILL.md`,
      kind: 'workflow',
      tags: workflow.tags,
      triggers: workflow.triggers,
      steps,
      rationalizations: workflow.rationalizations ?? [],
      redFlags: workflow.redFlags ?? [],
      verification: workflow.verification ?? [],
      body,
      fingerprint: createHash('sha256').update(body).digest('hex'),
      loadedAt: now,
    };
  });
}

const WORKFLOWS: BuiltinWorkflow[] = [
  {
    name: 'spec-driven-development',
    description:
      'Turn a vague request into a concrete implementation spec with acceptance criteria.',
    tags: ['spec', 'planning', 'requirements'],
    triggers: ['spec', 'requirements', 'acceptance criteria', 'design brief'],
    steps: [
      {
        title: 'Extract Intent',
        body: 'Restate the desired outcome, users, constraints, and non-goals. Call out assumptions that materially affect implementation.',
        verification: false,
      },
      {
        title: 'Define Interfaces',
        body: 'Name changed APIs, data contracts, commands, environment variables, files, and operational surfaces.',
        verification: false,
      },
      {
        title: 'Acceptance Criteria',
        body: 'List testable conditions for done, including legacy compatibility, safety, observability, and rollback expectations.',
        verification: true,
      },
    ],
    verification: ['Acceptance criteria are concrete enough to test.'],
  },
  {
    name: 'planning-and-task-breakdown',
    description:
      'Break a complex engineering goal into ordered, dependency-aware implementation steps.',
    tags: ['plan', 'tasks', 'execution'],
    triggers: ['plan', 'break down', 'roadmap', 'sequence'],
    steps: [
      {
        title: 'Map Workstreams',
        body: 'Separate critical-path work from independent sidecar work. Identify owners, files, and expected artifacts.',
        verification: false,
      },
      {
        title: 'Order Dependencies',
        body: 'Sort tasks so state/schema/API changes land before adapters and tests that depend on them.',
        verification: false,
      },
      {
        title: 'Risk Gate',
        body: 'Name the riskiest assumptions and the smallest checks that can invalidate them early.',
        verification: true,
      },
    ],
  },
  {
    name: 'incremental-implementation',
    description:
      'Implement a feature in small, reviewable slices while preserving existing behavior.',
    tags: ['build', 'implementation', 'integration'],
    triggers: ['build', 'implement', 'wire', 'integrate'],
    steps: [
      {
        title: 'Find Existing Pattern',
        body: 'Inspect local modules for the closest existing abstraction, naming style, tests, and error behavior.',
        verification: false,
      },
      {
        title: 'Patch Narrowly',
        body: 'Make the smallest coherent code change that connects the behavior end to end.',
        verification: false,
      },
      {
        title: 'Prove the Slice',
        body: 'Run focused tests or typechecks and report the exact evidence from the verification command.',
        verification: true,
      },
    ],
  },
  {
    name: 'test-driven-development',
    description:
      'Design and run focused tests for new behavior, regressions, and risky integration paths.',
    tags: ['test', 'quality', 'regression'],
    triggers: ['test', 'regression', 'coverage', 'verify'],
    steps: [
      {
        title: 'Choose Test Surface',
        body: 'Pick the lowest-level test that proves the behavior and one higher-level test when integration risk is real.',
        verification: false,
      },
      {
        title: 'Cover Failure Modes',
        body: 'Include denied, missing, malformed, timeout, or fallback paths when they are part of the user-visible contract.',
        verification: false,
      },
      {
        title: 'Run Evidence',
        body: 'Return the commands run and the pass/fail result. If a command cannot run, say why.',
        verification: true,
      },
    ],
  },
  {
    name: 'code-review-and-quality',
    description:
      'Review changes for bugs, logic errors, missing tests, security issues, and operational regressions.',
    tags: ['review', 'quality', 'security'],
    triggers: ['review', 'logic check', 'audit', 'risk'],
    steps: [
      {
        title: 'Read the Diff',
        body: 'Focus on changed behavior first. Ignore unrelated churn unless it affects the request.',
        verification: false,
      },
      {
        title: 'Find Concrete Failures',
        body: 'Prioritize reproducible bugs, broken contracts, missing safety gates, and test gaps over style notes.',
        verification: false,
      },
      {
        title: 'Anchor Findings',
        body: 'Cite file and line references for every actionable finding and include the expected fix.',
        verification: true,
      },
    ],
  },
  {
    name: 'shipping-and-launch',
    description:
      'Prepare a change for rollout with smoke tests, operational checks, rollback notes, and handoff clarity.',
    tags: ['ship', 'release', 'ops'],
    triggers: ['ship', 'launch', 'release', 'rollout', 'deploy'],
    steps: [
      {
        title: 'Gate Inventory',
        body: 'List typecheck, tests, audit, smoke, migration, and manual checks relevant to the release.',
        verification: false,
      },
      {
        title: 'Operational Readiness',
        body: 'Confirm env vars, service manager, logs, backups, state directories, and alerting expectations.',
        verification: false,
      },
      {
        title: 'Rollback and Handoff',
        body: 'Document what to revert, what to monitor, and what remains intentionally untested.',
        verification: true,
      },
    ],
  },
  {
    name: 'code-simplification',
    description:
      'Simplify code while preserving behavior and reducing accidental complexity.',
    tags: ['simplify', 'refactor', 'maintenance'],
    triggers: ['simplify', 'refactor', 'dedupe', 'cleanup'],
    steps: [
      {
        title: 'Preserve Contracts',
        body: 'Identify externally visible behavior, tests, exported APIs, config, and persistence formats that must not change.',
        verification: false,
      },
      {
        title: 'Remove Real Complexity',
        body: 'Prefer deleting duplication, narrowing conditionals, or reusing local helpers over adding new abstractions.',
        verification: false,
      },
      {
        title: 'Regression Proof',
        body: 'Run the smallest tests that prove behavior stayed equivalent.',
        verification: true,
      },
    ],
  },
];
