import { describe, expect, it } from 'vitest';

import './channels/index.js';

import {
  classifyAssistantRequest,
  classifyRuntimeJobRequest,
  classifyScheduledTaskRequest,
  maybeBuildOpenClawPresenceReply,
} from './assistant-routing.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';

describe('assistant request routing', () => {
  it('defaults ordinary conversation to direct assistant handling', () => {
    const policy = classifyAssistantRequest([
      { content: 'Can you summarize the main idea of this article for me?' },
    ]);

    expect(policy.route).toBe('direct_assistant');
    expect(policy.mcpTools).toEqual([]);
    expect(policy.builtinTools).toEqual([]);
    expect(policy.builtinTools).not.toContain('Bash');
    expect(policy.builtinTools).not.toContain('Write');
    expect(policy.builtinTools).not.toContain('Edit');
    expect(policy.builtinTools).not.toContain('Read');
    expect(policy.guidance).toContain('lightly witty tone');
    expect(policy.guidance).toContain('This route is tool-free');
  });

  it('keeps private outcome-review inbox asks on the local direct route', () => {
    for (const content of [
      'review recent answers',
      'review my assistant responses',
      'please review latest Andrea outcomes',
      'open review recommendations',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('direct_assistant');
      expect(policy.mcpTools).toEqual([]);
      expect(policy.builtinTools).toEqual([]);
    }
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
    const policy = classifyAssistantRequest([
      { content: "@Andrea what's up?" },
    ]);

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
    expect(policy.builtinTools).toEqual([]);
    expect(policy.builtinTools).not.toContain('Bash');
    expect(policy.guidance).toContain('use the task MCP tools');
    expect(policy.guidance).toContain(
      'Do not claim a reminder, schedule, or task update is complete',
    );
  });

  it('routes explicit text-message sends to the host-owned protected lane without tools', () => {
    for (const content of [
      "Send a text message to Travis Story saying dinner's ready.",
      'Can you text Travis Story and say dinner is ready?',
      'Text Travis Story: Dinner is ready.',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.reason).toContain('external message intent');
      expect(policy.builtinTools).toEqual([]);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('routes the exact BlueBubbles execution wording through the host capability lane', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Have BlueBubbles send Travis Story a message saying hi from Andrea and he smells, and make it funny.',
      },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.reason).toContain('normalized external message intent');
    expect(policy.guidance).not.toContain('This route is tool-free');
  });

  it.each([
    'Hi can you use blue bubbles to send a message back to Candace please. Check my recent text from her and reply from you that yes please if she could pick them up I haven’t had a chance.',
    'Yes reply to 1 Candace saying yes I need her to pick up please.',
    'You can’t send message on blue bubbles on my behalf?',
  ])(
    'keeps the real Telegram BlueBubbles regression in the host capability lane: %s',
    (content) => {
      const policy = classifyAssistantRequest([{ content }]);

      expect(policy.route).toBe('protected_assistant');
      expect(policy.reason).toContain('normalized external message intent');
      expect(policy.builtinTools).toEqual([]);
      expect(policy.mcpTools).toEqual([]);
    },
  );

  it('does not describe a descriptor-only message tool as registered', () => {
    const registry = new RuntimeCapabilityRegistry(
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
    );
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Have BlueBubbles send Travis Story a message saying hi from Andrea.',
        },
      ],
      { capabilityRegistry: registry },
    );

    expect(policy.route).toBe('protected_assistant');
    expect(policy.reason).toContain(
      'through declared host.messages.send.bluebubbles',
    );
    expect(policy.reason).toContain(
      'production surface unavailable in this process',
    );
    expect(policy.reason).not.toContain('through registered ');
  });

  it('describes a composed message surface as registered and exposed', () => {
    const registry = registerProductionRuntimeCapabilitySurfaces(
      new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS),
    );
    const policy = classifyAssistantRequest(
      [
        {
          content:
            'Have BlueBubbles send Travis Story a message saying hi from Andrea.',
        },
      ],
      { capabilityRegistry: registry },
    );

    expect(policy.route).toBe('protected_assistant');
    expect(policy.reason).toContain(
      'through registered/exposed host.messages.send.bluebubbles',
    );
    expect(policy.reason).not.toContain('surface unavailable');
  });

  it('keeps draft wording in the same host lane without changing it into execution', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Draft a funny message to Travis Story saying hi from Andrea and he smells.',
      },
    ]);
    expect(policy.route).toBe('protected_assistant');
    expect(policy.reason).toContain('(draft)');
  });

  it('does not mistake discussion or content-transfer language for an outbound text request', () => {
    for (const content of [
      'Send me the text of the article.',
      'What does this text message mean?',
      'Can you summarize the message and text?',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.reason).not.toContain('external message intent');
    }
  });

  it('keeps the compound fallback research-only while the host owns the calendar draft', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Add to my calendar that I need to meditate tomorrow morning at 8 am and can you look for a good meditation for me please.',
      },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.reason).toContain('calendar-create and research');
    expect(policy.builtinTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
    ]);
    expect(policy.mcpTools).toEqual([]);
    expect(policy.builtinTools).not.toContain('Bash');
  });

  it('routes polite explicit research asks to bounded research tools', () => {
    for (const content of [
      'Can you look for a good meditation for me?',
      'Could you find a source-backed sleep guide?',
      'Would you research current breathing exercises?',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
      ]);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('keeps obvious local lost-object asks off the research tool lane', () => {
    for (const content of [
      'Can you find my keys?',
      'Can you look for my phone?',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('direct_assistant');
      expect(policy.builtinTools).toEqual([]);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('routes natural research-launch wording without widening arbitrary start requests', () => {
    for (const content of [
      'Kick off some research on guided meditation and provide me the results.',
      'Start research on sleep routines.',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toContain('WebSearch');
      expect(policy.builtinTools).not.toContain('Bash');
    }
    expect(
      classifyAssistantRequest([{ content: 'Start a timer for ten minutes.' }])
        .route,
    ).toBe('direct_assistant');
  });

  it('does not treat conjunctions inside calendar titles as a research sidecar', () => {
    const policy = classifyAssistantRequest([
      {
        content: 'Add dinner with Sam and Alex to my calendar tomorrow at 7pm.',
      },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toContain('mcp__nanoclaw__schedule_task');
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
    expect(policy.builtinTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('routes explicit local file inspection to a read-only protected policy', () => {
    const policy = classifyAssistantRequest([
      { content: 'Open and summarize the attached document for me.' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.builtinTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(policy.mcpTools).toEqual([]);
  });

  it('keeps repository and concrete path inspection read-only', () => {
    for (const content of [
      'Review the attached file for typos.',
      'Review this file.',
      'Open and review README.md.',
      'Search the repository for AssistantRequestPolicy.',
      'Find AssistantRequestPolicy in the repo.',
      'Inspect src/container-runner.ts.',
      'Read /tmp/example.txt.',
      'Open package.json.',
      'What is in package.json?',
      'What does README.md say?',
      'What about /tmp/example.txt?',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('combines read-only file and web tools for an explicit mixed lookup', () => {
    const policy = classifyAssistantRequest([
      { content: 'Please check the latest file online.' },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.builtinTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
    ]);
    expect(policy.mcpTools).toEqual([]);
  });

  it('retains write-capable code routing for actual implementation asks', () => {
    const policy = classifyAssistantRequest([
      { content: 'Fix the parser in src/container-runner.ts and add tests.' },
    ]);

    expect(policy.route).toBe('code_plane');
    expect(policy.builtinTools).toContain('Bash');
    expect(policy.builtinTools).toContain('Write');
  });

  it('keeps terse explicit runtime jobs on the tool-bearing lane', () => {
    const policy = classifyRuntimeJobRequest('continue');

    expect(policy.route).toBe('code_plane');
    expect(policy.builtinTools).toContain('Bash');
    expect(policy.mcpTools).toEqual([]);
  });

  it('routes explicit web and URL lookups to web-only protected policies', () => {
    for (const content of [
      'Search the web for the latest release notes.',
      'Please check https://example.com/status and summarize it.',
      'Search for capybaras.',
      'Look up Jeff Story.',
      'Find recent news about OpenAI.',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toEqual(['WebSearch', 'WebFetch']);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('preserves reminder and shopping actions when their payload includes a file or URL', () => {
    for (const content of [
      'Remind me tomorrow to read https://example.com.',
      'Remind me to review README.md tomorrow.',
    ]) {
      const policy = classifyAssistantRequest([{ content }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toEqual([]);
      expect(policy.mcpTools).toContain('mcp__nanoclaw__schedule_task');
    }

    const shopping = classifyAssistantRequest([
      { content: 'Buy this on Amazon: https://amazon.com/dp/example.' },
    ]);
    expect(shopping.route).toBe('protected_assistant');
    expect(shopping.builtinTools).toEqual([]);
    expect(shopping.mcpTools).toContain(
      'mcp__nanoclaw__request_amazon_purchase',
    );
  });

  it('routes explicit research to bounded read and web tools without execution', () => {
    const policy = classifyAssistantRequest([
      {
        content: 'Research and compare sources on current battery technology.',
      },
    ]);

    expect(policy.route).toBe('protected_assistant');
    expect(policy.builtinTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
    ]);
    expect(policy.builtinTools).not.toContain('Bash');
    expect(policy.builtinTools).not.toContain('Write');
    expect(policy.mcpTools).toEqual([]);
  });

  it('routes community skill asks to advanced helper handling', () => {
    const policy = classifyAssistantRequest([
      {
        content:
          'Search the OpenClaw skill catalog and enable the best calendar skill for this chat.',
      },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toEqual(
      expect.arrayContaining([
        'mcp__nanoclaw__search_openclaw_skills',
        'mcp__nanoclaw__enable_openclaw_skill',
      ]),
    );
  });

  it('routes explicit @openclaw addressing to advanced helper handling', () => {
    const policy = classifyAssistantRequest([
      {
        content: '@openclaw find a calendar skill',
      },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.reason).toBe('matched explicit OpenClaw address');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toContain('mcp__nanoclaw__search_openclaw_skills');
    expect(policy.guidance).toContain('speak as OpenClaw');
    expect(policy.guidance).not.toContain('Never present them as a second');
  });

  it('lets @openclaw choose the helper lane even for otherwise protected wording', () => {
    const policy = classifyAssistantRequest([
      {
        content: '@openclaw what is on my calendar tomorrow?',
      },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.builtinTools).toContain('Bash');
    expect(policy.mcpTools).toEqual([]);
  });

  it('answers simple @openclaw presence checks locally as OpenClaw', () => {
    const reply = maybeBuildOpenClawPresenceReply([
      { content: '@openclaw are you there too?' },
    ]);

    expect(reply).toContain('OpenClaw here');
    expect(reply).toContain('@andrea');
    expect(reply).not.toContain('no separate');
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
    expect(policy.mcpTools).toEqual([]);
  });

  it('keeps cursor creation on a no-shell host-action profile', () => {
    const policy = classifyAssistantRequest([
      { content: 'Launch a Cursor agent for this repository task.' },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toEqual(
      expect.arrayContaining([
        'mcp__nanoclaw__list_cursor_agents',
        'mcp__nanoclaw__create_cursor_agent',
      ]),
    );
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

  it('keeps live weather lookup prompts on the protected assistant policy lane', () => {
    for (const prompt of [
      'What is the weather today in Dallas?',
      "What's the forecast for Dallas tomorrow?",
      'Will it rain in Dallas tonight?',
      "What's the temperature in Dallas right now?",
      "What's the weather in Austin this weekend?",
    ]) {
      const policy = classifyAssistantRequest([{ content: prompt }]);
      expect(policy.route).toBe('protected_assistant');
      expect(policy.builtinTools).toEqual(['WebSearch', 'WebFetch']);
      expect(policy.mcpTools).toEqual([]);
    }
  });

  it('uses combined context for terse follow-up approvals', () => {
    const policy = classifyAssistantRequest([
      { content: 'Search the OpenClaw catalog and enable a calendar skill.' },
      { content: 'Yes, do it.' },
    ]);

    expect(policy.route).toBe('advanced_helper');
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toContain('mcp__nanoclaw__enable_openclaw_skill');
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
    expect(policy.builtinTools).toEqual([]);
    expect(policy.mcpTools).toContain('mcp__nanoclaw__search_amazon_products');
  });
});
