// Fills an empty database with made-up colonies, volunteers and reports.
// Each report goes through the agent, as if a volunteer sent it from their phone.
// Usage: DB_PATH=data/demo.db pnpm seed
import { readFileSync } from 'node:fs';
import { db, createRoom, createColony, addMessage } from '../src/db.js';
import { respond } from '../src/agent.js';

if (db.prepare('SELECT COUNT(*) AS n FROM colonies').get().n > 0) {
  console.error('This database already has colonies. Seed a fresh one, e.g. DB_PATH=data/demo.db');
  process.exit(1);
}

const colonies = {
  laundromat: [25.781, -80.2105, 'Laundromat', 'Behind the laundromat, by the dryer vents'],
  marina: [25.733, -80.233, 'Marina Lot', 'Boat yard parking lot next to the marina'],
  church: [25.8, -80.199, 'Church Garden', 'Garden behind the church on the corner'],
};
for (const [lat, lng, name, description] of Object.values(colonies)) {
  createColony(name, description, lat, lng);
}

function volunteer(name, phone) {
  const { id } = createRoom(name);
  db.prepare('UPDATE rooms SET phone = ? WHERE id = ?').run(phone, id);
  return id;
}

const maria = volunteer('Maria Gomez', '(305) 555-0142');
const dev = volunteer('Dev Patel', '(305) 555-0178');
const ana = volunteer('Ana Ruiz', '(305) 555-0119');

// A spot a few meters from a colony, like a phone's location would be.
const near = (colony) => [colonies[colony][0] + 0.0002, colonies[colony][1] - 0.0001];

const reports = [
  [
    maria,
    'Fed the laundromat crew. New cream and white cat, very friendly, no ear tip',
    'cream-1.jpg',
    near('laundromat'),
  ],
  [
    dev,
    'Big fluffy orange guy under the bushes, looks grumpy but ok',
    'ginger-1.jpg',
    near('marina'),
  ],
  // The same cream cat as Maria's, from another volunteer: should count once.
  [
    ana,
    'Saw this one by the dryer vents, I think she’s pregnant, belly is big',
    'cream-2.jpg',
    near('laundromat'),
  ],
  [ana, 'Skinny black cat at the church garden, limping on her back left leg', 'black-1.jpg', null],
  [dev, 'Fed the marina cats, 5 showed up today', null, near('marina')],
  [
    maria,
    'Di de comer en la iglesia. La señora que alimentaba esa colonia se mudó y nadie les ha dado comida en 3 días',
    null,
    null,
  ],
];

for (const [roomId, text, photo, location] of reports) {
  const bytes = photo && readFileSync(new URL(`../seed/photos/${photo}`, import.meta.url));
  const [lat, lng] = location ?? [];
  const messageId = addMessage(roomId, 'volunteer', text, bytes, photo && 'image/jpeg', lat, lng);
  console.log(`> ${text}${photo ? ` [${photo}]` : ''}`);
  await respond(roomId, messageId);
  const reply = db.prepare('SELECT text FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1');
  console.log(`< ${reply.get(roomId).text}\n`);
}
