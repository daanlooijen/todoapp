// The only module that writes to the database. The web API, the AI features and the
// MCP server all go through here, so validation and the activity log can't be bypassed.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  addDays, firstOccurrence, fmtDate, isValidDate, isValidTime, nextDue, normalizeRecurrence, parseDue,
} from './shared/dates.js';

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export const COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'];
export const ACTORS = ['user', 'ai', 'mcp'];
// Board columns. "done" is not stored here: a task is done when completed_at is set,
// so completion keeps one source of truth (and recurring tasks keep working).
export const STATUSES = ['todo', 'doing'];
const STATUS_NAMES = { todo: 'To do', doing: 'Doing', done: 'Done' };

const newId = () => randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();
const today = () => fmtDate(new Date());

const DateStr = z.string().refine(isValidDate, 'must be a real date as YYYY-MM-DD');
const TimeStr = z.string().refine(isValidTime, 'must be HH:MM (24h)');
const Color = z.enum(COLORS);

const TaskFields = z.object({
  content: z.string().trim().min(1).max(500),
  description: z.string().max(10000),
  project_id: z.string(),
  project: z.string().trim().min(1), // project name, convenient for agents
  section_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  priority: z.number().int().min(1).max(4),
  due: z.string().max(200).nullable(), // natural language, e.g. "next friday 3pm" or "every weekday"
  due_date: DateStr.nullable(),
  due_time: TimeStr.nullable(),
  recurrence: z.string().max(100).nullable(),
  deadline: DateStr.nullable(),
  duration_min: z.number().int().min(1).max(1440).nullable(),
  labels: z.array(z.string().trim().min(1).max(60)).max(20),
  position: z.number(),
  status: z.enum(STATUSES),
}).strict();

const TaskCreate = TaskFields.partial().required({ content: true });
const TaskPatch = TaskFields.partial();

const ProjectFields = z.object({
  name: z.string().trim().min(1).max(120),
  color: Color,
  parent_id: z.string().nullable(),
  is_favorite: z.boolean(),
  position: z.number(),
}).strict();

const SectionFields = z.object({
  project_id: z.string(),
  name: z.string().trim().min(1).max(120),
  position: z.number(),
}).strict();

const MemoryFields = z.object({
  content: z.string().trim().min(1).max(2000),
  category: z.string().trim().min(1).max(40),
}).strict();

function parse(schema, input) {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new ValidationError(msg);
  }
  return r.data;
}

const TASK_SELECT = `
  SELECT t.*, p.name AS project_name, p.color AS project_color, p.is_inbox AS project_is_inbox, s.name AS section_name,
    (SELECT json_group_array(l.name) FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id) AS labels_json,
    (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS subtask_count,
    (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL AND c.completed_at IS NOT NULL) AS subtask_done,
    (SELECT COUNT(*) FROM comments cm WHERE cm.task_id = t.id) AS comment_count
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN sections s ON s.id = t.section_id`;

function rowToTask(r) {
  if (!r) return null;
  const { labels_json, project_is_inbox, ...rest } = r;
  return { ...rest, project_is_inbox: Boolean(project_is_inbox), labels: JSON.parse(labels_json || '[]').sort() };
}

export class Store {
  constructor(db) {
    this.db = db;
    this.ensureInbox();
    this.purgeTrash();
  }

  // ---------- plumbing ----------

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  log(actor, action, entity, entityId, summary, data = null) {
    this.run(
      'INSERT INTO activity (at, actor, action, entity, entity_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(), actor, action, entity, entityId, summary, data ? JSON.stringify(data) : null,
    );
  }

  ensureInbox() {
    if (!this.get('SELECT id FROM projects WHERE is_inbox = 1')) {
      const t = now();
      this.run("INSERT INTO projects (id, name, color, position, is_inbox, created_at, updated_at) VALUES (?, 'Inbox', 'blue', 0, 1, ?, ?)", newId(), t, t);
    }
  }

  inbox() { return this.get('SELECT * FROM projects WHERE is_inbox = 1'); }

