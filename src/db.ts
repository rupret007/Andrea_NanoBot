import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { assertValidGroupFolder, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS community_skills (
      skill_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_clawhub_url TEXT,
      github_tree_url TEXT NOT NULL,
      cache_dir_name TEXT NOT NULL UNIQUE,
      cache_path TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      virus_total_status TEXT,
      openclaw_status TEXT,
      openclaw_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS group_enabled_skills (
      group_folder TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, skill_id),
      FOREIGN KEY (skill_id) REFERENCES community_skills(skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_enabled_skills_group
      ON group_enabled_skills(group_folder, enabled_at);
    CREATE INDEX IF NOT EXISTS idx_group_enabled_skills_skill
      ON group_enabled_skills(skill_id);
    CREATE TABLE IF NOT EXISTS cursor_agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      prompt_text TEXT NOT NULL,
      source_repository TEXT,
      source_ref TEXT,
      source_pr_url TEXT,
      target_url TEXT,
      target_pr_url TEXT,
      target_branch_name TEXT,
      auto_create_pr INTEGER DEFAULT 0,
      open_as_cursor_github_app INTEGER DEFAULT 0,
      skip_reviewer_request INTEGER DEFAULT 0,
      summary TEXT,
      raw_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_group_created
      ON cursor_agents(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_chat_created
      ON cursor_agents(chat_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_status
      ON cursor_agents(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS cursor_agent_artifacts (
      agent_id TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      size_bytes INTEGER,
      updated_at TEXT,
      download_url TEXT,
      download_url_expires_at TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, absolute_path),
      FOREIGN KEY (agent_id) REFERENCES cursor_agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agent_artifacts_agent
      ON cursor_agent_artifacts(agent_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS cursor_agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT,
      summary TEXT,
      webhook_id TEXT,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES cursor_agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agent_events_agent
      ON cursor_agent_events(agent_id, received_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_agent_events_webhook
      ON cursor_agent_events(webhook_id)
      WHERE webhook_id IS NOT NULL;
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

export interface CommunitySkillRecord {
  skill_id: string;
  owner: string;
  slug: string;
  display_name: string;
  source_url: string;
  canonical_clawhub_url: string | null;
  github_tree_url: string;
  cache_dir_name: string;
  cache_path: string;
  manifest_path: string;
  cached_at: string;
  file_count: number;
  virus_total_status: string | null;
  openclaw_status: string | null;
  openclaw_summary: string | null;
}

export interface EnabledCommunitySkillRecord extends CommunitySkillRecord {
  group_folder: string;
  enabled_at: string;
}

function mapCommunitySkillRow(
  row: CommunitySkillRecord | undefined,
): CommunitySkillRecord | undefined {
  return row;
}

export function upsertCommunitySkill(record: CommunitySkillRecord): void {
  db.prepare(
    `
      INSERT INTO community_skills (
        skill_id,
        owner,
        slug,
        display_name,
        source_url,
        canonical_clawhub_url,
        github_tree_url,
        cache_dir_name,
        cache_path,
        manifest_path,
        cached_at,
        file_count,
        virus_total_status,
        openclaw_status,
        openclaw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        owner = excluded.owner,
        slug = excluded.slug,
        display_name = excluded.display_name,
        source_url = excluded.source_url,
        canonical_clawhub_url = excluded.canonical_clawhub_url,
        github_tree_url = excluded.github_tree_url,
        cache_dir_name = excluded.cache_dir_name,
        cache_path = excluded.cache_path,
        manifest_path = excluded.manifest_path,
        cached_at = excluded.cached_at,
        file_count = excluded.file_count,
        virus_total_status = excluded.virus_total_status,
        openclaw_status = excluded.openclaw_status,
        openclaw_summary = excluded.openclaw_summary
    `,
  ).run(
    record.skill_id,
    record.owner,
    record.slug,
    record.display_name,
    record.source_url,
    record.canonical_clawhub_url,
    record.github_tree_url,
    record.cache_dir_name,
    record.cache_path,
    record.manifest_path,
    record.cached_at,
    record.file_count,
    record.virus_total_status,
    record.openclaw_status,
    record.openclaw_summary,
  );
}

export function getCommunitySkillById(
  skillId: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare('SELECT * FROM community_skills WHERE skill_id = ?')
      .get(skillId) as CommunitySkillRecord | undefined,
  );
}

export function getCommunitySkillByUrl(
  url: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare(
        `
          SELECT *
          FROM community_skills
          WHERE source_url = ?
             OR canonical_clawhub_url = ?
             OR github_tree_url = ?
        `,
      )
      .get(url, url, url) as CommunitySkillRecord | undefined,
  );
}

export function getCommunitySkillByCacheDirName(
  cacheDirName: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare('SELECT * FROM community_skills WHERE cache_dir_name = ?')
      .get(cacheDirName) as CommunitySkillRecord | undefined,
  );
}

export function enableCommunitySkillForGroup(
  groupFolder: string,
  skillId: string,
  enabledAt = new Date().toISOString(),
): void {
  assertValidGroupFolder(groupFolder);
  db.prepare(
    `
      INSERT INTO group_enabled_skills (group_folder, skill_id, enabled_at)
      VALUES (?, ?, ?)
      ON CONFLICT(group_folder, skill_id) DO UPDATE SET enabled_at = excluded.enabled_at
    `,
  ).run(groupFolder, skillId, enabledAt);
}

export function disableCommunitySkillForGroup(
  groupFolder: string,
  skillId: string,
): void {
  assertValidGroupFolder(groupFolder);
  db.prepare(
    'DELETE FROM group_enabled_skills WHERE group_folder = ? AND skill_id = ?',
  ).run(groupFolder, skillId);
}

export function listEnabledCommunitySkillsForGroup(
  groupFolder: string,
): EnabledCommunitySkillRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT c.*, g.group_folder, g.enabled_at
        FROM group_enabled_skills g
        INNER JOIN community_skills c ON c.skill_id = g.skill_id
        WHERE g.group_folder = ?
        ORDER BY c.display_name COLLATE NOCASE
      `,
    )
    .all(groupFolder) as EnabledCommunitySkillRecord[];
}

export function listAllEnabledCommunitySkills(): EnabledCommunitySkillRecord[] {
  return db
    .prepare(
      `
        SELECT c.*, g.group_folder, g.enabled_at
        FROM group_enabled_skills g
        INNER JOIN community_skills c ON c.skill_id = g.skill_id
        ORDER BY g.group_folder, c.display_name COLLATE NOCASE
      `,
    )
    .all() as EnabledCommunitySkillRecord[];
}

export interface CursorAgentRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  status: string;
  model: string | null;
  prompt_text: string;
  source_repository: string | null;
  source_ref: string | null;
  source_pr_url: string | null;
  target_url: string | null;
  target_pr_url: string | null;
  target_branch_name: string | null;
  auto_create_pr: number;
  open_as_cursor_github_app: number;
  skip_reviewer_request: number;
  summary: string | null;
  raw_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface CursorAgentArtifactRecord {
  agent_id: string;
  absolute_path: string;
  size_bytes: number | null;
  updated_at: string | null;
  download_url: string | null;
  download_url_expires_at: string | null;
  synced_at: string;
}

export interface CursorAgentEventRecord {
  id: number;
  agent_id: string;
  event_type: string;
  status: string | null;
  summary: string | null;
  webhook_id: string | null;
  payload_json: string;
  received_at: string;
}

export function upsertCursorAgent(record: CursorAgentRecord): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO cursor_agents (
        id,
        group_folder,
        chat_jid,
        status,
        model,
        prompt_text,
        source_repository,
        source_ref,
        source_pr_url,
        target_url,
        target_pr_url,
        target_branch_name,
        auto_create_pr,
        open_as_cursor_github_app,
        skip_reviewer_request,
        summary,
        raw_json,
        created_by,
        created_at,
        updated_at,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        status = excluded.status,
        model = excluded.model,
        prompt_text = excluded.prompt_text,
        source_repository = excluded.source_repository,
        source_ref = excluded.source_ref,
        source_pr_url = excluded.source_pr_url,
        target_url = excluded.target_url,
        target_pr_url = excluded.target_pr_url,
        target_branch_name = excluded.target_branch_name,
        auto_create_pr = excluded.auto_create_pr,
        open_as_cursor_github_app = excluded.open_as_cursor_github_app,
        skip_reviewer_request = excluded.skip_reviewer_request,
        summary = excluded.summary,
        raw_json = excluded.raw_json,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_synced_at = excluded.last_synced_at
    `,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.status,
    record.model,
    record.prompt_text,
    record.source_repository,
    record.source_ref,
    record.source_pr_url,
    record.target_url,
    record.target_pr_url,
    record.target_branch_name,
    record.auto_create_pr,
    record.open_as_cursor_github_app,
    record.skip_reviewer_request,
    record.summary,
    record.raw_json,
    record.created_by,
    record.created_at,
    record.updated_at,
    record.last_synced_at,
  );
}

export function getCursorAgentById(id: string): CursorAgentRecord | undefined {
  return db.prepare('SELECT * FROM cursor_agents WHERE id = ?').get(id) as
    | CursorAgentRecord
    | undefined;
}

export function listCursorAgentsForGroup(
  groupFolder: string,
  limit = 50,
): CursorAgentRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        WHERE group_folder = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(groupFolder, Math.max(1, limit)) as CursorAgentRecord[];
}

export function listCursorAgentsForChat(
  chatJid: string,
  limit = 50,
): CursorAgentRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        WHERE chat_jid = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(chatJid, Math.max(1, limit)) as CursorAgentRecord[];
}

export function listAllCursorAgents(limit = 200): CursorAgentRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(Math.max(1, limit)) as CursorAgentRecord[];
}

