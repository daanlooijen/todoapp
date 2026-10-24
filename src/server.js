import path from 'node:path';
import express from 'express';
import { AIError, aiStatus, breakdown, capture, planDay } from './ai.js';
import { backupStatus, runBackup, scheduleBackups } from './backup.js';
import { DATA_DIR, HOST, PORT, ROOT } from './config.js';
import { openDb } from './db.js';
import { COLORS, NotFoundError, Store, ValidationError } from './store.js';
import { parseQuickAdd } from './shared/quickadd.js';

const db = openDb();
const store = new Store(db);
const app = express();
app.disable('x-powered-by');

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

app.use((req, res, next) => {
  // DNS rebinding defense: a malicious site can point its own domain at 127.0.0.1 and then
  // talk to this server "same-origin". Such requests carry that domain in Host, so reject them.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(421).send('Unknown host');

  // CSRF defense: browsers attach Origin to cross-site writes. Only this app's own pages may change data.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Cross-origin request blocked' });
    // Requiring JSON forces a CORS preflight for any cross-site attempt, which this server never approves.
    if (req.headers['content-length'] !== '0' && req.headers['content-length'] && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON' });
    }
  }

  // Strict CSP: scripts and styles only from this server, so injected markup in a task title can't execute.
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'src', 'shared')));

const api = express.Router();
const q = (req) => req.query;

api.get('/bootstrap', (req, res) => {
  res.json({
    projects: store.listProjects(),
    sections: store.listSections(),
    labels: store.listLabels(),
    colors: COLORS,
    ai: aiStatus(),
    data_dir: DATA_DIR,
    backup: backupStatus(),
    counts: store.overview().counts,
    activity_head: store.activityHead(),
  });
});

// Tasks
api.get('/tasks', (req, res) => res.json(store.listTasks(q(req))));
api.get('/tasks/:id', (req, res) => res.json(store.getTask(req.params.id, { withChildren: true })));
api.post('/tasks', (req, res) => res.status(201).json(store.createTask(req.body)));
api.post('/tasks/bulk', (req, res) => res.status(201).json(store.createTasks(req.body?.tasks, req.body?.actor === 'ai' ? 'ai' : 'user')));
api.post('/quick-add', (req, res) => {
  const p = parseQuickAdd(String(req.body?.text ?? ''), { projects: store.listProjects() });
  const task = store.createTask({
    content: p.content, description: p.description ?? undefined, priority: p.priority, project_id: p.project_id ?? undefined,
    labels: p.labels, due_date: p.due_date, due_time: p.due_time, recurrence: p.recurrence,
    ...(req.body?.project_id && !p.project_id ? { project_id: req.body.project_id } : {}),
  });
  res.status(201).json(task);
});
api.patch('/tasks/:id', (req, res) => res.json(store.updateTask(req.params.id, req.body)));
api.post('/tasks/:id/complete', (req, res) => res.json(store.completeTask(req.params.id)));
api.post('/tasks/:id/uncomplete', (req, res) => res.json(store.uncompleteTask(req.params.id)));
api.post('/tasks/:id/restore', (req, res) => res.json(store.restoreTask(req.params.id)));
api.delete('/tasks/:id', (req, res) => { store.deleteTask(req.params.id); res.status(204).end(); });
api.post('/tasks/:id/comments', (req, res) => res.status(201).json(store.addComment(req.params.id, req.body?.body)));
api.delete('/comments/:id', (req, res) => { store.deleteComment(req.params.id); res.status(204).end(); });

// Projects, sections, labels
api.post('/projects', (req, res) => res.status(201).json(store.createProject(req.body)));
api.patch('/projects/:id', (req, res) => res.json(store.updateProject(req.params.id, req.body)));
api.post('/projects/:id/archive', (req, res) => res.json(store.archiveProject(req.params.id, req.body?.archived !== false)));
api.post('/sections', (req, res) => res.status(201).json(store.createSection(req.body)));
api.patch('/sections/:id', (req, res) => res.json(store.updateSection(req.params.id, req.body)));
api.delete('/sections/:id', (req, res) => { store.deleteSection(req.params.id); res.status(204).end(); });
api.patch('/labels/:id', (req, res) => res.json(store.updateLabel(req.params.id, req.body ?? {})));
api.delete('/labels/:id', (req, res) => { store.deleteLabel(req.params.id); res.status(204).end(); });

// Memory, activity, export
api.get('/memory', (req, res) => res.json(store.listMemory()));
api.post('/memory', (req, res) => res.status(201).json(store.addMemory(req.body)));
api.patch('/memory/:id', (req, res) => res.json(store.updateMemory(req.params.id, req.body)));
api.delete('/memory/:id', (req, res) => { store.deleteMemory(req.params.id); res.status(204).end(); });
api.get('/activity', (req, res) => res.json(store.listActivity(q(req))));
api.get('/activity/head', (req, res) => res.json({ id: store.activityHead() }));
api.get('/export', (req, res) => {
  res.set('Content-Disposition', `attachment; filename="taskline-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(store.exportAll());
});
api.post('/backup', async (req, res) => res.json(await runBackup(db)));

// AI
api.post('/ai/capture', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw new ValidationError('text is required');
  if (text.length > 20000) throw new ValidationError('text is too long (max 20,000 characters)');
  res.json({ tasks: await capture(store, text) });
});
api.post('/ai/breakdown/:id', async (req, res) => res.status(201).json(await breakdown(store, req.params.id)));
api.post('/ai/plan', async (req, res) => res.json(await planDay(store)));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Error messages are shown for expected errors only; unexpected ones are logged
// server-side and the browser gets a generic message, so internals don't leak.
app.use((err, req, res, _next) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof AIError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. See the server log for details.' });
});

scheduleBackups(db);

const server = app.listen(PORT, HOST, () => {
  console.log(`Taskline running at http://localhost:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`AI: ${aiStatus().configured ? `on (${aiStatus().model})` : 'off (add ANTHROPIC_API_KEY to .env to enable)'}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Is Taskline already running? Set PORT in .env to use another port.`);
  else console.error(err);
  process.exit(1);
});

// Close the database cleanly on Ctrl+C so the WAL is checkpointed into the main file.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
