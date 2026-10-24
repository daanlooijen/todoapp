// Taskline web UI. Plain DOM, no framework or build step.
// All user text is inserted with textContent (via h()), never innerHTML, so a task titled
// "<img onerror=...>" is shown as text instead of running as code.
import { addDays, dueLabel, fmtDate, parseDate } from '/shared/dates.js';
import { parseQuickAdd } from '/shared/quickadd.js';
import { icon } from '/icons.js';

const $ = (s, el = document) => el.querySelector(s);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const dot = (color) => {
  const d = h('span', { class: 'dot' });
  d.style.background = `var(--c-${color || 'slate'})`;
  return d;
};
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });
const loading = (text) => h('p', { class: 'loading-line', role: 'status' }, spinner(), text);
const note = (text) => h('p', { class: 'note', role: 'alert' }, icon('alert', { size: 14 }), h('span', {}, text));
let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const state = { boot: null, route: { kind: 'today', arg: '' }, openId: null, head: 0 };
const todayStr = () => fmtDate(new Date());
const projectById = (id) => state.boot.projects.find((p) => p.id === id);

// ---------- toast ----------

let toastTimer;
function toast(message, actionLabel, action, { error = false } = {}) {
  const el = $('#toast');
  el.className = `toast show${error ? ' error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.replaceChildren(icon(error ? 'alert' : 'check', { size: 16 }), h('span', {}, message));
  if (actionLabel) {
    el.append(h('button', {
      onclick: async () => {
        el.classList.remove('show');
        try { await action(); } catch (e) { showError(e); }
      },
    }, actionLabel));
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 7000 : 5000);
}
const showError = (e) => toast(e.message || String(e), null, null, { error: true });

// ---------- modal ----------

// Dialog with a focus trap: Tab cycles inside it, Esc closes it, and focus returns to
// whatever opened it, so keyboard and screen reader users never get lost behind the scrim.
function modal(title, ...children) {
  const titleId = nextId('dialog-title');
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('h2', { id: titleId }, title), ...children);
  const back = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  const opener = document.activeElement;
  const focusables = () => [...box.querySelectorAll('button:not(:disabled), input, textarea, select, [href]')];
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  function close() {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected) opener.focus();
  }
  document.addEventListener('keydown', onKey, true);
  $('#modal-root').append(back);
  (box.querySelector('textarea, input') ?? focusables()[0])?.focus();
  return { close, box };
}

function formModal({ title, lead, fields, submitLabel = 'Save', onSubmit }) {
  const inputs = {};
  let color;
  const rows = fields.map((f) => {
    if (f.type === 'color') {
      color = f.value || 'slate';
      const labelId = nextId('color-label');
      const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-labelledby': labelId });
      const draw = () => sw.replaceChildren(...state.boot.colors.map((c) => {
        const b = h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(c === color), title: c, 'aria-label': c,
          onclick: () => { color = c; draw(); sw.querySelector('[aria-checked="true"]')?.focus(); },
        });
        b.style.background = `var(--c-${c})`;
        return b;
      }));
      draw();
      return h('div', { class: 'row' }, h('span', { class: 'field-label', id: labelId }, 'Color'), sw);
    }
    const id = nextId('field');
    inputs[f.name] = h('input', { type: 'text', id, value: f.value ?? '', placeholder: f.placeholder ?? '', required: f.required ?? false });
    return h('div', { class: 'row' }, h('label', { class: 'field-label', for: id }, f.label), inputs[f.name]);
  });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
        if (color) values.color = color;
        await onSubmit(values);
        m.close();
      } catch (err) { showError(err); } finally { submit.disabled = false; }
    },
  }, ...rows, h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Cancel'), submit));
  const m = modal(title, lead ? h('p', { class: 'lead' }, lead) : null, form);
  return m;
}

// ---------- sidebar ----------

function navLink(href, ico, label, count, { alert = false, color, countLabel } = {}) {
  const active = location.hash === href || (href === '#/today' && !location.hash);
  return h('a', { href, class: active ? 'active' : '', 'aria-current': active ? 'page' : null },
    color ? dot(color) : h('span', { class: 'ico' }, icon(ico, { size: 16 })),
    h('span', { class: 'label' }, label),
    count ? h('span', { class: `count${alert ? ' alert' : ''}`, 'aria-label': countLabel ?? `${count} open` }, count) : null);
}

function renderSidebar() {
  const { projects, labels, counts, ai, data_dir, backup } = state.boot;
  const inbox = projects.find((p) => p.is_inbox);
  const dueCount = counts.overdue + counts.due_today;
  fill($('#nav-main'),
    navLink('#/inbox', 'inbox', 'Inbox', inbox?.active_count),
    navLink('#/today', 'sun', 'Today', dueCount, {
      alert: counts.overdue > 0,
      countLabel: counts.overdue ? `${dueCount} due, ${counts.overdue} overdue` : `${dueCount} due`,
    }),
    navLink('#/upcoming', 'calendar', 'Upcoming'),
    navLink('#/completed', 'done', 'Completed'),
  );
  fill($('#nav-projects'), ...projects.filter((p) => !p.is_inbox).map((p) =>
    navLink(`#/project/${p.id}`, '', p.name, p.active_count, { color: p.color })));
  fill($('#nav-labels'), ...labels.filter((l) => l.active_count > 0).map((l) =>
    navLink(`#/label/${encodeURIComponent(l.name)}`, 'tag', l.name, l.active_count)));
  $('#nav-labels').previousElementSibling.hidden = !labels.some((l) => l.active_count > 0);
  fill($('#nav-tools'),
    navLink('#/memory', 'sparkles', 'Memory'),
    navLink('#/activity', 'history', 'Activity'),
    navLink('#/trash', 'trash', 'Trash'),
    h('a', { href: '/api/export', download: '' }, h('span', { class: 'ico' }, icon('download', { size: 16 })), h('span', { class: 'label' }, 'Export JSON')),
  );
  const last = backup?.at ? new Date(backup.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'pending';
  fill($('#status'),
    h('div', {}, h('b', {}, 'AI: '), ai.configured ? h('span', { class: 'on' }, `on (${ai.model})`) : 'off, add ANTHROPIC_API_KEY to .env'),
    h('div', {}, h('b', {}, 'Data: '), data_dir),
    h('div', {}, h('b', {}, 'Backup: '), backup?.ok === false ? h('span', { class: 'bad' }, `failed (${backup.error})`) : last),
  );
}

// ---------- task rows ----------

function dueClass(date) {
  if (!date) return '';
  const t = todayStr();
  return date < t ? 'overdue' : date === t ? 'today' : '';
}

function taskRow(t, depth = 0, { showProject = true } = {}) {
  const done = Boolean(t.completed_at);
  const row = h('div', {
    class: `task${done ? ' done' : ''}${state.openId === t.id ? ' selected' : ''}`,
    dataset: { id: t.id },
    tabindex: '0',
    onclick: () => openTask(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' && e.target === row) openTask(t.id); },
  });
  if (depth) row.style.paddingLeft = `${6 + depth * 32}px`;
  const check = h('button', {
    class: `check p${t.priority}${done ? ' checked' : ''}`,
    'aria-label': done ? `Mark "${t.content}" as not done` : `Complete "${t.content}"`,
    'aria-pressed': String(done),
    onclick: (e) => { e.stopPropagation(); toggleComplete(t, check); },
  }, icon('check', { size: 12 }));
  const meta = h('div', { class: 'meta' });
  if (t.due_date) {
    const cls = dueClass(t.due_date);
    meta.append(h('span', { class: `due ${cls}` },
      icon(t.recurrence ? 'repeat' : 'calendar', { size: 12 }),
      cls === 'overdue' ? h('span', { class: 'sr-only' }, 'Overdue: ') : null,
      dueLabel(t.due_date), t.due_time ? ` ${t.due_time}` : '',
      t.recurrence ? h('span', { class: 'sr-only' }, `, repeats ${t.recurrence}`) : null));
  }
  if (t.priority < 4) meta.append(h('span', { class: `prio p${t.priority}`, title: `Priority ${t.priority}` }, icon('flag', { size: 12 }), `P${t.priority}`));
  if (t.deadline) meta.append(h('span', { title: 'Deadline' }, icon('flag', { size: 12 }), `Deadline ${dueLabel(t.deadline)}`));
  if (t.subtask_count) meta.append(h('span', { title: 'Subtasks done' }, icon('subtasks', { size: 12 }), `${t.subtask_done}/${t.subtask_count}`));
  if (t.comment_count) meta.append(h('span', { title: 'Comments' }, icon('comment', { size: 12 }), String(t.comment_count)));
  for (const l of t.labels) meta.append(h('span', {}, `@${l}`));
  if (showProject) meta.append(h('span', { class: 'proj' }, dot(t.project_color), t.project_name + (t.section_name ? ` / ${t.section_name}` : '')));
  row.append(check, h('div', { class: 'task-body' },
    h('div', { class: 'task-title' }, t.content),
    t.description ? h('div', { class: 'task-desc' }, t.description.split('\n')[0]) : null,
    meta.childNodes.length ? meta : null));
  return row;
}

async function toggleComplete(t, check) {
  try {
    if (t.completed_at) {
      await api('POST', `/tasks/${t.id}/uncomplete`);
      return refresh();
    }
    check?.classList.add('checked');
    // Recurring tasks stay in the list with a new date, so only one-off tasks fold away.
    const row = check?.closest('.task');
    if (row && !t.recurrence) row.classList.add('completing');
    const res = await api('POST', `/tasks/${t.id}/complete`);
    if (t.recurrence) {
      toast(`Done. Next: ${dueLabel(res.due_date)}`, 'Undo', async () => {
        await api('PATCH', `/tasks/${t.id}`, { due_date: t.due_date, due_time: t.due_time });
        refresh();
      });
    } else {
      toast(`Completed "${t.content}"`, 'Undo', async () => {
        await api('POST', `/tasks/${t.id}/uncomplete`);
        refresh();
      });
    }
    // Let the completion animation play out before the list re-renders.
    setTimeout(refresh, reducedMotion.matches ? 0 : 440);
  } catch (e) {
    check?.classList.remove('checked');
    check?.closest('.task')?.classList.remove('completing');
    showError(e);
  }
}

// Orders a flat list so subtasks follow their parent, with nesting depth.
function tree(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const kids = new Map();
  for (const t of tasks) {
    const p = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  const out = [];
  const walk = (pid, depth) => { for (const t of kids.get(pid) ?? []) { out.push([t, depth]); walk(t.id, depth + 1); } };
  walk(null, 0);
  return out;
}

function group(title, { sub, cls, actions = [] } = {}, ...rows) {
  return h('div', { class: 'group' },
    title ? h('div', { class: `group-head ${cls ?? ''}` }, h('span', {}, title), sub ? h('span', { class: 'sub' }, sub) : null, h('span', { class: 'spacer' }), ...actions) : null,
    ...rows);
}

// A small "Add task" line inside a group (a section or a day), using quick-add syntax.
function inlineAdd(defaults, placeholder = 'Add task') {
  const input = h('input', { placeholder, 'aria-label': placeholder });
  return h('form', {
    class: 'inline-add',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        await createFromQuickAdd(input.value, defaults);
        input.value = '';
        await refresh();
        input.focus();
      } catch (err) { showError(err); }
    },
  }, icon('plus', { size: 16 }), input);
}

function empty(iconName, title, ...lines) {
  return h('div', { class: 'empty' },
    h('div', { class: 'big' }, icon(iconName, { size: 24 })),
    h('p', { class: 'lead-line' }, title),
    ...lines.map((l) => h('p', {}, l)));
}

function skeleton(rows = 4) {
  return h('div', { class: 'group', 'aria-busy': 'true', 'aria-label': 'Loading tasks' },
    ...Array.from({ length: rows }, (_, i) => h('div', { class: 'skeleton-row' },
      h('span', { class: 'sk-circle' }),
      h('span', { class: 'sk-lines' }, h('span', { class: 'sk-line', style: null }), i % 2 ? null : h('span', { class: 'sk-line short' })))));
}

// ---------- quick add ----------

function quickPayload(text, defaults = {}) {
  const p = parseQuickAdd(text, { projects: state.boot.projects });
  const body = {
    content: p.content || text.trim(),
    priority: p.priority,
    labels: [...new Set([...p.labels, ...(defaults.labels ?? [])])],
    due_date: p.due_date ?? defaults.due_date ?? null,
    due_time: p.due_time,
    recurrence: p.recurrence,
  };
  if (p.description) body.description = p.description;
  if (p.project_id) body.project_id = p.project_id;
  else if (defaults.project_id) {
    body.project_id = defaults.project_id;
    if (defaults.section_id) body.section_id = defaults.section_id;
  }
  if (defaults.parent_id) {
    body.parent_id = defaults.parent_id;
    delete body.project_id;
    delete body.section_id;
  }
  return { body, parsed: p };
}

function createFromQuickAdd(text, defaults) {
  return api('POST', '/tasks', quickPayload(text, defaults).body);
}

function routeDefaults() {
  const { kind, arg } = state.route;
  if (kind === 'project') return { project_id: arg };
  if (kind === 'today') return { due_date: todayStr() };
  if (kind === 'label') return { labels: [arg] };
  return {};
}

function renderPreview() {
  const text = $('#quick-input').value;
  const box = $('#quick-preview');
  if (!text.trim()) return box.replaceChildren();
  const { body, parsed } = quickPayload(text, routeDefaults());
  const chips = [];
  if (body.due_date) chips.push(h('span', { class: 'chip date' }, icon('calendar', { size: 12 }), `${dueLabel(body.due_date)}${body.due_time ? ` ${body.due_time}` : ''}`));
  if (body.recurrence) chips.push(h('span', { class: 'chip date' }, icon('repeat', { size: 12 }), body.recurrence));
  const proj = body.project_id && projectById(body.project_id);
  if (proj) chips.push(h('span', { class: 'chip' }, dot(proj.color), proj.name));
  for (const l of body.labels) chips.push(h('span', { class: 'chip' }, icon('tag', { size: 12 }), l));
  if (body.priority < 4) chips.push(h('span', { class: `chip p${body.priority}` }, icon('flag', { size: 12 }), `P${body.priority}`));
  if (body.description) chips.push(h('span', { class: 'chip' }, icon('note', { size: 12 }), 'Note'));
  const unknown = parsed.content.match(/(?:^|\s)#([\p{L}\p{N}_-]+)/u);
  if (unknown) chips.push(h('span', { class: 'chip warn' }, icon('alert', { size: 12 }), `No project "${unknown[1]}", it stays in the title`));
  box.replaceChildren(...chips);
}

// ---------- AI: smart add & plan ----------

function openSmartAdd() {
  const taId = nextId('smart-text');
  const ta = h('textarea', { id: taId, placeholder: 'e.g. "renew passport before march, call the plumber tmrw about the leak, and every friday send the weekly update to Sanne"' });
  ta.value = $('#quick-input').value;
  const out = h('div', { 'aria-live': 'polite' });
  const go = h('button', { class: 'btn ai', type: 'button', onclick: run }, icon('sparkles', { size: 15 }), 'Organize');
  const actions = h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), go);
  const m = modal('Smart add',
    h('p', { class: 'lead' }, 'Claude turns messy text into tasks with dates, projects and labels. You review everything before it is added.'),
    h('label', { class: 'field-label', for: taId }, 'Your notes'),
    ta,
    h('div', { class: 'hint' }, 'Paste a brain dump, meeting notes or an email. Ctrl/Cmd + Enter to organize.'),
    out, actions,
  );
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); });

  async function run() {
    if (!ta.value.trim()) { ta.focus(); return; }
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    fill(out, loading('Reading your notes...'));
    try {
      const { tasks } = await api('POST', '/ai/capture', { text: ta.value });
      showProposals(tasks);
    } catch (e) {
      fill(out, note(e.message));
    } finally { go.disabled = false; go.removeAttribute('aria-busy'); }
  }

  function showProposals(tasks) {
    if (!tasks.length) return fill(out, note('No tasks found in that text. Try adding a bit more detail.'));
    const picks = tasks.map(() => true);
    fill(out, h('div', { class: 'section-title' }, `${tasks.length} proposed task${tasks.length > 1 ? 's' : ''}`),
      ...tasks.map((t, i) => {
        const proj = state.boot.projects.find((p) => p.name === t.project);
        return h('label', { class: 'proposal' },
          h('input', { type: 'checkbox', checked: true, onchange: (e) => { picks[i] = e.target.checked; addBtn.textContent = label(); } }),
          h('div', {},
            h('div', {}, t.content),
            h('div', { class: 'meta' },
              t.due_date ? h('span', { class: `due ${dueClass(t.due_date)}` }, icon('calendar', { size: 12 }), dueLabel(t.due_date), t.due_time ? ` ${t.due_time}` : '') : null,
              t.recurrence ? h('span', {}, icon('repeat', { size: 12 }), t.recurrence) : null,
              t.priority < 4 ? h('span', { class: `prio p${t.priority}` }, icon('flag', { size: 12 }), `P${t.priority}`) : null,
              ...t.labels.map((l) => h('span', {}, `@${l}`)),
              h('span', { class: 'proj' }, dot(proj?.color ?? 'blue'), proj?.name ?? 'Inbox')),
            t.description ? h('div', { class: 'task-desc' }, t.description) : null,
            t.subtasks.length ? h('div', { class: 'subs' }, ...t.subtasks.map((s) => h('div', {}, `• ${s}`))) : null));
      }));
    const label = () => `Add ${picks.filter(Boolean).length} task${picks.filter(Boolean).length === 1 ? '' : 's'}`;
    const addBtn = h('button', {
      class: 'btn primary', type: 'button',
      onclick: async () => {
        const chosen = tasks.filter((_, i) => picks[i]);
        if (!chosen.length) return;
        addBtn.disabled = true;
        try {
          await api('POST', '/tasks/bulk', {
            actor: 'ai',
            tasks: chosen.map(({ project, ...t }) => (project ? { ...t, project } : t)),
          });
          m.close();
          $('#quick-input').value = '';
          renderPreview();
          toast(`Added ${chosen.length} task${chosen.length > 1 ? 's' : ''}`);
          refresh();
        } catch (e) { showError(e); addBtn.disabled = false; }
      },
    }, label());
    actions.replaceChildren(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn', type: 'button', onclick: run }, 'Try again'), addBtn);
  }
}

