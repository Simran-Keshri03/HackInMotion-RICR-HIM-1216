-- 017_mock_tests.sql
--
-- Mock tests: a set of questions across several topics, answered in one sitting, marked at the end.
--
-- The important difference from practice is not the length — it is *when the learner finds out*.
-- Practice reveals the answer and the explanation immediately, because the point is to learn from
-- each question. A test that did that would be a practice set with a timer: knowing you got question
-- three wrong changes how you answer question four, and the score at the end would measure something
-- other than what the learner knew when they started.
--
-- That single requirement is why these tables exist at all. Withholding the answer cannot be done in
-- the client — the answer would still be in the response, visible in devtools — so the server has to
-- know which questions belong to a test, take every answer at the end, and only then mark it. Hence a
-- stored test with stored per-question rows, rather than a loop over the existing attempts endpoint.
--
-- Questions come from the learner's study plan, so a test covers what they have been asked to study
-- rather than the whole syllabus. Selection lives in
-- backend/src/services/assessment/mockTestEngine.ts.

create table if not exists public.mock_tests (
    id uuid primary key default gen_random_uuid (),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- The plan the topics were drawn from. Set null rather than cascade: a re-plan supersedes the
    -- plan, and a test somebody sat last week is still a true record of that week.
    plan_id uuid references public.study_plans (id) on delete set null,

    title text not null,

    -- 'plan' when topics came from scheduled sessions, 'goal' when the plan had nothing to offer and
    -- the goal's subjects were used instead. Stored because it changes what the score means.
    source text not null default 'plan',

    status text not null default 'in_progress',

    total_questions integer not null,
    /** Advisory rather than enforced: the server does not cut a learner off mid-answer. */
    duration_minutes integer not null,

    -- ---- the outcome, written once at submission ----
    correct_count integer,
    score_percent numeric(5, 2),
    seconds_taken integer,

    started_at timestamptz not null default now(),
    submitted_at timestamptz,

    constraint mock_tests_status_known
        check (status in ('in_progress', 'submitted', 'abandoned')),

    constraint mock_tests_source_known check (source in ('plan', 'goal')),

    -- A test with no questions is a bug, and forty in one sitting is not a mock test.
    constraint mock_tests_size_sane check (total_questions between 1 and 40),

    constraint mock_tests_duration_sane check (duration_minutes between 1 and 300),

    -- A submitted test has a full result; an unsubmitted one has none of it. Half a result is worse
    -- than no result, because a screen cannot tell which half to trust.
    constraint mock_tests_result_complete check (
        (status = 'submitted'
            and submitted_at is not null
            and correct_count is not null
            and score_percent is not null)
        or (status <> 'submitted'
            and correct_count is null
            and score_percent is null)
    ),

    constraint mock_tests_correct_within_total
        check (correct_count is null or correct_count <= total_questions)
);

comment on table public.mock_tests is
    'A mock test sitting. Marked in one go at submission, never per question — that is the whole reason this is not just practice.';

comment on column public.mock_tests.duration_minutes is
    'Suggested time, shown as a countdown. Advisory: the server never refuses a late submission.';

create table if not exists public.mock_test_questions (
    test_id uuid not null references public.mock_tests (id) on delete cascade,

    -- Restrict: a question inside somebody's completed test must not disappear from under it.
    question_id uuid not null references public.questions (id) on delete restrict,

    -- Denormalised so a per-topic breakdown does not need a join through questions. Filled by the
    -- trigger below rather than by the caller.
    topic_id uuid references public.topics (id) on delete set null,

    sort_order integer not null,

    -- ---- what the learner did ----
    -- The answer as given: {"selectedOptions":[0,2]} or {"value":42}. Null until submission, which is
    -- also how an unanswered question is recorded — skipping is a real thing a learner does in a test.
    given_answer jsonb,
    is_correct boolean,

    primary key (test_id, question_id),

    constraint mock_test_questions_sort_order_sane check (sort_order >= 0),

    -- Marked implies answered. A row claiming correctness with nothing given would make the score
    -- unexplainable.
    constraint mock_test_questions_marked_needs_answer
        check (is_correct is null or given_answer is not null)
);

comment on table public.mock_test_questions is
    'The questions in one test, and what was answered. A null given_answer is a skipped question, which is different from a wrong one.';

-- ---------------------------------------------------------------------------
-- Keep topic_id honest
-- ---------------------------------------------------------------------------
-- Taken from the question rather than from whatever the caller passed, for the same reason
-- question_attempts overwrites its own topic_id: a denormalised field the caller controls is a
-- denormalised field the caller can lie about, and here it would silently skew the per-topic
-- breakdown a learner is meant to act on.
create or replace function public.fill_mock_test_question_topic ()
    returns trigger
    language plpgsql
    security definer
    set search_path = public, pg_temp
    as $$
begin
    select q.topic_id into new.topic_id
    from public.questions q
    where q.id = new.question_id;

    return new;
end;
$$;

drop trigger if exists mock_test_questions_fill_topic on public.mock_test_questions;
create trigger mock_test_questions_fill_topic
    before insert on public.mock_test_questions
    for each row
    execute function public.fill_mock_test_question_topic ();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- "My tests, newest first" — the history list.
create index if not exists mock_tests_user_recent_idx
    on public.mock_tests (user_id, started_at desc);

-- "Do I already have a test open" — checked before generating another.
create index if not exists mock_tests_open_idx
    on public.mock_tests (user_id)
    where status = 'in_progress';

create index if not exists mock_test_questions_order_idx
    on public.mock_test_questions (test_id, sort_order);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.mock_tests enable row level security;
alter table public.mock_test_questions enable row level security;

drop policy if exists "Learners read their own mock tests" on public.mock_tests;
create policy "Learners read their own mock tests"
    on public.mock_tests
    for select
    to authenticated
    using (auth.uid() = user_id);

-- Reachable only through a test the learner owns.
drop policy if exists "Learners read their own mock test questions" on public.mock_test_questions;
create policy "Learners read their own mock test questions"
    on public.mock_test_questions
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.mock_tests t
            where t.id = mock_test_questions.test_id
              and t.user_id = auth.uid()
        )
    );

-- Read only, and this one matters more than most.
--
-- `is_correct` on these rows is the marking. A learner who could write it could mark their own test,
-- and every readiness figure built on top would be fiction — the same reasoning that keeps
-- concept_mastery read-only. Note also that learners hold no privilege on questions.correct_answer,
-- so marking has to happen server-side regardless.
grant select on public.mock_tests to authenticated;
grant select on public.mock_test_questions to authenticated;
