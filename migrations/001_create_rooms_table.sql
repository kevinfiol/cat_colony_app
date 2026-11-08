-- One chat room per volunteer; its link is their ID.
create table if not exists rooms (
  id text primary key,
  -- Volunteer's name and phone; seen only by the rescue.
  name text,
  phone text,
  -- Latest message the admin has seen; newer volunteer messages are unread.
  last_read_message_id integer not null default 0,
  created_at text not null default CURRENT_TIMESTAMP
) strict;