async function openPlan() {
  const out = h('div', { 'aria-live': 'polite' }, loading('Looking at your week...'));
  const actions = h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close'));
  const m = modal('Plan my day', out, actions);
  let plan;
  try {
    plan = await api('POST', '/ai/plan');
  } catch (e) {
    return fill(out, note(e.message));
  }
  const moves = plan.reschedule.map(() => true);
  fill(out, 
    h('div', { class: 'plan-summary' }, plan.summary),
    plan.focus.length ? h('div', { class: 'section-title' }, 'Focus today, in this order') : null,
    ...plan.focus.map((f, i) => h('div', { class: 'plan-item' },
      h('span', { class: 'num' }, `${i + 1}.`),
      h('div', {}, h('div', {}, f.task.content), h('div', { class: 'why' }, f.reason)),
      h('span', { class: 'spacer' }),
      f.time_block ? h('span', { class: 'block' }, f.time_block) : null)),
    plan.reschedule.length ? h('div', { class: 'section-title' }, 'Suggested to move') : null,
    ...plan.reschedule.map((r, i) => h('label', { class: 'proposal' },
      h('input', { type: 'checkbox', checked: true, onchange: (e) => { moves[i] = e.target.checked; } }),
      h('div', {}, h('div', {}, r.task.content, ' ', h('span', { class: 'chip date' }, icon('arrow', { size: 12 }), dueLabel(r.new_date))), h('div', { class: 'why' }, r.reason)))),
    ...plan.notes.map((n) => note(n)),
  );
  if (plan.reschedule.length) {
    const apply = h('button', {
      class: 'btn primary', type: 'button',
      onclick: async () => {
        apply.disabled = true;
        try {
          const chosen = plan.reschedule.filter((_, i) => moves[i]);
          for (const r of chosen) await api('PATCH', `/tasks/${r.task_id}`, { due_date: r.new_date });
          toast(`Moved ${chosen.length} task${chosen.length === 1 ? '' : 's'}`);
          m.close();
          refresh();
        } catch (e) { showError(e); apply.disabled = false; }
      },
    }, 'Apply moves');
    actions.append(apply);
  }
}

