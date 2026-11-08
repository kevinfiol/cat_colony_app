import { Agent, run, tool, RunState, setTracingDisabled } from '@openai/agents';
import { z } from 'zod';
import {
  db,
  addMessage,
  getCat,
  getPhoto,
  recentPhotoMessage,
  markFixed,
  setCatStatus as setStatus,
  createCat as createCatRow,
  logFeeding as logFeedingRow,
  createFlag,
  FLAG_KINDS,
} from './db.js';

// Traces would send colony locations and feeder details to OpenAI's dashboard.
setTracingDisabled(true);

const photoUrl = (messageId) => {
  const row = getPhoto(messageId);
  return row && `data:${row.photo_type};base64,${Buffer.from(row.photo).toString('base64')}`;
};

// Distance in meters between two points on Earth.
function distance(lat1, lng1, lat2, lng2) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(a)));
}

// The message being handled; tools attach their records to it.
const current = (runContext) => runContext.context;

const listColonies = tool({
  name: 'list_colonies',
  description:
    'List all colonies. If the message has a location, each colony includes its distance in meters.',
  parameters: z.object({}),
  execute: (_, runContext) => {
    const { lat, lng } = current(runContext);
    const colonies = db
      .prepare('SELECT id, name, description, address, lat, lng FROM colonies')
      .all();
    return colonies.map(({ lat: cLat, lng: cLng, ...colony }) => ({
      ...colony,
      distance_m: lat != null && cLat != null ? distance(lat, lng, cLat, cLng) : null,
    }));
  },
});

const listColonyCats = tool({
  name: 'list_colony_cats',
  description:
    "List a colony's cats with their open urgent flags. Status 'pending' means reported but not yet confirmed by the rescue; it is still a known cat.",
  parameters: z.object({ colony_id: z.number() }),
  execute: ({ colony_id }) =>
    db
      .prepare(`
      SELECT c.id, c.status, c.name, c.coat, c.markings, c.fixed, c.photo_message_id IS NOT NULL AS has_photo,
             (SELECT group_concat(kind) FROM flags WHERE cat_id = c.id AND resolved_at IS NULL) AS open_flags
      FROM cats c WHERE c.colony_id = ? AND c.status IN ('active', 'pending')
    `)
      .all(colony_id),
});

const showCatPhoto = tool({
  name: 'show_cat_photo',
  description: "Show a cat's reference photo, to check whether a new photo is the same cat.",
  parameters: z.object({ cat_id: z.number() }),
  execute: ({ cat_id }) => {
    const cat = db.prepare('SELECT photo_message_id FROM cats WHERE id = ?').get(cat_id);
    const image = cat?.photo_message_id && photoUrl(cat.photo_message_id);
    return image ? { type: 'image', image } : 'This cat has no photo.';
  },
});

const createCat = tool({
  name: 'create_cat',
  description:
    'Report a cat not yet in the colony; the rescue confirms it. Also logs this message as its first sighting.',
  parameters: z.object({
    colony_id: z.number(),
    name: z.string().nullable(),
    coat: z.string().describe('e.g. "gray tabby", "calico"'),
    markings: z.string().describe('Anything that tells this cat apart'),
    fixed: z.boolean().describe('True if ear-tipped or reported neutered'),
    note: z.string().describe('What was reported this time'),
    maybe_same_as: z
      .number()
      .nullable()
      .describe('A known cat this might be, if you are not sure it is new'),
  }),
  execute: ({ colony_id, name, coat, markings, fixed, note, maybe_same_as }, runContext) => {
    const { messageId, photoMessageId } = current(runContext);
    const catId = createCatRow(colony_id, {
      name,
      coat,
      markings,
      fixed,
      photoMessageId,
      maybeSameAs: maybe_same_as,
      status: 'pending',
    });
    db.prepare('INSERT INTO sightings (cat_id, message_id, note) VALUES (?, ?, ?)').run(
      catId,
      messageId,
      note,
    );
    return { cat_id: catId };
  },
});

