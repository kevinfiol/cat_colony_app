-- History from before cat_events existed, rebuilt from what the cats table still records.
-- Moves weren't stored anywhere, so they can't be recovered.
insert into cat_events (cat_id, what, created_at)
select id, 'Fixed (TNR done)', fixed_at from cats
where fixed_at is not null
  and not exists (select 1 from cat_events e where e.cat_id = cats.id and e.what = 'Fixed (TNR done)');

-- The date of these changes wasn't kept; the note says so.
insert into cat_events (cat_id, what, note, created_at)
select id, 'Marked ' || status, 'Recorded before history was kept; the date is when the cat was first reported.', created_at
from cats
where status in ('adopted', 'missing', 'deceased')
  and not exists (select 1 from cat_events e where e.cat_id = cats.id and e.what like 'Marked %');
