-- Urgent cases. kind: 'pregnant', 'injured', 'sick', 'kittens' or 'no_feeder'.
create table if not exists flags (
  id integer primary key,
  colony_id integer not null references colonies(id),
  cat_id integer references cats(id),
  kind text not null,
  note text,
  resolved_at text,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
