// MCP server: lets Claude (Desktop, Code, or any MCP client) read and manage your tasks.
// Runs over stdio as a separate process that shares the same SQLite database as the web app.
// stdout carries the protocol, so anything diagnostic must go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb } from './db.js';
import { COLORS, Store } from './store.js';
import { parseQuickAdd } from './shared/quickadd.js';

const store = new Store(openDb());
const ACTOR = 'mcp';

const server = new McpServer(
  { name: 'taskline', version: '0.1.0' },
  {
    instructions: `Taskline is the user's personal task manager. Call get_overview first to learn today's date, projects, labels and the user's remembered preferences.
Tasks sit on a board: backlog -> ready (released to the AI worker) -> working -> review -> done. Use move_task; done completes the task. Priority 1 is most urgent, 4 is none. Dates are YYYY-MM-DD; the "due" field also accepts phrases like "tomorrow 5pm" or "every weekday".
Completing a recurring task moves it to its next date. Deletes go to a 30-day trash and can be undone with restore_task.
When the user states a lasting preference about how they work, save it with remember.`,
  },
);

// Every tool returns JSON text; errors become readable tool errors instead of crashing the server.
function tool(name, description, inputSchema, fn, annotations = {}) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try {
      const out = await fn(args ?? {});
      return { content: [{ type: 'text', text: out === undefined ? 'OK' : JSON.stringify(out, null, 1) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

const readOnly = { readOnlyHint: true };

// Trims tasks to the fields an agent needs, keeping responses small.
const slim = (t) => ({
  id: t.id, content: t.content, ...(t.description && { description: t.description }), priority: t.priority,
  status: t.completed_at ? 'done' : t.status,
  project: t.project_name, ...(t.section_name && { section: t.section_name }), ...(t.parent_id && { parent_id: t.parent_id }),
  ...(t.due_date && { due_date: t.due_date }), ...(t.due_time && { due_time: t.due_time }), ...(t.recurrence && { recurrence: t.recurrence }),
  ...(t.deadline && { deadline: t.deadline }), ...(t.duration_min && { duration_min: t.duration_min }),
  ...(t.labels?.length && { labels: t.labels }), ...(t.subtask_count && { subtasks: `${t.subtask_done}/${t.subtask_count}` }),
  ...(t.completed_at && { completed_at: t.completed_at }),
});

const TaskInput = {
  content: z.string().describe('Task title, short and starting with a verb'),
  description: z.string().optional().describe('Longer notes (markdown ok)'),
  project: z.string().optional().describe('Project name; omit for Inbox'),
  parent_id: z.string().optional().describe('Make this a subtask of that task'),
  section_id: z.string().optional(),
  priority: z.number().int().min(1).max(4).optional().describe('1 = urgent ... 4 = none (default)'),
  due: z.string().optional().describe('Natural language due date, e.g. "friday 3pm", "in 2 weeks", "every mon,thu"'),
  due_date: z.string().optional().describe('YYYY-MM-DD (alternative to due)'),
  due_time: z.string().optional().describe('HH:MM 24h'),
  recurrence: z.string().optional().describe('e.g. "every day", "every weekday", "every 2 weeks", "every month on 15"'),
  deadline: z.string().optional().describe('Hard deadline YYYY-MM-DD, separate from the planned due date'),
  duration_min: z.number().int().optional().describe('Estimated minutes'),
  labels: z.array(z.string()).optional(),
  status: z.enum(['backlog', 'ready', 'working', 'review']).optional().describe('Board column (default backlog)'),
};

tool('get_overview', 'Snapshot of the task system: today\'s date, counts (overdue, due today, inbox), projects, labels and remembered user preferences. Start here.',
  {}, () => store.overview(), readOnly);

tool('list_tasks', 'List tasks. view: today (incl. overdue), upcoming, inbox, project (needs project), label (needs label), search (needs query), completed, trash, all.',
  {
    view: z.enum(['today', 'upcoming', 'inbox', 'project', 'label', 'search', 'completed', 'trash', 'all']).default('today'),
    project: z.string().optional().describe('Project name, for view=project'),
    label: z.string().optional(),
    query: z.string().optional(),
    days: z.number().int().min(1).max(365).optional().describe('Horizon for view=upcoming (default 14)'),
    status: z.enum(['backlog', 'ready', 'working', 'review']).optional().describe('Only open tasks in this board column'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  ({ view, project, label, query, days, limit, status }) => {
    const project_id = project ? store.findProjectByName(project).id : undefined;
    return store.listTasks({ view, project_id, label, q: query, days, status, limit: limit ?? 200 }).map(slim);
  }, readOnly);

tool('get_task', 'Full details of one task, including subtasks, comments and its change history.',
  { id: z.string() },
  ({ id }) => {
    const t = store.getTask(id, { withChildren: true });
    return { ...slim(t), subtasks: t.subtasks.map(slim), comments: t.comments, history: store.listActivity({ entity_id: id, limit: 20 }) };
  }, readOnly);

tool('add_tasks', 'Create one or more tasks (max 100), optionally with subtasks.',
  { tasks: z.array(z.object({ ...TaskInput, subtasks: z.array(z.string()).optional() })).min(1).max(100) },
  ({ tasks }) => store.createTasks(tasks, ACTOR).map(slim));

tool('quick_add', 'Create a task from quick-add syntax, e.g. "Call mom tomorrow 5pm #Family @phone p2 // ask about the weekend".',
  { text: z.string() },
  ({ text }) => {
    const p = parseQuickAdd(text, { projects: store.listProjects() });
    return slim(store.createTask({
      content: p.content, description: p.description ?? undefined, priority: p.priority, project_id: p.project_id ?? undefined,
      labels: p.labels, due_date: p.due_date, due_time: p.due_time, recurrence: p.recurrence,
    }, ACTOR));
  });

tool('update_task', 'Change fields of a task. Only the fields you pass are changed. Pass null to clear due_date, due_time, recurrence or deadline.',
  {
    id: z.string(),
    content: z.string().optional(),
    description: z.string().optional(),
    project: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    section_id: z.string().nullable().optional(),
    priority: z.number().int().min(1).max(4).optional(),
    due: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    due_time: z.string().nullable().optional(),
    recurrence: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(),
    duration_min: z.number().int().nullable().optional(),
    labels: z.array(z.string()).optional().describe('Replaces all labels'),
  },
  ({ id, ...patch }) => slim(store.updateTask(id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), ACTOR)));

tool('move_task', 'Move a task to a board column: backlog, ready (releases it to the AI worker), working, review, or done (done completes it; recurring tasks then move to their next date).',
  { id: z.string(), status: z.enum(['backlog', 'ready', 'working', 'review', 'done']) },
  ({ id, status }) => slim(store.moveTask(id, status, ACTOR)));
tool('complete_task', 'Mark a task done. Recurring tasks move to their next date instead.', { id: z.string() },
  ({ id }) => slim(store.completeTask(id, ACTOR)));
tool('reopen_task', 'Mark a completed task as not done.', { id: z.string() },
  ({ id }) => slim(store.uncompleteTask(id, ACTOR)));
tool('delete_task', 'Move a task (and its subtasks) to the trash. Restorable for 30 days.', { id: z.string() },
  ({ id }) => store.deleteTask(id, ACTOR), { destructiveHint: true });
tool('restore_task', 'Restore a task from the trash.', { id: z.string() },
  ({ id }) => slim(store.restoreTask(id, ACTOR)));
tool('add_comment', 'Add a comment to a task (useful for progress notes).', { task_id: z.string(), body: z.string() },
  ({ task_id, body }) => store.addComment(task_id, body, ACTOR));

tool('list_projects', 'List projects with their active task counts and sections.', {},
  () => store.listProjects().map((p) => ({ ...p, sections: store.listSections(p.id).map(({ id, name }) => ({ id, name })) })), readOnly);
tool('create_project', 'Create a project.',
  { name: z.string(), color: z.enum(COLORS).optional(), parent: z.string().optional().describe('Parent project name') },
  ({ name, color, parent }) => store.createProject({ name, color, parent_id: parent ? store.findProjectByName(parent).id : undefined }, ACTOR));
tool('create_section', 'Create a section inside a project.', { project: z.string(), name: z.string() },
  ({ project, name }) => store.createSection({ project_id: store.findProjectByName(project).id, name }, ACTOR));

tool('remember', 'Save a lasting fact about the user that should shape future planning ("prefers calls after 2pm", "Fridays are admin days").',
  { content: z.string(), category: z.string().optional().describe('e.g. schedule, preferences, people, goals') },
  (args) => store.addMemory(args, ACTOR));
tool('list_memory', 'List everything remembered about the user.', {}, () => store.listMemory(), readOnly);
tool('forget', 'Delete a remembered fact by id.', { id: z.string() }, ({ id }) => store.deleteMemory(id, ACTOR), { destructiveHint: true });

tool('get_activity', 'Recent changes (who did what, when). actor is user, ai or mcp.',
  { limit: z.number().int().min(1).max(500).optional(), since: z.string().optional().describe('ISO timestamp') },
  (args) => store.listActivity(args), readOnly);

await server.connect(new StdioServerTransport());
console.error('Taskline MCP server ready');
