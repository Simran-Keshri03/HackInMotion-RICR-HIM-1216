-- 015_ai_conversations.sql
--
-- Chat history for the AI tutor: conversations, and the messages inside them.
--
-- Two tables rather than one, because a learner asking about Trigonometry today and Normalisation
-- tomorrow is having two conversations, and a flat message log would make "show me what I asked
-- about Trees" a scan instead of a lookup.
--
-- What is NOT stored here: the context the model was given. The tutor is sent the learner's
-- mastery on the current topic and their recent mistakes, assembled fresh on every request from
-- tables that already hold it. Copying that into the message log would duplicate data that can
-- drift, and would mean a learner's mastery history sat in two places with different retention.
--
-- Writes go through the backend, because that is where the AI call happens. Learners read their
-- own history and nothing else.

create table if not exists public.ai_conversations (
    id uuid primary key default gen_random_uuid(),

    user_id uuid not null references public.profiles (id) on delete cascade,

    -- What the conversation is about. Null for a general question with no topic in view.
    -- Restrict, not cascade: a conversation is worth keeping even if a topic is retired.
    topic_id uuid references public.topics (id) on delete restrict,

    -- Taken from the learner's first message, so the history list is readable without opening
    -- each thread.
    title text not null,

    created_at timestamptz not null default now(),

    -- Ordering the list by recency needs this; created_at would sort a long-running conversation
    -- below a brief newer one.
    last_message_at timestamptz not null default now(),

    constraint ai_conversations_title_not_blank
        check (char_length(trim(title)) between 1 and 200)
);

comment on table public.ai_conversations is
    'One tutor conversation. The context sent to the model is assembled per request, not stored.';

create index if not exists ai_conversations_user_recent_idx
    on public.ai_conversations (user_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create table if not exists public.ai_messages (
    id uuid primary key default gen_random_uuid(),

    conversation_id uuid not null
        references public.ai_conversations (id) on delete cascade,

    -- learner or tutor. Named for what they are rather than borrowing the provider's vocabulary,
    -- so swapping providers does not make the stored data read strangely.
    role text not null,

    content text not null,

    -- Null on learner messages. Recorded on tutor replies so the cost of the feature is
    -- measurable rather than guessed at.
    input_tokens integer,
    output_tokens integer,

    -- Which model answered. A tutor reply written by a different model later is worth being able
    -- to tell apart.
    model text,

    created_at timestamptz not null default now(),

    constraint ai_messages_role_known check (role in ('learner', 'tutor')),

    constraint ai_messages_content_not_blank
        check (char_length(trim(content)) between 1 and 20000),

    -- A learner message has no token cost; a tutor message should have one.
    constraint ai_messages_tokens_match_role check (
        (role = 'learner' and input_tokens is null and output_tokens is null)
        or role = 'tutor'
    )
);

comment on table public.ai_messages is
    'Messages within a tutor conversation, in created_at order.';

create index if not exists ai_messages_conversation_idx
    on public.ai_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Keep last_message_at honest
-- ---------------------------------------------------------------------------
-- A trigger rather than application code: the ordering of the history list should not depend on
-- every writer remembering to touch the parent row.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.ai_conversations
    set last_message_at = new.created_at
    where id = new.conversation_id;

    return new;
end;
$$;

drop trigger if exists ai_messages_touch_conversation on public.ai_messages;
create trigger ai_messages_touch_conversation
    after insert on public.ai_messages
    for each row
    execute function public.touch_conversation();

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- A learner's questions are among the most private things in this system: what somebody does not
-- understand is more revealing than their score. Read your own, write nothing.
alter table public.ai_conversations enable row level security;

drop policy if exists "Learners read their own conversations" on public.ai_conversations;
create policy "Learners read their own conversations"
    on public.ai_conversations
    for select
    to authenticated
    using (auth.uid() = user_id);

grant select on public.ai_conversations to authenticated;

alter table public.ai_messages enable row level security;

-- Messages are reachable only through a conversation the learner owns.
drop policy if exists "Learners read messages in their own conversations" on public.ai_messages;
create policy "Learners read messages in their own conversations"
    on public.ai_messages
    for select
    to authenticated
    using (
        exists (
            select 1
            from public.ai_conversations c
            where c.id = ai_messages.conversation_id
              and c.user_id = auth.uid()
        )
    );

grant select on public.ai_messages to authenticated;
