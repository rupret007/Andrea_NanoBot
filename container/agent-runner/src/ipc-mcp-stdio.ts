/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const OPENCLAW_MARKET_CATALOG = path.join(
  '/home/node/.claude/skills/openclaw-market',
  'catalog.json',
);
const OPENCLAW_MARKET_SNAPSHOT = path.join(
  IPC_DIR,
  'current_openclaw_skills.json',
);
const CURSOR_AGENTS_SNAPSHOT = path.join(IPC_DIR, 'current_cursor_agents.json');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const requestRoute = process.env.NANOCLAW_REQUEST_ROUTE || 'code_plane';
const requestReason =
  process.env.NANOCLAW_REQUEST_REASON || 'compatibility fallback';
const allowedMcpTools = (() => {
  const raw = process.env.NANOCLAW_ALLOWED_MCP_TOOLS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === 'string'),
    );
  } catch {
    return null;
  }
})();

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

interface OpenClawCatalogSkill {
  name: string;
  description: string;
  category: string;
  categorySlug: string;
  url: string;
}

interface OpenClawCatalog {
  skills: OpenClawCatalogSkill[];
}

interface EnabledOpenClawSkillSnapshot {
  chatJid: string;
  groupFolder: string;
  groupName: string;
  skillId: string;
  displayName: string;
  sourceUrl: string;
  canonicalClawHubUrl: string | null;
  githubTreeUrl: string;
  installDirName: string;
  enabledAt: string;
  security: {
    virusTotalStatus: string | null;
    openClawStatus: string | null;
    openClawSummary: string | null;
  };
}

interface OpenClawSkillSnapshotFile {
  skills: EnabledOpenClawSkillSnapshot[];
  lastSync: string;
}

interface CursorArtifactSnapshot {
  absolutePath: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  syncedAt: string;
}

interface CursorAgentSnapshot {
  id: string;
  chatJid: string;
  groupFolder: string;
  groupName: string;
  status: string;
  model: string | null;
  promptText: string;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourcePrUrl: string | null;
  targetUrl: string | null;
  targetPrUrl: string | null;
  targetBranchName: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  artifacts: CursorArtifactSnapshot[];
}

interface CursorAgentSnapshotFile {
  agents: CursorAgentSnapshot[];
  lastSync: string;
}

function loadOpenClawCatalog(): OpenClawCatalog {
  if (!fs.existsSync(OPENCLAW_MARKET_CATALOG)) {
    throw new Error('OpenClaw skill catalog is not installed in this session');
  }
  return JSON.parse(
    fs.readFileSync(OPENCLAW_MARKET_CATALOG, 'utf-8'),
  ) as OpenClawCatalog;
}

function loadOpenClawSkillSnapshot(): OpenClawSkillSnapshotFile {
  if (!fs.existsSync(OPENCLAW_MARKET_SNAPSHOT)) {
    return {
      skills: [],
      lastSync: new Date(0).toISOString(),
    };
  }

  return JSON.parse(
    fs.readFileSync(OPENCLAW_MARKET_SNAPSHOT, 'utf-8'),
  ) as OpenClawSkillSnapshotFile;
}

function loadCursorAgentSnapshot(): CursorAgentSnapshotFile {
  if (!fs.existsSync(CURSOR_AGENTS_SNAPSHOT)) {
    return {
      agents: [],
      lastSync: new Date(0).toISOString(),
    };
  }

  return JSON.parse(
    fs.readFileSync(CURSOR_AGENTS_SNAPSHOT, 'utf-8'),
  ) as CursorAgentSnapshotFile;
}

