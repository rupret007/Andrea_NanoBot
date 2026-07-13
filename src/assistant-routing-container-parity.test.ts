import path from 'path';
import { pathToFileURL } from 'url';

import { describe, expect, it } from 'vitest';

import {
  classifyAssistantRequest,
  normalizeAssistantRequestPolicy,
  type AssistantRequestPolicy,
} from './assistant-routing.js';
import { resolveTrustedSkillControlMode } from './container-runner.js';

interface ContainerPolicyModule {
  normalizeRequestPolicy(
    policy?: AssistantRequestPolicy,
  ): AssistantRequestPolicy;
}

async function loadContainerPolicy(): Promise<ContainerPolicyModule> {
  const moduleUrl = pathToFileURL(
    path.resolve(
      process.cwd(),
      'container',
      'agent-runner',
      'src',
      'request-policy.ts',
    ),
  ).href;
  return (await import(/* @vite-ignore */ moduleUrl)) as ContainerPolicyModule;
}

describe('host and container request-policy parity', () => {
  it('accepts every representative host policy without widening or failing closed', async () => {
    const { normalizeRequestPolicy } = await loadContainerPolicy();
    const prompts = [
      'Hello Andrea',
      'Remind me tomorrow at 3pm to call Sam.',
      'Find an ergonomic keyboard on Amazon.',
      'Open and summarize the attached document.',
      'Search the web for the latest release notes.',
      'Research and compare sources on current battery technology.',
      'List my cursor jobs and stop the stuck one.',
      '@openclaw find a calendar skill',
      'Implement the API handler and add tests.',
    ];

    for (const prompt of prompts) {
      const hostPolicy = classifyAssistantRequest([{ content: prompt }]);
      const containerPolicy = normalizeRequestPolicy(hostPolicy);
      expect(containerPolicy.route, prompt).toBe(hostPolicy.route);
      expect(containerPolicy.builtinTools, prompt).toEqual(
        hostPolicy.builtinTools,
      );
      expect(containerPolicy.mcpTools, prompt).toEqual(hostPolicy.mcpTools);
    }
  });

  it('provides the narrow trusted catalog to the no-shell skill-management policy', () => {
    const policy = classifyAssistantRequest([
      { content: '@openclaw find a calendar skill' },
    ]);

    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toContain('mcp__nanoclaw__search_openclaw_skills');
    expect(
      resolveTrustedSkillControlMode(
        policy.route,
        policy.builtinTools,
        policy.mcpTools,
      ),
    ).toBe('catalog');
  });

  it('still fails closed when a known execution tool is injected into a protected policy', async () => {
    const { normalizeRequestPolicy } = await loadContainerPolicy();
    const protectedPolicy = classifyAssistantRequest([
      { content: 'Remind me tomorrow at 3pm to call Sam.' },
    ]);

    const normalized = normalizeRequestPolicy({
      ...protectedPolicy,
      builtinTools: [...protectedPolicy.builtinTools, 'Bash'],
    });

    expect(normalized.route).toBe('direct_assistant');
    expect(normalized.builtinTools).toEqual([]);
    expect(normalized.mcpTools).toEqual([]);
  });

  it('keeps host and container normalization aligned for tampered policies', async () => {
    const { normalizeRequestPolicy } = await loadContainerPolicy();
    const candidates: AssistantRequestPolicy[] = [
      {
        route: 'direct_assistant',
        reason: 'tampered direct policy',
        builtinTools: ['Read'],
        mcpTools: ['mcp__nanoclaw__schedule_task'],
        guidance: 'untrusted',
      },
      {
        route: 'advanced_helper',
        reason: 'tampered mixed policy',
        builtinTools: ['Bash'],
        mcpTools: ['mcp__nanoclaw__create_cursor_agent'],
        guidance: 'untrusted',
      },
      {
        route: 'protected_assistant',
        reason: 'tampered over-wide policy',
        builtinTools: ['Write'],
        mcpTools: [],
        guidance: 'untrusted',
      },
      {
        route: 'toString',
        reason: 'prototype-key route',
        builtinTools: [],
        mcpTools: [],
        guidance: 'untrusted',
      } as unknown as AssistantRequestPolicy,
      {
        route: '__proto__',
        reason: 'prototype route',
        builtinTools: [],
        mcpTools: [],
        guidance: 'untrusted',
      } as unknown as AssistantRequestPolicy,
    ];

    for (const candidate of candidates) {
      const host = normalizeAssistantRequestPolicy(candidate);
      const container = normalizeRequestPolicy(candidate);
      expect({
        route: host.route,
        builtinTools: host.builtinTools,
        mcpTools: host.mcpTools,
      }).toEqual({
        route: container.route,
        builtinTools: container.builtinTools,
        mcpTools: container.mcpTools,
      });
    }
  });
});
