-- 007_learner_profiles.sql
--
-- The learner-level half of the learner model: traits that describe the person rather
-- than any single topic. How accurate they are overall, how fast they answer, how
-- regularly they show up, which difficulty suits them right now.
--
-- Everything in this table is DERIVED from question_attempts and can be rebuilt from
-- scratch at any time. It exists because recomputing it on every dashboard load would
-- mean scanning a learner's whole history on a phone with a slow connection, and the
-- dashboard is the most visited screen in the app. One row read instead of one scan.
--
-- Because it is a cache, two columns exist to keep us honest:
--   computed_at        when these numbers were last refreshed
--   computed_version   which version of the formula produced them, so that changing the
--                      weights later tells us exactly which rows are stale
--
-- Per-topic mastery is a separate table (008), because that is where the interesting
-- decisions happen and it needs one row per topic.

create table if not exists public.learner_profiles (
    -- One row per learner. The primary key IS the user, so a duplicate cannot exist.
    user_id uuid primary key references public.profiles (id) on delete cascade,

    -- ---- volume and accuracy ----
    total_attempts integer not null default 0,
    correct_attempts integer not null default 0,

    overall_accuracy numeric(5, 2) generated always as (
        case
            when total_attempts > 0
                then round(correct_attempts::numeric * 100 / total_attempts, 2)
            else null
        end
    ) stored,

    -- ---- speed ----
    -- Average seconds per answered question. The adaptive engine uses it to estimate how
    -- long a practice set will take, so a plan promising "20 minutes" is believable.
    avg_seconds_per_question numeric(6, 2),

    -- ---- regularity ----
    -- 0 to 100. How consistently the learner studies, not how much. A learner doing 20
    -- minutes daily beats one doing three hours every second Sunday, and the readiness
    -- score is meant to reflect that.
    consistency_score numeric(5, 2),

    current_streak_days integer not null default 0,
    longest_streak_days integer not null default 0,

    -- Drives re-planning: if this date falls behind, sessions were missed and the plan
    -- needs recalculating.
    last_activity_date date,

    -- Where the learner currently performs best. The adaptive engine starts here and
    -- pushes up as mastery grows. NULL until there is enough evidence to say.
    preferred_difficulty text,

    -- ---- cache bookkeeping ----
    computed_at timestamptz not null default now(),
    computed_version integer not null default 1,

    updated_at timestamptz not null default now(),

    constraint learner_profiles_counts_non_negative
        check (total_attempts >= 0 and correct_attempts >= 0),

    -- More correct answers than answers given is not a thing.
    constraint learner_profiles_correct_within_total
        check (correct_attempts <= total_attempts),

    constraint learner_profiles_consistency_range
        check (consistency_score is null or consistency_score between 0 and 100),

    constraint learner_profiles_streaks_sane
        check (
            current_streak_days >= 0
            and longest_streak_days >= 0
            and current_streak_days <= longest_streak_days
        ),

    constraint learner_profiles_preferred_difficulty_known
        check (preferred_difficulty is null
               or preferred_difficulty in ('easy', 'medium', 'hard')),

    constraint learner_profiles_speed_sane
        check (avg_seconds_per_question is null
               or avg_seconds_per_question between 0 and 3600)
);

comment on table public.learner_profiles is
    'Cached learner-level traits derived from question_attempts. Safe to delete and rebuild.';

drop trigger if exists learner_profiles_set_updated_at on public.learner_profiles;
create trigger learner_profiles_set_updated_at
    before update on public.learner_profiles
    for each row
    execute function extensions.moddatetime (updated_at);

-- Finding learners whose cache predates a formula change, so a rebuild can target only
-- the rows that need it.
create index if not exists learner_profiles_stale_idx
    on public.learner_profiles (computed_version, computed_at);

-- ---------------------------------------------------------------------------
-- Every learner has one from the moment they sign up
-- ---------------------------------------------------------------------------
-- Creating the row here rather than on first use means no reader anywhere has to handle
-- "profile exists but learner profile does not". A brand new learner has zeros, which is
-- the truth about them.
create or replace function public.create_learner_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.learner_profiles (user_id)
    values (new.id)
    on conflict (user_id) do nothing;

    return new;
end;
$$;

drop trigger if exists profiles_create_learner_profile on public.profiles;
create trigger profiles_create_learner_profile
    after insert on public.profiles
    for each row
    execute function public.create_learner_profile();

-- Anyone who signed up before this migration ran.
insert into public.learner_profiles (user_id)
select p.id from public.profiles p
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Learners read their own numbers. Only the backend writes them, because they are the
-- output of a calculation and a learner editing their own mastery cache would make every
-- recommendation meaningless.
alter table public.learner_profiles enable row level security;

drop policy if exists "Learners read their own learner profile" on public.learner_profiles;
create policy "Learners read their own learner profile"
    on public.learner_profiles
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.learner_profiles to authenticated;
