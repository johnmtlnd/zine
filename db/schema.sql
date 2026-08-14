-- ============================================================
--  SCHEMA
--  Paste this whole file into Supabase → SQL Editor → Run.
--  Safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. WHO'S ALLOWED IN
--    Kept in the database, not in the repo, so your email
--    addresses never end up in public source. You'll add the
--    two rows by hand in the Supabase table editor.
-- ------------------------------------------------------------
create table if not exists allowed_emails (
  email text primary key
);
alter table allowed_emails enable row level security;
-- Nobody reads this table from the client. Policies below
-- consult it server-side via the helper function.

create or replace function is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ------------------------------------------------------------
-- 2. PROFILES  (exactly two rows, ever)
-- ------------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);
alter table profiles enable row level security;

-- Auto-create a profile the first time someone signs in.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ------------------------------------------------------------
-- 3. ENTRY TYPES
--    Four seeds you can't delete, plus any you add later.
-- ------------------------------------------------------------
create table if not exists entry_types (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  slug       text not null unique,
  sort_order int  not null default 100,
  is_seed    boolean not null default false
);
alter table entry_types enable row level security;

insert into entry_types (label, slug, sort_order, is_seed) values
  ('Band name', 'band-name', 10, true),
  ('T-shirt',   't-shirt',   20, true),
  ('Hat',       'hat',       30, true),
  ('Other',     'other',     40, true)
on conflict (slug) do nothing;

-- ------------------------------------------------------------
-- 4. ENTRIES
-- ------------------------------------------------------------
create table if not exists entries (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references profiles(id) on delete cascade,
  type_id     uuid references entry_types(id) on delete set null,
  body        text not null default '',
  transcript  text,                       -- raw machine guess, kept separate
  audio_path  text,
  audio_ms    int,
  photo_path  text,
  client_id   text not null unique,       -- idempotency key from the offline queue
  created_at  timestamptz not null default now(),  -- CAPTURE time, set by the client
  synced_at   timestamptz not null default now()
);
alter table entries enable row level security;

create index if not exists entries_created_at_idx on entries (created_at desc);
create index if not exists entries_type_idx       on entries (type_id);

-- ------------------------------------------------------------
-- 5. REPLIES
-- ------------------------------------------------------------
create table if not exists replies (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references entries(id) on delete cascade,
  author_id  uuid not null references profiles(id) on delete cascade,
  body       text not null,
  client_id  text not null unique,
  created_at timestamptz not null default now()
);
alter table replies enable row level security;
create index if not exists replies_entry_idx on replies (entry_id, created_at);

-- ------------------------------------------------------------
-- 6. PUSH SUBSCRIPTIONS
-- ------------------------------------------------------------
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

-- ------------------------------------------------------------
-- 7. POLICIES
--    There is no privacy boundary between the two of you.
--    The boundary is the allowlist at the door.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','entry_types','entries','replies','push_subscriptions']
  loop
    execute format('drop policy if exists "allowed_read"  on %I', t);
    execute format('drop policy if exists "allowed_write" on %I', t);
    execute format(
      'create policy "allowed_read" on %I for select using (is_allowed())', t);
    execute format(
      'create policy "allowed_write" on %I for all using (is_allowed()) with check (is_allowed())', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 8. STORAGE
--    Two buckets, private. Access flows through the same
--    allowlist check as everything else.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('audio', 'audio', false), ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "allowed_storage_read"  on storage.objects;
drop policy if exists "allowed_storage_write" on storage.objects;

create policy "allowed_storage_read" on storage.objects
  for select using (bucket_id in ('audio','photos') and is_allowed());

create policy "allowed_storage_write" on storage.objects
  for all using (bucket_id in ('audio','photos') and is_allowed())
      with check (bucket_id in ('audio','photos') and is_allowed());

-- ------------------------------------------------------------
-- 9. A VIEW THAT SAVES THE CLIENT SOME ROUND TRIPS
-- ------------------------------------------------------------
create or replace view entries_full
with (security_invoker = true) as
select
  e.*,
  p.display_name as author_name,
  t.label        as type_label,
  t.slug         as type_slug,
  (select count(*) from replies r where r.entry_id = e.id) as reply_count
from entries e
join profiles p on p.id = e.author_id
left join entry_types t on t.id = e.type_id;

-- ============================================================
--  DONE.
--  Next: Table editor → allowed_emails → add two rows,
--  one for each of your email addresses. Nothing works
--  until those exist.
-- ============================================================
