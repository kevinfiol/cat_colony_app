-- Agent runs paused until a person approves or rejects an action.
create table if not exists approvals (
  id integer primary key,
  room_id text not null references rooms(id),
  summary text not null,
  run_state text not null,
  approved integer,
  decided_at text,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
