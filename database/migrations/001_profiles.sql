-- 001_profiles.sql
--
-- Every Adigam learner has exactly one profile row, keyed by their Supabase auth id.
-- This table is the anchor for the whole schema: goals, attempts, mastery, plans and
-- readiness all point back to profiles.id.
--
-- Design note: the row is created by a database trigger when the user signs up, never
-- by the browser. If a client can insert its own profile, it can also choose its own
-- field values, and we would be trusting the browser with data the server owns.

-- Supabase ships moddatetime; we use it instead of hand-writing an updated_at trigger.
create extension if not exists moddatetime schema extensions;

create table if not exists public.profiles (
    -- Same id as auth.users. Deleting the auth user removes the profile and, through
    -- the rest of the schema, everything that belongs to them.
    id uuid primary key references auth.users (id) on delete cascade,

    -- Convenience copy for display and joins. auth.users stays the source of truth
    -- for identity, so nothing security-related should ever read this column.
    email text,

    display_name text,
    avatar_url text,

    -- The study planner schedules by the learner's local day, so it needs their zone.
    timezone text not null default 'Asia/Kolkata',

    -- UI preferences (theme, sound, notifications). jsonb so that adding a toggle in
    -- the Settings page does not need a migration.
    settings jsonb not null default '{}'::jsonb,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint profiles_display_name_length check (
        display_name is null or char_length(display_name) between 1 and 60
    ),
    constraint profiles_timezone_not_blank check (char_length(trim(timezone)) > 0)
);

comment on table public.profiles is
    'One row per learner, created automatically on signup. Anchor for all user-owned data.';

-- Keep updated_at honest without the application having to remember.
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
    before update on public.profiles
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Profile creation on signup
-- ---------------------------------------------------------------------------
-- Runs as the definer so it can write to a table the new user cannot insert into.
-- search_path is pinned: without it, a rogue schema earlier on the path could shadow
-- the objects this function resolves, which is the classic definer-function attack.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.profiles (id, email, display_name, avatar_url)
    values (
        new.id,
        new.email,
        nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
        new.raw_user_meta_data ->> 'avatar_url'
    )
    -- A retried or duplicate signup event must not break authentication.
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- A learner may read and edit their own profile, and nothing else. There is
-- deliberately no INSERT policy (the trigger above owns creation) and no DELETE policy
-- (account deletion is a separate, audited operation).
alter table public.profiles enable row level security;

drop policy if exists "Learners read their own profile" on public.profiles;
create policy "Learners read their own profile"
    on public.profiles
    for select
    using (auth.uid() = id);

drop policy if exists "Learners update their own profile" on public.profiles;
create policy "Learners update their own profile"
    on public.profiles
    for update
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------
-- This project has "automatically expose new tables" turned off, so a table is
-- unreachable until we grant it deliberately. Two separate locks:
--   grants  decide which operations a role may attempt
--   RLS     decides which rows those operations may touch
--
-- Logged-out visitors (anon) get nothing. Signed-in learners may read their row and
-- edit only the columns they own — email and id are excluded on purpose, since
-- auth.users is the source of truth for identity.
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url, timezone, settings) on public.profiles to authenticated;
