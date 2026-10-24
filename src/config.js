import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Secrets live in .env (git-ignored), never in code, so they can't leak through a commit.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Data lives in the OS's per-user app-data folder, not the project folder, so deleting
// or re-cloning the code can never take your tasks with it.
function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Taskline');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Taskline');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'taskline');
}

export const DATA_DIR = path.resolve(process.env.TASKLINE_DATA_DIR || defaultDataDir());
export const DB_PATH = path.join(DATA_DIR, 'taskline.db');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const BACKUP_KEEP = Number(process.env.TASKLINE_BACKUP_KEEP || 14);

export const PORT = Number(process.env.PORT || 4100);
// Loopback only: the app has no login, so it must not be reachable from other machines on your network.
export const HOST = '127.0.0.1';

export const AI_MODEL = process.env.TASKLINE_AI_MODEL || 'claude-opus-5-5';

// The AI worker writes drafts here, one folder per ticket. It cannot write anywhere else.
export const DRAFTS_DIR = path.resolve(process.env.TASKLINE_DRAFTS_DIR || path.join(os.homedir(), 'Documents', 'Taskline Drafts'));
// Optional folder the AI may READ for context (e.g. your dbt project), never write. Off unless set.
export const REFERENCE_DIR = process.env.TASKLINE_REFERENCE_DIR ? path.resolve(process.env.TASKLINE_REFERENCE_DIR) : null;
export const AGENT_MAX_TURNS = Number(process.env.TASKLINE_AGENT_MAX_TURNS || 40);
export const AGENT_MAX_CONCURRENT = Number(process.env.TASKLINE_AGENT_MAX_CONCURRENT || 2);

export const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  to: process.env.ALERT_EMAIL_TO,
};
