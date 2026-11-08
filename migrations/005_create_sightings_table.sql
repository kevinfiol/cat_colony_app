-- Each report of a cat; its history.
create table if not exists sightings (
  id integer primary key,
  cat_id integer not null references cats(id),
  message_id integer not null references messages(id),
  note text,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