// ---------- views ----------

const TASK_VIEWS = new Set(['today', 'upcoming', 'inbox', 'project', 'label', 'search', 'completed', 'trash']);

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { kind: parts[0] || 'today', arg: decodeURIComponent(parts.slice(1).join('/')) };
}

function setHead(title, sub, actions = []) {
  $('#view-title').textContent = title;
  $('#view-sub').textContent = sub ?? '';
  $('#view-actions').replaceChildren(...actions);
  document.title = `${title} · Taskline`;
}

async function renderView() {
  const { kind, arg } = state.route;
  const content = $('#content');
  $('#composer').hidden = !TASK_VIEWS.has(kind) || kind === 'trash' || kind === 'completed';

  if (kind === 'memory') return renderMemory(content);
  if (kind === 'activity') return renderActivity(content);

  let tasks;
  try {
    const params = new URLSearchParams({ view: kind });
    if (kind === 'project') params.set('project_id', arg);
    if (kind === 'label') params.set('label', arg);
    if (kind === 'search') params.set('q', arg);
    if (kind === 'completed') params.set('limit', '200');
    tasks = await api('GET', `/tasks?${params}`);
  } catch (e) {
    fill(content, empty('alert', 'Could not load tasks', e.message));
    return;
  }

  const t = todayStr();
  const nodes = [];

  if (kind === 'today') {
    const overdue = tasks.filter((x) => x.due_date < t);
    const today = tasks.filter((x) => x.due_date === t);
    setHead('Today', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
      [h('button', { class: 'btn ai', onclick: openPlan }, icon('sparkles', { size: 15 }), 'Plan my day')]);
    if (overdue.length) {
      nodes.push(group('Overdue', {
        cls: 'overdue', sub: String(overdue.length),
        actions: [h('button', {
          class: 'btn small',
          onclick: async () => {
            try {
              for (const x of overdue) await api('PATCH', `/tasks/${x.id}`, { due_date: t });
              refresh();
            } catch (e) { showError(e); }
          },
        }, icon('arrow', { size: 13 }), 'Move all to today')],
      }, ...overdue.map((x) => taskRow(x))));
    }
    nodes.push(group(overdue.length ? 'Today' : null, { sub: today.length ? String(today.length) : '' }, ...today.map((x) => taskRow(x))));
    if (!tasks.length) nodes.push(empty('sun', 'Nothing due today', 'Enjoy it, or pull something forward from Upcoming.'));
  } else if (kind === 'upcoming') {
    setHead('Upcoming', 'Next 14 days');
    const overdue = tasks.filter((x) => x.due_date < t);
    if (overdue.length) nodes.push(group('Overdue', { cls: 'overdue', sub: String(overdue.length) }, ...overdue.map((x) => taskRow(x))));
    for (let i = 0; i < 14; i++) {
      const d = fmtDate(addDays(new Date(), i));
      const dayTasks = tasks.filter((x) => x.due_date === d);
      if (i >= 7 && !dayTasks.length) continue;
      const date = parseDate(d);
      const title = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      nodes.push(group(title, { sub: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : '' }, ...dayTasks.map((x) => taskRow(x)), inlineAdd({ due_date: d })));
    }
  } else if (kind === 'inbox') {
    setHead('Inbox', 'Everything that has no project yet');
    nodes.push(group(null, {}, ...tree(tasks).map(([x, depth]) => taskRow(x, depth, { showProject: false }))));
    if (!tasks.length) nodes.push(empty('inbox', 'Inbox zero', 'New tasks without a #project land here.'));
  } else if (kind === 'project') {
    const p = projectById(arg);
    if (!p) { fill(content, empty('folder', 'Project not found', 'It may have been archived.')); return; }
    setHead(p.name, `${tasks.length} open task${tasks.length === 1 ? '' : 's'}`, [
      h('button', { class: 'btn', onclick: () => addSection(p) }, icon('plus', { size: 14 }), 'Section'),
      h('button', { class: 'btn', onclick: () => editProject(p) }, icon('pencil', { size: 14 }), 'Edit'),
      h('button', { class: 'btn', onclick: () => archiveProject(p) }, icon('archive', { size: 14 }), 'Archive'),
    ]);
    const sections = state.boot.sections.filter((s) => s.project_id === p.id);
    const loose = tasks.filter((x) => !x.section_id);
    nodes.push(group(null, {}, ...tree(loose).map(([x, d]) => taskRow(x, d, { showProject: false }))));
    if (!tasks.length && !sections.length) nodes.push(empty('folder', 'No tasks yet', 'Add one above, or use Smart add to paste a whole plan.'));
    for (const s of sections) {
      const st = tasks.filter((x) => x.section_id === s.id);
      nodes.push(group(s.name, {
        sub: st.length ? String(st.length) : '',
        actions: [
          h('button', { class: 'icon-btn', title: 'Rename section', 'aria-label': `Rename section ${s.name}`, onclick: () => renameSection(s) }, icon('pencil', { size: 14 })),
          h('button', { class: 'icon-btn danger', title: 'Delete section', 'aria-label': `Delete section ${s.name}`, onclick: () => deleteSection(s) }, icon('trash', { size: 14 })),
        ],
      }, ...tree(st).map(([x, d]) => taskRow(x, d, { showProject: false })), inlineAdd({ project_id: p.id, section_id: s.id })));
    }
  } else if (kind === 'label') {
    setHead(`@${arg}`, `${tasks.length} open task${tasks.length === 1 ? '' : 's'}`);
    nodes.push(group(null, {}, ...tasks.map((x) => taskRow(x))));
    if (!tasks.length) nodes.push(empty('tag', 'No open tasks with this label'));
  } else if (kind === 'search') {
    setHead(`Search: "${arg}"`, `${tasks.length} result${tasks.length === 1 ? '' : 's'}`);
    nodes.push(group(null, {}, ...tasks.map((x) => taskRow(x))));
    if (!tasks.length) nodes.push(empty('search', 'No tasks match', 'Search looks at titles and descriptions.'));
  } else if (kind === 'completed') {
    setHead('Completed', 'Most recent first');
    const byDay = new Map();
    for (const x of tasks) {
      const d = fmtDate(new Date(x.completed_at));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(x);
    }
    for (const [d, list] of byDay) nodes.push(group(dueLabel(d), {}, ...list.map((x) => taskRow(x))));
    if (!tasks.length) nodes.push(empty('done', 'Nothing completed yet', 'Ticked-off tasks show up here.'));
  } else if (kind === 'trash') {
    setHead('Trash', 'Deleted tasks are kept for 30 days');
    nodes.push(group(null, {}, ...tasks.map((x) => {
      const row = taskRow(x);
      row.append(h('button', {
        class: 'btn small',
        onclick: async (e) => {
          e.stopPropagation();
          try { await api('POST', `/tasks/${x.id}/restore`); toast('Restored'); refresh(); } catch (err) { showError(err); }
        },
      }, icon('undo', { size: 13 }), 'Restore'));
      return row;
    })));
    if (!tasks.length) nodes.push(empty('trash', 'Trash is empty'));
  } else {
    location.hash = '#/today';
    return;
  }
  fill(content, ...nodes);
}

