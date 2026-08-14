-- 011_study_plans.sql
--
-- One row per plan a learner has been given. Plans are versioned rather than edited: when
-- the plan is rebuilt -- because sessions were missed, or a re-test went badly -- a new
-- version is written and the old one is superseded, not overwritten.
--
-- Why versions rather than an UPDATE. A plan is a promise made to somebody on a date, and
-- the whole point of adaptive re-planning is that the promise changed. Overwriting it
-- destroys the only evidence of what changed and why, which is exactly what a learner
-- asking "why is my plan different today" needs to see. It also means a plan can be shown
-- as history without any extra bookkeeping.
--
-- What lives here: the inputs the plan was built from and the shape of the result. The
-- day-by-day work is in 012_study_sessions. The algorithm is in
-- backend/src/services/planning/planEngine.ts -- deliberately not in SQL, and deliberately
-- not asked of the model. Dividing a budget by priority is arithmetic; a plan that came
-- out of a language model could not be explained, reproduced, or unit tested, and the
-- learner would have no way to know whether it added up.

create table if not exists public.study_plans (
    id uuid primary key default gen_random_uuid (),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- The goal this plan serves. Cascade: a plan for a deleted goal is meaningless.
    goal_id uuid not null references public.learning_goals (id) on delete cascade,

    -- 1 for the first plan against a goal, then 2, 3... Scoped per goal, not per learner,
    -- so "version 3" reads as "the third plan for this exam".
    version integer not null default 1,

    status text not null default 'active',

    -- ---- the inputs, kept so the plan is explainable after the fact ----
    -- Copied rather than joined on purpose. A learner who edits their goal from 60 to 90
    -- minutes a day should still be able to see that yesterday's plan assumed 60.
    exam_date date not null,
    daily_minutes integer not null,
    days_remaining integer not null,

    -- ---- the shape of the result ----
    total_minutes_planned integer not null default 0,
    topics_covered integer not null default 0,

    -- Why this plan was built. 'initial' for the first one; the rest name what triggered
    -- the rebuild, which is what the re-planning feature has to be able to justify.
    reason text not null default 'initial',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint study_plans_version_positive check (version >= 1),

    constraint study_plans_status_known
        check (status in ('active', 'superseded', 'completed', 'abandoned')),

    constraint study_plans_reason_known
        check (reason in ('initial', 'missed_sessions', 'poor_performance', 'goal_changed', 'requested')),

    -- Bounds mirroring learning_goals, so a plan cannot claim a budget the goal could not
    -- have given it.
    constraint study_plans_daily_minutes_sane
        check (daily_minutes between 10 and 960),

    constraint study_plans_days_remaining_sane
        check (days_remaining between 0 and 730),

    constraint study_plans_totals_non_negative
        check (total_minutes_planned >= 0 and topics_covered >= 0),

    -- One version number per goal. Two plans claiming to be version 2 of the same goal
    -- would make the history unreadable.
    constraint study_plans_unique_version unique (goal_id, version)
);

comment on table public.study_plans is
    'A day-by-day study plan, versioned. Re-planning writes a new version and supersedes the old one rather than editing it.';

comment on column public.study_plans.reason is
    'What caused this version to exist. The justification the re-planning feature owes the learner.';

comment on column public.study_plans.daily_minutes is
    'The budget this plan was built against, copied from the goal so an edited goal does not rewrite history.';

-- ---------------------------------------------------------------------------
-- One active plan per learner
-- ---------------------------------------------------------------------------
-- Enforced in the database rather than trusted to the service. Two active plans is not a
-- cosmetic problem: every screen asks for "the" current plan, and which one it got would
-- depend on row order.
create unique index if not exists study_plans_one_active_per_user_idx
    on public.study_plans (user_id)
    where status = 'active';

-- "Show me this goal's plans, newest first" -- the history view.
create index if not exists study_plans_goal_version_idx
    on public.study_plans (goal_id, version desc);

drop trigger if exists study_plans_set_updated_at on public.study_plans;
create trigger study_plans_set_updated_at
    before update on public.study_plans
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Read-only to learners, like mastery and for the same reason: a plan a learner could
-- write is a plan that proves nothing about what they should study. Plans are created by
-- the planning service through the elevated client.
alter table public.study_plans enable row level security;

drop policy if exists "Learners read their own plans" on public.study_plans;
create policy "Learners read their own plans"
    on public.study_plans
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.study_plans to authenticated;
