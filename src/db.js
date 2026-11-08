import { DatabaseSync } from 'node:sqlite';
import { slugify } from './slugify.js';

// The schema lives in migrations/; run `pnpm migrate` first.
const DB_PATH = process.env.DB_PATH || 'data/app.db';
export const db = new DatabaseSync(DB_PATH);

// Creates a named room. Its slug comes from the name, with a number added if it's taken.
export function createRoom(name) {
  // Strip accents first, so "María" becomes "maria", not "mara".
  const base = slugify(name.normalize('NFD').replace(/\p{Diacritic}/gu, '')) || 'room';
  let slug = base;
  for (let n = 2; getRoom(slug); n++) slug = `${base}-${n}`;

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO rooms (id, name, slug) VALUES (?, ?, ?)').run(id, name, slug);
  return { id, slug };
}

export function getRoom(slug) {
  return db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug);
}

// Renaming keeps the slug, so the volunteer's link still works.
export function renameRoom(id, name) {
  db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, id);
}

// Each room with its latest message, most recently active first.
export function listRooms() {
  return db
    .prepare(`
    SELECT r.id, r.name, r.slug, m.text, m.sender, m.photo_type IS NOT NULL AS has_photo,
           COALESCE(m.created_at, r.created_at) AS last_at,
           EXISTS (
             SELECT 1 FROM messages
             WHERE room_id = r.id AND sender = 'volunteer' AND id > r.last_read_message_id
           ) AS unread
    FROM rooms r
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE room_id = r.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY last_at DESC
  `)
    .all();
}

export function listMessages(roomId) {
  return db
    .prepare(`
    SELECT id, text, sender, photo_type IS NOT NULL AS has_photo, lat, created_at
    FROM messages WHERE room_id = ? ORDER BY id
  `)
    .all(roomId);
}

