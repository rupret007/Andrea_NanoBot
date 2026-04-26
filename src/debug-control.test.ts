import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDebugLogsInlineActions,
  buildDebugMutationInlineActions,
  buildDebugStatusInlineActions,
  formatDebugStatus,
  getAssistantExecutionProbeState,
  parseDebugDurationMs,
  readDebugLogs,
  resolveDebugScope,
  resetDebugLevel,
  setAssistantExecutionProbeState,
  setDebugLevel,
} from './debug-control.js';
import {
  _closeDatabase,
  _initTestDatabase,
  insertPilotIssue,
  insertPilotJourneyEvent,
  upsertResponseFeedback,
} from './db.js';
import {
  persistNanoclawHostState,
  writeRuntimeAuditState,
} from './host-control.js';
import { getLogControlConfig, setLogControlConfig } from './logger.js';
import { recordOpenAiGuidedRoutingState } from './openai-guided-routing-state.js';
import { recordOpenAiUsageState } from './openai-usage-state.js';

describe('debug control', () => {
  beforeEach(() => {
    _initTestDatabase();
    setLogControlConfig({
      globalLevel: 'info',
      scopedOverrides: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
    });
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('defaults Telegram-style durations to 60 minutes', () => {
    expect(parseDebugDurationMs(undefined)).toBe(60 * 60 * 1000);
  });

  it('resolves current scope to the active chat', () => {
    expect(resolveDebugScope('current', 'tg:main')).toEqual({
      scopeKey: 'chat:tg:main',
      label: 'chat:tg:main',
    });
  });

  it('persists a scoped verbose override immediately', () => {
    const result = setDebugLevel({
      level: 'verbose',
      scopeToken: 'lane:andrea_runtime',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    expect(result.level).toBe('trace');
    expect(result.resolvedScope.scopeKey).toBe('lane:andrea_runtime');
    expect(
      getLogControlConfig().scopedOverrides['lane:andrea_runtime'],
    ).toBeDefined();
  });

  it('resets all overrides back to normal', () => {
    setDebugLevel({
      level: 'debug',
      scopeToken: 'component:container',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    const result = resetDebugLevel({
      scopeToken: 'all',
      updatedBy: 'test',
      chatJid: 'tg:main',
    });

    expect(result.resetScope).toBe('all');
    expect(getLogControlConfig().globalLevel).toBe('info');
    expect(Object.keys(getLogControlConfig().scopedOverrides)).toEqual([]);
  });

  it('formats debug status with assistant execution probe state', () => {
    setAssistantExecutionProbeState({
      status: 'failed',
      reason: 'initial_output_timeout',
      detail: 'container did not emit first structured result before timeout',
      checkedAt: '2026-03-31T14:00:00.000Z',
    });

    const status = formatDebugStatus();
    expect(status).toContain('Assistant execution probe: failed');
    expect(status).toContain('Host state:');
    expect(getAssistantExecutionProbeState().reason).toBe(
      'initial_output_timeout',
    );
  });

  it('builds actionable debug panel buttons', () => {
    expect(
      buildDebugStatusInlineActions().map((action) => action.label),
    ).toEqual([
      'Refresh',
      'Current Logs',
      'Host Logs',
      'Debug Chat 10m',
      'Reset All',
    ]);
    expect(
      buildDebugMutationInlineActions().map((action) => action.label),
    ).toEqual(['Debug Status', 'Current Logs', 'Host Logs', 'Reset All']);
    expect(buildDebugLogsInlineActions('runtime', 40)[0]).toEqual({
      label: 'Refresh Logs',
      actionId: '/debug-logs runtime 40',
    });
  });
});

describe('debug log tails', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-debug-'));
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    process.chdir(tempDir);
    _initTestDatabase();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    _closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads stderr tails with sanitization', () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      'line1\nOPENAI_API_KEY=sk-secret-token\nline3\n',
    );

    const payload = readDebugLogs({ target: 'stderr', lines: 5 });
    expect(payload.title).toBe('stderr');
    expect(payload.body).toContain('OPENAI_API_KEY=***');
  });

  it('reads host control logs separately', () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'nanoclaw.host.log'),
      '[2026-04-02T00:00:00.000Z] HOST: starting\n',
    );

    const payload = readDebugLogs({ target: 'host', lines: 5 });
    expect(payload.title).toBe('host');
    expect(payload.body).toContain('HOST: starting');
  });

  it('includes host dependency and log path details in debug status', () => {
    persistNanoclawHostState({
      bootId: 'boot-debug',
      phase: 'running_ready',
      pid: process.pid,
      installMode: 'manual_host_control',
      nodePath: 'C:\\node.exe',
      nodeVersion: '22.22.2',
      startedAt: '2026-04-02T00:00:00.000Z',
      readyAt: '2026-04-02T00:00:05.000Z',
      lastError: '',
      dependencyState: 'degraded',
      dependencyError: 'OpenAI key is out of quota/billing.',
      stdoutLogPath: path.join(tempDir, 'logs', 'nanoclaw.log'),
      stderrLogPath: path.join(tempDir, 'logs', 'nanoclaw.error.log'),
      hostLogPath: path.join(tempDir, 'logs', 'nanoclaw.host.log'),
    });

    const status = formatDebugStatus();
    expect(status).toContain('Host dependency: degraded');
    expect(status).toContain(
      'Host dependency detail: OpenAI key is out of quota/billing.',
    );
    expect(status).toContain(
      `Host log path: ${path.join(tempDir, 'logs', 'nanoclaw.host.log')}`,
    );
    expect(status).toContain('BlueBubbles proof:');
    expect(status).toContain('BlueBubbles last inbound chat:');
    expect(status).toContain('BlueBubbles last outbound target kind:');
    expect(status).toContain('BlueBubbles last send error:');
    expect(status).toContain('BlueBubbles send method:');
    expect(status).toContain('BlueBubbles private API available:');
    expect(status).toContain('BlueBubbles last metadata hydration:');
    expect(status).toContain('BlueBubbles attempted target sequence:');
    expect(status).toContain('Google Calendar proof:');
    expect(status).toContain('Outward research proof:');
    expect(status).toContain('Image generation proof:');
    expect(status).toContain('Host health proof:');
    expect(status).toContain('Work cockpit proof:');
  });

  it('shows serving commit drift and missing Alexa live proof in debug status', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'hello\n');
    execFileSync('git', ['init'], {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['branch', '-M', 'main'], {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['add', 'README.md'], {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: tempDir,
      stdio: 'ignore',
    });

    writeRuntimeAuditState({
      updatedAt: '2026-04-07T12:00:00.000Z',
      activeRepoRoot: tempDir,
      activeGitBranch: 'main',
      activeGitCommit: 'dc67cf98c6b2f3d19c6a3c70f3a6c54abe266794',
      activeEntryPath: path.join(tempDir, 'dist', 'index.js'),
      activeEnvPath: path.join(tempDir, '.env'),
      activeStoreDbPath: path.join(tempDir, 'store', 'messages.db'),
      activeRuntimeStateDir: path.join(tempDir, 'data', 'runtime'),
      assistantName: 'Andrea',
      assistantNameSource: 'env',
      registeredMainChatJid: null,
      registeredMainChatName: null,
      registeredMainChatFolder: null,
      registeredMainChatPresentInChats: false,
      latestTelegramChatJid: null,
      latestTelegramChatName: null,
      mainChatAuditWarning: null,
    });

    const status = formatDebugStatus();
    expect(status).toContain('Installed artifact mode:');
    expect(status).toContain('Current launch mode:');
    expect(status).toContain(
      'Serving git commit: dc67cf98c6b2f3d19c6a3c70f3a6c54abe266794',
    );
    expect(status).toContain('Serving commit aligned: no');
    expect(status).toContain('Alexa last signed request: none');
    expect(status).toContain('Alexa proof kind: none');
    expect(status).toContain('Alexa proof freshness: none');
    expect(status).toContain('Alexa confirm command: npm run services:status');
  });

  it('surfaces pilot issue counts and journey truth in debug status', () => {
    insertPilotJourneyEvent({
      eventId: 'journey-1',
      journeyId: 'daily_guidance',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      routeKey: 'daily.loose_ends',
      systemsInvolved: ['daily_companion'],
      outcome: 'success',
      blockerClass: null,
      blockerOwner: 'none',
      degradedPath: null,
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      currentWorkRef: null,
      summaryText: 'Daily guidance proof',
      startedAt: '2026-04-07T17:00:00.000Z',
      completedAt: '2026-04-07T17:00:05.000Z',
      durationMs: 5000,
    });
    insertPilotIssue({
      issueId: 'issue-1',
      createdAt: '2026-04-07T17:05:00.000Z',
      status: 'open',
      issueKind: 'felt_weird',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      journeyEventId: 'journey-1',
      routeKey: 'pilot.capture_issue',
      blockerClass: null,
      blockerOwner: 'none',
      summaryText: 'User marked daily guidance as weird.',
      assistantContextSummary: 'Daily guidance proof',
      linkedRefs: {},
    });
    upsertResponseFeedback({
      feedbackId: 'feedback-1',
      createdAt: '2026-04-07T17:06:00.000Z',
      updatedAt: '2026-04-07T17:08:00.000Z',
      status: 'running',
      classification: 'repo_side_broken',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      platformMessageId: '99',
      userMessageId: '98',
      issueId: 'issue-1',
      routeKey: 'assistant_completion',
      capabilityId: 'research.answer',
      handlerKind: 'assistant_completion',
      responseSource: 'assistant_completion',
      traceReason: 'generic fallback',
      traceNotes: [],
      blockerClass: 'response_feedback_repo_side_broken',
      blockerOwner: 'repo_side',
      originalUserText: "what's the news today",
      assistantReplyText: 'I can help with updates.',
      linkedRefs: {
        responseFeedbackId: 'feedback-1',
      },
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'job-1',
      remediationRuntimePreference: 'codex_local',
      remediationPrompt: 'fix it',
      operatorNote: 'Saved for review.',
    });

    const status = formatDebugStatus();
    expect(status).toContain('Pilot logging enabled: yes');
    expect(status).toContain('Open pilot issues: 1');
    expect(status).toContain(
      'Latest pilot issue: User marked daily guidance as weird.',
    );
    expect(status).toContain('Latest response feedback: running');
    expect(status).toContain(
      'Latest response feedback class: repo_side_broken',
    );
    expect(status).toContain('Latest response feedback summary:');
    expect(status).toContain('Local hotfix pending landing: no');
    expect(status).toContain('Journey daily_guidance: live_proven');
  });

  it('shows local hotfix pending landing when response feedback resolved locally', () => {
    upsertResponseFeedback({
      feedbackId: 'feedback-local',
      createdAt: '2026-04-07T17:06:00.000Z',
      updatedAt: '2026-04-07T17:09:00.000Z',
      status: 'resolved_locally',
      classification: 'repo_side_broken',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      platformMessageId: '101',
      userMessageId: '100',
      issueId: 'issue-2',
      routeKey: 'assistant_completion',
      capabilityId: 'research.answer',
      handlerKind: 'assistant_completion',
      responseSource: 'assistant_completion',
      traceReason: 'generic fallback',
      traceNotes: [],
      blockerClass: 'response_feedback_repo_side_broken',
      blockerOwner: 'repo_side',
      originalUserText: "what's the news today",
      assistantReplyText: 'I can help with updates.',
      linkedRefs: {
        responseFeedbackId: 'feedback-local',
      },
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'job-local',
      remediationRuntimePreference: 'codex_local',
      remediationPrompt: 'fix it',
      operatorNote: 'Local hotfix ready to land.',
    });

    const status = formatDebugStatus();
    expect(status).toContain('Latest response feedback: resolved_locally');
    expect(status).toContain('Local hotfix pending landing: yes');
  });

  it('shows failed remediation truth without implying a landing is pending', () => {
    upsertResponseFeedback({
      feedbackId: 'feedback-failed',
      createdAt: '2026-04-07T17:06:00.000Z',
      updatedAt: '2026-04-07T17:10:00.000Z',
      status: 'failed',
      classification: 'repo_side_rough_edge',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      platformMessageId: '201',
      userMessageId: '200',
      issueId: 'issue-3',
      routeKey: 'weather.answer',
      capabilityId: 'weather.answer',
      handlerKind: 'assistant_completion',
      responseSource: 'assistant_completion',
      traceReason: 'execution issue',
      traceNotes: [],
      blockerClass: 'response_feedback_repo_side_rough_edge',
      blockerOwner: 'repo_side',
      originalUserText: 'What is the weather today in Dallas?',
      assistantReplyText:
        'I hit a temporary execution issue while processing that request.',
      linkedRefs: {
        responseFeedbackId: 'feedback-failed',
      },
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'job-failed',
      remediationRuntimePreference: 'codex_local',
      remediationPrompt: 'fix it',
      operatorNote:
        'The remediation task failed before it produced a clean local hotfix, so it is back in review.',
    });

    const status = formatDebugStatus();
    expect(status).toContain('Latest response feedback: failed');
    expect(status).toContain(
      'Latest response feedback class: repo_side_rough_edge',
    );
    expect(status).toContain('Local hotfix pending landing: no');
  });

  it('shows OpenAI routing and usage tier truth in debug status', () => {
    recordOpenAiGuidedRoutingState({
      at: '2026-04-15T15:00:00.000Z',
      channel: 'telegram',
      source: 'openai_router',
      routeKind: 'assistant_capability',
      capabilityId: 'research.topic',
      confidence: 'high',
      selectedModelTier: 'simple',
      selectedModel: 'gpt-5.4-mini',
      providerMode: 'direct_openai',
    });
    recordOpenAiUsageState({
      at: '2026-04-15T15:00:01.000Z',
      surface: 'research',
      selectedModelTier: 'simple',
      selectedModel: 'gpt-5.4-mini',
      providerMode: 'direct_openai',
      outcome: 'success',
      detail: 'openai_responses',
    });

    const status = formatDebugStatus();
    expect(status).toContain('OpenAI-guided routing model tier: simple');
    expect(status).toContain('OpenAI-guided routing model: gpt-5.4-mini');
    expect(status).toContain(
      'OpenAI-guided routing provider mode: direct_openai',
    );
    expect(status).toContain('Last OpenAI usage surface: research');
    expect(status).toContain('Last OpenAI usage model tier: simple');
    expect(status).toContain('Last OpenAI usage model: gpt-5.4-mini');
    expect(status).toContain('Last OpenAI usage provider mode: direct_openai');
    expect(status).toContain('Last OpenAI usage outcome: success');
    expect(status).toContain('Last OpenAI usage detail: openai_responses');
  });

  it('prefers current chat service lines over stale group container logs', () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'nanoclaw.log'),
      [
        '[10:00:00.000] INFO (1): current chat line',
        '  chatJid: "tg:main"',
        '  component: "assistant"',
      ].join('\n'),
    );

    const groupLogsDir = path.join(tempDir, 'groups', 'main', 'logs');
    fs.mkdirSync(groupLogsDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupLogsDir, 'container-2026-03-31T15-00-00-000Z.log'),
      'stale container timeout log',
    );

    const payload = readDebugLogs({
      target: 'current',
      lines: 20,
      chatJid: 'tg:main',
      groupFolder: 'main',
    });

    expect(payload.title).toBe('current');
    expect(payload.body).toContain('current chat line');
    expect(payload.body).not.toContain('stale container timeout log');
  });
});
