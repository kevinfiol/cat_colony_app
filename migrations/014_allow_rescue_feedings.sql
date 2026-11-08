-- A feeding with no room was done by the rescue itself, e.g. when it handles a colony that lost its feeder.
-- SQLite can't drop NOT NULL in place, so the table is rebuilt.
create table feedings_new (
  id integer primary key,
  colony_id integer not null references colonies(id),
  room_id text references rooms(id),
  message_id integer references messages(id),
  created_at text not null default CURRENT_TIMESTAMP
) strict;
insert into feedings_new select id, colony_id, room_id, message_id, created_at from feedings;
drop table feedings;
alter table feedings_new rename to feedings;
