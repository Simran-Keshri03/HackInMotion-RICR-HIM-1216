-- 003_questions.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/003_questions.test.sql
--
-- The headline check is 4/7: a learner must not be able to read correct_answer.
-- Rolled back at the end.

begin;

insert into public.topics (id, parent_id, name)
values ('cccccccc-0000-4000-8000-000000000001', null, 'Question Test Subject');

insert into public.questions (id, topic_id, question_type, body, options, correct_answer, difficulty, is_verified)
values
    ('cccccccc-0000-4000-8000-0000000000a1', 'cccccccc-0000-4000-8000-000000000001',
     'mcq', 'Which one is verified?', array['yes', 'no'], '[0]'::jsonb, 'easy', true),
    ('cccccccc-0000-4000-8000-0000000000a2', 'cccccccc-0000-4000-8000-000000000001',
     'mcq', 'Which one is still unverified?', array['yes', 'no'], '[1]'::jsonb, 'hard', false);

-- 1. A choice question with fewer than two options is nonsense.
do $$
begin
    begin
        insert into public.questions (topic_id, question_type, body, options, correct_answer)
        values ('cccccccc-0000-4000-8000-000000000001', 'mcq', 'One option only?', array['only'], '[0]'::jsonb);

        raise exception 'FAIL: an mcq with a single option was accepted';
    exception
        when check_violation then
            raise notice 'PASS 1/7: mcq with fewer than two options rejected';
    end;
end $$;

-- 2. A numeric question must not carry options.
do $$
begin
    begin
        insert into public.questions (topic_id, question_type, body, options, correct_answer)
        values ('cccccccc-0000-4000-8000-000000000001', 'numeric', 'Value of pi?',
                array['3', '4'], '{"value": 3.14, "tol": 0.01}'::jsonb);

        raise exception 'FAIL: a numeric question was allowed to have options';
    exception
        when check_violation then
            raise notice 'PASS 2/7: numeric question with options rejected';
    end;
end $$;

-- 3. The same question text must not be storable twice under one topic.
do $$
begin
    begin
        insert into public.questions (topic_id, question_type, body, options, correct_answer)
        values ('cccccccc-0000-4000-8000-000000000001', 'mcq', 'Which one is verified?',
                array['yes', 'no'], '[0]'::jsonb);

        raise exception 'FAIL: a duplicate question body was accepted';
    exception
        when unique_violation then
            raise notice 'PASS 3/7: duplicate question under the same topic rejected';
    end;
end $$;

-- ---------------------------------------------------------------------------
-- Now behave like the browser: role authenticated, identity from the JWT.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001"}';

-- 4. THE IMPORTANT ONE. Reading the answer must be impossible, not merely discouraged.
do $$
declare
    leaked jsonb;
begin
    begin
        select correct_answer into leaked from public.questions
        where id = 'cccccccc-0000-4000-8000-0000000000a1';

        raise exception 'FAIL: learner read correct_answer (%). The mock test is worthless.', leaked;
    exception
        when insufficient_privilege then
            raise notice 'PASS 4/7: learner cannot read correct_answer';
    end;
end $$;

-- 5. The explanation is withheld too, so it cannot be used as a hint mid-question.
do $$
begin
    begin
        perform explanation from public.questions
        where id = 'cccccccc-0000-4000-8000-0000000000a1';

        raise exception 'FAIL: learner read the explanation column';
    exception
        when insufficient_privilege then
            raise notice 'PASS 5/7: learner cannot read explanation';
    end;
end $$;

-- 6. What they *are* allowed to read still works, and unverified questions stay hidden.
do $$
declare
    visible int;
    unverified int;
begin
    select count(*) into visible
    from public.questions
    where topic_id = 'cccccccc-0000-4000-8000-000000000001';

    select count(*) into unverified
    from public.questions
    where id = 'cccccccc-0000-4000-8000-0000000000a2';

    assert visible = 1, format('FAIL: expected 1 visible question, got %s', visible);
    assert unverified = 0, 'FAIL: an unverified question was visible to a learner';
    raise notice 'PASS 6/7: learner sees the verified question and not the unverified one';
end $$;

-- 7. Learners cannot add questions, so nobody can seed themselves easy ones.
do $$
begin
    begin
        insert into public.questions (topic_id, question_type, body, options, correct_answer, is_verified)
        values ('cccccccc-0000-4000-8000-000000000001', 'mcq', 'My own easy question',
                array['a', 'b'], '[0]'::jsonb, true);

        raise exception 'FAIL: a learner inserted a question';
    exception
        when insufficient_privilege then
            raise notice 'PASS 7/7: learner cannot insert questions';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
