-- Rooms are named by the admin; the slug is set from the first name and never changes.
alter table rooms add column slug text;
update rooms set slug = id where slug is null;
create unique index if not exists rooms_slug on rooms(slug);