function tokenizeSearchQuery(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function scoreCatalogSkill(
  skill: OpenClawCatalogSkill,
  tokens: string[],
  categoryFilter?: string,
): number {
  if (
    categoryFilter &&
    skill.categorySlug !== categoryFilter &&
    skill.category.toLowerCase() !== categoryFilter
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const haystack =
    `${skill.name} ${skill.description} ${skill.category}`.toLowerCase();
  const skillName = skill.name.toLowerCase();
  let score = 0;
  let matchedTokenCount = 0;

  if (tokens.length === 0) score += 1;

  for (const token of tokens) {
    let matched = false;
    if (skillName === token) {
      score += 120;
      matched = true;
    }
    if (skillName.includes(token)) {
      score += 40;
      matched = true;
    }
    if (haystack.includes(token)) {
      score += 10;
      matched = true;
    }
    if (skill.category.toLowerCase().includes(token)) {
      score += 4;
      matched = true;
    }
    if (matched) matchedTokenCount++;
  }

  if (tokens.length > 0 && matchedTokenCount === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  return score;
}

function resolveTargetJid(targetGroupJid?: string): string {
  return isMain && targetGroupJid ? targetGroupJid : chatJid;
}

function createRouteDeniedResult(toolName: string) {
  const routeLabel = requestRoute.replace(/_/g, ' ');
  return {
    content: [
      {
        type: 'text' as const,
        text: `${toolName} is blocked while handling this ${routeLabel} request. Reason: ${requestReason}. Answer as Andrea directly unless the user explicitly asks for the heavier workflow that needs this tool.`,
      },
    ],
    isError: true,
  };
}

function guardMcpTool(toolName: string) {
  if (!allowedMcpTools) return null;

  const qualifiedName = `mcp__nanoclaw__${toolName}`;
  if (
    allowedMcpTools.has(toolName) ||
    allowedMcpTools.has(qualifiedName) ||
    allowedMcpTools.has('mcp__nanoclaw__*')
  ) {
    return null;
  }

  return createRouteDeniedResult(toolName);
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'search_openclaw_skills',
  `Search NanoClaw's bundled community OpenClaw skill catalog. Use this when the user wants a new capability, integration, workflow, or tool that isn't already built in.

Return a short shortlist first. Only enable a skill after the user clearly chooses one.`,
  {
    query: z
      .string()
      .describe('Keywords describing the capability the user wants'),
    category: z
      .string()
      .optional()
      .describe('Optional category slug or category name to narrow the search'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Maximum number of results to return'),
  },
  async (args) => {
    const denied = guardMcpTool('search_openclaw_skills');
    if (denied) return denied;
    try {
      const catalog = loadOpenClawCatalog();
      const tokens = tokenizeSearchQuery(args.query);
      const categoryFilter = args.category?.trim().toLowerCase();
      const matches = catalog.skills
        .map((skill) => ({
          skill,
          score: scoreCatalogSkill(skill, tokens, categoryFilter),
        }))
        .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.skill.name.localeCompare(b.skill.name);
        })
        .slice(0, args.limit);

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No matching community skills were found.',
            },
          ],
        };
      }

      const formatted = matches
        .map(
          ({ skill }, index) =>
            `${index + 1}. ${skill.name} [${skill.category}]\nURL: ${skill.url}\n${skill.description}`,
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Top community skill matches:\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unable to search the community skill catalog: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'enable_openclaw_skill',
  `Enable a community OpenClaw skill for this chat.

Only enable a skill after the user explicitly approves a specific result. Community skills remain isolated per chat and take effect on the next message.`,
  {
    skill_url: z
      .string()
      .describe(
        'A ClawSkills, ClawHub, or official github.com/openclaw/skills URL',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Install into a different registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('enable_openclaw_skill');
    if (denied) return denied;
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const data = {
      type: 'enable_openclaw_skill',
      skill_url: args.skill_url,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Skill enable requested. NanoClaw will post the result back into the chat, and the skill will be available on the next message if enablement succeeds.',
        },
      ],
    };
  },
);

server.tool(
  'install_openclaw_skill',
  `Compatibility alias for enable_openclaw_skill.

Use this only when an older prompt or skill still asks to "install" a community skill.`,
  {
    skill_url: z
      .string()
      .describe(
        'A ClawSkills, ClawHub, or official github.com/openclaw/skills URL',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Enable into a different registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('install_openclaw_skill');
    if (denied) return denied;
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const data = {
      type: 'install_openclaw_skill',
      skill_url: args.skill_url,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Skill enable requested through the compatibility install alias. NanoClaw will post the result back into the chat.',
        },
      ],
    };
  },
);

server.tool(
  'disable_openclaw_skill',
  `Disable a previously enabled community OpenClaw skill for this chat.

Use list_enabled_openclaw_skills first if you need to see the currently enabled skills.`,
  {
    skill_id_or_url: z
      .string()
      .describe(
        'Either the skill id (owner/slug), installed directory name, or the original registry URL',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Disable from a different registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('disable_openclaw_skill');
    if (denied) return denied;
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const data = {
      type: 'disable_openclaw_skill',
      skill_id_or_url: args.skill_id_or_url,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Skill disable requested. NanoClaw will confirm in the chat once it has been removed for that group.',
        },
      ],
    };
  },
);

