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
  });

  it('routes reminder and calendar asks to protected assistant handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'Remind me tomorrow at 3pm to call Sam about the calendar.' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__schedule_task');
    expect(policy.mcpTools).not.toContain('mcp__nanoclaw__create_cursor_agent');
  });

  it('routes operational status and stop asks to control plane handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'List my active cursor jobs and stop the stuck one.' },
    ]);

    expect(policy.route).toBe('control_plane');
    expect(policy.mcpTools).toContain('mcp__nanoclaw__list_cursor_agents');
    expect(policy.mcpTools).not.toContain('mcp__nanoclaw__create_cursor_agent');
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

  it('defaults scheduled tasks to protected assistant handling when the prompt is otherwise plain', () => {
    const policy = classifyScheduledTaskRequest(
      'Send me a short daily reminder to review tomorrow’s plan.',
    );

    expect(policy.route).toBe('protected_assistant');
  });
});
