create table if not exists feedings (
  id integer primary key,
  colony_id integer not null references colonies(id),
  room_id text not null references rooms(id),
  message_id integer references messages(id),
  created_at text not null default CURRENT_TIMESTAMP
) strict;
