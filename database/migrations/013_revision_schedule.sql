-- 013_revision_schedule.sql
--
-- When each topic needs seeing again. One row per learner per topic.
--
-- This is spaced repetition, and the interval arithmetic is the SuperMemo/SM-2 family that Anki and
-- Mnemosyne use: get it right and the gap until the next review grows; get it wrong and it collapses
-- back to a day. The formula lives in backend/src/services/learner/srsEngine.ts, not in SQL, for the
-- same reason the mastery formula does — it is meant to be tuned and unit tested.
--
-- Two things make this different from a flashcard scheduler, and both are why an off-the-shelf one
-- would have been wrong here:
--
--   The unit is a TOPIC, not a card. A card is recalled or it is not; a topic is a set of questions
--   with an accuracy, so the review "grade" is how well the review session went rather than a button
--   the learner presses about their own memory.
--
--   THE EXAM CAPS THE INTERVAL. Anki assumes you want to remember something forever. Here there is a
--   date after which none of this matters, so a 60-day interval for an exam 30 days away is not a
--   scheduling decision, it is throwing the topic away. The cap is applied when the schedule is
--   written, by code that knows the goal.
--
-- Relationship to concept_mastery: that table says how well a topic is known and decays its score
-- after 30 idle days. This table says when to do something about it. They are deliberately separate —
-- mastery is a rebuildable cache over attempts, while a review schedule is a decision that has to
-- survive a recompute.

create table if not exists public.revision_schedule (
    user_id uuid not null references public.profiles (id) on delete cascade,

    -- Restrict, like concept_mastery: a topic somebody has a review scheduled on should not vanish.
    topic_id uuid not null references public.topics (id) on delete restrict,

    -- ---- the decision ----
    -- The date this topic should next be revised. Today or earlier means due.
    due_on date not null,

    -- Days between the last review and due_on. Kept so the next interval can be derived from it
    -- rather than recomputed from the whole review history.
    interval_days integer not null default 1,

    -- ---- how this learner handles this topic ----
    -- SM-2's ease factor: the multiplier applied to the interval on a good review. Rises slightly
    -- when reviews go well, falls when they do not, so a topic somebody finds hard comes back more
    -- often than one they find easy even at the same mastery score.
    ease_factor numeric(4, 2) not null default 2.50,

    review_count integer not null default 0,

    -- Times this topic has collapsed back to a one-day interval. High lapses on a topic is the
    -- signal that it needs teaching differently rather than repeating.
    lapses integer not null default 0,

    -- The last date this topic was seen at all, whether learned or reviewed. It is what the
    -- once-per-day guard compares against, so it is set on a first sighting too.
    last_reviewed_on date,

    -- Accuracy of the most recent review, 0-100. Stored so the plan can explain itself: "you scored
    -- 40% on this last time" is a reason a learner can act on.
    last_review_accuracy numeric(5, 2),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (user_id, topic_id),

    -- One day is the shortest useful gap; nothing is gained by reviewing a topic twice in a day, and
    -- 365 is past any exam this app plans for.
    constraint revision_schedule_interval_sane
        check (interval_days between 1 and 365),

    -- SM-2 floors ease at 1.3: below that the interval barely grows and the topic is effectively
    -- stuck at daily, which is a sign the schedule is the wrong tool rather than a number to keep
    -- lowering. 3.0 is a generous ceiling.
    constraint revision_schedule_ease_sane
        check (ease_factor between 1.30 and 3.00),

    constraint revision_schedule_counts_non_negative
        check (review_count >= 0 and lapses >= 0),

    -- Every lapse is a review, so there cannot be more lapses than reviews.
    constraint revision_schedule_lapses_within_reviews
        check (lapses <= review_count),

    constraint revision_schedule_accuracy_range
        check (last_review_accuracy is null
               or last_review_accuracy between 0 and 100),

    -- A review count above zero means a review happened, so it has a date.
    --
    -- Only that direction. The reverse — a date implying a review — was asserted here at first and
    -- was wrong: the first time a topic is studied it is *learned*, not reviewed, so the schedule
    -- records the date it was seen while the review count stays at zero. The stricter version
    -- rejected every one of those writes, and because the caller treats a failed schedule update as
    -- survivable the rejection was swallowed and the first-sighting path silently never worked.
    -- Found by answering questions and reading the row back, not by reading the code.
    constraint revision_schedule_reviewed_has_date
        check (review_count = 0 or last_reviewed_on is not null)
);

comment on table public.revision_schedule is
    'Spaced repetition: when each topic is next due. SM-2 style intervals, computed in srsEngine.ts, capped by the exam date.';

comment on column public.revision_schedule.ease_factor is
    'SM-2 ease. Multiplies the interval on a good review; falls on a bad one, so a topic this learner finds hard returns sooner.';

comment on column public.revision_schedule.lapses is
    'Times this topic fell back to a one-day interval. Repeated lapses mean it needs teaching differently, not repeating.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- "What does this learner owe today" — the query behind every plan build and every revision list.
create index if not exists revision_schedule_due_idx
    on public.revision_schedule (user_id, due_on);

-- "Which topics keep collapsing" — for the insight that a topic needs a different approach.
create index if not exists revision_schedule_lapses_idx
    on public.revision_schedule (user_id, lapses desc)
    where lapses > 0;

drop trigger if exists revision_schedule_set_updated_at on public.revision_schedule;
create trigger revision_schedule_set_updated_at
    before update on public.revision_schedule
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Read-only to learners, like mastery and plans. A learner who could push their own due dates out
-- would be able to remove every topic they found difficult from their revision list, which is
-- precisely the topic spaced repetition exists to bring back.
alter table public.revision_schedule enable row level security;

drop policy if exists "Learners read their own revision schedule" on public.revision_schedule;
create policy "Learners read their own revision schedule"
    on public.revision_schedule
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.revision_schedule to authenticated;