async function renderMemory(content) {
  setHead('Memory', 'What the AI knows about how you work. Smart add, Plan my day and Claude (via MCP) all read this.');
  const items = await api('GET', '/memory');
  const input = h('input', { placeholder: 'e.g. "I do deep work before noon" or "Sanne is my manager"', 'aria-label': 'New memory' });
  const cat = h('input', { class: 'cat', placeholder: 'category', 'aria-label': 'Category' });
  const form = h('form', {
    class: 'memory-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        await api('POST', '/memory', { content: input.value, ...(cat.value.trim() ? { category: cat.value } : {}) });
        refresh();
      } catch (err) { showError(err); }
    },
  }, input, cat, h('button', { class: 'btn primary' }, icon('plus', { size: 14 }), 'Remember'));

  const byCat = new Map();
  for (const m of items) {
    if (!byCat.has(m.category)) byCat.set(m.category, []);
    byCat.get(m.category).push(m);
  }
  const cards = [...byCat].map(([c, list]) => h('div', { class: 'card' },
    h('div', { class: 'section-title' }, c),
    ...list.map((m) => h('div', { class: 'memory-item' },
      h('div', { class: 'body' }, m.content),
      m.source !== 'user' ? h('span', { class: `badge ${m.source}` }, m.source === 'mcp' ? 'Claude' : 'AI') : null,
      h('button', { class: 'icon-btn', title: 'Edit', 'aria-label': `Edit memory: ${m.content}`, onclick: () => formModal({
        title: 'Edit memory',
        fields: [{ name: 'content', label: 'Memory', value: m.content }, { name: 'category', label: 'Category', value: m.category }],
        onSubmit: async (v) => { await api('PATCH', `/memory/${m.id}`, v); refresh(); },
      }) }, icon('pencil', { size: 14 })),
      h('button', { class: 'icon-btn danger', title: 'Forget', 'aria-label': `Forget: ${m.content}`, onclick: async () => {
        try { await api('DELETE', `/memory/${m.id}`); refresh(); } catch (err) { showError(err); }
      } }, icon('x', { size: 15 }))))));
  fill(content, h('div', { class: 'card' }, form), ...cards,
    items.length ? null : empty('sparkles', 'Nothing remembered yet', 'Add how you like to work, your rhythms, the people you work with.'));
}

