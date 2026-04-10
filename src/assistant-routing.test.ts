import { describe, expect, it } from 'vitest';

import {
  classifyAssistantRequest,
  classifyScheduledTaskRequest,
} from './assistant-routing.js';

describe('assistant request routing', () => {
  it('defaults ordinary conversation to direct assistant handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'Can you summarize the main idea of this article for me?' },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
    expect(policy.builtinTools).toEqual(['Read']);
    expect(policy.builtinTools).not.toContain('Bash');
    expect(policy.builtinTools).not.toContain('Write');
    expect(policy.builtinTools).not.toContain('Edit');
    expect(policy.builtinTools).toContain('Read');
    expect(policy.guidance).toContain('lightly witty tone');
    expect(policy.guidance).toContain(
      'Do not use tools unless the user explicitly asks',
    );
  });

  it('keeps playful meaning-of-life asks on the direct assistant route', () => {
    const policy = classifyAssistantRequest([
      { content: "what's the meaning of life?" },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
  });

  it('keeps simple math asks on the direct assistant route', () => {
    const policy = classifyAssistantRequest([{ content: 'what is 46 / 6' }]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
  });

  it('keeps cursor-and-codex capability questions on the direct assistant route', () => {
    const policy = classifyAssistantRequest([
      { content: 'Can you use cursor and codex?' },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
  });

  it('keeps lightweight timezone questions on the direct assistant route', () => {
    const policy = classifyAssistantRequest([
      { content: 'What time is it in Australia?' },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
  });

  it('classifies vibe-check conversation before the generic direct fallback reason', () => {
    const policy = classifyAssistantRequest([{ content: "What's up?" }]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.reason).toContain('greeting_or_vibe_check');
  });

  it('treats BlueBubbles @Andrea vibe checks as ordinary direct conversation', () => {
    const policy = classifyAssistantRequest([{ content: "@Andrea what's up?" }]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.reason).toContain('greeting_or_vibe_check');
  });

  it('classifies plain factoid conversation before the generic direct fallback reason', () => {
    const policy = classifyAssistantRequest([
      { content: "What is Jar Jar Binks' species?" },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.reason).toContain('simple_factoid');
  });

  it('routes reminder and calendar asks to protected assistant handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'Remind me tomorrow at 3pm to call Sam about the calendar.' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__schedule_task');
    expect(policy.mcpTools).not.toContain('mcp__nanoclaw__create_cursor_agent');
    expect(policy.builtinTools).not.toContain('Bash');
    expect(policy.guidance).toContain('use the task MCP tools');
    expect(policy.guidance).toContain(
      'Do not claim a reminder, schedule, or task update is complete',
    );
  });

  it('routes help-me-remember phrasing to protected assistant handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'Can you help me remember to call Brian tomorrow morning?' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__schedule_task');
  });

  it('keeps natural task follow-up drafting prompts on the direct assistant route', () => {
    const policy = classifyAssistantRequest([
      { content: 'Help me follow up on this task' },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
  });

  it('routes operational status and stop asks to control plane handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'List my active cursor jobs and stop the stuck one.' },
    ]);

    expect(policy.route).toBe('control_plane');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__list_cursor_agents');
    expect(policy.mcpTools).not.toContain('mcp__nanoclaw__create_cursor_agent');
    expect(policy.builtinTools).not.toContain('Bash');
  });

  it('routes community skill asks to advanced helper handling', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Search the OpenClaw skill catalog and enable the best calendar skill for this chat.',
      },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__search_openclaw_skills');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__enable_openclaw_skill');
  });

  it('routes explicit engineering requests to code plane handling', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Implement the calendar integration, write tests, and prepare a PR.',
      },
    ]);

    expect(policy.route).toBe('code_plane');
    expect(policy.builtinTools).toContain('Bash');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__create_cursor_agent');
  });

  it('routes engineering work about stop commands to code plane instead of control plane', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Implement the stop command handler for cursor jobs and add tests.',
      },
    ]);

    expect(policy.route).toBe('code_plane');
  });

  it('treats slash control commands as control plane work', () => {
    const policy = classifyAssistantRequest([{ content: '/cursor_jobs' }]);

    expect(policy.route).toBe('control_plane');
  });

  it('treats shopping slash commands as protected assistant work', () => {
    const policy = classifyAssistantRequest([
      { content: '/purchase_request B012345678 OFFER123 2' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__request_amazon_purchase');
  });

  it('treats purchase approval slash commands as control plane work', () => {
    const policy = classifyAssistantRequest([
      { content: '/purchase_approve purchase-abc CODE1234' },
    ]);

    expect(policy.route).toBe('control_plane');
    expect(policy.mcpTools).toContain(
      'mcp__nanoclaw__approve_amazon_purchase_request',
    );
  });

  it('does not let an older heavy request override a later direct user question', () => {
    const policy = classifyAssistantRequest([
      { content: 'Search the OpenClaw catalog and enable a calendar skill.' },
      { content: 'Actually, what is the weather tomorrow in Chicago?' },
    ]);

    expect(policy.route).toBe('protected_assistant');
  });

  it('uses combined context for terse follow-up approvals', () => {
    const policy = classifyAssistantRequest([
      { content: 'Search the OpenClaw catalog and enable a calendar skill.' },
      { content: 'Yes, do it.' },
    ]);

    expect(policy.route).toBe('advanced_helper');
  });

  it('does not inherit older work context for terse standalone phrases when combined context is disabled', () => {
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Implement the stop command handler for cursor jobs and add tests.',
        },
        { content: 'continue' },
      ],
      { allowCombinedContext: false },
    );

    expect(policy.route).toBe('direct_assistant');
  });

  it('does not inherit older work context for do-that phrasing when combined context is disabled', () => {
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Implement the stop command handler for cursor jobs and add tests.',
        },
        { content: 'do that' },
      ],
      { allowCombinedContext: false },
    );

    expect(policy.route).toBe('direct_assistant');
  });

  it('keeps standalone fix-that phrasing out of implicit task continuation when combined context is disabled', () => {
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Implement the stop command handler for cursor jobs and add tests.',
        },
        { content: 'fix that' },
      ],
      { allowCombinedContext: false },
    );

    expect(policy.route).toBe('direct_assistant');
  });

  it('keeps standalone make-it-shorter phrasing out of implicit task continuation when combined context is disabled', () => {
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Implement the stop command handler for cursor jobs and add tests.',
        },
        { content: 'make it shorter' },
      ],
      { allowCombinedContext: false },
    );

    expect(policy.route).toBe('direct_assistant');
  });

  it('defaults scheduled tasks to protected assistant handling when the prompt is otherwise plain', () => {
    const policy = classifyScheduledTaskRequest(
      "Send me a short daily reminder to review tomorrow's plan.",
    );

    expect(policy.route).toBe('protected_assistant');
  });

  it('routes shopping asks to protected assistant handling', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Find me a good ergonomic keyboard on Amazon and prepare an approval request if one looks right.',
      },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__search_amazon_products');
  });
});
