// Applies the .sql files in migrations/ that haven't run on this database yet.
// Usage: pnpm migrate (DB_PATH picks the database, default data/app.db)
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || 'data/app.db';
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// Migration files start with a number and an underscore, e.g. 001_create_rooms_table.sql
const FILENAME_REGEX = /^\d+_.+\.sql$/;
const directory = new URL('../migrations', import.meta.url).pathname;

db.exec(`
  create table if not exists migrations (
    id integer primary key,
    name text not null unique,
    created_at text not null default CURRENT_TIMESTAMP
  )
`);

const migrations = readdirSync(directory)
  .filter((name) => FILENAME_REGEX.test(name))
  .sort()
  .map((name) => ({ id: Number.parseInt(name), name }));

// Numbers must run 1, 2, 3... with no gaps or repeats.
migrations.forEach((migration, index) => {
  if (migration.id !== index + 1) {
    throw Error(`Inconsistent migration numbering at ${migration.name}`);
  }
});

const { currentId } = db.prepare('select max(id) as currentId from migrations').get();
const needed = migrations.slice(currentId ?? 0);

for (const migration of needed) {
  const sql = readFileSync(join(directory, migration.name), 'utf8');
  try {
    db.exec('begin immediate transaction');
    db.exec(sql);
    db.prepare('insert into migrations (id, name) values (?, ?)').run(migration.id, migration.name);
    db.exec('commit');
    console.log(`Applied ${migration.name}`);
  } catch (error) {
    db.exec('rollback');
    console.error(`Failed on ${migration.name}:`, error);
    process.exit(1);
  }
}

console.log(`Migrations run: ${needed.length}`);
db.close();
