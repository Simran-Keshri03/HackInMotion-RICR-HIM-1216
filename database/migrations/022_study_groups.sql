-- 022_study_groups.sql
--
-- Study groups: learners preparing for the same thing, able to see how each other are doing.
--
-- This is the only feature in the project where one learner reads anything derived from another's
-- account, and every other table is locked to its owner by row-level security. So it gets its own
-- tables and its own policies rather than loosening any existing ones — no policy on
-- concept_mastery, learner_profiles or question_attempts is touched by this migration. What a group
-- member is allowed to see about a peer is decided in one place, groupService, and is a short
-- deliberate list rather than "their row".
--
-- What is shared: display name, questions answered, current streak, topics mastered.
-- What is NOT: accuracy, weakest topics, wrong answers, mastery per topic, tutor conversations,
-- goals, plans. Sharing a leaderboard is motivating; publishing somebody's weak spots to their
-- classmates is a reason to stop using the app. LeetCode makes the same cut — it shows how many
-- problems somebody solved, never how many they got wrong.
--
-- Groups are joined by invite code, never discovered. There is no way to list or search groups, so
-- a learner cannot be added to, or found in, a group they were not given a code for.

create table if not exists public.study_groups (
    id uuid primary key default gen_random_uuid (),

    name text not null,

    -- The code a learner types to join. Generated server-side from an alphabet with no O/0 or I/1,
    -- because this gets read aloud and copied off a screen.
    invite_code text not null unique,

    -- What the group is preparing for, copied from the creator's goal. Comparing progress only means
    -- something between people studying the same syllabus, and it lets the group screen say so.
    curriculum_id uuid references public.curricula (id) on delete set null,

    -- Set null rather than cascade: a group outliving the account that made it is better than
    -- deleting everybody else's group along with one member.
    created_by uuid references public.profiles (id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint study_groups_name_length
        check (char_length(trim(name)) between 2 and 60),

    -- Matches the generator: 6 characters, upper case, unambiguous alphabet.
    constraint study_groups_invite_code_shape
        check (invite_code ~ '^[A-HJ-NP-Z2-9]{6}$')
);

comment on table public.study_groups is
    'A group of learners preparing for the same syllabus. Joined by invite code only; groups cannot be listed or searched.';

comment on column public.study_groups.invite_code is
    'Six characters from an alphabet with no O/0 or I/1, because it is read aloud and typed by hand.';

create table if not exists public.group_members (
    group_id uuid not null references public.study_groups (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,

    -- 'owner' created it. The only thing the role currently decides is who may rename or delete the
    -- group; members are otherwise equal, because a study group is not a hierarchy.
    role text not null default 'member',

    joined_at timestamptz not null default now(),

    primary key (group_id, user_id),

    constraint group_members_role_known check (role in ('owner', 'member'))
);

comment on table public.group_members is
    'Who is in which group. The membership check behind every group read.';

-- "Which groups am I in" — the query behind the group list.
create index if not exists group_members_user_idx
    on public.group_members (user_id);

drop trigger if exists study_groups_set_updated_at on public.study_groups;
create trigger study_groups_set_updated_at
    before update on public.study_groups
    for each row
    execute function extensions.moddatetime (updated_at);

-- ---------------------------------------------------------------------------
-- Group size
-- ---------------------------------------------------------------------------
-- Capped in the database rather than in the service. A group is a handful of classmates; without a
-- limit a shared invite code posted publicly turns one group into a mailing list, and every group
-- read scales with its membership.
create or replace function public.enforce_group_size ()
    returns trigger
    language plpgsql
    security definer
    set search_path = public, pg_temp
    as $$
declare
    member_count integer;
begin
    select count(*) into member_count
    from public.group_members
    where group_id = new.group_id;

    if member_count >= 30 then
        raise exception 'this group is full';
    end if;

    return new;
end;
$$;

drop trigger if exists group_members_enforce_size on public.group_members;
create trigger group_members_enforce_size
    before insert on public.group_members
    for each row
    execute function public.enforce_group_size ();

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- The membership test, as a function that bypasses RLS.
--
-- This exists because the obvious policy does not work. "A learner may read group_members rows for
-- groups they belong to" has to consult group_members to decide whether it may read group_members,
-- and Postgres refuses that with `infinite recursion detected in policy`. A security definer
-- function is the standard way out: it runs with the definer's rights, so the lookup inside it is
-- not itself subject to the policy.
--
-- It is narrow on purpose — it answers exactly one boolean and takes both ids, so it cannot be used
-- to enumerate anything.
create or replace function public.is_group_member (check_group_id uuid, check_user_id uuid)
    returns boolean
    language sql
    security definer
    stable
    set search_path = public, pg_temp
    as $$
    select exists (
        select 1
        from public.group_members
        where group_id = check_group_id
          and user_id = check_user_id
    );
$$;

comment on function public.is_group_member is
    'Membership test used by group policies. Security definer to avoid infinite recursion in RLS on group_members.';

alter table public.study_groups enable row level security;
alter table public.group_members enable row level security;

-- A learner sees a group only once they are in it. Notably there is no policy allowing a group to be
-- found by its invite code: joining goes through the service with the elevated client, so a code
-- cannot be brute-forced by querying the table directly from a browser.
drop policy if exists "Members read their own groups" on public.study_groups;
create policy "Members read their own groups"
    on public.study_groups
    for select
    to authenticated
    using (public.is_group_member (id, auth.uid()));

drop policy if exists "Members read the membership of their groups" on public.group_members;
create policy "Members read the membership of their groups"
    on public.group_members
    for select
    to authenticated
    using (public.is_group_member (group_id, auth.uid()));

-- Read only, like every other table a learner does not own outright. Creating, joining and leaving
-- all go through the service: a learner who could insert into group_members directly could add
-- themselves to any group whose id they learned, which would make the invite code decorative.
grant select on public.study_groups to authenticated;
grant select on public.group_members to authenticated;
