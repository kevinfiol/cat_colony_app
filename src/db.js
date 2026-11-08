import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || 'data/app.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

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
    SELECT id, text, sender, photo_type IS NOT NULL AS has_photo, created_at
    FROM messages WHERE room_id = ? ORDER BY id
  `)
    .all(roomId);
}

export function addMessage(roomId, sender, text, photo, photoType) {
  db.prepare(
    'INSERT INTO messages (room_id, sender, text, photo, photo_type) VALUES (?, ?, ?, ?, ?)',
  ).run(roomId, sender, text, photo, photoType);
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
