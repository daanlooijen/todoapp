import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDate, nextDue } from '../src/shared/dates.js';
import { parseQuickAdd } from '../src/shared/quickadd.js';

const now = new Date(2026, 9, 21, 14, 0); // Wednesday 21 Oct 2026, 14:00
const x = (s) => extractDate(s, now);

test('relative dates and times', () => {
  assert.deepEqual([x('call mom tomorrow at 5').date, x('call mom tomorrow at 5').time], ['2026-10-22', '17:00']);
  assert.equal(x('report in 2 weeks').date, '2026-11-04');
  assert.equal(x('send invoice friday').date, '2026-10-23');
  assert.equal(x('review next friday').date, '2026-10-30');
  assert.equal(x('dentist 3 nov 9:30am').time, '09:30');
  assert.equal(x('trip 2026-12-24').date, '2026-12-24');
  assert.equal(x('pay 1/2').date, '2027-02-01'); // day first, rolls to next year
  assert.equal(x('call tom').date, null); // names are not dates
});

test('recurrence', () => {
  assert.equal(x('standup every weekday 9:15').recurrence, 'every weekday');
  assert.equal(x('gym every mon, wed and fri 7am').recurrence, 'every mon,wed,fri');
  assert.equal(x('pay every 15th').date, '2026-11-15');
  assert.equal(x('plants every! 3 days').recurrence, 'every! 3 days');
  assert.equal(x('standup daily').recurrence, 'every day');
  const r = x('Send weekly update every friday 4pm');
  assert.deepEqual([r.text, r.recurrence, r.date, r.time], ['Send weekly update', 'every fri', '2026-10-23', '16:00']);
});

test('next occurrence', () => {
  assert.equal(nextDue('every weekday', '2026-10-23', now), '2026-10-26');
  assert.equal(nextDue('every day', '2026-10-10', now), '2026-10-22'); // overdue skips ahead
  assert.equal(nextDue('every month on 31', '2026-10-31', new Date(2026, 9, 31)), '2026-11-30');
  assert.equal(nextDue('every month on 31', '2026-11-30', new Date(2026, 10, 30)), '2026-12-31');
  assert.equal(nextDue('every! 3 days', '2026-10-01', now), '2026-10-24');
});

test('quick add tokens', () => {
  const p = parseQuickAdd('Fix bug #side_project @code p1 // see issue 12', { projects: [{ id: 'a', name: 'Side project' }], now });
  assert.deepEqual([p.content, p.project_id, p.labels, p.priority, p.description], ['Fix bug', 'a', ['code'], 1, 'see issue 12']);
  assert.equal(parseQuickAdd('Plan #Unknown', { now }).content, 'Plan #Unknown');
});
