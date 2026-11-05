-- ============================================================
--  002 · TAGS, LIKES, EDITS, MERCH
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Safe to run more than once. Nothing is deleted except the
--  Hat / T-shirt / Tote bag tags, whose posts move to Merch.
--
--  What it does:
--    1. Posts can have any number of tags (entry_tags).
--       Every post keeps the tag it has today.
--    2. Likes — one heart per person per post.
--    3. entries.edited_at, so an edited post can say so.
--    4. Two helpers the app calls: set_entry_tags, merge_tags.
--    5. Merges Hat, T-shirt and Tote bag into one tag: Merch.
--    6. Rebuilds the entries_full view with tags and likes.
-- ============================================================

-- ── 1 · many tags per post ──────────────────────────────────
create table if not exists entry_tags (
  entry_id   uuid not null references entries(id)     on delete cascade,
  type_id    uuid not null references entry_types(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, type_id)
);
alter table entry_tags enable row level security;
create index if not exists entry_tags_type_idx on entry_tags (type_id);

-- everything tagged today keeps that tag
insert into entry_tags (entry_id, type_id)
select id, type_id from entries where type_id is not null
on conflict do nothing;

-- ── 2 · likes ───────────────────────────────────────────────
create table if not exists likes (
  entry_id   uuid not null references entries(id)  on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);
alter table likes enable row level security;

-- ── 3 · edits ───────────────────────────────────────────────
alter table entries add column if not exists edited_at timestamptz;

-- ── policies: same door as everything else ─────────────────
drop policy if exists "allowed_read"  on entry_tags;
drop policy if exists "allowed_write" on entry_tags;
create policy "allowed_read"  on entry_tags for select using (is_allowed());
create policy "allowed_write" on entry_tags for all using (is_allowed()) with check (is_allowed());

-- a like is always your own
drop policy if exists "allowed_read"  on likes;
drop policy if exists "own_likes"     on likes;
create policy "allowed_read" on likes for select using (is_allowed());
create policy "own_likes"    on likes for all
  using (is_allowed() and user_id = auth.uid())
  with check (is_allowed() and user_id = auth.uid());

-- ── 4 · helpers ─────────────────────────────────────────────
-- Replace a post's tags in one go. security invoker: it runs as
-- whoever calls it, so the policies above still apply.
create or replace function set_entry_tags(p_entry uuid, p_tags uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  p_tags := coalesce(p_tags, '{}');
  delete from entry_tags where entry_id = p_entry and not (type_id = any (p_tags));
  insert into entry_tags (entry_id, type_id)
    select p_entry, t from unnest(p_tags) as t
    on conflict do nothing;
  -- keep the old single-tag column pointing somewhere sensible,
  -- for any phone still running a cached older version
  update entries set type_id = p_tags[1] where id = p_entry;
end;
$$;

-- Fold one or more tags into another. Posts keep every tag they
-- had; the folded tags disappear.
create or replace function merge_tags(p_sources uuid[], p_target uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into entry_tags (entry_id, type_id)
    select distinct entry_id, p_target
    from entry_tags
    where type_id = any (p_sources) and type_id <> p_target
    on conflict do nothing;
  update entries set type_id = p_target
    where type_id = any (p_sources) and type_id <> p_target;
  delete from entry_types where id = any (p_sources) and id <> p_target;
end;
$$;

grant execute on function set_entry_tags(uuid, uuid[]) to authenticated;
grant execute on function merge_tags(uuid[], uuid)    to authenticated;

-- ── 5 · Hat + T-shirt + Tote bag → Merch ────────────────────
do $$
declare
  merch uuid;
  src   uuid[];
  names text;
begin
  select array_agg(id), string_agg(label, ', ')
    into src, names
  from entry_types
  where lower(btrim(label)) in ('hat','hats','t-shirt','t-shirts','tshirt','tshirts',
                                'tee','tees','tee idea','tee ideas',
                                'tote','totes','tote bag','tote bags')
     or slug in ('hat','hats','t-shirt','t-shirts','tee-ideas','tote-bag','tote-bags');

  insert into entry_types (label, slug, sort_order, is_seed)
  values ('Merch', 'merch', 20, true)
  on conflict (slug) do update set label = 'Merch'
  returning id into merch;

  if src is null then
    raise notice 'Merch: nothing left to merge';
  else
    perform merge_tags(src, merch);
    raise notice 'Merch: merged %', names;
  end if;
end $$;

-- ── 6 · the view the app reads ──────────────────────────────
-- Dropped and recreated (not "replaced") because a new column
-- on entries shifts the view's columns.
drop view if exists entries_full;
create view entries_full
with (security_invoker = true) as
select
  e.*,
  p.display_name as author_name,
  t.label        as type_label,
  t.slug         as type_slug,
  (select count(*) from replies r where r.entry_id = e.id) as reply_count,
  coalesce((
    select jsonb_agg(jsonb_build_object('id', ty.id, 'label', ty.label)
                     order by ty.sort_order, ty.label)
    from entry_tags et join entry_types ty on ty.id = et.type_id
    where et.entry_id = e.id
  ), '[]'::jsonb) as tags,
  coalesce((
    select jsonb_agg(lp.display_name order by l.created_at)
    from likes l join profiles lp on lp.id = l.user_id
    where l.entry_id = e.id
  ), '[]'::jsonb) as liked_by,
  exists (
    select 1 from likes l where l.entry_id = e.id and l.user_id = auth.uid()
  ) as liked_by_me
from entries e
join profiles p on p.id = e.author_id
left join entry_types t on t.id = e.type_id;

grant select on entries_full to authenticated;

-- make PostgREST see the new tables and functions right away
notify pgrst, 'reload schema';

-- ── check ───────────────────────────────────────────────────
-- You should see Merch here and no Hat / T-shirt / Tote bag.
select ty.label as tag, count(et.entry_id) as posts
from entry_types ty
left join entry_tags et on et.type_id = ty.id
group by ty.label, ty.sort_order
order by ty.sort_order, ty.label;