export function replaceCursorAgentArtifacts(
  agentId: string,
  artifacts: CursorAgentArtifactRecord[],
): void {
  const tx = db.transaction((records: CursorAgentArtifactRecord[]) => {
    db.prepare('DELETE FROM cursor_agent_artifacts WHERE agent_id = ?').run(
      agentId,
    );

    const insert = db.prepare(
      `
        INSERT INTO cursor_agent_artifacts (
          agent_id,
          absolute_path,
          size_bytes,
          updated_at,
          download_url,
          download_url_expires_at,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const record of records) {
      insert.run(
        record.agent_id,
        record.absolute_path,
        record.size_bytes,
        record.updated_at,
        record.download_url,
        record.download_url_expires_at,
        record.synced_at,
      );
    }
  });

  tx(artifacts);
}

export function listCursorAgentArtifacts(
  agentId: string,
): CursorAgentArtifactRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agent_artifacts
        WHERE agent_id = ?
        ORDER BY updated_at DESC, absolute_path COLLATE NOCASE ASC
      `,
    )
    .all(agentId) as CursorAgentArtifactRecord[];
}

export function recordCursorAgentEvent(
  record: Omit<CursorAgentEventRecord, 'id'>,
): { inserted: boolean } {
  if (record.webhook_id) {
    const existing = db
      .prepare(
        'SELECT id FROM cursor_agent_events WHERE webhook_id = ? LIMIT 1',
      )
      .get(record.webhook_id) as { id: number } | undefined;
    if (existing) return { inserted: false };
  }

  db.prepare(
    `
      INSERT INTO cursor_agent_events (
        agent_id,
        event_type,
        status,
        summary,
        webhook_id,
        payload_json,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.agent_id,
    record.event_type,
    record.status,
    record.summary,
    record.webhook_id,
    record.payload_json,
    record.received_at,
  );

  return { inserted: true };
}

export function listCursorAgentEvents(
  agentId: string,
  limit = 100,
): CursorAgentEventRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agent_events
        WHERE agent_id = ?
        ORDER BY received_at DESC
        LIMIT ?
      `,
    )
    .all(agentId, Math.max(1, limit)) as CursorAgentEventRecord[];
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
