create table if not exists messages (
  id integer primary key,
  room_id text not null references rooms(id),
  -- 'volunteer', 'admin' or 'bot'
  sender text not null default 'volunteer',
  text text,
  photo blob,
  photo_type text,
  -- Shared location, if the volunteer sent one.
  lat real,
  lng real,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
