-- 005_question_attempts.sql
--
-- Every answer a learner gives, kept forever. This is the raw material the whole
-- learner model is computed from: mastery, mistake patterns, retention risk, readiness,
-- and the difficulty a question really has. Nothing here is a summary; summaries are
-- derived and can always be rebuilt from these rows.
--
-- The table is append-only in practice. We never edit an attempt to "fix" a score,
-- because then the history stops matching what the learner actually did.
--
-- Two columns are filled by a trigger rather than by the caller:
--   topic_id        copied from the question, so an attempt can never be filed under
--                   the wrong topic and quietly poison a mastery score
--   attempt_number  counted from the rows that already exist, so a client cannot
--                   claim "this was my first try" on a question it has failed twice

create table if not exists public.question_attempts (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- Cascade on purpose: if a question turns out to be wrong and gets removed, the
    -- attempts at it should stop counting towards anybody's mastery.
    question_id uuid not null references public.questions (id) on delete cascade,

    -- Denormalised from questions.topic_id. Mastery is calculated per topic and runs
    -- often, so this saves a join on the hottest query in the app. The trigger below
    -- keeps it honest.
    topic_id uuid not null references public.topics (id) on delete restrict,

    -- Graded by the backend, never by the browser -- the browser cannot even read the
    -- correct answer.
    is_correct boolean not null,

    -- What the learner actually chose. Needed to tell a careless slip from a real
    -- misconception, which is what the mistake engine looks at.
    given_answer jsonb,

    time_taken_seconds integer,

    -- Which part of the app produced this attempt. The engines weigh these differently:
    -- a mock test answer says more about exam readiness than an untimed practice one.
    source text not null default 'practice',

    -- 1 for the first go at this question, 2 for the next, and so on.
    attempt_number integer not null,

    attempted_at timestamptz not null default now(),

    constraint question_attempts_source_known
        check (source in ('practice', 'assessment', 'topic_test', 'mock_test', 'revision')),

    -- A minute over an hour on one question means the tab was left open, not that the
    -- learner was thinking. Capping keeps averages usable.
    constraint question_attempts_time_sane
        check (time_taken_seconds is null or time_taken_seconds between 0 and 3600),

    constraint question_attempts_number_positive
        check (attempt_number > 0),

    -- Belt and braces against a double-submitted request creating two "attempt 3"s.
    constraint question_attempts_unique_try
        unique (user_id, question_id, attempt_number)
);

comment on table public.question_attempts is
    'Append-only log of every answer. Source of truth for mastery, mistakes, retention and readiness.';

-- ---------------------------------------------------------------------------
-- Derived columns
-- ---------------------------------------------------------------------------
create or replace function public.fill_question_attempt_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_topic_id uuid;
begin
    -- The topic comes from the question. Whatever the caller sent is ignored.
    select q.topic_id into v_topic_id
    from public.questions q
    where q.id = new.question_id;

    if v_topic_id is null then
        raise exception 'cannot record an attempt for question %: it does not exist', new.question_id
            using errcode = 'foreign_key_violation';
    end if;

    new.topic_id := v_topic_id;

    -- Count the tries that already exist instead of trusting the number sent to us.
    select coalesce(max(a.attempt_number), 0) + 1
    into new.attempt_number
    from public.question_attempts a
    where a.user_id = new.user_id
      and a.question_id = new.question_id;

    return new;
end;
$$;

drop trigger if exists question_attempts_fill_fields on public.question_attempts;
create trigger question_attempts_fill_fields
    before insert on public.question_attempts
    for each row
    execute function public.fill_question_attempt_fields();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- "This learner's recent attempts on this topic" -- the mastery and retention engines'
-- main read. Newest first, because recency is weighted most.
create index if not exists question_attempts_user_topic_recent_idx
    on public.question_attempts (user_id, topic_id, attempted_at desc);

-- "Has this learner seen this question before, and how did it go" -- used when picking
-- the next question so practice does not repeat itself.
create index if not exists question_attempts_user_question_idx
    on public.question_attempts (user_id, question_id);

-- "How hard is this question really" -- across all learners, first tries only.
create index if not exists question_attempts_question_first_try_idx
    on public.question_attempts (question_id)
    where attempt_number = 1;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Learners read their own history for their progress screens. Writing goes through the
-- backend, and it has to: grading needs the correct answer, which the browser is not
-- allowed to see, and the same request updates mastery.
alter table public.question_attempts enable row level security;

drop policy if exists "Learners read their own attempts" on public.question_attempts;
create policy "Learners read their own attempts"
    on public.question_attempts
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.question_attempts to authenticated;
