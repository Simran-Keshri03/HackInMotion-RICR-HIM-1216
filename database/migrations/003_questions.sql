-- 003_questions.sql
--
-- The question bank. Every attempt, mastery score and mock test is built on these rows.
--
-- The important decision in this file is that the browser is never given the answer.
-- A quiz app that ships correct_answer to the client has no working mock test, because
-- the answer is one devtools tab away. We enforce that with column-level grants:
-- `authenticated` may read the question but has no privilege on correct_answer or
-- explanation at all. Grading and explanations go through the backend, which uses the
-- secret key.
--
-- Consequence to remember: `select *` from the browser will fail with a permission
-- error. That is intentional. Ask for the columns you are allowed to have.

create table if not exists public.questions (
    id uuid primary key default gen_random_uuid(),

    -- Restrict, not cascade: attempts and mastery point at questions, and that history
    -- is worth more than the convenience of deleting a topic in one click. Move the
    -- questions first.
    topic_id uuid not null references public.topics (id) on delete restrict,

    -- mcq     exactly one correct option
    -- msq     one or more correct options
    -- numeric a typed number, checked against a tolerance
    question_type text not null,

    body text not null,

    -- Ordered choice text for mcq/msq, NULL for numeric.
    options text[],

    -- Shape depends on question_type:
    --   mcq     [1]                       zero-based index of the correct option
    --   msq     [0, 2]                    every correct index
    --   numeric {"value": 3.5, "tol": 0.01}
    correct_answer jsonb not null,

    explanation text,

    -- The author's judgement. The real difficulty is measured later from how learners
    -- actually perform, which is a separate calculation.
    difficulty text not null default 'medium',

    marks integer not null default 1,

    -- AI-written questions start unverified and must pass validation before a learner
    -- can ever see them. The RLS policy below is what actually enforces that.
    is_ai_generated boolean not null default false,
    is_verified boolean not null default false,

    -- NULL means the question came from our seed data rather than a specific user.
    created_by uuid references public.profiles (id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint questions_type_known
        check (question_type in ('mcq', 'msq', 'numeric')),

    constraint questions_difficulty_known
        check (difficulty in ('easy', 'medium', 'hard')),

    constraint questions_body_not_blank
        check (char_length(trim(body)) > 0),

    constraint questions_marks_positive
        check (marks between 1 and 100),

    -- Choice questions need choices; numeric questions must not have any.
    constraint questions_options_match_type check (
        (question_type in ('mcq', 'msq') and array_length(options, 1) >= 2)
        or (question_type = 'numeric' and options is null)
    )
);

comment on table public.questions is
    'Question bank. correct_answer and explanation are deliberately not granted to the authenticated role.';

drop trigger if exists questions_set_updated_at on public.questions;
create trigger questions_set_updated_at
    before update on public.questions
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The adaptive engine's main query is "give me verified questions for this topic at
-- this difficulty", so that is the index we build.
create index if not exists questions_topic_difficulty_idx
    on public.questions (topic_id, difficulty)
    where is_verified;

-- Stops the same question being stored twice under one topic, which matters most when
-- AI generation is asked for questions on a topic more than once. md5 keeps the index
-- small no matter how long the question text is.
create unique index if not exists questions_topic_body_uniq
    on public.questions (topic_id, md5(body));

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.questions enable row level security;

-- Unverified questions do not exist as far as a learner is concerned.
drop policy if exists "Learners read verified questions" on public.questions;
create policy "Learners read verified questions"
    on public.questions
    for select
    to authenticated
    using (is_verified);

-- Column-level grant: everything a learner legitimately needs to answer a question,
-- and nothing that would let them skip answering it.
grant select (
    id,
    topic_id,
    question_type,
    body,
    options,
    difficulty,
    marks
) on public.questions to authenticated;