export function addMessage(roomId, sender, text, photo, photoType, lat, lng) {
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO messages (room_id, sender, text, photo, photo_type, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(roomId, sender, text, photo ?? null, photoType ?? null, lat ?? null, lng ?? null);
  return Number(lastInsertRowid);
}

export function markRead(roomId) {
  db.prepare(`
    UPDATE rooms
    SET last_read_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE room_id = ?)
    WHERE id = ?
  `).run(roomId, roomId);
}

export function getPhoto(messageId) {
  return db
    .prepare('SELECT photo, photo_type FROM messages WHERE id = ? AND photo IS NOT NULL')
    .get(messageId);
}

// Each colony with its current state.
export function listColonies() {
  return db
    .prepare(`
    SELECT c.id, c.name, c.description, c.address, c.lat, c.lng,
           (SELECT COUNT(*) FROM cats WHERE colony_id = c.id AND status = 'active') AS cats,
           (SELECT COUNT(*) FROM cats WHERE colony_id = c.id AND status = 'active' AND fixed) AS fixed,
           (SELECT COUNT(*) FROM cats WHERE colony_id = c.id AND status = 'pending') AS new_cats,
           (SELECT COUNT(*) FROM flags WHERE colony_id = c.id AND resolved_at IS NULL) AS urgent,
           (SELECT MAX(created_at) FROM feedings WHERE colony_id = c.id) AS last_fed_at
    FROM colonies c ORDER BY c.name
  `)
    .all();
}

export function getColony(id) {
  return listColonies().find((colony) => colony.id === Number(id));
}

// A colony's confirmed and newly reported cats, with their open flags.
export function listColonyCats(colonyId) {
  return db
    .prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM sightings WHERE cat_id = c.id) AS sightings,
           (SELECT MAX(created_at) FROM sightings WHERE cat_id = c.id) AS last_seen_at,
           (SELECT group_concat(kind, ', ') FROM flags WHERE cat_id = c.id AND resolved_at IS NULL) AS open_flags
    FROM cats c WHERE c.colony_id = ? AND c.status IN ('pending', 'active')
    ORDER BY c.status = 'pending' DESC, c.id
  `)
    .all(colonyId);
}

// Newly reported cats waiting for the rescue to confirm them, across all colonies.
export function listPendingCats() {
  return db
    .prepare(`
    SELECT c.*, col.name AS colony_name, same.name AS same_name, same.coat AS same_coat,
           same.photo_message_id AS same_photo_message_id,
           (SELECT COUNT(*) FROM sightings WHERE cat_id = c.id) AS sightings,
           (SELECT group_concat(kind, ', ') FROM flags WHERE cat_id = c.id AND resolved_at IS NULL) AS open_flags
    FROM cats c
    JOIN colonies col ON col.id = c.colony_id
    LEFT JOIN cats same ON same.id = c.maybe_same_as
    WHERE c.status = 'pending' ORDER BY c.id
  `)
    .all();
}

// The colony's recent feedings, newest first, with who fed.
export function listFeedings(colonyId) {
  return db
    .prepare(`
    SELECT f.created_at, r.slug AS room_slug, r.name FROM feedings f LEFT JOIN rooms r ON r.id = f.room_id
    WHERE f.colony_id = ? ORDER BY f.id DESC LIMIT 10
  `)
    .all(colonyId);
}

// Unresolved urgent cases, newest first: one colony's, or every colony's if none is given.
export function listOpenFlags(colonyId = null) {
  return db
    .prepare(`
    SELECT f.id, f.kind, f.note, f.created_at, f.colony_id, f.cat_id, col.name AS colony_name,
           c.name AS cat_name, c.coat AS cat_coat
    FROM flags f JOIN colonies col ON col.id = f.colony_id LEFT JOIN cats c ON c.id = f.cat_id
    WHERE (?1 IS NULL OR f.colony_id = ?1) AND f.resolved_at IS NULL ORDER BY f.id DESC
  `)
    .all(colonyId);
}

// The colony's handled urgent cases, newest first, with what the rescue wrote.
export function listHandledFlags(colonyId) {
  return db
    .prepare(`
    SELECT f.kind, f.note, f.resolution, f.resolved_at, f.cat_id, c.name AS cat_name, c.coat AS cat_coat
    FROM flags f LEFT JOIN cats c ON c.id = f.cat_id
    WHERE f.colony_id = ? AND f.resolved_at IS NOT NULL ORDER BY f.resolved_at DESC LIMIT 20
  `)
    .all(colonyId);
}

export function getFlag(id) {
  return db.prepare('SELECT * FROM flags WHERE id = ?').get(id);
}

export function resolveFlag(id, note) {
  db.prepare(
    'UPDATE flags SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ? AND resolved_at IS NULL',
  ).run(note, id);
}

// Every cat except ignored reports, with its colony and any cat it might be.
// Urgent cats first, then likely duplicates, then new ones, then newest.
export function listAllCats() {
  return db
    .prepare(`
    SELECT c.*, col.name AS colony_name, same.name AS same_name, same.coat AS same_coat,
           same.photo_message_id AS same_photo_message_id,
           (SELECT COUNT(*) FROM sightings WHERE cat_id = c.id) AS sightings,
           (SELECT MAX(created_at) FROM sightings WHERE cat_id = c.id) AS last_seen_at,
           (SELECT group_concat(kind, ', ') FROM flags WHERE cat_id = c.id AND resolved_at IS NULL) AS open_flags
    FROM cats c JOIN colonies col ON col.id = c.colony_id
    LEFT JOIN cats same ON same.id = c.maybe_same_as AND same.status != 'rejected'
    WHERE c.status != 'rejected'
    ORDER BY open_flags IS NULL, same.id IS NULL, c.status = 'pending' DESC, c.id DESC
  `)
    .all();
}

export function getCat(id) {
  return db
    .prepare(`
    SELECT c.*, col.name AS colony_name,
           (SELECT group_concat(kind, ', ') FROM flags WHERE cat_id = c.id AND resolved_at IS NULL) AS open_flags
    FROM cats c JOIN colonies col ON col.id = c.colony_id WHERE c.id = ?
  `)
    .get(id);
}

// Everything that happened to the cat, newest first: reports (with photo and reporter),
// urgent cases and how they were handled, and what the rescue did.
export function listCatHistory(catId) {
  return db
    .prepare(`
    SELECT m.created_at AS at, 'Reported' AS what, s.note, s.message_id,
           m.photo_type IS NOT NULL AS has_photo, r.name AS room_name, r.slug AS room_slug
    FROM sightings s JOIN messages m ON m.id = s.message_id JOIN rooms r ON r.id = m.room_id
    WHERE s.cat_id = ?1
    UNION ALL
    SELECT created_at, 'Urgent: ' || kind, note, NULL, 0, NULL, NULL FROM flags WHERE cat_id = ?1
    UNION ALL
    SELECT resolved_at, 'Handled: ' || kind, resolution, NULL, 0, NULL, NULL
    FROM flags WHERE cat_id = ?1 AND resolved_at IS NOT NULL
    UNION ALL
    SELECT created_at, what, note, NULL, 0, NULL, NULL FROM cat_events WHERE cat_id = ?1
    ORDER BY at DESC
  `)
    .all(catId);
}

export function logCatEvent(catId, what, note = null) {
  db.prepare('INSERT INTO cat_events (cat_id, what, note) VALUES (?, ?, ?)').run(catId, what, note);
}

// Totals across all colonies, for the team and for sponsors.
export function catTotals() {
  return db
    .prepare(`
    SELECT SUM(status = 'active') AS cats,
           SUM(status = 'active' AND fixed) AS fixed,
           SUM(status = 'active' AND NOT fixed) AS need_tnr,
           SUM(fixed_at IS NOT NULL) AS fixed_by_us,
           SUM(fixed_at >= strftime('%Y-01-01', 'now')) AS fixed_this_year,
           SUM(status = 'adopted') AS adopted
    FROM cats
  `)
    .get();
}

// The rescue fixed this cat (TNR done).
export function markFixed(catId) {
  const { changes } = db
    .prepare('UPDATE cats SET fixed = 1, fixed_at = CURRENT_TIMESTAMP WHERE id = ? AND NOT fixed')
    .run(catId);
  if (changes) logCatEvent(catId, 'Fixed (TNR done)');
}

export function resolveCatFlags(catId, note) {
  db.prepare(
    'UPDATE flags SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE cat_id = ? AND resolved_at IS NULL',
  ).run(note, catId);
}

// Moves a cat registered to the wrong colony, along with its flags.
export function moveCat(catId, colonyId) {
  db.prepare('UPDATE cats SET colony_id = ? WHERE id = ?').run(colonyId, catId);
  db.prepare('UPDATE flags SET colony_id = ? WHERE cat_id = ?').run(colonyId, catId);
  const { name } = db.prepare('SELECT name FROM colonies WHERE id = ?').get(colonyId);
  logCatEvent(catId, `Moved to ${name}`);
}

// The rescue says the two records are different cats.
export function clearSameCat(catId) {
  db.prepare('UPDATE cats SET maybe_same_as = NULL WHERE id = ?').run(catId);
}

const STATUS_EVENTS = { active: 'Added to colony', rejected: 'Ignored' };

export function setCatStatus(catId, status) {
  db.prepare('UPDATE cats SET status = ? WHERE id = ?').run(status, catId);
  logCatEvent(catId, STATUS_EVENTS[status] ?? `Marked ${status}`);
}

// Folds a duplicate record into the cat it really is.
export function mergeCats(keepId, duplicateId) {
  // A mistyped number would otherwise delete the duplicate and orphan its history.
  if (!db.prepare('SELECT 1 FROM cats WHERE id = ?').get(keepId)) return;
  for (const table of ['sightings', 'flags', 'cat_events']) {
    db.prepare(`UPDATE ${table} SET cat_id = ? WHERE cat_id = ?`).run(keepId, duplicateId);
  }
  db.prepare(`
    UPDATE cats SET photo_message_id = COALESCE(photo_message_id,
      (SELECT photo_message_id FROM cats WHERE id = ?))
    WHERE id = ?
  `).run(duplicateId, keepId);
  db.prepare('UPDATE cats SET maybe_same_as = NULL WHERE maybe_same_as = ?').run(duplicateId);
  db.prepare('DELETE FROM cats WHERE id = ?').run(duplicateId);
  logCatEvent(keepId, `Merged duplicate record #${duplicateId}`);
}

export function createColony(name, description, address, lat, lng) {
  db.prepare(
    'INSERT INTO colonies (name, description, address, lat, lng) VALUES (?, ?, ?, ?, ?)',
  ).run(name, description, address, lat, lng);
}

export function listPendingApprovals() {
  return db
    .prepare(`
      SELECT a.id, r.slug AS room_slug, r.name AS room_name, a.summary, a.created_at
      FROM approvals a JOIN rooms r ON r.id = a.room_id WHERE a.decided_at IS NULL
    `)
    .all();
}