  // Deleted tasks stay restorable for 30 days.
  purgeTrash() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    this.run('DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ? AND id NOT IN (SELECT parent_id FROM tasks WHERE parent_id IS NOT NULL AND deleted_at IS NULL)', cutoff);
  }

  // ---------- projects ----------

  listProjects({ includeArchived = false } = {}) {
    return this.all(`
      SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.completed_at IS NULL AND t.deleted_at IS NULL) AS active_count
      FROM projects p ${includeArchived ? '' : 'WHERE p.archived_at IS NULL'}
      ORDER BY p.is_inbox DESC, p.position, p.name`).map((p) => ({ ...p, is_inbox: Boolean(p.is_inbox), is_favorite: Boolean(p.is_favorite) }));
  }

  getProject(id) {
    const p = this.get('SELECT * FROM projects WHERE id = ?', id);
    if (!p) throw new NotFoundError(`Project ${id} not found`);
    return p;
  }

  findProjectByName(name) {
    const p = this.get('SELECT * FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL', name.trim());
    if (!p) {
      const names = this.listProjects().map((x) => x.name).join(', ');
      throw new ValidationError(`No project named "${name}". Existing projects: ${names}`);
    }
    return p;
  }

  createProject(input, actor = 'user') {
    const f = parse(ProjectFields.partial().required({ name: true }), input);
    return this.tx(() => {
      if (f.parent_id) this.getProject(f.parent_id);
      const id = newId();
      const t = now();
      const pos = f.position ?? (this.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM projects').n);
      this.run('INSERT INTO projects (id, name, color, parent_id, position, is_favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, f.name, f.color ?? 'slate', f.parent_id ?? null, pos, f.is_favorite ? 1 : 0, t, t);
      this.log(actor, 'create', 'project', id, `Created project "${f.name}"`);
      return this.getProject(id);
    });
  }

  updateProject(id, input, actor = 'user') {
    const f = parse(ProjectFields.partial(), input);
    return this.tx(() => {
      const p = this.getProject(id);
      if (p.is_inbox && f.name && f.name !== p.name) throw new ValidationError('The Inbox cannot be renamed');
      if (f.parent_id === id) throw new ValidationError('A project cannot be its own parent');
      const next = { ...p, ...f, is_favorite: f.is_favorite === undefined ? p.is_favorite : (f.is_favorite ? 1 : 0) };
      this.run('UPDATE projects SET name = ?, color = ?, parent_id = ?, is_favorite = ?, position = ?, updated_at = ? WHERE id = ?',
        next.name, next.color, next.parent_id ?? null, next.is_favorite, next.position, now(), id);
      this.log(actor, 'update', 'project', id, `Updated project "${next.name}"`, f);
      return this.getProject(id);
    });
  }

  // Projects are archived, never hard-deleted, so their tasks remain recoverable.
  archiveProject(id, archived = true, actor = 'user') {
    return this.tx(() => {
      const p = this.getProject(id);
      if (p.is_inbox) throw new ValidationError('The Inbox cannot be archived');
      this.run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', archived ? now() : null, now(), id);
      this.log(actor, archived ? 'archive' : 'unarchive', 'project', id, `${archived ? 'Archived' : 'Restored'} project "${p.name}"`);
      return this.getProject(id);
    });
  }

  // ---------- sections ----------

  listSections(projectId) {
    return projectId
      ? this.all('SELECT * FROM sections WHERE project_id = ? ORDER BY position, created_at', projectId)
      : this.all('SELECT * FROM sections ORDER BY project_id, position, created_at');
  }

  createSection(input, actor = 'user') {
    const f = parse(SectionFields.partial().required({ project_id: true, name: true }), input);
    return this.tx(() => {
      this.getProject(f.project_id);
      const id = newId();
      const pos = f.position ?? this.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM sections WHERE project_id = ?', f.project_id).n;
      this.run('INSERT INTO sections (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', id, f.project_id, f.name, pos, now());
      this.log(actor, 'create', 'section', id, `Created section "${f.name}"`);
      return this.get('SELECT * FROM sections WHERE id = ?', id);
    });
  }

  updateSection(id, input, actor = 'user') {
    const f = parse(SectionFields.omit({ project_id: true }).partial(), input);
    return this.tx(() => {
      const s = this.get('SELECT * FROM sections WHERE id = ?', id);
      if (!s) throw new NotFoundError(`Section ${id} not found`);
      this.run('UPDATE sections SET name = ?, position = ? WHERE id = ?', f.name ?? s.name, f.position ?? s.position, id);
      this.log(actor, 'update', 'section', id, `Updated section "${f.name ?? s.name}"`);
      return this.get('SELECT * FROM sections WHERE id = ?', id);
    });
  }

  // Deleting a section keeps its tasks; they move to the top of the project.
  deleteSection(id, actor = 'user') {
    return this.tx(() => {
      const s = this.get('SELECT * FROM sections WHERE id = ?', id);
      if (!s) throw new NotFoundError(`Section ${id} not found`);
      this.run('UPDATE tasks SET section_id = NULL WHERE section_id = ?', id);
      this.run('DELETE FROM sections WHERE id = ?', id);
      this.log(actor, 'delete', 'section', id, `Deleted section "${s.name}"`);
    });
  }

  // ---------- labels ----------

  listLabels() {
    return this.all(`
      SELECT l.*, (SELECT COUNT(*) FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
                   WHERE tl.label_id = l.id AND t.completed_at IS NULL AND t.deleted_at IS NULL) AS active_count
      FROM labels l ORDER BY l.name`);
  }

  labelId(name) {
    const clean = name.trim().replace(/^@/, '').toLowerCase();
    const found = this.get('SELECT id FROM labels WHERE name = ?', clean);
    if (found) return found.id;
    const id = newId();
    this.run('INSERT INTO labels (id, name) VALUES (?, ?)', id, clean);
    return id;
  }

  updateLabel(id, { name, color }, actor = 'user') {
    return this.tx(() => {
      const l = this.get('SELECT * FROM labels WHERE id = ?', id);
      if (!l) throw new NotFoundError(`Label ${id} not found`);
      const f = parse(z.object({ name: z.string().trim().min(1).max(60), color: Color }).partial(), { name, color });
      this.run('UPDATE labels SET name = ?, color = ? WHERE id = ?', (f.name ?? l.name).toLowerCase(), f.color ?? l.color, id);
      this.log(actor, 'update', 'label', id, `Updated label "${f.name ?? l.name}"`);
      return this.get('SELECT * FROM labels WHERE id = ?', id);
    });
  }

  deleteLabel(id, actor = 'user') {
    return this.tx(() => {
      const l = this.get('SELECT * FROM labels WHERE id = ?', id);
      if (!l) throw new NotFoundError(`Label ${id} not found`);
      this.run('DELETE FROM labels WHERE id = ?', id);
      this.log(actor, 'delete', 'label', id, `Deleted label "${l.name}"`);
    });
  }

  // ---------- tasks: reading ----------

  getTask(id, { withChildren = false } = {}) {
    const t = rowToTask(this.get(`${TASK_SELECT} WHERE t.id = ?`, id));
    if (!t) throw new NotFoundError(`Task ${id} not found`);
    if (withChildren) {
      t.subtasks = this.all(`${TASK_SELECT} WHERE t.parent_id = ? AND t.deleted_at IS NULL ORDER BY t.completed_at IS NOT NULL, t.position`, id).map(rowToTask);
      t.comments = this.all('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at', id);
    }
    return t;
  }

  // view: inbox | today | upcoming | project | label | search | completed | trash | all
  // done_days: also include tasks completed in the last N days (the board's Done column).
  // status: only open tasks with that status (todo | doing).
  listTasks({ view = 'all', project_id, label, q, days = 14, limit = 500, done_days, status } = {}) {
    const where = [];
    const params = [];
    const doneSince = Number(done_days) > 0 ? new Date(Date.now() - Number(done_days) * 86400000).toISOString() : null;
    // Adds the "not deleted, not completed (or recently completed)" conditions, keeping params in order.
    const open = ({ includeArchived = false } = {}) => {
      where.push(includeArchived ? 't.deleted_at IS NULL' : 't.deleted_at IS NULL AND p.archived_at IS NULL');
      if (doneSince) {
        where.push('(t.completed_at IS NULL OR t.completed_at >= ?)');
        params.push(doneSince);
      } else {
        where.push('t.completed_at IS NULL');
      }
    };
    let order = 't.position';

    switch (view) {
      case 'inbox':
        open();
        where.push('p.is_inbox = 1');
        order = 't.position';
        break;
      case 'today':
        open();
        where.push('t.due_date IS NOT NULL AND t.due_date <= ?');
        params.push(today());
        order = "t.due_date, COALESCE(t.due_time, '99:99'), t.priority, t.position";
        break;
      case 'upcoming':
        open();
        where.push('t.due_date IS NOT NULL AND t.due_date <= ?');
        params.push(fmtDate(addDays(new Date(), days)));
        order = "t.due_date, COALESCE(t.due_time, '99:99'), t.priority, t.position";
        break;
      case 'project':
        if (!project_id) throw new ValidationError('project_id is required for the project view');
        open({ includeArchived: true });
        where.push('t.project_id = ?');
        params.push(project_id);
        break;
      case 'label':
        if (!label) throw new ValidationError('label is required for the label view');
        open();
        where.push('EXISTS (SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id AND l.name = ? COLLATE NOCASE)');
        params.push(label.replace(/^@/, ''));
        order = 't.priority, t.due_date IS NULL, t.due_date, t.position';
        break;
      case 'search':
        if (!q) throw new ValidationError('q is required for search');
        where.push('t.deleted_at IS NULL', "(t.content LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')");
        {
          const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          params.push(like, like);
        }
        order = 't.completed_at IS NOT NULL, t.priority, t.updated_at DESC';
        break;
      case 'completed':
        where.push('t.completed_at IS NOT NULL AND t.deleted_at IS NULL');
        order = 't.completed_at DESC';
        break;
      case 'trash':
        where.push('t.deleted_at IS NOT NULL');
        order = 't.deleted_at DESC';
        break;
      case 'all':
        open();
        order = 'p.position, t.position';
        break;
      default:
        throw new ValidationError(`Unknown view "${view}"`);
    }

    if (status) {
      if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
      where.push('t.completed_at IS NULL AND t.status = ?');
      params.push(status);
    }

    params.push(Math.min(Math.max(Number(limit) || 500, 1), 2000));
    return this.all(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...params).map(rowToTask);
  }

  // ---------- tasks: writing ----------

  // Turns validated input into column values, resolving names and natural-language dates.
  resolveTaskFields(f, existing = null) {
    const out = {};
    for (const k of ['content', 'description', 'section_id', 'priority', 'due_date', 'due_time', 'deadline', 'duration_min', 'position', 'status']) {
      if (f[k] !== undefined) out[k] = f[k];
    }

    if (f.project !== undefined) out.project_id = this.findProjectByName(f.project).id;
    if (f.project_id !== undefined) out.project_id = this.getProject(f.project_id).id;

    if (f.parent_id !== undefined) {
      out.parent_id = f.parent_id;
      if (f.parent_id) {
        const parent = this.getTask(f.parent_id);
        if (existing) {
          const isDescendant = this.get(`
            WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
            SELECT 1 AS hit FROM d WHERE id = ?`, existing.id, f.parent_id);
          if (isDescendant) throw new ValidationError('A task cannot be moved under itself or its own subtask');
        }
        // Subtasks always live in their parent's project and section.
        out.project_id = parent.project_id;
        out.section_id = parent.section_id;
      }
    }

    if (f.due !== undefined) {
      const d = parseDue(f.due);
      if (!d) throw new ValidationError(`Could not understand the due date "${f.due}". Try e.g. "tomorrow 5pm", "next friday", "every monday" or "2026-11-03".`);
      out.due_date = d.date;
      out.due_time = d.time;
      out.recurrence = d.recurrence;
    }
    if (f.recurrence !== undefined) {
      if (f.recurrence === null || f.recurrence === '') out.recurrence = null;
      else {
        out.recurrence = normalizeRecurrence(f.recurrence);
        if (!out.recurrence) throw new ValidationError(`Could not understand the recurrence "${f.recurrence}". Examples: "every day", "every weekday", "every mon,thu", "every 2 weeks", "every month on 15".`);
      }
    }

    if (out.section_id) {
      const s = this.get('SELECT * FROM sections WHERE id = ?', out.section_id);
      const projectId = out.project_id ?? existing?.project_id;
      if (!s || (projectId && s.project_id !== projectId)) throw new ValidationError('section_id does not belong to that project');
      out.project_id = s.project_id;
    }
    // Moving to another project drops a section that belonged to the old one.
    if (existing && out.project_id && out.project_id !== existing.project_id && out.section_id === undefined) out.section_id = null;

    // Clearing the date of a recurring task means "stop repeating" too.
    if (out.due_date === null && f.recurrence === undefined) out.recurrence = null;

    const merged = { ...existing, ...out };
    if (merged.recurrence && !merged.due_date) out.due_date = firstOccurrence(merged.recurrence);
    if (merged.due_time && !(out.due_date ?? merged.due_date)) throw new ValidationError('due_time needs a due_date');
    if (out.due_date === null && existing?.due_time) out.due_time = null;
    return out;
  }

  createTask(input, actor = 'user') {
    return this.tx(() => this.createTaskInTx(input, actor));
  }

  createTasks(inputs, actor = 'user') {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new ValidationError('tasks must be a non-empty array');
    if (inputs.length > 100) throw new ValidationError('At most 100 tasks at once');
    return this.tx(() => inputs.map((i) => this.createTaskInTx(i, actor)));
  }

  createTaskInTx(input, actor) {
    const { subtasks, ...rest } = input ?? {};
    const f = parse(TaskCreate, rest);
    const v = this.resolveTaskFields(f);
    const id = newId();
    const t = now();
    const projectId = v.project_id ?? this.inbox().id;
    const parentId = v.parent_id ?? null;
    const pos = v.position ?? this.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM tasks WHERE project_id = ? AND parent_id IS ?', projectId, parentId).n;
    this.run(`INSERT INTO tasks (id, content, description, project_id, section_id, parent_id, position, priority,
                due_date, due_time, recurrence, deadline, duration_min, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, v.content, v.description ?? '', projectId, v.section_id ?? null, parentId, pos, v.priority ?? 4,
      v.due_date ?? null, v.due_time ?? null, v.recurrence ?? null, v.deadline ?? null, v.duration_min ?? null, t, t);
    for (const name of f.labels ?? []) this.run('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)', id, this.labelId(name));
    this.log(actor, 'create', 'task', id, `Added "${v.content}"`);

    if (Array.isArray(subtasks)) {
      for (const sub of subtasks.slice(0, 50)) {
        const s = typeof sub === 'string' ? { content: sub } : sub;
        this.createTaskInTx({ ...s, parent_id: id }, actor);
      }
    }
    return this.getTask(id);
  }

  updateTask(id, input, actor = 'user') {
    const f = parse(TaskPatch, input);
    return this.tx(() => {
      const existing = this.getTask(id);
      const v = this.resolveTaskFields(f, existing);
      const cols = Object.keys(v);
      if (cols.length) {
        this.run(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c] ?? null), now(), id);
        // Subtasks follow their parent to a new project or section.
        if (v.project_id || 'section_id' in v) {
          const after = this.getTask(id);
          this.run(`WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
                    UPDATE tasks SET project_id = ?, section_id = ? WHERE id IN (SELECT id FROM d)`, id, after.project_id, after.section_id);
        }
      }
      if (f.labels) {
        this.run('DELETE FROM task_labels WHERE task_id = ?', id);
        for (const name of f.labels) this.run('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)', id, this.labelId(name));
      }
      const onlyStatus = Object.keys(f).length === 1 && f.status && f.status !== existing.status;
      this.log(actor, 'update', 'task', id,
        onlyStatus ? `Moved "${existing.content}" to ${STATUS_NAMES[f.status]}` : `Updated "${v.content ?? existing.content}"`,
        { changes: Object.keys(f) });
      return this.getTask(id);
    });
  }

  // Completing a recurring task moves it to its next date (and reopens its subtasks)
  // instead of closing it, the way Todoist does.
  completeTask(id, actor = 'user') {
    return this.tx(() => {
      const t = this.getTask(id);
      if (t.deleted_at) throw new ValidationError('Cannot complete a deleted task');
      if (t.completed_at) return t;
      if (t.recurrence) {
        const next = nextDue(t.recurrence, t.due_date);
        // The next occurrence starts fresh in To do.
        this.run("UPDATE tasks SET due_date = ?, status = 'todo', updated_at = ? WHERE id = ?", next, now(), id);
        this.run('UPDATE tasks SET completed_at = NULL WHERE parent_id = ?', id);
        this.log(actor, 'complete', 'task', id, `Completed "${t.content}" (next: ${next})`, { recurring: true, was_due: t.due_date, next_due: next });
      } else {
        const t2 = now();
        this.run(`WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
                  UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id IN (SELECT id FROM d) AND completed_at IS NULL`, id, t2, t2);
        this.log(actor, 'complete', 'task', id, `Completed "${t.content}"`);
      }
      return this.getTask(id);
    });
  }

  uncompleteTask(id, actor = 'user') {
    return this.tx(() => {
      const t = this.getTask(id);
      // Reopening a subtask also reopens its parents, otherwise it would be hidden.
      this.run(`WITH RECURSIVE a(id) AS (SELECT ? UNION ALL SELECT t.parent_id FROM tasks t JOIN a ON t.id = a.id WHERE t.parent_id IS NOT NULL)
                UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id IN (SELECT id FROM a)`, id, now());
      this.log(actor, 'uncomplete', 'task', id, `Reopened "${t.content}"`);
      return this.getTask(id);
    });
  }

  // Moves a task between board columns. "done" completes it (recurring tasks advance to
  // their next date and land back in To do); leaving "done" reopens it into the new column.
  moveTask(id, status, actor = 'user') {
    if (status === 'done') return this.completeTask(id, actor);
    if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${[...STATUSES, 'done'].join(', ')}`);
    return this.tx(() => {
      const t = this.getTask(id);
      if (t.deleted_at) throw new ValidationError('Cannot move a deleted task');
      if (!t.completed_at && t.status === status) return t;
      const at = now();
      if (t.completed_at) {
        // Reopen it, and its parents, so it doesn't stay hidden under a completed parent.
        this.run(`WITH RECURSIVE a(id) AS (SELECT ? UNION ALL SELECT t.parent_id FROM tasks t JOIN a ON t.id = a.id WHERE t.parent_id IS NOT NULL)
                  UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id IN (SELECT id FROM a)`, id, at);
      }
      this.run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
      this.log(actor, 'move', 'task', id, `Moved "${t.content}" to ${STATUS_NAMES[status]}`, { from: t.completed_at ? 'done' : t.status, to: status });
      return this.getTask(id);
    });
  }

  // Soft delete: the task and its subtasks go to the trash and can be restored for 30 days.
  deleteTask(id, actor = 'user') {
    return this.tx(() => {
      const t = this.getTask(id);
      const at = now();
      this.run(`WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
                UPDATE tasks SET deleted_at = ? WHERE id IN (SELECT id FROM d) AND deleted_at IS NULL`, id, at);
      this.log(actor, 'delete', 'task', id, `Deleted "${t.content}"`);
    });
  }

  restoreTask(id, actor = 'user') {
    return this.tx(() => {
      const t = this.getTask(id);
      if (!t.deleted_at) return t;
      this.run(`WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
                UPDATE tasks SET deleted_at = NULL WHERE id IN (SELECT id FROM d) AND deleted_at = ?`, id, t.deleted_at);
      if (t.parent_id) this.run('UPDATE tasks SET deleted_at = NULL WHERE id = ?', t.parent_id);
      this.log(actor, 'restore', 'task', id, `Restored "${t.content}"`);
      return this.getTask(id);
    });
  }

  // ---------- comments ----------

  addComment(taskId, body, actor = 'user') {
    const text = parse(z.string().trim().min(1).max(10000), body);
    return this.tx(() => {
      const t = this.getTask(taskId);
      const id = newId();
      this.run('INSERT INTO comments (id, task_id, body, author, created_at) VALUES (?, ?, ?, ?, ?)', id, taskId, text, actor, now());
      this.log(actor, 'comment', 'task', taskId, `Commented on "${t.content}"`);
      return this.get('SELECT * FROM comments WHERE id = ?', id);
    });
  }

  deleteComment(id, actor = 'user') {
    return this.tx(() => {
      const c = this.get('SELECT * FROM comments WHERE id = ?', id);
      if (!c) throw new NotFoundError(`Comment ${id} not found`);
      this.run('DELETE FROM comments WHERE id = ?', id);
      this.log(actor, 'delete', 'comment', id, 'Deleted a comment');
    });
  }

  // ---------- memory ----------

  listMemory() {
    return this.all('SELECT * FROM memory ORDER BY category, created_at');
  }

  addMemory(input, actor = 'user') {
    const f = parse(MemoryFields.partial().required({ content: true }), input);
    return this.tx(() => {
      const id = newId();
      const t = now();
      this.run('INSERT INTO memory (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, f.content, f.category ?? 'general', actor, t, t);
      this.log(actor, 'create', 'memory', id, `Remembered: ${f.content.slice(0, 80)}`);
      return this.get('SELECT * FROM memory WHERE id = ?', id);
    });
  }

  updateMemory(id, input, actor = 'user') {
    const f = parse(MemoryFields.partial(), input);
    return this.tx(() => {
      const m = this.get('SELECT * FROM memory WHERE id = ?', id);
      if (!m) throw new NotFoundError(`Memory ${id} not found`);
      this.run('UPDATE memory SET content = ?, category = ?, updated_at = ? WHERE id = ?', f.content ?? m.content, f.category ?? m.category, now(), id);
      this.log(actor, 'update', 'memory', id, `Updated memory: ${(f.content ?? m.content).slice(0, 80)}`);
      return this.get('SELECT * FROM memory WHERE id = ?', id);
    });
  }

  deleteMemory(id, actor = 'user') {
    return this.tx(() => {
      const m = this.get('SELECT * FROM memory WHERE id = ?', id);
      if (!m) throw new NotFoundError(`Memory ${id} not found`);
      this.run('DELETE FROM memory WHERE id = ?', id);
      this.log(actor, 'delete', 'memory', id, `Forgot: ${m.content.slice(0, 80)}`);
    });
  }

  // ---------- activity & overview ----------

  listActivity({ limit = 50, since, entity_id } = {}) {
    const where = [];
    const params = [];
    if (since) { where.push('at >= ?'); params.push(since); }
    if (entity_id) { where.push('entity_id = ?'); params.push(entity_id); }
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    return this.all(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params)
      .map((a) => ({ ...a, data: a.data ? JSON.parse(a.data) : null }));
  }

  activityHead() {
    return this.get('SELECT COALESCE(MAX(id), 0) AS id FROM activity').id;
  }

  // A compact snapshot of the whole system, sized for an AI's context window.
  overview() {
    const d = today();
    const active = 't.completed_at IS NULL AND t.deleted_at IS NULL AND p.archived_at IS NULL';
    const count = (extra, ...p) => this.get(`SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${active} ${extra}`, ...p).n;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    return {
      today: d,
      weekday: new Date().toLocaleDateString('en-GB', { weekday: 'long' }),
      counts: {
        active: count(''),
        overdue: count('AND t.due_date < ?', d),
        due_today: count('AND t.due_date = ?', d),
        doing: count("AND t.status = 'doing'"),
        inbox: count('AND p.is_inbox = 1'),
        completed_last_7_days: this.get('SELECT COUNT(*) AS n FROM activity WHERE action = ? AND entity = ? AND at >= ?', 'complete', 'task', weekAgo).n,
      },
      projects: this.listProjects().map(({ id, name, active_count, is_inbox }) => ({ id, name, active_count, is_inbox })),
      labels: this.listLabels().map(({ name, active_count }) => ({ name, active_count })),
      memory: this.listMemory().map(({ id, content, category }) => ({ id, content, category })),
    };
  }

  exportAll() {
    return {
      exported_at: now(),
      schema_version: this.get('PRAGMA user_version').user_version,
      projects: this.all('SELECT * FROM projects'),
      sections: this.all('SELECT * FROM sections'),
      tasks: this.all('SELECT * FROM tasks'),
      labels: this.all('SELECT * FROM labels'),
      task_labels: this.all('SELECT * FROM task_labels'),
      comments: this.all('SELECT * FROM comments'),
      memory: this.all('SELECT * FROM memory'),
    };
  }
}
