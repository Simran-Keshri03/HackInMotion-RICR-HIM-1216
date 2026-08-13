-- 006_assessments.sql
--
-- The diagnostic. Before Adigam can plan anything it has to find out what the learner
-- already knows, measured from answers rather than from a self-rating -- which is the
-- whole point of the product.
--
-- Two tables:
--   assessments           one sitting: when it started, how it went
--   assessment_questions  the exact questions served, in order
--
-- The question list is stored rather than generated on the fly for two reasons. A
-- learner on a patchy connection can close the tab and resume the same paper, and the
-- per-topic breakdown afterwards needs to know which topics were actually tested.
--
-- The answers themselves are NOT stored here. They go into question_attempts like every
-- other answer, and each row below points at the attempt. One log of answers, one place
-- for mastery to read from.

create table if not exists public.assessments (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- An assessment only means something against a goal, because the goal decides which
    -- topics are worth testing.
    goal_id uuid not null references public.learning_goals (id) on delete cascade,

    -- diagnostic  the first sitting, used to build the learner profile
    -- checkpoint  a later re-test, used to show whether things improved
    kind text not null default 'diagnostic',

    status text not null default 'in_progress',

    -- Fixed when the paper is created, so progress ("4 of 12") is known up front.
    question_count integer not null,

    correct_count integer not null default 0,

    -- Derived, so it can never disagree with the two counts above. Postgres recomputes
    -- it on every update and no application code can get it wrong.
    accuracy numeric(5, 2) generated always as (
        case
            when question_count > 0
                then round(correct_count::numeric * 100 / question_count, 2)
            else null
        end
    ) stored,

    started_at timestamptz not null default now(),
    completed_at timestamptz,

    constraint assessments_kind_known
        check (kind in ('diagnostic', 'checkpoint')),

    constraint assessments_status_known
        check (status in ('in_progress', 'completed', 'abandoned')),

    constraint assessments_question_count_sane
        check (question_count between 1 and 100),

    constraint assessments_correct_count_sane
        check (correct_count between 0 and question_count),

    -- A finished assessment has a finish time; an unfinished one does not.
    constraint assessments_completed_at_matches_status check (
        (status = 'completed' and completed_at is not null)
        or (status <> 'completed' and completed_at is null)
    )
);

comment on table public.assessments is
    'Diagnostic and checkpoint sittings. Answers live in question_attempts, not here.';

-- Resuming has to be unambiguous, so a learner can only have one unfinished sitting.
create unique index if not exists assessments_one_in_progress_per_user
    on public.assessments (user_id)
    where status = 'in_progress';

create index if not exists assessments_user_status_idx
    on public.assessments (user_id, status);

-- ---------------------------------------------------------------------------
-- The paper
-- ---------------------------------------------------------------------------
create table if not exists public.assessment_questions (
    assessment_id uuid not null references public.assessments (id) on delete cascade,

    question_id uuid not null references public.questions (id) on delete restrict,

    -- 1-based order the learner sees them in.
    position integer not null,

    -- NULL until answered. Filled with the attempt that answered it, which is how the
    -- breakdown afterwards finds out what happened without duplicating the result here.
    attempt_id uuid references public.question_attempts (id) on delete set null,

    primary key (assessment_id, question_id),

    constraint assessment_questions_position_positive check (position > 0),

    -- Two questions cannot share a slot, or "question 3 of 12" means nothing.
    constraint assessment_questions_position_unique unique (assessment_id, position)
);

comment on table public.assessment_questions is
    'Questions served in one sitting, in order. attempt_id is NULL until the learner answers.';

create index if not exists assessment_questions_attempt_idx
    on public.assessment_questions (attempt_id);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Learners read their own sittings so the UI can show progress and results. Creating a
-- paper, grading it and marking it complete all happen in the backend, because that is
-- where the correct answers are readable.
alter table public.assessments enable row level security;

drop policy if exists "Learners read their own assessments" on public.assessments;
create policy "Learners read their own assessments"
    on public.assessments
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.assessments to authenticated;

alter table public.assessment_questions enable row level security;

drop policy if exists "Learners read the questions of their own assessments" on public.assessment_questions;
create policy "Learners read the questions of their own assessments"
    on public.assessment_questions
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.assessments a
            where a.id = assessment_questions.assessment_id
              and a.user_id = auth.uid()
        )
    );

grant select on public.assessment_questions to authenticated;
