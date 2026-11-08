create table if not exists cats (
  id integer primary key,
  colony_id integer not null references colonies(id),
  name text,
  coat text,
  markings text,
  -- Ear-tipped or otherwise known to be neutered.
  fixed integer not null default 0,
  -- 'pending' (reported, not yet confirmed by the rescue), 'active', 'adopted',
  -- 'missing' or 'rejected'
  status text not null default 'pending',
  -- Best reference photo, used to recognize the cat again.
  photo_message_id integer references messages(id),
  -- A known cat the agent thinks a newly reported cat might be.
  maybe_same_as integer references cats(id),
  created_at text not null default CURRENT_TIMESTAMP
) strict;
