-- 004_learning_goals.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/004_learning_goals.test.sql
--
-- Rolled back at the end.

begin;

-- Topics now belong to a curriculum, so the test needs one of its own. Rolled back with
-- everything else, so it leaves nothing behind and cannot collide with the seeded syllabi.
insert into public.curricula (id, slug, name)
values ('dddddddd-0000-4000-8000-0000000000c1', 'test-goals-004', 'Goals Test Curriculum');

-- Two learners, so the isolation checks have something to fail against.
insert into auth.users (id, email)
values
    ('dddddddd-0000-4000-8000-000000000001', 'goal-one@adigam.test'),
    ('dddddddd-0000-4000-8000-000000000002', 'goal-two@adigam.test');

insert into public.topics (curriculum_id, id, parent_id, name)
values
    ('dddddddd-0000-4000-8000-0000000000c1', 'dddddddd-0000-4000-8000-0000000000f1', null, 'Goal Test Subject'),
    ('dddddddd-0000-4000-8000-0000000000c1', 'dddddddd-0000-4000-8000-0000000000f2', 'dddddddd-0000-4000-8000-0000000000f1', 'Goal Test Topic');

insert into public.learning_goals (id, user_id, title, exam_date, daily_minutes)
values
    ('dddddddd-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-000000000001',
     'Learner One Goal', current_date + 60, 90),
    ('dddddddd-0000-4000-8000-0000000000a2', 'dddddddd-0000-4000-8000-000000000002',
     'Learner Two Goal', current_date + 30, 45);

insert into public.learning_goal_topics (goal_id, topic_id)
values ('dddddddd-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-0000000000f1');

-- 1. A second active goal for the same learner must be refused, or "the current plan"
--    becomes ambiguous.
do $$
begin
    begin
        insert into public.learning_goals (user_id, title, exam_date, daily_minutes)
        values ('dddddddd-0000-4000-8000-000000000001', 'Second Active Goal', current_date + 10, 60);

        raise exception 'FAIL: a learner ended up with two active goals';
    exception
        when unique_violation then
            raise notice 'PASS 1/7: only one active goal per learner';
    end;
end $$;

-- 2. Archiving the first one frees the slot.
do $$
declare
    n int;
begin
    update public.learning_goals
    set status = 'archived'
    where id = 'dddddddd-0000-4000-8000-0000000000a1';

    insert into public.learning_goals (user_id, title, exam_date, daily_minutes)
    values ('dddddddd-0000-4000-8000-000000000001', 'Replacement Goal', current_date + 20, 60);

    select count(*) into n
    from public.learning_goals
    where user_id = 'dddddddd-0000-4000-8000-000000000001';

    assert n = 2, format('FAIL: expected 2 goals after archiving, got %s', n);
    raise notice 'PASS 2/7: archiving frees the active slot, history is kept';
end $$;

-- 3. An unrealistic daily budget is rejected before it can wreck a plan.
do $$
begin
    begin
        insert into public.learning_goals (user_id, title, exam_date, daily_minutes)
        values ('dddddddd-0000-4000-8000-000000000002', 'Sleepless Goal', current_date + 5, 2000);

        raise exception 'FAIL: 2000 minutes a day was accepted';
    exception
        when check_violation then
            raise notice 'PASS 3/7: absurd daily_minutes rejected';
    end;
end $$;

-- 4. A goal cannot reference a topic that does not exist.
do $$
begin
    begin
        insert into public.learning_goal_topics (goal_id, topic_id)
        values ('dddddddd-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-00000000ffff');

        raise exception 'FAIL: goal scope accepted a topic that does not exist';
    exception
        when foreign_key_violation then
            raise notice 'PASS 4/7: goal scope must point at a real topic';
    end;
end $$;

-- ---------------------------------------------------------------------------
-- As learner one, from the browser.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-0000-4000-8000-000000000001"}';

-- 5. Learner one sees only their own goals.
do $$
declare
    total int;
    others int;
begin
    select count(*) into total from public.learning_goals;
    select count(*) into others from public.learning_goals
    where user_id = 'dddddddd-0000-4000-8000-000000000002';

    assert others = 0, 'FAIL: RLS leak, learner one can see another learner''s goal';
    assert total = 2, format('FAIL: learner one should see their 2 goals, saw %s', total);
    raise notice 'PASS 5/7: learner sees only their own goals';
end $$;

-- 6. Goal scope is readable only through a goal they own.
do $$
declare
    n int;
begin
    select count(*) into n from public.learning_goal_topics;
    assert n = 1, format('FAIL: expected 1 visible scope row, got %s', n);
    raise notice 'PASS 6/7: goal scope visible only for own goals';
end $$;

-- 7. Goals are created by the backend, not by the browser.
do $$
begin
    begin
        insert into public.learning_goals (user_id, title, exam_date, daily_minutes)
        values ('dddddddd-0000-4000-8000-000000000001', 'Self-served goal', current_date + 7, 30);

        raise exception 'FAIL: a learner created a goal directly';
    exception
        when insufficient_privilege then
            raise notice 'PASS 7/7: learner cannot write goals, only the backend can';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
