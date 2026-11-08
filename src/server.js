import { readFileSync } from 'node:fs';
import { H3, HTTPError, EventStream, serve, redirect, getRouterParam } from 'h3';
import { compile } from 'tempura';
import * as db from './db.js';
import { respond, decide } from './agent.js';

const view = (name) => compile(readFileSync(`src/views/${name}.hbs`, 'utf8'));
const adminView = view('admin');
const chatView = view('chat');
const coloniesView = view('colonies');
const colonyView = view('colony');

const page = (markup) =>
  new Response(markup, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

function requireRoom(event) {
  const room = db.getRoom(getRouterParam(event, 'id'));
  if (!room) throw new HTTPError({ status: 404, message: 'Chat room not found' });
  return room;
}

// A number from a form field, or null if it's blank or not a number.
function number(form, name) {
  const value = Number.parseFloat(form.get(name));
  return Number.isFinite(value) ? value : null;
}

// Saves the text, photo and/or location from a chat form, if any was given.
// Returns the new message's id, or null if nothing was sent.
async function saveMessage(event, room, sender) {
  const form = await event.req.formData();
  const text = form.get('text')?.trim() || null;
  const file = form.get('photo');
  const lat = number(form, 'lat');
  const lng = number(form, 'lng');

  // Only accept real images. SVG is skipped since it can contain scripts.
  const isImage = file?.size > 0 && file.type.startsWith('image/') && file.type !== 'image/svg+xml';
  const photo = isImage ? new Uint8Array(await file.arrayBuffer()) : null;

  if (!text && !photo && lat == null) return null;
  return db.addMessage(room.id, sender, text, photo, isImage ? file.type : null, lat, lng);
}

// The agent can take a while, so it replies after the volunteer's message is shown.
function replyInBackground(roomId, messageId) {
  respond(roomId, messageId)
    .catch((error) => {
      console.error(error);
      db.addMessage(roomId, 'bot', 'Sorry, I couldn’t log that. The rescue will read it.');
    })
    .finally(() => notifyRoom(roomId));
}

// Open pages listening for updates, grouped by channel: 'admin' or a room id.
const channels = new Map();

function subscribe(event, channel) {
  const stream = new EventStream(event);
  if (!channels.has(channel)) channels.set(channel, new Set());
  const streams = channels.get(channel);
  streams.add(stream);
  stream.onClosed(() => streams.delete(stream));
  return stream;
}

function notify(channel) {
  for (const stream of channels.get(channel) ?? []) stream.push('update');
}

const notifyAdmins = () => notify('admin');

// A new message changes both the room's chat and the admin room list.
function notifyRoom(roomId) {
  notify(roomId);
  notifyAdmins();
}

const app = new H3()
  .get('/', () => redirect('/admin'))

  .get('/admin', () =>
    page(
      adminView({
        rooms: db.listRooms(),
        approvals: db.listPendingApprovals(),
        newCats: db.listPendingCats(),
      }),
    ),
  )

  // Confirms a newly reported cat, rejects it, or folds it into the cat it really is.
  .post('/admin/cats/:id', async (event) => {
    const id = Number(getRouterParam(event, 'id'));
    const form = await event.req.formData();
    const action = form.get('action');
    if (action === 'register') db.setCatStatus(id, 'active');
    if (action === 'reject') db.setCatStatus(id, 'rejected');
    const into = Number(form.get('into'));
    if (action === 'merge' && Number.isInteger(into) && into > 0 && into !== id) {
      db.mergeCats(into, id);
    }
    notifyAdmins();
    const back = form.get('back');
    return redirect(back?.startsWith('/admin') ? back : '/admin');
  })

  .post('/admin/approvals/:id', async (event) => {
    const form = await event.req.formData();
    const roomId = await decide(getRouterParam(event, 'id'), form.get('approved') === '1');
    if (roomId) notifyRoom(roomId);
    return redirect('/admin');
  })

  .get('/admin/colonies', () => page(coloniesView({ colonies: db.listColonies() })))

  .post('/admin/colonies', async (event) => {
    const form = await event.req.formData();
    const name = form.get('name')?.trim();
    const lat = number(form, 'lat');
    const lng = number(form, 'lng');
    if (!name || lat == null || lng == null) {
      throw new HTTPError({ status: 400, message: 'A colony needs a name and a spot on the map' });
    }
    db.createColony(name, form.get('description')?.trim() || null, lat, lng);
    return redirect('/admin/colonies');
  })

  .get('/admin/colonies/:id', (event) => {
    const colony = db.getColony(getRouterParam(event, 'id'));
    if (!colony) throw new HTTPError({ status: 404, message: 'Colony not found' });
    return page(
      colonyView({
        colony,
        cats: db.listColonyCats(colony.id),
        flags: db.listOpenFlags(colony.id),
        feedings: db.listFeedings(colony.id),
      }),
    );
  })

  .get('/admin/events', (event) => subscribe(event, 'admin'))

  .post('/admin/rooms', () => {
    const id = db.createRoom();
    notifyAdmins();
    return redirect(`/admin/chat/${id}`);
  })

  .get('/admin/chat/:id', (event) => {
    const room = requireRoom(event);
    db.markRead(room.id);
    notifyAdmins();
    return page(chatView({ room, messages: db.listMessages(room.id), isAdmin: true }));
  })

  .post('/admin/chat/:id', async (event) => {
    const room = requireRoom(event);
    await saveMessage(event, room, 'admin');
    db.markRead(room.id);
    notifyRoom(room.id);
    return redirect(`/admin/chat/${room.id}`);
  })

  .get('/chat/:id', (event) => {
    const room = requireRoom(event);
    return page(chatView({ room, messages: db.listMessages(room.id), isAdmin: false }));
  })

  .get('/chat/:id/events', (event) => subscribe(event, requireRoom(event).id))

  .post('/chat/:id', async (event) => {
    const room = requireRoom(event);
    const messageId = await saveMessage(event, room, 'volunteer');
    notifyRoom(room.id);
    if (messageId) replyInBackground(room.id, messageId);
    return redirect(`/chat/${room.id}`);
  })

  .get('/photos/:id', (event) => {
    const row = db.getPhoto(getRouterParam(event, 'id'));
    if (!row) throw new HTTPError({ status: 404, message: 'Photo not found' });
    return new Response(row.photo, {
      headers: { 'Content-Type': row.photo_type, 'X-Content-Type-Options': 'nosniff' },
    });
  });

serve(app, { port: process.env.PORT || 3000 });
