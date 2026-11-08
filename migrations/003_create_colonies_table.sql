create table if not exists colonies (
  id integer primary key,
  name text not null,
  description text,
  lat real,
  lng real,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
