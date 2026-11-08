-- A photo the rescue attached directly to a cat, outside the chat/sighting pipeline.
create table if not exists cat_photos (
  id integer primary key,
  cat_id integer not null references cats(id),
  photo blob not null,
  photo_type text not null,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