server.tool(
  'list_enabled_openclaw_skills',
  'List community OpenClaw skills currently enabled for this chat. Main can optionally inspect another registered group.',
  {
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to inspect. Defaults to the current group.',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('list_enabled_openclaw_skills');
    if (denied) return denied;
    const snapshot = loadOpenClawSkillSnapshot();
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const matches = snapshot.skills.filter(
      (skill) => skill.chatJid === targetJid,
    );

    if (matches.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No community OpenClaw skills are enabled for that chat.',
          },
        ],
      };
    }

    const formatted = matches
      .map((skill, index) => {
        const securityBits = [
          skill.security.openClawStatus
            ? `OpenClaw ${skill.security.openClawStatus}`
            : null,
          skill.security.virusTotalStatus
            ? `VirusTotal ${skill.security.virusTotalStatus}`
            : null,
        ]
          .filter(Boolean)
          .join(', ');

        return `${index + 1}. ${skill.displayName}\nID: ${skill.skillId}\nURL: ${skill.sourceUrl}\nEnabled: ${skill.enabledAt}${securityBits ? `\nSecurity: ${securityBits}` : ''}`;
      })
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Enabled community skills:\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  'list_cursor_agents',
  `List Cursor Cloud agent jobs tracked by NanoClaw.

Use this before followup/stop/sync so you can reference the exact agent id.`,
  {
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to inspect. Defaults to the current group.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum number of agents to return'),
  },
  async (args) => {
    const denied = guardMcpTool('list_cursor_agents');
    if (denied) return denied;
    const snapshot = loadCursorAgentSnapshot();
    const targetJid = resolveTargetJid(args.target_group_jid);
    const matches = snapshot.agents
      .filter((agent) => agent.chatJid === targetJid)
      .slice(0, args.limit);

    if (matches.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No Cursor agents are tracked for that chat yet.',
          },
        ],
      };
    }

    const formatted = matches
      .map((agent, index) => {
        const targetBits = [
          agent.targetUrl ? `URL: ${agent.targetUrl}` : null,
          agent.targetPrUrl ? `PR: ${agent.targetPrUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        return `${index + 1}. ${agent.id} [${agent.status}]
Model: ${agent.model || 'default'}
Prompt: ${agent.promptText.slice(0, 120)}
Updated: ${agent.updatedAt}
Artifacts: ${agent.artifacts.length}${targetBits ? `\n${targetBits}` : ''}`;
      })
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Tracked Cursor agents:\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  'create_cursor_agent',
  `Create a new Cursor Cloud agent job for this chat.

Use this when the user explicitly wants Cursor to work on a coding/repo task asynchronously.`,
  {
    prompt: z.string().describe('The task for the Cursor agent to execute'),
    model: z
      .string()
      .optional()
      .describe(
        'Optional Cursor model id. Defaults to Cursor API default model.',
      ),
    source_repository: z
      .string()
      .optional()
      .describe('Optional Git repository URL'),
    source_ref: z
      .string()
      .optional()
      .describe('Optional Git ref (branch/tag/commit)'),
    source_pr_url: z
      .string()
      .optional()
      .describe(
        'Optional PR URL. Overrides repository/ref when supported by Cursor.',
      ),
    auto_create_pr: z
      .boolean()
      .optional()
      .describe('Whether Cursor should auto-create a pull request'),
    open_as_cursor_github_app: z
      .boolean()
      .optional()
      .describe(
        'If auto_create_pr is true, whether to open PR as the Cursor GitHub app',
      ),
    skip_reviewer_request: z
      .boolean()
      .optional()
      .describe(
        'If auto_create_pr/open_as_cursor_github_app are enabled, skip reviewer request',
      ),
    branch_name: z
      .string()
      .optional()
      .describe('Optional custom branch name for Cursor to use'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Create the agent for another registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('create_cursor_agent');
    if (denied) return denied;
    const data = {
      type: 'create_cursor_agent',
      prompt: args.prompt,
      model: args.model,
      source_repository: args.source_repository,
      source_ref: args.source_ref,
      source_pr_url: args.source_pr_url,
      auto_create_pr: args.auto_create_pr,
      open_as_cursor_github_app: args.open_as_cursor_github_app,
      skip_reviewer_request: args.skip_reviewer_request,
      branch_name: args.branch_name,
      targetJid: resolveTargetJid(args.target_group_jid),
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Cursor agent creation requested. NanoClaw will post the created job id and status into the chat.',
        },
      ],
    };
  },
);

server.tool(
  'followup_cursor_agent',
  'Send a follow-up instruction to an existing Cursor agent job.',
  {
    agent_id: z.string().describe('Cursor agent id (e.g., bc_abc123)'),
    prompt: z.string().describe('Follow-up instruction text'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Target another registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('followup_cursor_agent');
    if (denied) return denied;
    const data = {
      type: 'followup_cursor_agent',
      cursor_agent_id: args.agent_id,
      prompt: args.prompt,
      targetJid: resolveTargetJid(args.target_group_jid),
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Follow-up requested for Cursor agent ${args.agent_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'stop_cursor_agent',
  'Request a graceful stop for a running Cursor agent job.',
  {
    agent_id: z.string().describe('Cursor agent id (e.g., bc_abc123)'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Target another registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('stop_cursor_agent');
    if (denied) return denied;
    const data = {
      type: 'stop_cursor_agent',
      cursor_agent_id: args.agent_id,
      targetJid: resolveTargetJid(args.target_group_jid),
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Stop requested for Cursor agent ${args.agent_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'sync_cursor_agent',
  'Refresh Cursor agent status and artifacts from the Cursor Cloud API.',
  {
    agent_id: z.string().describe('Cursor agent id (e.g., bc_abc123)'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Target another registered group instead of the current one',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('sync_cursor_agent');
    if (denied) return denied;
    const data = {
      type: 'sync_cursor_agent',
      cursor_agent_id: args.agent_id,
      targetJid: resolveTargetJid(args.target_group_jid),
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Sync requested for Cursor agent ${args.agent_id}.`,
        },
      ],
    };
  },
);

