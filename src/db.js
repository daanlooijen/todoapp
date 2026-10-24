import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.js';

// Each entry upgrades the schema by one version. Never edit a shipped migration;
// append a new one, so existing databases upgrade in place without losing data.
const MIGRATIONS = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'slate',
    parent_id TEXT REFERENCES projects(id),
    position REAL NOT NULL DEFAULT 0,
    is_inbox INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL REFERENCES projects(id),
    section_id TEXT REFERENCES sections(id),
    parent_id TEXT REFERENCES tasks(id),
    position REAL NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
    due_date TEXT,
    due_time TEXT,
    recurrence TEXT,
    deadline TEXT,
    duration_min INTEGER,
    completed_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, completed_at, deleted_at);
  CREATE INDEX tasks_due ON tasks(due_date) WHERE completed_at IS NULL AND deleted_at IS NULL;
  CREATE INDEX tasks_parent ON tasks(parent_id);
  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT 'slate'
  );
  CREATE TABLE task_labels (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );
  -- Long-lived facts about the user that the AI should take into account
  -- ("I do deep work in the morning", "Fridays are for admin").
  CREATE TABLE memory (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Append-only history of every change and who made it (user, ai, mcp).
  -- Lets an agent see what happened recently and lets the UI notice outside edits.
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX activity_entity ON activity(entity, entity_id);
  `,
];

export function openDb(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets the web server and the MCP server use the same file at the same time;
  // busy_timeout makes one wait briefly for the other instead of failing.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
