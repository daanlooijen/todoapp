import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { Store, ValidationError } from '../src/store.js';
import { addDays, fmtDate } from '../src/shared/dates.js';

const fresh = () => new Store(openDb(':memory:'));
const today = fmtDate(new Date());

test('creates an inbox and puts new tasks in it', () => {
  const s = fresh();
  const t = s.createTask({ content: 'Buy milk' });
  assert.equal(t.project_name, 'Inbox');
  assert.equal(t.priority, 4);
  assert.deepEqual(s.listTasks({ view: 'inbox' }).map((x) => x.content), ['Buy milk']);
});

test('resolves project names, labels and natural-language due dates', () => {
  const s = fresh();
  s.createProject({ name: 'Work' });
  const t = s.createTask({ content: 'Report', project: 'work', labels: ['Deep', 'deep'], due: 'tomorrow 9am', priority: 1 });
  assert.equal(t.project_name, 'Work');
  assert.deepEqual(t.labels, ['deep']);
  assert.equal(t.due_date, fmtDate(addDays(new Date(), 1)));
  assert.equal(t.due_time, '09:00');
  assert.throws(() => s.createTask({ content: 'x', project: 'Nope' }), ValidationError);
  assert.throws(() => s.createTask({ content: 'x', due: 'blorp' }), ValidationError);
  assert.throws(() => s.createTask({ content: '' }), ValidationError);
  assert.throws(() => s.createTask({ content: 'x', priority: 7 }), ValidationError);
});

test('recurring tasks advance instead of closing', () => {
  const s = fresh();
  const t = s.createTask({ content: 'Water plants', recurrence: 'every day', due_date: today });
  const done = s.completeTask(t.id);
  assert.equal(done.completed_at, null);
  assert.equal(done.due_date, fmtDate(addDays(new Date(), 1)));
  assert.equal(s.listActivity({ limit: 1 })[0].action, 'complete');
});

test('completing a parent completes subtasks; reopening a subtask reopens the parent', () => {
  const s = fresh();
  const p = s.createTask({ content: 'Trip', subtasks: ['Book flight', { content: 'Pack', priority: 2 }] });
  const full = s.getTask(p.id, { withChildren: true });
  assert.equal(full.subtasks.length, 2);
  s.completeTask(p.id);
  assert.ok(s.getTask(full.subtasks[0].id).completed_at);
  s.uncompleteTask(full.subtasks[1].id);
  assert.equal(s.getTask(p.id).completed_at, null);
});

test('delete is soft and restorable, including subtasks', () => {
  const s = fresh();
  const p = s.createTask({ content: 'Parent', subtasks: ['Child'] });
  s.deleteTask(p.id);
  assert.equal(s.listTasks({ view: 'inbox' }).length, 0);
  assert.equal(s.listTasks({ view: 'trash' }).length, 2);
  s.restoreTask(p.id);
  assert.equal(s.listTasks({ view: 'inbox' }).length, 2);
});

test('moving a task under its own subtask is rejected', () => {
  const s = fresh();
  const p = s.createTask({ content: 'A', subtasks: ['B'] });
  const child = s.getTask(p.id, { withChildren: true }).subtasks[0];
  assert.throws(() => s.updateTask(p.id, { parent_id: child.id }), /under itself/);
});

test('today view includes overdue, search escapes wildcards', () => {
  const s = fresh();
  s.createTask({ content: 'Late', due_date: fmtDate(addDays(new Date(), -2)) });
  s.createTask({ content: 'Now', due_date: today });
  s.createTask({ content: 'Later', due_date: fmtDate(addDays(new Date(), 3)) });
  s.createTask({ content: '100% done' });
  assert.deepEqual(s.listTasks({ view: 'today' }).map((t) => t.content), ['Late', 'Now']);
  assert.equal(s.listTasks({ view: 'upcoming' }).length, 3);
  assert.deepEqual(s.listTasks({ view: 'search', q: '%' }).map((t) => t.content), ['100% done']);
});

test('clearing the date of a recurring task stops the recurrence', () => {
  const s = fresh();
  const t = s.createTask({ content: 'Gym', due: 'every monday' });
  assert.equal(t.recurrence, 'every mon');
  const u = s.updateTask(t.id, { due_date: null });
  assert.equal(u.recurrence, null);
  assert.equal(u.due_date, null);
});

test('memory and overview', () => {
  const s = fresh();
  s.addMemory({ content: 'Deep work in the morning', category: 'schedule' }, 'mcp');
  const o = s.overview();
  assert.equal(o.memory.length, 1);
  assert.equal(o.counts.inbox, 0);
  assert.equal(s.listActivity({ limit: 1 })[0].actor, 'mcp');
});
