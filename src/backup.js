// Daily database snapshots. Runs once at startup and then every 24 hours while the app is running.
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { BACKUP_DIR, BACKUP_KEEP, SMTP } from './config.js';
import { fmtDate } from './shared/dates.js';

let lastResult = { ok: null, at: null, file: null, error: null };
export const backupStatus = () => lastResult;

// This job runs unattended, so failures are emailed (when SMTP is configured) instead
// of only being printed to a terminal nobody is watching.
async function notifyFailure(err) {
  if (!SMTP.host || !SMTP.to) {
    console.error('[backup] Email alerts are off: set SMTP_HOST, SMTP_USER, SMTP_PASS and ALERT_EMAIL_TO in .env to enable them.');
    return;
  }
  try {
    // secure for port 465, STARTTLS required otherwise: the SMTP password never crosses the network in plain text.
    const transport = nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.port === 465,
      requireTLS: SMTP.port !== 465,
      auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
    });
    await transport.sendMail({
      from: SMTP.user || SMTP.to,
      to: SMTP.to,
      subject: `[Taskline] Backup failed: ${err.name}`,
      text: [
        'The scheduled Taskline database backup failed.',
        '',
        `Time: ${new Date().toISOString()}`,
        `Error type: ${err.name}`,
        `Message: ${err.message}`,
        '',
        'Traceback:',
        err.stack || '(none)',
      ].join('\n'),
    });
  } catch (mailErr) {
    console.error('[backup] Could not send failure email:', mailErr.message);
  }
}

export async function runBackup(db) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `taskline-${fmtDate(new Date())}.db`);
    const tmp = `${file}.partial`;
    // SQLite's online backup API copies a consistent snapshot even while the app is writing.
    await backup(db, tmp);
    fs.renameSync(tmp, file);

    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^taskline-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(BACKUP_KEEP);
    for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));

    lastResult = { ok: true, at: new Date().toISOString(), file, error: null };
  } catch (err) {
    lastResult = { ok: false, at: new Date().toISOString(), file: null, error: `${err.name}: ${err.message}` };
    console.error('[backup] Failed:', err);
    await notifyFailure(err);
  }
  return lastResult;
}

export function scheduleBackups(db) {
  runBackup(db);
  const timer = setInterval(() => runBackup(db), 24 * 60 * 60 * 1000);
  timer.unref();
}