async function renderActivity(content) {
  setHead('Activity', 'Every change, and who made it');
  const items = await api('GET', '/activity?limit=200');
  const who = { user: ['You', ''], ai: ['AI', 'ai'], mcp: ['Claude', 'mcp'] };
  fill(content, h('div', { class: 'card' }, ...items.map((a) => h('div', { class: 'act' },
    h('time', { datetime: a.at }, new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
    h('span', { class: `badge ${who[a.actor]?.[1] ?? ''}` }, who[a.actor]?.[0] ?? a.actor),
    h('span', { class: 'what' }, a.summary)))), items.length ? null : empty('history', 'No activity yet'));
}

// ---------- project & section actions ----------

function addProject() {
  formModal({
    title: 'New project',
    fields: [{ name: 'name', label: 'Project name' }, { type: 'color', value: 'blue' }],
    submitLabel: 'Create',
    onSubmit: async (v) => {
      const p = await api('POST', '/projects', v);
      await refresh();
      location.hash = `#/project/${p.id}`;
    },
  });
}

function editProject(p) {
  formModal({
    title: 'Edit project',
    fields: [{ name: 'name', label: 'Project name', value: p.name }, { type: 'color', value: p.color }],
    onSubmit: async (v) => { await api('PATCH', `/projects/${p.id}`, v); refresh(); },
  });
}

async function archiveProject(p) {
  try {
    await api('POST', `/projects/${p.id}/archive`, { archived: true });
    location.hash = '#/today';
    toast(`Archived "${p.name}"`, 'Undo', async () => {
      await api('POST', `/projects/${p.id}/archive`, { archived: false });
      await refresh();
      location.hash = `#/project/${p.id}`;
    });
    refresh();
  } catch (e) { showError(e); }
}

function addSection(p) {
  formModal({
    title: 'New section', fields: [{ name: 'name', label: 'Section name' }], submitLabel: 'Add',
    onSubmit: async (v) => { await api('POST', '/sections', { project_id: p.id, name: v.name }); refresh(); },
  });
}

function renameSection(s) {
  formModal({
    title: 'Rename section', fields: [{ name: 'name', label: 'Section name', value: s.name }],
    onSubmit: async (v) => { await api('PATCH', `/sections/${s.id}`, v); refresh(); },
  });
}

async function deleteSection(s) {
  try {
    await api('DELETE', `/sections/${s.id}`);
    toast(`Deleted section "${s.name}". Its tasks moved to the top of the project.`);
    refresh();
  } catch (e) { showError(e); }
}

// ---------- task drawer ----------

let drawerOpener = null;

async function openTask(id) {
  const wasOpen = Boolean(state.openId);
  if (!wasOpen) drawerOpener = document.activeElement;
  state.openId = id;
  document.querySelectorAll('.task.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll(`.task[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add('selected'));
  await renderDrawer();
  // Move keyboard focus into the panel, so Tab continues where the eye goes.
  $('#drawer [data-fk="close"]')?.focus({ preventScroll: true });
}

function closeDrawer() {
  const id = state.openId;
  state.openId = null;
  const d = $('#drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  d.replaceChildren();
  document.querySelectorAll('.task.selected').forEach((el) => el.classList.remove('selected'));
  // Return focus to the row that opened the panel (or its replacement after a re-render).
  const target = (drawerOpener?.isConnected && drawerOpener) || (id && $(`.task[data-id="${CSS.escape(id)}"]`));
  target?.focus?.({ preventScroll: true });
  drawerOpener = null;
}

async function patch(id, body) {
  try {
    await api('PATCH', `/tasks/${id}`, body);
    await refresh();
  } catch (e) {
    showError(e);
    renderDrawer();
  }
}

async function renderDrawer() {
  const d = $('#drawer');
  if (!state.openId) return closeDrawer();
  let t, history;
  try {
    [t, history] = await Promise.all([
      api('GET', `/tasks/${state.openId}`),
      api('GET', `/activity?entity_id=${encodeURIComponent(state.openId)}&limit=15`),
    ]);
  } catch {
    return closeDrawer();
  }

  // Re-rendering after a save replaces every control; remember which one had focus so it can be restored.
  const focusKey = d.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  const fid = (k) => `d-${k}`;

  const title = h('textarea', { rows: 1, 'aria-label': 'Task title', value: t.content, 'data-fk': 'title' });
  const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  title.addEventListener('input', fit);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { if (title.value.trim() && title.value.trim() !== t.content) patch(t.id, { content: title.value.trim() }); });

  const desc = h('textarea', { class: 'd-desc', placeholder: 'Add a description', 'aria-label': 'Description', value: t.description, 'data-fk': 'desc' });
  desc.addEventListener('blur', () => { if (desc.value !== t.description) patch(t.id, { description: desc.value }); });

  const dueValue = [t.recurrence || t.due_date, t.due_time].filter(Boolean).join(' ');
  const due = h('input', { class: 'field-input', id: fid('due'), value: dueValue, placeholder: 'e.g. friday 3pm, every weekday', 'aria-describedby': fid('due-hint'), 'data-fk': 'due' });
  const saveDue = () => { if (due.value.trim() !== dueValue) patch(t.id, { due: due.value.trim() || null }); };
  due.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); due.blur(); } });
  due.addEventListener('blur', saveDue);
  const dueHint = t.recurrence
    ? `Repeats ${t.recurrence}. Next: ${dueLabel(t.due_date)}`
    : t.due_date ? parseDate(t.due_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Type a date in plain English';

  const prio = h('div', { class: 'prio-set', role: 'group', 'aria-labelledby': fid('prio-label') }, ...[1, 2, 3, 4].map((n) =>
    h('button', {
      class: `p${n}`, 'aria-pressed': String(t.priority === n), 'data-fk': `prio${n}`,
      title: ['', 'Urgent', 'High', 'Medium', 'None'][n],
      onclick: () => patch(t.id, { priority: n }),
    }, n < 4 ? icon('flag', { size: 12 }) : null, `P${n}`)));

  const project = h('select', { id: fid('project'), disabled: Boolean(t.parent_id), 'data-fk': 'project', onchange: (e) => patch(t.id, { project_id: e.target.value }) },
    ...state.boot.projects.map((p) => h('option', { value: p.id, selected: p.id === t.project_id }, p.name)));
  const sections = state.boot.sections.filter((s) => s.project_id === t.project_id);
  const section = sections.length ? h('select', { 'aria-label': 'Section', disabled: Boolean(t.parent_id), 'data-fk': 'section', onchange: (e) => patch(t.id, { section_id: e.target.value || null }) },
    h('option', { value: '' }, 'No section'),
    ...sections.map((s) => h('option', { value: s.id, selected: s.id === t.section_id }, s.name))) : null;

  const labels = h('input', { class: 'field-input', id: fid('labels'), value: t.labels.join(', '), placeholder: 'e.g. home, calls', 'data-fk': 'labels' });
  labels.addEventListener('blur', () => {
    const next = labels.value.split(',').map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
    if (next.join(',') !== t.labels.join(',')) patch(t.id, { labels: next });
  });

  const deadline = h('input', { class: 'field-input', id: fid('deadline'), type: 'date', value: t.deadline ?? '', 'data-fk': 'deadline', onchange: (e) => patch(t.id, { deadline: e.target.value || null }) });
  const duration = h('input', { class: 'field-input', id: fid('estimate'), type: 'number', inputmode: 'numeric', min: '1', max: '1440', value: t.duration_min ?? '', placeholder: 'minutes', 'data-fk': 'estimate' });
  duration.addEventListener('change', () => patch(t.id, { duration_min: duration.value ? Number(duration.value) : null }));

  const breakLabel = () => [icon('sparkles', { size: 13 }), 'Break down'];
  const breakBtn = h('button', {
    class: 'btn ai small', 'data-fk': 'breakdown',
    onclick: async () => {
      breakBtn.disabled = true;
      breakBtn.setAttribute('aria-busy', 'true');
      breakBtn.replaceChildren(spinner(), 'Thinking');
      try {
        const subs = await api('POST', `/ai/breakdown/${t.id}`);
        toast(`Added ${subs.length} subtasks`);
        await refresh();
      } catch (e) {
        showError(e);
        breakBtn.disabled = false;
        breakBtn.removeAttribute('aria-busy');
        breakBtn.replaceChildren(...breakLabel());
      }
    },
  }, ...breakLabel());

  const comment = h('textarea', { placeholder: 'Write a comment', 'aria-label': 'Add a comment', 'data-fk': 'comment' });
  const commentForm = h('form', {
    class: 'comment-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!comment.value.trim()) return;
      try { await api('POST', `/tasks/${t.id}/comments`, { body: comment.value }); await renderDrawer(); $('#drawer [data-fk="comment"]')?.focus(); } catch (err) { showError(err); }
    },
  }, comment, h('div', { class: 'modal-actions' }, h('button', { class: 'btn small' }, icon('comment', { size: 13 }), 'Comment')));
  comment.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commentForm.requestSubmit(); });

  const who = { user: 'You', ai: 'AI', mcp: 'Claude' };
  const parent = t.parent_id ? await api('GET', `/tasks/${t.parent_id}`).catch(() => null) : null;
  const subDone = t.subtasks.filter((s) => s.completed_at).length;
  const progress = t.subtasks.length ? h('div', {
    class: 'progress', role: 'progressbar', 'aria-label': 'Subtasks done',
    'aria-valuemin': '0', 'aria-valuemax': String(t.subtasks.length), 'aria-valuenow': String(subDone),
  }, h('span')) : null;
  if (progress) progress.firstChild.style.width = `${(subDone / t.subtasks.length) * 100}%`;
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  d.replaceChildren(h('div', { class: 'drawer-inner' },
    h('div', { class: 'drawer-top' },
      dot(t.project_color), h('span', {}, t.project_name + (t.section_name ? ` / ${t.section_name}` : '')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close task details', 'data-fk': 'close', onclick: closeDrawer }, icon('x', { size: 18 }))),
    parent ? h('div', { class: 'hint' }, 'Subtask of ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openTask(parent.id); } }, parent.content)) : null,
    h('div', { class: 'd-title' },
      h('button', {
        class: `check p${t.priority}${t.completed_at ? ' checked' : ''}`, 'data-fk': 'check',
        'aria-label': t.completed_at ? 'Mark as not done' : 'Complete task', 'aria-pressed': String(Boolean(t.completed_at)),
        onclick: (e) => toggleComplete(t, e.currentTarget),
      }, icon('check', { size: 12 })),
      title),
    desc,
    h('div', { class: 'fields' },
      h('label', { for: fid('due') }, 'Due'), h('div', {}, due, h('div', { class: 'hint', id: fid('due-hint') }, dueHint)),
      h('span', { id: fid('prio-label'), class: 'field-name' }, 'Priority'), prio,
      h('label', { for: fid('project') }, 'Project'), h('div', { class: 'field-row' }, project, section),
      h('label', { for: fid('labels') }, 'Labels'), labels,
      h('label', { for: fid('deadline') }, 'Deadline'), deadline,
      h('label', { for: fid('estimate') }, 'Estimate'), duration,
    ),
    h('div', { class: 'section-title' }, 'Subtasks', t.subtasks.length ? h('span', { class: 'count' }, `${subDone}/${t.subtasks.length}`) : null, h('span', { class: 'spacer' }), breakBtn),
    progress,
    ...t.subtasks.map((s) => taskRow(s, 0, { showProject: false })),
    inlineAdd({ parent_id: t.id }, 'Add subtask'),
    h('div', { class: 'section-title' }, 'Comments', t.comments.length ? h('span', { class: 'count' }, String(t.comments.length)) : null),
    ...t.comments.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'who' }, `${who[c.author] ?? c.author} · ${when(c.created_at)}`),
      h('div', { class: 'comment-body' }, c.body))),
    commentForm,
    h('div', { class: 'section-title' }, 'History'),
    h('div', { class: 'history' }, ...history.map((a) => h('div', {}, `${when(a.at)} · ${who[a.actor] ?? a.actor}: ${a.summary}`))),
    h('div', { class: 'drawer-foot' }, t.deleted_at
      ? h('button', { class: 'btn', onclick: async () => { try { await api('POST', `/tasks/${t.id}/restore`); refresh(); } catch (e) { showError(e); } } }, icon('undo', { size: 14 }), 'Restore')
      : h('button', {
        class: 'btn danger',
        onclick: async () => {
          try {
            await api('DELETE', `/tasks/${t.id}`);
            closeDrawer();
            toast(`Deleted "${t.content}"`, 'Undo', async () => { await api('POST', `/tasks/${t.id}/restore`); refresh(); });
            refresh();
          } catch (e) { showError(e); }
        },
      }, icon('trash', { size: 14 }), 'Delete task')),
  ));
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  if (focusKey) d.querySelector(`[data-fk="${focusKey}"]`)?.focus({ preventScroll: true });
  requestAnimationFrame(fit);
}

