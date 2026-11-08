import { readFileSync } from 'node:fs';
import { H3, HTTPError, EventStream, serve, redirect, getRouterParam, getQuery } from 'h3';
import { compile } from 'tempura';
import * as db from './db.js';
import { respond, decide, applyHandledNote } from './agent.js';

const view = (name) => compile(readFileSync(`src/views/${name}.hbs`, 'utf8'));
const adminView = view('admin');
const chatView = view('chat');
const coloniesView = view('colonies');
const colonyView = view('colony');
const catsView = view('cats');
const catView = view('cat');

const page = (markup, status = 200) =>
  new Response(markup, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

// Shared styles and scripts, read once at startup.
const asset = (name, type) => {
  const body = readFileSync(`src/public/${name}`, 'utf8');
  return () => new Response(body, { headers: { 'Content-Type': type } });
};

// A readable page instead of raw JSON when something goes wrong, e.g. a mistyped chat link.
function errorPage(error) {
  const status = error.status || 500;
  // Route errors can quote the URL, so escape the message before putting it in HTML.
  // h3's own 404 message is technical, so swap in a plain one.
  const message = (
    status === 404 && error.message.startsWith('Cannot find')
      ? 'Page not found.'
      : status < 500
        ? error.message
        : 'Something went wrong. Please try again.'
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;');
  return page(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/app.css"><title>${status}</title>
    <h1>Sorry</h1><p>${message}</p><p><a href="javascript:history.back()">← Go back</a></p>`,
    status,
  );
}

function requireRoom(event) {
  const room = db.getRoom(getRouterParam(event, 'slug'));
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

// Lets the agent update the census from a handled case's note, without making the admin wait.
function applyInBackground(colonyId, catId, kinds, note) {
  applyHandledNote(colonyId, catId, kinds, note).catch(console.error).finally(notifyAdmins);
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

const app = new H3({ onError: errorPage })
  .get('/app.css', asset('app.css', 'text/css; charset=utf-8'))
  .get('/app.js', asset('app.js', 'text/javascript; charset=utf-8'))
  .get('/', () => redirect('/admin'))

  .get('/admin', () =>
    page(
      adminView({
        rooms: db.listRooms(),
        approvals: db.listPendingApprovals(),
        newCats: db.listPendingCats(),
        flags: db.listOpenFlags(),
      }),
    ),
  )

  .post('/admin/flags/:id', async (event) => {
    const form = await event.req.formData();
    const flag = db.getFlag(getRouterParam(event, 'id'));
    const note = form.get('note')?.trim() || null;
    if (flag && !flag.resolved_at) {
      db.resolveFlag(flag.id, note);
      if (note) applyInBackground(flag.colony_id, flag.cat_id, flag.kind, note);
    }
    notifyAdmins();
    const back = form.get('back');
    return redirect(back?.startsWith('/admin') ? back : '/admin');
  })

  // Confirms a newly reported cat, rejects it, or folds it into the cat it really is.
  .post('/admin/cats/:id', async (event) => {
    const id = Number(getRouterParam(event, 'id'));
    const form = await event.req.formData();
    const action = form.get('action');
    if (action === 'register') db.setCatStatus(id, 'active');
    if (action === 'reject') db.setCatStatus(id, 'rejected');
    const into = Number(form.get('into'));
    const merging = action === 'merge' && Number.isInteger(into) && into > 0 && into !== id;
    if (merging) db.mergeCats(into, id);
    const colonyId = Number(form.get('colony_id'));
    if (action === 'move' && db.getColony(colonyId)) db.moveCat(id, colonyId);
    if (action === 'fixed') db.markFixed(id);
    const note = form.get('note')?.trim() || null;
    const cat = db.getCat(id);
    if (action === 'resolve' && cat?.open_flags) {
      db.resolveCatFlags(id, note);
      if (note) applyInBackground(cat.colony_id, id, cat.open_flags, note);
    }
    if (action === 'note' && note) db.logCatEvent(id, 'Note', note);
    if (action === 'not_same') db.clearSameCat(id);
    if (action === 'edit') {
      const coat = form.get('coat')?.trim();
      if (!coat) throw new HTTPError({ status: 400, message: 'A cat needs a coat description' });
      db.updateCat(id, {
        name: form.get('name')?.trim() || null,
        coat,
        markings: form.get('markings')?.trim() || null,
      });
    }
    const status = form.get('status');
    if (action === 'set_status' && db.CAT_STATUSES.includes(status)) db.setCatStatus(id, status);
    notifyAdmins();
    let back = form.get('back');
    // A merged record is gone, so show the cat it was merged into instead.
    if (merging && back === `/admin/cats/${id}`) back = `/admin/cats/${into}`;
    return redirect(back?.startsWith('/admin') ? back : '/admin');
  })

  .post('/admin/approvals/:id', async (event) => {
    const form = await event.req.formData();
    const roomId = await decide(getRouterParam(event, 'id'), form.get('approved') === '1');
    if (roomId) notifyRoom(roomId);
    return redirect('/admin');
  })

  .get('/admin/cats', (event) => {
    const { show, colony_id: colonyId } = getQuery(event);
    const filters = {
      urgent: (cat) => cat.open_flags,
      tnr: (cat) => !cat.fixed && ['active', 'pending'].includes(cat.status),
      new: (cat) => cat.status === 'pending',
      same: (cat) => cat.same_coat,
    };
    const cats = db.listAllCats().filter(filters[show] ?? (() => true));
    // Urgent cases about a whole colony, e.g. kittens or a lost feeder; cat ones show on the cat.
    const colonyFlags = db.listOpenFlags().filter((flag) => !flag.cat_id);
    return page(
      catsView({
        cats,
        show,
        colonyFlags,
        totals: db.catTotals(),
        colonies: db.listColonies(),
        colonyId: colonyId ?? null,
      }),
    );
  })

  // Adds a cat the rescue already knows is real - skips the pending/confirm step.
  .post('/admin/cats', async (event) => {
    const form = await event.req.formData();
    const colonyId = Number(form.get('colony_id'));
    if (!db.getColony(colonyId)) throw new HTTPError({ status: 400, message: 'Pick a colony' });
    const coat = form.get('coat')?.trim();
    if (!coat) throw new HTTPError({ status: 400, message: 'A cat needs a coat description' });
    const catId = db.createCat(colonyId, {
      name: form.get('name')?.trim() || null,
      coat,
      markings: form.get('markings')?.trim() || null,
      fixed: form.get('fixed') === '1',
      status: 'active',
    });
    notifyAdmins();
    return redirect(`/admin/cats/${catId}`);
  })

  .get('/admin/cats/:id', (event) => {
    const cat = db.getCat(getRouterParam(event, 'id'));
    if (!cat) throw new HTTPError({ status: 404, message: 'Cat not found' });
    const history = db.listCatHistory(cat.id);
    // Every photo of this cat: sighting photos from chat, and ones the rescue uploaded directly.
    const photos = [
      ...history.filter((entry) => entry.has_photo).map((h) => ({ url: `/photos/${h.message_id}`, at: h.at })),
      ...db.listCatPhotos(cat.id).map((p) => ({ url: `/cat-photos/${p.id}`, at: p.created_at })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    return page(
      catView({
        cat,
        history,
        photos,
        statuses: db.CAT_STATUSES,
        colonies: db.listColonies(),
        others: db.listColonyCats(cat.colony_id).filter((other) => other.id !== cat.id),
      }),
    );
  })

  // A photo the rescue attached directly to a cat.
  .post('/admin/cats/:id/photos', async (event) => {
    const id = Number(getRouterParam(event, 'id'));
    if (!db.getCat(id)) throw new HTTPError({ status: 404, message: 'Cat not found' });
    const form = await event.req.formData();
    const file = form.get('photo');
    const isImage = file?.size > 0 && file.type.startsWith('image/') && file.type !== 'image/svg+xml';
    if (!isImage) throw new HTTPError({ status: 400, message: 'Choose an image to upload.' });
    db.addCatPhoto(id, new Uint8Array(await file.arrayBuffer()), file.type);
    notifyAdmins();
    return redirect(`/admin/cats/${id}`);
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
    const description = form.get('description')?.trim() || null;
    db.createColony(name, description, form.get('address')?.trim() || null, lat, lng);
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
        handled: db.listHandledFlags(colony.id),
        feedings: db.listFeedings(colony.id),
        past: db.listPastCats(colony.id),
      }),
    );
  })

  .post('/admin/colonies/:id/feedings', async (event) => {
    const colonyId = Number(getRouterParam(event, 'id'));
    if (!db.getColony(colonyId)) throw new HTTPError({ status: 404, message: 'Colony not found' });
    db.logFeeding(colonyId);
    notifyAdmins();
    return redirect(`/admin/colonies/${colonyId}`);
  })

  .get('/admin/events', (event) => subscribe(event, 'admin'))

  .post('/admin/rooms', async (event) => {
    const name = (await event.req.formData()).get('name')?.trim();
    if (!name) throw new HTTPError({ status: 400, message: 'A chat room needs a name' });
    const { slug } = db.createRoom(name);
    notifyAdmins();
    return redirect(`/admin/chat/${slug}`);
  })

  .post('/admin/chat/:slug/name', async (event) => {
    const room = requireRoom(event);
    const name = (await event.req.formData()).get('name')?.trim();
    if (name) db.renameRoom(room.id, name);
    notifyAdmins();
    return redirect(`/admin/chat/${room.slug}`);
  })

  .get('/admin/chat/:slug', (event) => {
    const room = requireRoom(event);
    db.markRead(room.id);
    notifyAdmins();
    return page(chatView({ room, messages: db.listMessages(room.id), isAdmin: true }));
  })

  .post('/admin/chat/:slug', async (event) => {
    const room = requireRoom(event);
    await saveMessage(event, room, 'admin');
    db.markRead(room.id);
    notifyRoom(room.id);
    return redirect(`/admin/chat/${room.slug}`);
  })

  .get('/chat/:slug', (event) => {
    const room = requireRoom(event);
    return page(chatView({ room, messages: db.listMessages(room.id), isAdmin: false }));
  })

  .get('/chat/:slug/events', (event) => subscribe(event, requireRoom(event).id))

  .post('/chat/:slug', async (event) => {
    const room = requireRoom(event);
    const messageId = await saveMessage(event, room, 'volunteer');
    notifyRoom(room.id);
    if (messageId) replyInBackground(room.id, messageId);
    return redirect(`/chat/${room.slug}`);
  })

  .get('/photos/:id', (event) => {
    const row = db.getPhoto(getRouterParam(event, 'id'));
    if (!row) throw new HTTPError({ status: 404, message: 'Photo not found' });
    return new Response(row.photo, {
      headers: { 'Content-Type': row.photo_type, 'X-Content-Type-Options': 'nosniff' },
    });
  })

  .get('/cat-photos/:id', (event) => {
    const row = db.getCatPhoto(getRouterParam(event, 'id'));
    if (!row) throw new HTTPError({ status: 404, message: 'Photo not found' });
    return new Response(row.photo, {
      headers: { 'Content-Type': row.photo_type, 'X-Content-Type-Options': 'nosniff' },
    });
  });

serve(app, { port: process.env.PORT || 3000 });
