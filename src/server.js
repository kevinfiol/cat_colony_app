import { readFileSync } from 'node:fs';
import { H3, HTTPError, EventStream, serve, redirect, getRouterParam } from 'h3';
import { compile } from 'tempura';
import * as db from './db.js';

const view = (name) => compile(readFileSync(`src/views/${name}.hbs`, 'utf8'));
const adminView = view('admin');
const chatView = view('chat');

const page = (markup) =>
  new Response(markup, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

function requireRoom(event) {
  const room = db.getRoom(getRouterParam(event, 'id'));
  if (!room) throw new HTTPError({ status: 404, message: 'Chat room not found' });
  return room;
}

// Saves the text and/or photo from a chat form, if either was given.
async function saveMessage(event, room, sender) {
  const form = await event.req.formData();
  const text = form.get('text')?.trim() || null;
  const file = form.get('photo');

  // Only accept real images. SVG is skipped since it can contain scripts.
  const isImage = file?.size > 0 && file.type.startsWith('image/') && file.type !== 'image/svg+xml';
  const photo = isImage ? new Uint8Array(await file.arrayBuffer()) : null;

  if (text || photo) {
    db.addMessage(room.id, sender, text, photo, isImage ? file.type : null);
  }
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

  .get('/admin', () => page(adminView({ rooms: db.listRooms() })))

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
    await saveMessage(event, room, 'volunteer');
    notifyRoom(room.id);
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
