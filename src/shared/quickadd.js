// Quick-add syntax, modelled on Todoist:
//   "Pay rent every month on 1 #Home @bills p1 // transfer from savings"
//   #Project   moves to an existing project (use _ for spaces: #Side_project)
//   @label     adds a label (created if new)
//   p1..p4     priority (p1 = urgent, p4 = none)
//   // text    everything after becomes the description
// Dates, times and recurrence are pulled out by extractDate().
import { extractDate } from './dates.js';

const norm = (s) => s.toLowerCase().replace(/[_-]+/g, ' ').trim();

export function parseQuickAdd(input, { projects = [], now = new Date() } = {}) {
  let text = String(input);
  let description = null;

  const slash = text.indexOf(' // ');
  if (slash >= 0) {
    description = text.slice(slash + 4).trim() || null;
    text = text.slice(0, slash);
  }

  let priority = 4;
  text = text.replace(/(^|\s)p([1-4])(?=\s|$)/i, (_, pre, p) => {
    priority = Number(p);
    return pre;
  });

  let project = null;
  text = text.replace(/(^|\s)#([\p{L}\p{N}_-]+)/u, (whole, pre, name) => {
    const found = projects.find((p) => norm(p.name) === norm(name));
    if (!found) return whole; // unknown project stays in the text, like Todoist
    project = found;
    return pre;
  });

  const labels = [];
  text = text.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (_, pre, name) => {
    if (!labels.includes(name.toLowerCase())) labels.push(name.toLowerCase());
    return pre;
  });

  const due = extractDate(text, now);

  return {
    content: due.text,
    description,
    priority,
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    labels,
    due_date: due.date,
    due_time: due.time,
    recurrence: due.recurrence,
    matched_dates: due.matched,
  };
}