const logSighting = tool({
  name: 'log_sighting',
  description:
    'Log this message as a sighting of a known cat, updating any details that were learned.',
  parameters: z.object({
    cat_id: z.number(),
    note: z.string().describe('What was reported this time'),
    name: z.string().nullable(),
    markings: z.string().nullable(),
    fixed: z.boolean().nullable(),
  }),
  execute: ({ cat_id, note, name, markings, fixed }, runContext) => {
    const { messageId, photoMessageId } = current(runContext);
    db.prepare('INSERT INTO sightings (cat_id, message_id, note) VALUES (?, ?, ?)').run(
      cat_id,
      messageId,
      note,
    );
    db.prepare(`
      UPDATE cats SET
        name = COALESCE(?, name),
        markings = COALESCE(?, markings),
        fixed = COALESCE(?, fixed),
        photo_message_id = COALESCE(photo_message_id, ?)
      WHERE id = ?
    `).run(name, markings, fixed == null ? null : fixed ? 1 : 0, photoMessageId, cat_id);
    return 'Logged.';
  },
});

const logFeeding = tool({
  name: 'log_feeding',
  description: 'Log that the reporter fed a colony.',
  parameters: z.object({ colony_id: z.number() }),
  execute: ({ colony_id }, runContext) => {
    const { roomId, messageId } = current(runContext);
    logFeedingRow(colony_id, roomId, messageId);
    return 'Logged.';
  },
});

const flagUrgent = tool({
  name: 'flag_urgent',
  description: 'Flag an urgent case for the rescue to act on today.',
  parameters: z.object({
    colony_id: z.number(),
    cat_id: z.number().nullable(),
    kind: z.enum(FLAG_KINDS),
    note: z.string(),
  }),
  execute: ({ colony_id, cat_id, kind, note }) => {
    createFlag(colony_id, cat_id, kind, note);
    return 'Flagged.';
  },
});

const suggestSameCat = tool({
  name: 'suggest_same_cat',
  description:
    'Suggest that two known cat records are likely the same cat. The rescue decides whether to merge them.',
  parameters: z.object({ cat_id: z.number(), other_cat_id: z.number() }),
  execute: ({ cat_id, other_cat_id }) => {
    // The newer record points at the older one, which is kept if they're merged.
    const [older, newer] = [cat_id, other_cat_id].sort((a, b) => a - b);
    db.prepare('UPDATE cats SET maybe_same_as = ? WHERE id = ?').run(older, newer);
    return 'Suggested to the rescue.';
  },
});

const setCatStatus = tool({
  name: 'set_cat_status',
  description: 'Mark a cat adopted, missing or deceased. A person at the rescue confirms first.',
  parameters: z.object({
    cat_id: z.number(),
    status: z.enum(['adopted', 'missing', 'deceased']),
  }),
  needsApproval: true,
  execute: ({ cat_id, status }) => {
    setStatus(cat_id, status);
    return `Marked ${status}.`;
  },
});

