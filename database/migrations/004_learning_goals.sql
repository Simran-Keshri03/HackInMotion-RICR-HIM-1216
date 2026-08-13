-- 004_learning_goals.sql
--
-- What the learner is preparing for, by when, and with how much time per day. This is
-- the planner's input: without an exam date and a daily budget there is nothing to
-- schedule, and without a topic list there is nothing to schedule it over.
--
-- Two tables, one concern:
--   learning_goals        the goal itself
--   learning_goal_topics  which parts of the syllabus it covers
--
-- Writes go through the backend (POST /api/v1/goals), which is why the browser gets
-- SELECT and nothing else. Validation that needs judgement -- is the exam date in the
-- future, do these topics belong together -- lives in one place instead of being half
-- in a CHECK constraint and half in the API.

create table if not exists public.learning_goals (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- The learner's own words: "GATE CS 2027", "DBMS endsem".
    title text not null,

    -- The deadline everything is planned backwards from.
    exam_date date not null,

    -- Minutes the learner can realistically study per day. The planner divides work by
    -- this, so a wrong value here quietly ruins every plan.
    daily_minutes integer not null,

    -- active   the one goal the dashboard, planner and readiness score refer to
    -- archived kept for history, ignored by every engine
    status text not null default 'active',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint learning_goals_title_not_blank
        check (char_length(trim(title)) between 1 and 120),

    constraint learning_goals_status_known
        check (status in ('active', 'archived')),

    -- 10 minutes is the least that makes a plan meaningful; 16 hours is past the point
    -- where a person is being honest with themselves.
    constraint learning_goals_daily_minutes_sane
        check (daily_minutes between 10 and 960)
);

comment on table public.learning_goals is
    'One active goal per learner drives the planner, revision schedule and readiness score.';

-- "The current study plan" has to mean one thing, so a learner can only have one active
-- goal. Archived goals are unlimited. A partial unique index says exactly that.
create unique index if not exists learning_goals_one_active_per_user
    on public.learning_goals (user_id)
    where status = 'active';

create index if not exists learning_goals_user_id_idx
    on public.learning_goals (user_id);

drop trigger if exists learning_goals_set_updated_at on public.learning_goals;
create trigger learning_goals_set_updated_at
    before update on public.learning_goals
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Which syllabus the goal covers
-- ---------------------------------------------------------------------------
-- A row may point at a subject (covers everything under it) or at a single topic. The
-- planner expands subjects to their children, so the learner can say "all of DBMS" or
-- "just Normalisation" with the same table.
create table if not exists public.learning_goal_topics (
    goal_id uuid not null references public.learning_goals (id) on delete cascade,

    -- Restrict: a topic that somebody is actively preparing for should not vanish from
    -- under their plan.
    topic_id uuid not null references public.topics (id) on delete restrict,

    primary key (goal_id, topic_id)
);

comment on table public.learning_goal_topics is
    'Scope of a goal. A subject row implies all topics beneath it.';

create index if not exists learning_goal_topics_topic_id_idx
    on public.learning_goal_topics (topic_id);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Read straight from the browser so the dashboard costs one request. Every write goes
-- through the backend, so no INSERT, UPDATE or DELETE policy exists here.
alter table public.learning_goals enable row level security;

drop policy if exists "Learners read their own goals" on public.learning_goals;
create policy "Learners read their own goals"
    on public.learning_goals
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.learning_goals to authenticated;

alter table public.learning_goal_topics enable row level security;

-- The scope rows are reachable only through a goal the learner already owns.
drop policy if exists "Learners read the scope of their own goals" on public.learning_goal_topics;
create policy "Learners read the scope of their own goals"
    on public.learning_goal_topics
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.learning_goals g
            where g.id = learning_goal_topics.goal_id
              and g.user_id = auth.uid()
        )
    );

grant select on public.learning_goal_topics to authenticated;