// ---------- refresh & live updates ----------

let refreshing = null;
async function refresh({ fromPoll = false } = {}) {
  // Coalesce overlapping refreshes into one.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      state.boot = await api('GET', '/bootstrap');
      state.head = state.boot.activity_head;
      renderSidebar();
      await renderView();
      renderPreview();
      // Don't yank the drawer out from under someone who is typing in it.
      if (state.openId && !(fromPoll && $('#drawer').contains(document.activeElement))) await renderDrawer();
    } catch (e) {
      if (!fromPoll) showError(e);
    }
  })();
  try { await refreshing; } finally { refreshing = null; }
}

// Picks up changes made elsewhere (Claude via MCP, another tab) within a few seconds.
setInterval(async () => {
  if (document.hidden) return;
  try {
    const { id } = await api('GET', '/activity/head');
    if (id !== state.head) refresh({ fromPoll: true });
  } catch { /* server stopped; try again next tick */ }
}, 4000);

// ---------- wiring ----------

$('#quick-input').addEventListener('input', renderPreview);
$('#quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#quick-input');
  if (!input.value.trim()) return;
  try {
    const task = await createFromQuickAdd(input.value, routeDefaults());
    input.value = '';
    renderPreview();
    toast(`Added "${task.content}" to ${task.project_name}`);
    await refresh();
  } catch (err) { showError(err); }
});
$('#smart-add').addEventListener('click', openSmartAdd);
$('#add-project').addEventListener('click', addProject);

