-- What the rescue did to each cat, e.g. "Fixed (TNR done)", "Moved to Laundromat" or a note.
create table if not exists cat_events (
  id integer primary key,
  cat_id integer not null references cats(id),
  what text not null,
  note text,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
-- What the rescue wrote when it handled an urgent case.
alter table flags add column resolution text;
