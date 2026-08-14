-- 012_study_sessions.sql
--
-- The day-by-day work inside a plan: on this date, spend this long on this topic.
--
-- One row per (plan, date, topic). A day with three topics is three rows, which is what
-- makes "what did I actually do on Tuesday" answerable without unpacking a JSON blob.
--
-- Completion is recorded here rather than inferred from question_attempts. The two are not
-- the same question: attempts say what was answered, a session says whether the thing the
-- plan asked for got done. A learner who practised a different topic for an hour has been
-- active and has still missed the session, and re-planning needs to be able to tell those
-- apart -- that distinction is the input signal for challenge 1.

create table if not exists public.study_sessions (
    id uuid primary key default gen_random_uuid (),

    plan_id uuid not null references public.study_plans (id) on delete cascade,

    -- Denormalised from the plan so "my sessions this week" does not need a join, and so
    -- row-level security can check ownership without one. Kept honest by a trigger below.
    user_id uuid not null references public.profiles (id) on delete cascade,

    -- Restrict, like concept_mastery: a topic somebody has planned work on should not
    -- vanish from under their plan.
    topic_id uuid not null references public.topics (id) on delete restrict,

    scheduled_date date not null,

    -- Where in the day this sits. Lower first. Not a time of day: the plan does not know
    -- when somebody is free, only what order to do things in.
    sort_order integer not null default 0,

    -- ---- what was planned ----
    planned_minutes integer not null,
    planned_questions integer not null,

    -- 'learn' for a topic being built up, 'revise' for one being kept alive. Spaced
    -- repetition (challenge 2) writes 'revise' rows; the planner writes 'learn'.
    kind text not null default 'learn',

    -- Why this topic, on this day, for this long. Written at planning time in words,
    -- because a plan a learner cannot interrogate is a plan they will not follow.
    reason text,

    -- ---- what happened ----
    status text not null default 'pending',
    completed_at timestamptz,

    -- Filled in when the session is closed out, from the attempts that belong to it.
    questions_answered integer not null default 0,
    questions_correct integer not null default 0,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint study_sessions_kind_known check (kind in ('learn', 'revise', 'assess')),

    constraint study_sessions_status_known
        check (status in ('pending', 'completed', 'partial', 'missed', 'skipped')),

    -- A session nobody could do is a planning bug, not a valid row.
    constraint study_sessions_planned_positive
        check (planned_minutes > 0 and planned_questions > 0),

    -- A single session longer than a very long day means the split went wrong.
    constraint study_sessions_planned_minutes_sane
        check (planned_minutes <= 960),

    constraint study_sessions_answered_non_negative
        check (questions_answered >= 0 and questions_correct >= 0),

    constraint study_sessions_correct_within_answered
        check (questions_correct <= questions_answered),

    -- Completed means completed: a status claiming so without a timestamp cannot be
    -- reasoned about, and the missed-session signal depends on this being trustworthy.
    constraint study_sessions_completed_has_timestamp
        check (
            (status = 'completed' and completed_at is not null)
            or (status <> 'completed')
        ),

    -- One session per topic per day per plan. Two would double-count the day's budget.
    constraint study_sessions_unique_slot
        unique (plan_id, scheduled_date, topic_id)
);

comment on table public.study_sessions is
    'One planned block of study: date, topic, how long. Completion is recorded, not inferred, so a missed session is distinguishable from a busy day spent elsewhere.';

comment on column public.study_sessions.status is
    'pending until the date passes. completed/partial from what was answered; missed when nothing was. The signal adaptive re-planning reads.';

comment on column public.study_sessions.reason is
    'Why this topic on this day, in words, written when the plan was built.';

-- ---------------------------------------------------------------------------
-- Keep user_id honest
-- ---------------------------------------------------------------------------
-- The column is a copy, and a copy that can disagree with its source is worse than a
-- join. Taken from the plan rather than from whatever the caller passed, for the same
-- reason question_attempts overwrites its own topic_id: a denormalised field the caller
-- controls is a denormalised field the caller can lie about.
create or replace function public.fill_study_session_user ()
    returns trigger
    language plpgsql
    security definer
    set search_path = public, pg_temp
    as $$
begin
    select p.user_id into new.user_id
    from public.study_plans p
    where p.id = new.plan_id;

    if new.user_id is null then
        raise exception 'study session references a plan that does not exist';
    end if;

    return new;
end;
$$;

drop trigger if exists study_sessions_fill_user on public.study_sessions;
create trigger study_sessions_fill_user
    before insert on public.study_sessions
    for each row
    execute function public.fill_study_session_user ();

drop trigger if exists study_sessions_set_updated_at on public.study_sessions;
create trigger study_sessions_set_updated_at
    before update on public.study_sessions
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- "What am I doing today" -- the query behind the plan screen, run on every visit.
create index if not exists study_sessions_user_date_idx
    on public.study_sessions (user_id, scheduled_date, sort_order);

-- "Which sessions in this plan were missed" -- the re-planning trigger.
create index if not exists study_sessions_plan_status_idx
    on public.study_sessions (plan_id, status, scheduled_date);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.study_sessions enable row level security;

drop policy if exists "Learners read their own sessions" on public.study_sessions;
create policy "Learners read their own sessions"
    on public.study_sessions
    for select
    to authenticated
    using (auth.uid() = user_id);

-- Read only. A learner marking their own sessions complete would make the missed-session
-- signal -- and therefore every re-plan built on it -- worthless. Completion is written by
-- the service from what was actually answered.
grant select on public.study_sessions to authenticated;
