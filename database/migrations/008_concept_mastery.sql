-- 008_concept_mastery.sql
--
-- One row per learner per topic: how well they know it, and the evidence behind that
-- judgement. This is the table the adaptive engine reads to answer "what should this
-- person do next", and the one the readiness score rolls up.
--
-- What lives here and what does not:
--   mastery_score   the OUTPUT of the mastery formula, stored so it can be read cheaply
--   everything else the INPUTS that formula ran on, stored so the score is explainable
--
-- The formula itself lives in backend/src/services/learner/masteryEngine.ts, not in SQL,
-- because its weights are meant to be tuned and unit tested. This table is deliberately
-- dumb: it holds numbers and refuses to hold impossible ones.
--
-- Like 007 this is a rebuildable cache over question_attempts. If the weights change,
-- bump computed_version and recompute.
--
-- Honesty note carried through to the UI: a mastery score is an estimate from a handful
-- of answers, not a measurement. total_attempts sits next to it so the interface can say
-- "68, based on 9 attempts" instead of pretending to precision it does not have.

create table if not exists public.concept_mastery (
    user_id uuid not null references public.profiles (id) on delete cascade,

    -- Restrict: a topic somebody has mastery in should not disappear from under them.
    topic_id uuid not null references public.topics (id) on delete restrict,

    -- ---- the output ----
    -- 0 to 100. NULL would mean "no opinion", but a row only exists once there is
    -- evidence, so it always has a value.
    mastery_score numeric(5, 2) not null default 0,

    -- ---- evidence: overall ----
    total_attempts integer not null default 0,
    correct_attempts integer not null default 0,

    accuracy numeric(5, 2) generated always as (
        case
            when total_attempts > 0
                then round(correct_attempts::numeric * 100 / total_attempts, 2)
            else null
        end
    ) stored,

    -- ---- evidence: recent ----
    -- The last N attempts on this topic, N decided by the engine. Recent performance is
    -- weighted more heavily than history, because someone who has just revised a topic
    -- knows it better than their six-week-old average suggests.
    recent_attempts integer not null default 0,
    recent_correct integer not null default 0,

    recent_accuracy numeric(5, 2) generated always as (
        case
            when recent_attempts > 0
                then round(recent_correct::numeric * 100 / recent_attempts, 2)
            else null
        end
    ) stored,

    -- ---- evidence: difficulty handling ----
    -- Getting easy questions right is not the same as getting hard ones right, and a
    -- mastery score that cannot tell the difference is not worth much. The engine also
    -- uses this to decide which difficulty to serve next.
    easy_attempts integer not null default 0,
    easy_correct integer not null default 0,
    medium_attempts integer not null default 0,
    medium_correct integer not null default 0,
    hard_attempts integer not null default 0,
    hard_correct integer not null default 0,

    -- ---- evidence: recency and consistency ----
    last_attempt_at timestamptz,

    -- When the learner last got this topic right. The retention engine measures decay
    -- from here, so it earns its own column rather than being dug out of the attempt log.
    last_correct_at timestamptz,

    -- Consecutive correct answers on this topic. A run of five says something a 60%
    -- average hides.
    correct_streak integer not null default 0,

    -- ---- cache bookkeeping ----
    computed_at timestamptz not null default now(),
    computed_version integer not null default 1,

    updated_at timestamptz not null default now(),

    -- One row per learner per topic, enforced by the key itself.
    primary key (user_id, topic_id),

    constraint concept_mastery_score_range
        check (mastery_score between 0 and 100),

    constraint concept_mastery_counts_non_negative check (
        total_attempts >= 0 and correct_attempts >= 0
        and recent_attempts >= 0 and recent_correct >= 0
        and easy_attempts >= 0 and easy_correct >= 0
        and medium_attempts >= 0 and medium_correct >= 0
        and hard_attempts >= 0 and hard_correct >= 0
        and correct_streak >= 0
    ),

    constraint concept_mastery_correct_within_total
        check (correct_attempts <= total_attempts),

    constraint concept_mastery_recent_within_total check (
        recent_correct <= recent_attempts
        and recent_attempts <= total_attempts
    ),

    constraint concept_mastery_difficulty_correct_within_attempts check (
        easy_correct <= easy_attempts
        and medium_correct <= medium_attempts
        and hard_correct <= hard_attempts
    ),

    -- Every attempt was at exactly one difficulty, so the three buckets must add up. If
    -- they ever do not, an update touched the total without touching the bucket, and the
    -- difficulty part of the score has quietly gone wrong. Better to fail loudly here.
    constraint concept_mastery_difficulty_buckets_add_up
        check (easy_attempts + medium_attempts + hard_attempts = total_attempts),

    constraint concept_mastery_streak_within_total
        check (correct_streak <= correct_attempts),

    -- A topic cannot have been answered correctly before it was answered at all.
    constraint concept_mastery_correct_needs_attempt check (
        last_correct_at is null
        or (last_attempt_at is not null and last_correct_at <= last_attempt_at)
    )
);

comment on table public.concept_mastery is
    'Per-topic mastery: the score plus the evidence it was derived from. Rebuildable from question_attempts.';

comment on column public.concept_mastery.mastery_score is
    'Estimate on a 0-100 scale, produced by masteryEngine. Read alongside total_attempts; a score from 3 attempts means little.';

drop trigger if exists concept_mastery_set_updated_at on public.concept_mastery;
create trigger concept_mastery_set_updated_at
    before update on public.concept_mastery
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- "This learner's weakest topics first" -- the query behind the next recommendation, the
-- revision list and the insights screen.
create index if not exists concept_mastery_user_weakest_idx
    on public.concept_mastery (user_id, mastery_score);

-- "Which topics has this learner not touched lately" -- retention risk and smart revision.
create index if not exists concept_mastery_user_stalest_idx
    on public.concept_mastery (user_id, last_attempt_at nulls first);

-- Rebuilding after a formula change, without scanning rows that are already current.
create index if not exists concept_mastery_stale_idx
    on public.concept_mastery (computed_version, computed_at);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- The single most important write restriction in the schema. If a learner could set
-- their own mastery, every plan, recommendation, revision list and readiness score built
-- on top of it would be fiction.
alter table public.concept_mastery enable row level security;

drop policy if exists "Learners read their own mastery" on public.concept_mastery;
create policy "Learners read their own mastery"
    on public.concept_mastery
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.concept_mastery to authenticated;
