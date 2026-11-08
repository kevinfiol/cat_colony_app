import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { compile } from 'tempura';

// Exercise the real schema without touching the app's database or calling the agent.
process.env.DB_PATH = ':memory:';
const { db, listAdminNotifications, setCatStatus, clearSameCat, mergeCats, resolveFlag } =
  await import('../src/db.js');
const migrations = new URL('../migrations/', import.meta.url);
for (const file of readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  db.exec(readFileSync(new URL(file, migrations), 'utf8'));
}
const render = compile(
  readFileSync(new URL('../src/views/notifications.hbs', import.meta.url), 'utf8'),
);
after(() => db.close());

beforeEach(() => {
  for (const table of [
    'cat_events',
    'flags',
    'sightings',
    'approvals',
    'cats',
    'colonies',
    'rooms',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec(`
    INSERT INTO colonies (id, name) VALUES (1, 'Demo Garden');
    INSERT INTO rooms (id, name, slug) VALUES ('demo', 'Demo Feeder', 'demo-feeder');
  `);
});

test('combines pending decisions, puts urgent cases first, and counts a new duplicate once', () => {
  db.exec(`
    INSERT INTO cats (id, colony_id, name, coat, status, maybe_same_as) VALUES
      (1, 1, 'Mango', 'ginger', 'active', NULL),
      (2, 1, 'New report', 'ginger', 'pending', 1),
      (3, 1, 'Pepper', 'black', 'pending', NULL),
      (4, 1, 'Ignored', 'gray', 'rejected', 1),
      (5, 1, 'Another report', 'ginger', 'active', 1);
    INSERT INTO flags (id, colony_id, kind, created_at) VALUES
      (1, 1, 'no_feeder', '2026-01-01 09:00:00');
    INSERT INTO flags (colony_id, kind, resolved_at) VALUES
      (1, 'kittens', CURRENT_TIMESTAMP);
  `);
  for (const status of ['adopted', 'missing', 'deceased']) {
    db.prepare('INSERT INTO approvals (room_id, summary, run_state) VALUES (?, ?, ?)').run(
      'demo',
      `Mark Mango as ${status}`,
      'unused',
    );
  }
  const items = listAdminNotifications();
  assert.equal(items.length, 7);
  assert.equal(items[0].kind, 'Urgent');
  assert.equal(items.filter((item) => item.id === 'cat-2').length, 1);
  assert.equal(items.find((item) => item.id === 'cat-2').kind, 'Possible duplicate');
  assert.equal(items.find((item) => item.id === 'cat-3').kind, 'New cat to confirm');
  assert.ok(items.some((item) => item.id === 'cat-5'));
  assert.ok(!items.some((item) => item.id === 'cat-4'));
  assert.equal(items.filter((item) => item.kind === 'Approval needed').length, 3);
  assert.deepEqual(listAdminNotifications(), items, 'reading notifications must not dismiss them');
});

test('notifications follow confirmations, duplicate decisions, merges, handled flags and approvals', () => {
  db.exec(`
    INSERT INTO cats (id, colony_id, name, status, maybe_same_as) VALUES
      (1, 1, 'Mango', 'active', NULL),
      (2, 1, 'New report', 'pending', 1),
      (3, 1, 'Duplicate', 'active', 1),
      (4, 1, 'Unconfirmed', 'pending', NULL);
    INSERT INTO flags (id, colony_id, cat_id, kind) VALUES (1, 1, 1, 'injured');
    INSERT INTO approvals (id, room_id, summary, run_state) VALUES
      (1, 'demo', 'Mark Mango as adopted', 'unused');
  `);
  assert.equal(listAdminNotifications().length, 5);
  clearSameCat(2);
  assert.equal(
    listAdminNotifications().find((item) => item.id === 'cat-2').kind,
    'New cat to confirm',
  );
  setCatStatus(2, 'active');
  mergeCats(1, 3);
  setCatStatus(4, 'rejected');
  resolveFlag(1, null);
  db.exec('UPDATE approvals SET approved = 0, decided_at = CURRENT_TIMESTAMP WHERE id = 1');
  assert.deepEqual(listAdminNotifications(), []);
});

test('ignores invalid duplicate suggestions but keeps unconfirmed cats in the queue', () => {
  db.exec(`
    INSERT INTO cats (id, colony_id, name, status, maybe_same_as) VALUES
      (1, 1, 'Ignored', 'rejected', NULL),
      (2, 1, 'Known', 'active', 1),
      (3, 1, 'New', 'pending', 1),
      (4, 1, 'Self reference', 'active', 4);
  `);
  const items = listAdminNotifications();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'cat-3');
  assert.equal(items[0].kind, 'New cat to confirm');
});

test('renders an empty state and escapes names and reports in the dropdown', () => {
  assert.match(render({ items: [] }), /All caught up/);
  assert.match(render({ items: [] }), /0 pending actions/);
  db.prepare('INSERT INTO cats (colony_id, name) VALUES (1, ?)').run(
    '<img src=x onerror=alert(1)>',
  );
  const markup = render({ items: listAdminNotifications() });
  assert.match(markup, /1 pending action/);
  assert.ok(markup.includes('&lt;img'));
  assert.ok(!markup.includes('<img src=x'));
});
