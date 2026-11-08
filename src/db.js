import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || 'data/app.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    text TEXT,
    photo BLOB,
    photo_type TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS colonies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    lat REAL,
    lng REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cats (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    name TEXT,
    coat TEXT,
    markings TEXT,
    -- Ear-tipped or otherwise known to be neutered.
    fixed INTEGER NOT NULL DEFAULT 0,
    -- 'pending' (reported, not yet confirmed by the rescue), 'active', 'adopted',
    -- 'missing' or 'rejected'
    status TEXT NOT NULL DEFAULT 'pending',
    -- Best reference photo, used to recognize the cat again.
    photo_message_id INTEGER REFERENCES messages(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Each report of a cat; its history.
  CREATE TABLE IF NOT EXISTS sightings (
    id INTEGER PRIMARY KEY,
    cat_id INTEGER NOT NULL REFERENCES cats(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    message_id INTEGER REFERENCES messages(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Urgent cases. kind: 'pregnant', 'injured', 'sick', 'kittens' or 'no_feeder'.
  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY,
    colony_id INTEGER NOT NULL REFERENCES colonies(id),
    cat_id INTEGER REFERENCES cats(id),
    kind TEXT NOT NULL,
    note TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Agent runs paused until a person approves or rejects an action.
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    summary TEXT NOT NULL,
    run_state TEXT NOT NULL,
    approved INTEGER,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Adds a column to databases created before that column existed.
function addColumn(table, column, definition) {
  const exists = db
    .prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 'volunteer' or 'admin'
addColumn('messages', 'sender', "TEXT NOT NULL DEFAULT 'volunteer'");
// Latest message the admin has seen; newer volunteer messages are unread.
addColumn('rooms', 'last_read_message_id', 'INTEGER NOT NULL DEFAULT 0');
// Volunteer's name and phone; seen only by the rescue.
addColumn('rooms', 'name', 'TEXT');
addColumn('rooms', 'phone', 'TEXT');
// Shared location, if the volunteer sent one.
addColumn('messages', 'lat', 'REAL');
addColumn('messages', 'lng', 'REAL');
// A known cat the agent thinks a newly reported cat might be.
addColumn('cats', 'maybe_same_as', 'INTEGER REFERENCES cats(id)');

export function createRoom() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO rooms (id) VALUES (?)').run(id);
  return id;
}

export function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

// Each room with its latest message, most recently active first.
export function listRooms() {
  return db
    .prepare(`
    SELECT r.id, m.text, m.sender, m.photo_type IS NOT NULL AS has_photo,
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
    SELECT c.id, c.name, c.description, c.lat, c.lng,
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
    SELECT f.created_at, f.room_id, r.name FROM feedings f JOIN rooms r ON r.id = f.room_id
    WHERE f.colony_id = ? ORDER BY f.id DESC LIMIT 10
  `)
    .all(colonyId);
}

export function listOpenFlags(colonyId) {
  return db
    .prepare(`
    SELECT f.kind, f.note, f.created_at, c.name AS cat_name, c.coat AS cat_coat
    FROM flags f LEFT JOIN cats c ON c.id = f.cat_id
    WHERE f.colony_id = ? AND f.resolved_at IS NULL ORDER BY f.id DESC
  `)
    .all(colonyId);
}

export function setCatStatus(catId, status) {
  db.prepare('UPDATE cats SET status = ? WHERE id = ?').run(status, catId);
}

// Folds a duplicate record into the cat it really is.
export function mergeCats(keepId, duplicateId) {
  for (const table of ['sightings', 'flags']) {
    db.prepare(`UPDATE ${table} SET cat_id = ? WHERE cat_id = ?`).run(keepId, duplicateId);
  }
  db.prepare(`
    UPDATE cats SET photo_message_id = COALESCE(photo_message_id,
      (SELECT photo_message_id FROM cats WHERE id = ?))
    WHERE id = ?
  `).run(duplicateId, keepId);
  db.prepare('UPDATE cats SET maybe_same_as = NULL WHERE maybe_same_as = ?').run(duplicateId);
  db.prepare('DELETE FROM cats WHERE id = ?').run(duplicateId);
}

export function createColony(name, description, lat, lng) {
  db.prepare('INSERT INTO colonies (name, description, lat, lng) VALUES (?, ?, ?, ?)').run(
    name,
    description,
    lat,
    lng,
  );
}

export function listPendingApprovals() {
  return db
    .prepare('SELECT id, room_id, summary, created_at FROM approvals WHERE decided_at IS NULL')
    .all();
}
