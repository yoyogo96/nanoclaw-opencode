import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: DatabaseSync;

export function initDb(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'nanoclaw.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  logger.info({ path: dbPath }, 'Database initialized');
}

function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_at TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
      ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron','interval','once')),
      schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'group' CHECK(context_mode IN ('group','isolated')),
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );

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
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      container_config TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Chats ──────────────────────────────────────────────────

export function upsertChat(
  jid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_at, channel, is_group)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       last_message_at = excluded.last_message_at,
       name = COALESCE(excluded.name, chats.name),
       channel = COALESCE(excluded.channel, chats.channel),
       is_group = COALESCE(excluded.is_group, chats.is_group)`,
  ).run(jid, name ?? null, timestamp, channel ?? null, isGroup ? 1 : 0);
}

// ── Messages ───────────────────────────────────────────────

export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages
     (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function getMessagesSince(
  chatJid: string,
  since: string,
): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC`,
    )
    .all(chatJid, since) as unknown as NewMessage[];
}

export function getRecentMessages(
  chatJid: string,
  limit: number,
): NewMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatJid, limit) as unknown as NewMessage[];
}

// ── Scheduled Tasks ────────────────────────────────────────

export function createTask(task: ScheduledTask): void {
  db.prepare(
    `INSERT INTO scheduled_tasks
     (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTask(id: string): ScheduledTask | undefined {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as unknown as ScheduledTask | undefined;
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?`,
    )
    .all(now) as unknown as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<ScheduledTask>,
): void {
  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values = Object.values(updates);
  db.prepare(`UPDATE scheduled_tasks SET ${fields} WHERE id = ?`).run(
    ...values,
    id,
  );
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

// ── Sessions ───────────────────────────────────────────────

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as unknown as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id)
     VALUES (?, ?)
     ON CONFLICT(group_folder) DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, sessionId);
}

// ── Router State ───────────────────────────────────────────

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as unknown as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    `INSERT INTO router_state (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ── Registered Groups ──────────────────────────────────────

export function getRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups ORDER BY added_at ASC')
    .all() as unknown as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    requires_trigger: number;
    is_main: number;
    container_config: string | null;
    added_at: string;
  }>;

  const groups: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    groups[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      requiresTrigger: row.requires_trigger === 1,
      isMain: row.is_main === 1,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
    };
  }
  return groups;
}

export function registerGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT INTO registered_groups
     (jid, name, folder, trigger_pattern, requires_trigger, is_main, container_config, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       folder = excluded.folder,
       trigger_pattern = excluded.trigger_pattern,
       requires_trigger = excluded.requires_trigger,
       is_main = excluded.is_main,
       container_config = excluded.container_config`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.added_at,
  );
}

export function getDb(): DatabaseSync {
  return db;
}