const agent = new Agent({
  name: 'Cat line',
  model: 'gpt-5.4-nano',
  modelSettings: { reasoning: { effort: 'low' } },
  instructions: `
You keep the census for Mangrove Mews, a street cat rescue in Miami.
Volunteers and feeders message you from the street with text, photos and locations.
Record what they report like a careful rescue coordinator would:

1. Always call list_colonies first. Find the colony among the ones the rescue has set up: use the location's distance
   (within ~150 m is a match), or a place in the text that matches a colony's name or description.
2. For each cat mentioned or pictured, list the colony's cats and compare coat and markings.
   Pending cats count: another volunteer may have just reported the same cat.
   Use show_cat_photo when a photo could match.
   Matching cats by photo is never certain, especially for common, nondescript coats (solid black,
   solid gray, solid white, plain tabby) that many different cats share. Never call log_sighting to
   decide a new photo belongs to a known cat, however sure it looks - a person at the rescue must
   confirm before two records become one. Only use log_sighting when identity isn't actually in
   question: the volunteer names a cat that matches one you already know, or this message plainly
   continues the exact report you already pinned to this cat earlier in the same exchange (no new or
   conflicting photo). Otherwise create the cat; if it might already be a known cat, pass that cat as
   maybe_same_as so the rescue can compare photos and decide. Never count the same cat twice, and
   never decide two different reports are the same cat on your own.
   An ear-tip (a flat, clipped ear tip) means the cat is fixed.
3. Log a feeding if they fed the colony.
4. Flag urgent cases: pregnant, injured, sick, new kittens, or a colony that lost its feeder.
5. If two known records look like the same cat (same coat and markings, or matching photos), call
   suggest_same_cat; the rescue decides whether to merge them.
   If a cat was adopted, went missing (e.g. not seen for days) or died, find it in the colony's cats
   and call set_cat_status. A person confirms those.

If no colony fits or you can't tell the colony, ask one short question and record nothing yet.
Reply in one or two short lines saying what you logged. Always write in English, even if the volunteer writes in another language.
Write every note in English too.
Never repeat locations or phone numbers in a reply.
`,
  tools: [
    listColonies,
    listColonyCats,
    showCatPhoto,
    createCat,
    logSighting,
    logFeeding,
    flagUrgent,
    suggestSameCat,
    setCatStatus,
  ],
});

// Recent messages in the room, so the agent can follow up on its own questions.
function history(roomId, beforeId) {
  return db
    .prepare(`
    SELECT sender, text, photo_type IS NOT NULL AS has_photo, created_at FROM messages
    WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT 10
  `)
    .all(roomId, beforeId)
    .reverse()
    .map((m) => `[${m.created_at}] ${m.sender}: ${m.text ?? ''}${m.has_photo ? ' (photo)' : ''}`)
    .join('\n');
}

// A plain sentence for the rescue to approve, e.g. "Mark Smokey (#3, black) at Church Garden as deceased".
// set_cat_status is the only tool that needs approval.
function describe(call) {
  const { cat_id, status } = JSON.parse(call.arguments);
  const cat = getCat(cat_id);
  if (!cat) return `Mark cat #${cat_id} as ${status}`;
  const name = cat.name
    ? `${cat.name} (#${cat.id}, ${cat.coat})`
    : `the ${cat.coat} cat (#${cat.id})`;
  return `Mark ${name} at ${cat.colony_name} as ${status}`;
}

// Posts the agent's reply, or holds the run for a person to approve.
function finish(result, roomId) {
  if (result.interruptions.length === 0) {
    addMessage(roomId, 'bot', result.finalOutput);
    return;
  }
  const summary = result.interruptions.map((item) => describe(item.rawItem)).join('; ');
  db.prepare('INSERT INTO approvals (room_id, summary, run_state) VALUES (?, ?, ?)').run(
    roomId,
    summary,
    result.state.toString(),
  );
  addMessage(roomId, 'bot', 'Thanks! I’ve asked the rescue to confirm that change.');
}

// Turns a volunteer's message into census records, then replies in the room.
export async function respond(roomId, messageId) {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  const location = message.lat == null ? 'none' : `${message.lat}, ${message.lng}`;
  const content = [
    {
      type: 'input_text',
      text: `Earlier in this chat:\n${history(roomId, messageId) || '(nothing)'}\n\nNew message, sent ${message.created_at} UTC.\nLocation: ${location}\nText: ${message.text ?? '(none)'}`,
    },
  ];

  // If this message has no photo of its own, fall back to the most recent one sent in this
  // room, so a cat's photo isn't lost when the colony or details are given in a later reply.
  let photoMessageId = null;
  if (message.photo_type) {
    photoMessageId = messageId;
    content.push({ type: 'input_image', image: photoUrl(messageId) });
  } else {
    const recent = recentPhotoMessage(roomId, messageId);
    if (recent) {
      photoMessageId = recent.id;
      content[0].text += `\n\nNo new photo this time, but a photo was sent earlier in this chat (${recent.created_at} UTC), attached below in case this message is still about that same cat.`;
      content.push({ type: 'input_image', image: photoUrl(recent.id) });
    }
  }

  const context = { roomId, messageId, lat: message.lat, lng: message.lng, photoMessageId };
  finish(await run(agent, [{ role: 'user', content }], { context }), roomId);
}

