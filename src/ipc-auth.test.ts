import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import {
  DisabledOpenClawSkill,
  EnabledOpenClawSkill,
} from './openclaw-market.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let enabledSkills: Array<{ groupFolder: string; skillUrl: string }>;
let disabledSkills: Array<{ groupFolder: string; skillIdOrUrl: string }>;
let marketplaceChangedCount: number;
let createdCursorAgents: Array<{ groupFolder: string; chatJid: string }>;
let followedCursorAgents: Array<{ groupFolder: string; agentId: string }>;
let stoppedCursorAgents: Array<{ groupFolder: string; agentId: string }>;
let syncedCursorAgents: Array<{ groupFolder: string; agentId: string }>;
let cursorChangedCount: number;
let sentMessages: Array<{ jid: string; text: string }>;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };
  enabledSkills = [];
  disabledSkills = [];
  marketplaceChangedCount = 0;
  createdCursorAgents = [];
  followedCursorAgents = [];
  stoppedCursorAgents = [];
  syncedCursorAgents = [];
  cursorChangedCount = 0;
  sentMessages = [];

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
    },
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    onMarketplaceChanged: () => {
      marketplaceChangedCount += 1;
    },
    enableOpenClawSkill: async ({ groupFolder, skillUrl }) => {
      enabledSkills.push({ groupFolder, skillUrl });
      return {
        skillId: 'demo/sample',
        owner: 'demo',
        slug: 'sample',
        displayName: 'Sample Skill',
        sourceUrl: skillUrl,
        canonicalClawHubUrl: null,
        githubTreeUrl:
          'https://github.com/openclaw/skills/tree/main/skills/demo/sample',
        cacheDirName: 'openclaw-demo-sample',
        cachePath: `/tmp/cache/demo/sample`,
        manifestPath: `/tmp/cache/demo/sample/.nanoclaw-openclaw-market.json`,
        cachedAt: '2024-01-01T00:00:00.000Z',
        fileCount: 1,
        groupFolder,
        enabledAt: '2024-01-01T00:00:00.000Z',
        enabledPath: `/tmp/${groupFolder}/openclaw-demo-sample`,
        installDirName: 'openclaw-demo-sample',
        security: {
          openClawStatus: 'Benign',
          virusTotalStatus: 'Benign',
          openClawSummary: null,
        },
      } satisfies EnabledOpenClawSkill;
    },
    disableOpenClawSkill: async ({ groupFolder, skillIdOrUrl }) => {
      disabledSkills.push({ groupFolder, skillIdOrUrl });
      return {
        skillId: 'demo/sample',
        owner: 'demo',
        slug: 'sample',
        displayName: 'Sample Skill',
        groupFolder,
        removedPath: `/tmp/${groupFolder}/openclaw-demo-sample`,
        disabledAt: '2024-01-01T00:00:00.000Z',
        installDirName: 'openclaw-demo-sample',
      } satisfies DisabledOpenClawSkill;
    },
    createCursorAgent: async ({ groupFolder, chatJid }) => {
      createdCursorAgents.push({ groupFolder, chatJid });
      return {
        id: 'bc_123',
        groupFolder,
        chatJid,
        status: 'CREATING',
        model: 'default',
        promptText: 'prompt',
        sourceRepository: null,
        sourceRef: null,
        sourcePrUrl: null,
        targetUrl: 'https://cursor.com/agents?id=bc_123',
        targetPrUrl: null,
        targetBranchName: null,
        autoCreatePr: false,
        openAsCursorGithubApp: false,
        skipReviewerRequest: false,
        summary: null,
        createdBy: 'test',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:00.000Z',
        lastSyncedAt: '2026-03-28T00:00:00.000Z',
      };
    },
    followupCursorAgent: async ({ groupFolder, agentId }) => {
      followedCursorAgents.push({ groupFolder, agentId });
      return {
        id: agentId,
        groupFolder,
        chatJid: 'other@g.us',
        status: 'RUNNING',
        model: 'default',
        promptText: 'prompt',
        sourceRepository: null,
        sourceRef: null,
        sourcePrUrl: null,
        targetUrl: null,
        targetPrUrl: null,
        targetBranchName: null,
        autoCreatePr: false,
        openAsCursorGithubApp: false,
        skipReviewerRequest: false,
        summary: null,
        createdBy: 'test',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:00.000Z',
        lastSyncedAt: '2026-03-28T00:00:00.000Z',
      };
    },
    stopCursorAgent: async ({ groupFolder, agentId }) => {
      stoppedCursorAgents.push({ groupFolder, agentId });
      return {
        id: agentId,
        groupFolder,
        chatJid: 'other@g.us',
        status: 'STOPPED',
        model: 'default',
        promptText: 'prompt',
        sourceRepository: null,
        sourceRef: null,
        sourcePrUrl: null,
        targetUrl: null,
        targetPrUrl: null,
        targetBranchName: null,
        autoCreatePr: false,
        openAsCursorGithubApp: false,
        skipReviewerRequest: false,
        summary: null,
        createdBy: 'test',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:00.000Z',
        lastSyncedAt: '2026-03-28T00:00:00.000Z',
      };
    },
    syncCursorAgent: async ({ groupFolder, agentId }) => {
      syncedCursorAgents.push({ groupFolder, agentId });
      return {
        agent: {
          id: agentId,
          groupFolder,
          chatJid: 'other@g.us',
          status: 'FINISHED',
          model: 'default',
          promptText: 'prompt',
          sourceRepository: null,
          sourceRef: null,
          sourcePrUrl: null,
          targetUrl: null,
          targetPrUrl: null,
          targetBranchName: null,
          autoCreatePr: false,
          openAsCursorGithubApp: false,
          skipReviewerRequest: false,
          summary: null,
          createdBy: 'test',
          createdAt: '2026-03-28T00:00:00.000Z',
          updatedAt: '2026-03-28T00:00:00.000Z',
          lastSyncedAt: '2026-03-28T00:00:00.000Z',
        },
        artifacts: [],
      };
    },
    onCursorChanged: () => {
      cursorChangedCount += 1;
    },
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

