import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { assertValidGroupFolder, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  AgentThreadState,
  NewMessage,
  RegisteredGroup,
  RuntimeOrchestrationJob,
  RuntimeOrchestrationJobList,
  ScheduledTask,
  TaskRunLog,
  ListRuntimeJobsRequest,
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
    CREATE TABLE IF NOT EXISTS agent_threads (
      group_folder TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_response_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_threads_updated
      ON agent_threads(updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_orchestration_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      parent_job_id TEXT,
      thread_id TEXT,
      runtime_route TEXT NOT NULL,
      requested_runtime TEXT,
      selected_runtime TEXT,
      status TEXT NOT NULL,
      stop_requested INTEGER DEFAULT 0,
      prompt_preview TEXT NOT NULL,
      latest_output_text TEXT,
      final_output_text TEXT,
      error_text TEXT,
      log_file TEXT,
      source_system TEXT NOT NULL,
      actor_ref TEXT,
      correlation_id TEXT,
      reply_ref TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_created
      ON runtime_orchestration_jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_group_created
      ON runtime_orchestration_jobs(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_thread_created
      ON runtime_orchestration_jobs(thread_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
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

export function getAgentThread(
  groupFolder: string,
): AgentThreadState | undefined {
  const row = db
    .prepare(
      `
        SELECT group_folder, runtime, thread_id, last_response_id, updated_at
        FROM agent_threads
        WHERE group_folder = ?
      `,
    )
    .get(groupFolder) as AgentThreadState | undefined;

  if (row) {
    return row;
  }

  const legacySessionId = getSession(groupFolder);
  if (!legacySessionId) return undefined;

  return {
    group_folder: groupFolder,
    runtime: 'claude_legacy',
    thread_id: legacySessionId,
    last_response_id: null,
    updated_at: '',
  };
}

export function setAgentThread(thread: AgentThreadState): void {
  assertValidGroupFolder(thread.group_folder);
  db.prepare(
    `
      INSERT OR REPLACE INTO agent_threads (
        group_folder,
        runtime,
        thread_id,
        last_response_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    thread.group_folder,
    thread.runtime,
    thread.thread_id,
    thread.last_response_id || null,
    thread.updated_at,
  );
  setSession(thread.group_folder, thread.thread_id);
}

export function getAllAgentThreads(): Record<string, AgentThreadState> {
  const rows = db
    .prepare(
      `
        SELECT group_folder, runtime, thread_id, last_response_id, updated_at
        FROM agent_threads
      `,
    )
    .all() as AgentThreadState[];
  const result: Record<string, AgentThreadState> = {};

  for (const row of rows) {
    result[row.group_folder] = row;
  }

  const legacySessions = getAllSessions();
  for (const [groupFolder, threadId] of Object.entries(legacySessions)) {
    if (result[groupFolder]) continue;
    result[groupFolder] = {
      group_folder: groupFolder,
      runtime: 'claude_legacy',
      thread_id: threadId,
      last_response_id: null,
      updated_at: '',
    };
  }

  return result;
}

interface RuntimeOrchestrationJobRow {
  job_id: string;
  kind: RuntimeOrchestrationJob['kind'];
  status: RuntimeOrchestrationJob['status'];
  stop_requested: number;
  group_folder: string;
  group_jid: string;
  parent_job_id: string | null;
  thread_id: string | null;
  runtime_route: RuntimeOrchestrationJob['runtimeRoute'];
  requested_runtime: RuntimeOrchestrationJob['requestedRuntime'] | null;
  selected_runtime: RuntimeOrchestrationJob['selectedRuntime'] | null;
  prompt_preview: string;
  latest_output_text: string | null;
  final_output_text: string | null;
  error_text: string | null;
  log_file: string | null;
  source_system: string;
  actor_ref: string | null;
  correlation_id: string | null;
  reply_ref: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface RuntimeOrchestrationJobRecord extends RuntimeOrchestrationJob {
  actorRef?: string | null;
}

function mapRuntimeOrchestrationJobRow(
  row: RuntimeOrchestrationJobRow,
): RuntimeOrchestrationJobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    stopRequested: row.stop_requested === 1,
    groupFolder: row.group_folder,
    groupJid: row.group_jid,
    parentJobId: row.parent_job_id,
    threadId: row.thread_id,
    runtimeRoute: row.runtime_route,
    requestedRuntime: row.requested_runtime,
    selectedRuntime: row.selected_runtime,
    promptPreview: row.prompt_preview,
    latestOutputText: row.latest_output_text,
    finalOutputText: row.final_output_text,
    errorText: row.error_text,
    logFile: row.log_file,
    sourceSystem: row.source_system,
    actorRef: row.actor_ref,
    correlationId: row.correlation_id,
    replyRef: row.reply_ref,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export function createRuntimeOrchestrationJob(
  job: RuntimeOrchestrationJobRecord,
): void {
  assertValidGroupFolder(job.groupFolder);
  db.prepare(
    `
      INSERT INTO runtime_orchestration_jobs (
        job_id,
        kind,
        group_folder,
        group_jid,
        parent_job_id,
        thread_id,
        runtime_route,
        requested_runtime,
        selected_runtime,
        status,
        stop_requested,
        prompt_preview,
        latest_output_text,
        final_output_text,
        error_text,
        log_file,
        source_system,
        actor_ref,
        correlation_id,
        reply_ref,
        created_at,
        started_at,
        finished_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    job.jobId,
    job.kind,
    job.groupFolder,
    job.groupJid,
    job.parentJobId || null,
    job.threadId || null,
    job.runtimeRoute,
    job.requestedRuntime || null,
    job.selectedRuntime || null,
    job.status,
    job.stopRequested ? 1 : 0,
    job.promptPreview,
    job.latestOutputText || null,
    job.finalOutputText || null,
    job.errorText || null,
    job.logFile || null,
    job.sourceSystem,
    job.actorRef || null,
    job.correlationId || null,
    job.replyRef || null,
    job.createdAt,
    job.startedAt || null,
    job.finishedAt || null,
    job.updatedAt,
  );
}

export function updateRuntimeOrchestrationJob(
  jobId: string,
  updates: Partial<RuntimeOrchestrationJobRecord>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  const addField = (field: string, value: unknown): void => {
    fields.push(`${field} = ?`);
    values.push(value);
  };

  if (updates.threadId !== undefined) addField('thread_id', updates.threadId);
  if (updates.requestedRuntime !== undefined) {
    addField('requested_runtime', updates.requestedRuntime);
  }
  if (updates.selectedRuntime !== undefined) {
    addField('selected_runtime', updates.selectedRuntime);
  }
  if (updates.status !== undefined) addField('status', updates.status);
  if (updates.stopRequested !== undefined) {
    addField('stop_requested', updates.stopRequested ? 1 : 0);
  }
  if (updates.latestOutputText !== undefined) {
    addField('latest_output_text', updates.latestOutputText);
  }
  if (updates.finalOutputText !== undefined) {
    addField('final_output_text', updates.finalOutputText);
  }
  if (updates.errorText !== undefined)
    addField('error_text', updates.errorText);
  if (updates.logFile !== undefined) addField('log_file', updates.logFile);
  if (updates.correlationId !== undefined) {
    addField('correlation_id', updates.correlationId);
  }
  if (updates.replyRef !== undefined) addField('reply_ref', updates.replyRef);
  if (updates.startedAt !== undefined)
    addField('started_at', updates.startedAt);
  if (updates.finishedAt !== undefined) {
    addField('finished_at', updates.finishedAt);
  }
  if (updates.updatedAt !== undefined)
    addField('updated_at', updates.updatedAt);

  if (fields.length === 0) return;

  values.push(jobId);
  db.prepare(
    `UPDATE runtime_orchestration_jobs SET ${fields.join(', ')} WHERE job_id = ?`,
  ).run(...values);
}

export function getRuntimeOrchestrationJob(
  jobId: string,
): RuntimeOrchestrationJobRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        WHERE job_id = ?
      `,
    )
    .get(jobId) as RuntimeOrchestrationJobRow | undefined;

  return row ? mapRuntimeOrchestrationJobRow(row) : undefined;
}

export function listRuntimeOrchestrationJobs(
  query: ListRuntimeJobsRequest = {},
): RuntimeOrchestrationJobList {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (query.groupFolder) {
    assertValidGroupFolder(query.groupFolder);
    conditions.push('group_folder = ?');
    values.push(query.groupFolder);
  }

  if (query.threadId) {
    conditions.push('thread_id = ?');
    values.push(query.threadId);
  }

  if (query.beforeJobId) {
    const anchor = getRuntimeOrchestrationJob(query.beforeJobId);
    if (anchor) {
      conditions.push('(created_at < ? OR (created_at = ? AND job_id < ?))');
      values.push(anchor.createdAt, anchor.createdAt, anchor.jobId);
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        ${whereClause}
        ORDER BY created_at DESC, job_id DESC
        LIMIT ?
      `,
    )
    .all(...values, limit + 1) as RuntimeOrchestrationJobRow[];

  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const jobs = visibleRows.map(mapRuntimeOrchestrationJobRow);

  return {
    jobs,
    nextBeforeJobId: hasMore ? jobs.at(-1)?.jobId || null : null,
  };
}

export function findLatestRuntimeJobByThread(
  threadId: string,
): RuntimeOrchestrationJobRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        WHERE thread_id = ?
        ORDER BY created_at DESC, job_id DESC
        LIMIT 1
      `,
    )
    .get(threadId) as RuntimeOrchestrationJobRow | undefined;

  return row ? mapRuntimeOrchestrationJobRow(row) : undefined;
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
