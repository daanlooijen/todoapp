import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PathError, safeJoin } from '../src/agent.js';

// safeJoin is the boundary that keeps the AI's writes inside a ticket's draft folder.
test('safeJoin keeps paths inside the draft folder', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-')));
  assert.equal(safeJoin(root, 'models/a.sql'), path.join(root, 'models', 'a.sql'));
  assert.equal(safeJoin(root, './README.md'), path.join(root, 'README.md'));
  for (const bad of ['../escape.sql', 'models/../../escape.sql', '/etc/passwd', 'C:\\Windows\\x', '', '.', '..']) {
    assert.throws(() => safeJoin(root, bad), PathError, bad);
  }
  // A symlink planted inside the folder must not become a way out.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => safeJoin(root, 'link/evil.sql'), /symlinks/);
});