server.tool(
  'list_cursor_agent_artifacts',
  'List artifacts currently tracked for a Cursor agent.',
  {
    agent_id: z.string().describe('Cursor agent id (e.g., bc_abc123)'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Inspect artifacts for an agent in another registered group',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('list_cursor_agent_artifacts');
    if (denied) return denied;
    const snapshot = loadCursorAgentSnapshot();
    const targetJid = resolveTargetJid(args.target_group_jid);
    const agent = snapshot.agents.find(
      (row) => row.id === args.agent_id && row.chatJid === targetJid,
    );

    if (!agent) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No tracked Cursor agent with id "${args.agent_id}" was found for that chat.`,
          },
        ],
      };
    }

    if (agent.artifacts.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Cursor agent ${agent.id} has no tracked artifacts yet.`,
          },
        ],
      };
    }

    const formatted = agent.artifacts
      .map(
        (artifact, index) =>
          `${index + 1}. ${artifact.absolutePath}\nSize: ${artifact.sizeBytes ?? 'unknown'} bytes\nUpdated: ${artifact.updatedAt || artifact.syncedAt}`,
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Tracked artifacts for ${agent.id}:\n\n${formatted}`,
        },
      ],
    };
  },
);

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Legacy no-op field. Public messages still appear as Andrea; this value is ignored.',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('send_message');
    if (denied) return denied;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('schedule_task');
    if (denied) return denied;
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const denied = guardMcpTool('list_tasks');
    if (denied) return denied;
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const denied = guardMcpTool('pause_task');
    if (denied) return denied;
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const denied = guardMcpTool('resume_task');
    if (denied) return denied;
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const denied = guardMcpTool('cancel_task');
    if (denied) return denied;
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    const denied = guardMcpTool('update_task');
    if (denied) return denied;
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' && args.schedule_value) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'once' && args.schedule_value) {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid once timestamp: "${args.schedule_value}". Use local time without timezone suffix (example: "2026-02-01T15:30:00").`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid once timestamp: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    // If schedule_value is updated without schedule_type, don't guess.
    // The host side validates using the task's existing schedule_type.
    if (!args.schedule_type && args.schedule_value) {
      // No-op local validation by design.
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    const denied = guardMcpTool('register_group');
    if (denied) return denied;
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