// Resumes a held run once a person approves or rejects it.
export async function decide(approvalId, approved) {
  const approval = db
    .prepare('SELECT * FROM approvals WHERE id = ? AND decided_at IS NULL')
    .get(approvalId);
  if (!approval) return null;
  db.prepare('UPDATE approvals SET approved = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    approved ? 1 : 0,
    approvalId,
  );

  const state = await RunState.fromString(agent, approval.run_state);
  for (const item of state.getInterruptions()) {
    if (approved) state.approve(item);
    else state.reject(item, { message: 'The rescue said no.' });
  }
  finish(await run(agent, state), approval.room_id);
  return approval.room_id;
}

const markCatFixed = tool({
  name: 'mark_fixed',
  description: 'Record that the rescue spayed or neutered a cat.',
  parameters: z.object({ cat_id: z.number() }),
  execute: ({ cat_id }) => {
    markFixed(cat_id);
    return 'Marked fixed.';
  },
});

// A person at the rescue wrote the note themselves, so no further confirmation is needed.
const setCatStatusNow = tool({
  name: 'set_cat_status',
  description: 'Mark a cat adopted, missing or deceased.',
  parameters: z.object({
    cat_id: z.number(),
    status: z.enum(['adopted', 'missing', 'deceased']),
  }),
  execute: ({ cat_id, status }) => {
    setStatus(cat_id, status);
    return `Marked ${status}.`;
  },
});

const logRescueFeeding = tool({
  name: 'log_feeding',
  description: 'Log that the rescue fed a colony.',
  parameters: z.object({ colony_id: z.number() }),
  execute: ({ colony_id }) => {
    logFeedingRow(colony_id);
    return 'Logged.';
  },
});

const rescueAgent = new Agent({
  name: 'Rescue notes',
  model: 'gpt-5.4-nano',
  modelSettings: { reasoning: { effort: 'low' } },
  instructions: `
You keep the census for Mangrove Mews, a street cat rescue in Miami.
A person at the rescue just handled an urgent case and wrote what they did. The note is already saved with the case.
Update the census to match what they wrote, and nothing more:

- If a cat was spayed or neutered, call mark_fixed.
- If the rescue fed the colony, call log_feeding.
- If a cat was adopted, went missing or died, call set_cat_status.
- This note is what closes the case above - don't call flag_urgent for the same problem it describes,
  however it reads. "Took it to the vet", "resting" or "keeping an eye on her" all close the case; they
  don't reopen it. Only call flag_urgent for a genuinely different, still-open problem the note raises
  (a different symptom, or more kittens found elsewhere) - not the one that was just handled.
- To act on a cat other than the case's cat, call list_colony_cats to find it. If you can't tell which cat, do nothing.
- If the note needs no change, do nothing.

Write any note in English.
`,
  tools: [listColonyCats, markCatFixed, setCatStatusNow, logRescueFeeding, flagUrgent],
});

// Updates the census from what the rescue wrote when it handled an urgent case.
// kinds is the case's kind, e.g. 'injured', or several for a cat's cases, e.g. 'injured, sick'.
export async function applyHandledNote(colonyId, catId, kinds, note) {
  const colony = db.prepare('SELECT name FROM colonies WHERE id = ?').get(colonyId);
  const cat = catId && getCat(catId);
  const about = cat
    ? `the cat #${cat.id} (${cat.name ?? 'no name'}, ${cat.coat}, ${cat.fixed ? 'fixed' : 'not fixed'})`
    : 'the colony as a whole';
  const text = `Case: ${kinds}, about ${about}, at colony #${colonyId} (${colony.name}).\nWhat the rescue did: ${note}`;
  await run(rescueAgent, text);
}
