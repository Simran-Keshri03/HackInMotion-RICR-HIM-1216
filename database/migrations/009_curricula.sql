-- 009_curricula.sql
--
-- A curriculum is one thing a learner can prepare for: "Class 10 CBSE", "GATE CS",
-- "NEET Biology". It owns subjects, which own topics, so the syllabus tree gains the level it
-- was missing.
--
-- Why this exists: the seeded syllabus was three fixed subjects. A learner sitting a class 10
-- board exam had nothing to choose. Curricula are resolved from what the learner types and, when
-- one does not exist yet, written by the AI layer and stored — so the app is not limited to a
-- syllabus somebody hand-typed in advance.
--
-- Curricula are SHARED, keyed on a normalised slug. Two learners who both type "class 10" get
-- the same syllabus rather than two near-identical AI-generated copies. That keeps cost down and
-- makes the question bank accumulate usefully, at the price of one learner's generated syllabus
-- being visible to the next. `is_ai_generated` marks those rows so they can be reviewed.

create table if not exists public.curricula (
    id uuid primary key default gen_random_uuid(),

    -- The lookup key. Normalised so "class 10", "Class 10" and "CLASS 10 " all resolve to one
    -- row instead of paying for the same syllabus three times.
    slug text not null unique,

    -- What the learner sees: the AI's tidied-up label, e.g. "Class 10 (CBSE)".
    name text not null,

    description text,

    -- False for the seeded syllabus, true for anything the model wrote.
    is_ai_generated boolean not null default false,

    created_at timestamptz not null default now(),

    -- Slugs come from user text, so their shape is enforced rather than trusted.
    constraint curricula_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),

    constraint curricula_name_length
        check (char_length(trim(name)) between 2 and 120)
);

comment on table public.curricula is
    'One thing a learner can prepare for. Shared across learners, keyed on a normalised slug.';

-- ---------------------------------------------------------------------------
-- Topics belong to a curriculum
-- ---------------------------------------------------------------------------
alter table public.topics
    add column if not exists curriculum_id uuid references public.curricula (id) on delete cascade;

-- The existing seeded subjects are a computer-science preparation syllabus; give them a home so
-- curriculum_id can be NOT NULL and no reader has to handle a special case.
insert into public.curricula (slug, name, description, is_ai_generated)
values (
    'computer-science-fundamentals',
    'Computer Science Fundamentals',
    'Core data structures, databases and quantitative aptitude — the default syllabus.',
    false
)
on conflict (slug) do nothing;

update public.topics
set curriculum_id = (
    select id from public.curricula where slug = 'computer-science-fundamentals'
)
where curriculum_id is null;

alter table public.topics
    alter column curriculum_id set not null;

create index if not exists topics_curriculum_idx
    on public.topics (curriculum_id, parent_id);

-- A subject name is unique within its curriculum, not globally: two curricula may both contain
-- "Mathematics" and they are different subjects. The old constraint compared (parent_id, name)
-- with NULL parents treated as equal, which would have blocked exactly that.
alter table public.topics
    drop constraint if exists topics_unique_name_per_parent;

alter table public.topics
    add constraint topics_unique_name_per_parent
    unique nulls not distinct (curriculum_id, parent_id, name);

-- ---------------------------------------------------------------------------
-- A goal names the curriculum it is for
-- ---------------------------------------------------------------------------
-- Nullable: goals created before this migration have no curriculum, and their scope still works
-- because it is stored as explicit topic ids.
alter table public.learning_goals
    add column if not exists curriculum_id uuid references public.curricula (id) on delete set null;

create index if not exists learning_goals_curriculum_idx
    on public.learning_goals (curriculum_id);

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- Reference data: every signed-in learner may read the catalogue, and nobody may change it from
-- the browser. Creating a curriculum goes through the API, where the goal text is validated and
-- the AI output is checked before anything is stored.
alter table public.curricula enable row level security;

drop policy if exists "Signed-in learners read curricula" on public.curricula;
create policy "Signed-in learners read curricula"
    on public.curricula
    for select
    to authenticated
    using (true);

grant select on public.curricula to authenticated;
