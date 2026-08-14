-- ============================================================
--  DIAGNOSE
--  Paste into Supabase → SQL Editor → Run. Read-only except for
--  step 4, which repairs a specific problem and is safe to run
--  more than once.
-- ============================================================

-- ── 1 · Who's on the guest list? ────────────────────────────
-- Whitespace and capitalisation are the usual culprits. is_allowed()
-- lowercases both sides, so case is fine — a stray space is not.
select
  email,
  length(email)                as chars,
  email <> btrim(email)        as has_stray_whitespace,
  email <> lower(email)        as has_uppercase
from allowed_emails
order by email;


-- ── 2 · Who has actually signed up, and can they see anything? ──
-- on_allowlist false  → they can sign in but every read returns
--                       nothing and every write is rejected.
-- has_profile  false  → worse. Sign-in works, reads work, but
--                       EVERY entry they try to save fails the
--                       author_id foreign key. Fixed in step 4.
select
  u.email,
  u.created_at::date                                as signed_up,
  u.last_sign_in_at                                 as last_seen,
  u.email_confirmed_at is not null                  as email_confirmed,
  (p.id is not null)                                as has_profile,
  exists (select 1 from allowed_emails a
          where lower(a.email) = lower(u.email))    as on_allowlist
from auth.users u
left join profiles p on p.id = u.id
order by u.created_at;


-- ── 3 · Is anything actually in there? ──────────────────────
select
  (select count(*) from entries)     as entries,
  (select count(*) from replies)     as replies,
  (select count(*) from entry_types) as types,
  (select count(*) from profiles)    as profiles,
  (select count(*) from auth.users)  as auth_users;
-- profiles should equal auth_users. If it's lower, run step 4.


-- ── 4 · REPAIR: backfill missing profiles ───────────────────
-- The trigger that creates a profile only fires on NEW signups.
-- Anyone who signed in before schema.sql was run has no profile
-- row, and every save they attempt fails silently on the foreign
-- key. This fixes them. Safe to re-run.
insert into profiles (id, display_name)
select u.id, split_part(u.email, '@', 1)
from auth.users u
on conflict (id) do nothing;

-- Confirm it worked — should return 0 rows.
select u.email as still_missing_a_profile
from auth.users u
left join profiles p on p.id = u.id
where p.id is null;


-- ── 5 · Sanity: are the policies actually on? ───────────────
-- Every one of these must be true. If rowsecurity is false
-- anywhere, that table is wide open to anyone with the anon key.
select tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','entries','replies','entry_types',
                    'allowed_emails','push_subscriptions')
order by tablename;


-- ── 6 · Does the allowlist function work at all? ────────────
-- Run this while signed in via the SQL editor and it'll return
-- false (the editor has no user JWT) — that's expected. What
-- matters is that it runs without erroring.
select is_allowed() as should_run_without_error;