// Mobile menu: a scrim behind the sidebar closes it, and the button reports its state.
function setMenu(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
  $('#menu-btn').setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  if (open) $('#sidebar a.active, #sidebar a')?.focus();
}
$('#menu-btn').addEventListener('click', () => setMenu(!$('#sidebar').classList.contains('open')));
$('#scrim').addEventListener('click', () => setMenu(false));
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
});

window.addEventListener('hashchange', async () => {
  state.route = parseRoute();
  const fromMenu = $('#sidebar').contains(document.activeElement);
  setMenu(false);
  renderSidebar();
  await renderView();
  renderPreview();
  // After navigating, put screen reader and keyboard users at the top of the new view.
  if (fromMenu) $('#view-title').focus({ preventScroll: true });
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (typing) document.activeElement.blur();
    else if ($('#sidebar').classList.contains('open')) { setMenu(false); $('#menu-btn').focus(); }
    else if (state.openId) closeDrawer();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#modal-root').childElementCount) return;
  if (e.key === 'q' || e.key === 'n') { e.preventDefault(); $('#quick-input').focus(); }
  if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); }
  if (e.key === 's') { e.preventDefault(); openSmartAdd(); }
});

// Static icons in index.html are placeholders (<span data-icon="...">) filled in here.
const ICON_SIZES = { menu: 20, plus: 18, check: 15 };
for (const el of document.querySelectorAll('[data-icon]')) el.append(icon(el.dataset.icon, { size: ICON_SIZES[el.dataset.icon] ?? 15 }));

state.route = parseRoute();
fill($('#content'), skeleton());
refresh();
