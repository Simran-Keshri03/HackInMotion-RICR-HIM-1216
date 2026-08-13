-- 002_topics.sql
--
-- The syllabus tree. Everything Adigam measures hangs off a topic: questions belong to
-- one, mastery is tracked per topic, the planner schedules topics, and readiness rolls
-- topic scores up into a subject score.
--
-- One table holds the whole tree instead of separate subjects and topics tables:
--   parent_id IS NULL      -> a subject      ("Data Structures")
--   parent_id IS NOT NULL  -> a topic        ("Binary Trees")
-- Sub-topics work the same way without needing another migration.
--
-- This is shared reference data, not user data. Learners read it; only the server
-- (service key) writes it.

create table if not exists public.topics (
    id uuid primary key default gen_random_uuid(),

    -- A subject has no parent. Deleting a subject removes its topics with it.
    parent_id uuid references public.topics (id) on delete cascade,

    name text not null,

    -- How much this topic matters for the learner's exam. The planner and the
    -- readiness score multiply by this, so a heavier topic gets scheduled earlier and
    -- counts for more. 1.00 means average importance.
    weight numeric(4, 2) not null default 1.00,

    -- Syllabus order, so "learn the next new concept" follows a sensible sequence
    -- instead of alphabetical accident.
    sort_order integer not null default 0,

    created_at timestamptz not null default now(),

    -- "nulls not distinct" matters here: without it Postgres treats every NULL parent
    -- as unique, and two subjects could share a name.
    constraint topics_unique_name_per_parent
        unique nulls not distinct (parent_id, name),

    constraint topics_name_not_blank check (char_length(trim(name)) between 1 and 120),
    constraint topics_weight_range check (weight > 0 and weight <= 5),

    -- ponytail: blocks a topic parenting itself, which is the only cycle our own seed
    -- data could realistically create. A full cycle check needs a recursive trigger;
    -- add one if topics ever become user-editable.
    constraint topics_no_self_parent check (parent_id is null or parent_id <> id)
);

comment on table public.topics is
    'Syllabus tree. parent_id IS NULL means the row is a subject; otherwise it is a topic under that subject.';

-- Listing the topics of a subject is the most common read in the app.
create index if not exists topics_parent_id_idx on public.topics (parent_id);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Reference data every signed-in learner may read, and nobody may change from the
-- browser. There is no INSERT, UPDATE or DELETE policy at all, so those operations are
-- impossible for learners even if a grant were added by mistake later.
alter table public.topics enable row level security;

drop policy if exists "Signed-in learners read the syllabus" on public.topics;
create policy "Signed-in learners read the syllabus"
    on public.topics
    for select
    to authenticated
    using (true);

grant select on public.topics to authenticated;