describe('enable_openclaw_skill authorization', () => {
  it('main group can enable a skill for another group', async () => {
    await processTaskIpc(
      {
        type: 'enable_openclaw_skill',
        skill_url: 'https://clawskills.sh/skills/demo-sample',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(enabledSkills).toEqual([
      {
        groupFolder: 'other-group',
        skillUrl: 'https://clawskills.sh/skills/demo-sample',
      },
    ]);
    expect(marketplaceChangedCount).toBe(1);
  });

  it('non-main group can enable a skill for itself', async () => {
    await processTaskIpc(
      {
        type: 'enable_openclaw_skill',
        skill_url: 'https://clawskills.sh/skills/demo-sample',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(enabledSkills).toEqual([
      {
        groupFolder: 'other-group',
        skillUrl: 'https://clawskills.sh/skills/demo-sample',
      },
    ]);
    expect(marketplaceChangedCount).toBe(1);
  });

  it('non-main group cannot enable a skill for another group', async () => {
    await processTaskIpc(
      {
        type: 'enable_openclaw_skill',
        skill_url: 'https://clawskills.sh/skills/demo-sample',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(enabledSkills).toEqual([]);
    expect(marketplaceChangedCount).toBe(0);
  });

  it('keeps install_openclaw_skill as a compatibility alias', async () => {
    await processTaskIpc(
      {
        type: 'install_openclaw_skill',
        skill_url: 'https://clawskills.sh/skills/demo-sample',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(enabledSkills).toEqual([
      {
        groupFolder: 'other-group',
        skillUrl: 'https://clawskills.sh/skills/demo-sample',
      },
    ]);
    expect(marketplaceChangedCount).toBe(1);
  });
});

describe('disable_openclaw_skill authorization', () => {
  it('main group can disable a skill for another group', async () => {
    await processTaskIpc(
      {
        type: 'disable_openclaw_skill',
        skill_id_or_url: 'demo/sample',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(disabledSkills).toEqual([
      {
        groupFolder: 'other-group',
        skillIdOrUrl: 'demo/sample',
      },
    ]);
    expect(marketplaceChangedCount).toBe(1);
  });

  it('non-main group cannot disable a skill for another group', async () => {
    await processTaskIpc(
      {
        type: 'disable_openclaw_skill',
        skill_id_or_url: 'demo/sample',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(disabledSkills).toEqual([]);
    expect(marketplaceChangedCount).toBe(0);
  });
});

describe('cursor agent authorization', () => {
  it('main group can create cursor agent for another group', async () => {
    await processTaskIpc(
      {
        type: 'create_cursor_agent',
        prompt: 'do work',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(createdCursorAgents).toEqual([
      { groupFolder: 'other-group', chatJid: 'other@g.us' },
    ]);
    expect(cursorChangedCount).toBe(1);
  });

  it('non-main group cannot create cursor agent for another group', async () => {
    await processTaskIpc(
      {
        type: 'create_cursor_agent',
        prompt: 'do work',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(createdCursorAgents).toEqual([]);
    expect(cursorChangedCount).toBe(0);
  });

  it('non-main group can followup/stop/sync own cursor agent', async () => {
    await processTaskIpc(
      {
        type: 'followup_cursor_agent',
        cursor_agent_id: 'bc_123',
        prompt: 'continue',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    await processTaskIpc(
      {
        type: 'stop_cursor_agent',
        cursor_agent_id: 'bc_123',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    await processTaskIpc(
      {
        type: 'sync_cursor_agent',
        cursor_agent_id: 'bc_123',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    expect(followedCursorAgents).toEqual([
      { groupFolder: 'other-group', agentId: 'bc_123' },
    ]);
    expect(stoppedCursorAgents).toEqual([
      { groupFolder: 'other-group', agentId: 'bc_123' },
    ]);
    expect(syncedCursorAgents).toEqual([
      { groupFolder: 'other-group', agentId: 'bc_123' },
    ]);
    expect(cursorChangedCount).toBe(3);
  });
});

describe('user-facing IPC failures', () => {
  it('sanitizes raw helper errors before sending them back to the chat', async () => {
    deps.enableOpenClawSkill = async () => {
      throw new Error(
        '401 unauthorized for https://cursor.example/v1 using token sk-proj-secret',
      );
    };

    await processTaskIpc(
      {
        type: 'enable_openclaw_skill',
        skill_url: 'https://clawskills.sh/skills/demo-sample',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe('other@g.us');
    expect(sentMessages[0].text).toBe(
      "I couldn't enable that community skill. The external integration credentials were rejected.",
    );
    expect(sentMessages[0].text).not.toContain('https://cursor.example/v1');
    expect(sentMessages[0].text).not.toContain('sk-proj-secret');
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});
