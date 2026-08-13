-- 005_question_attempts.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/005_question_attempts.test.sql
--
-- Checks 3 and 4 are the anti-tamper ones: a caller cannot file an attempt under the
-- wrong topic, and cannot lie about which try this is.
--
-- Rolled back at the end.

begin;

insert into auth.users (id, email)
values
    ('eeeeeeee-0000-4000-8000-000000000001', 'attempt-one@adigam.test'),
    ('eeeeeeee-0000-4000-8000-000000000002', 'attempt-two@adigam.test');

insert into public.topics (id, parent_id, name)
values
    ('eeeeeeee-0000-4000-8000-0000000000f1', null, 'Attempt Test Subject'),
    ('eeeeeeee-0000-4000-8000-0000000000f2', null, 'Wrong Subject');

insert into public.questions (id, topic_id, question_type, body, options, correct_answer, is_verified)
values ('eeeeeeee-0000-4000-8000-0000000000a1', 'eeeeeeee-0000-4000-8000-0000000000f1',
        'mcq', 'Attempt test question', array['a', 'b'], '[0]'::jsonb, true);

-- 1. topic_id is filled in from the question without the caller providing it.
do $$
declare
    v_topic uuid;
begin
    insert into public.question_attempts (user_id, question_id, is_correct, time_taken_seconds)
    values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', true, 30);

    select topic_id into v_topic from public.question_attempts
    where user_id = 'eeeeeeee-0000-4000-8000-000000000001';

    assert v_topic = 'eeeeeeee-0000-4000-8000-0000000000f1',
        format('FAIL: topic_id should have come from the question, got %s', v_topic);
    raise notice 'PASS 1/8: topic_id filled from the question';
end $$;

-- 2. attempt_number counts up on its own.
do $$
declare
    numbers int[];
begin
    insert into public.question_attempts (user_id, question_id, is_correct)
    values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', false);

    insert into public.question_attempts (user_id, question_id, is_correct)
    values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', true);

    select array_agg(attempt_number order by attempt_number) into numbers
    from public.question_attempts
    where user_id = 'eeeeeeee-0000-4000-8000-000000000001';

    assert numbers = array[1, 2, 3], format('FAIL: expected attempts 1,2,3 got %s', numbers);
    raise notice 'PASS 2/8: attempt_number increments by itself';
end $$;

-- 3. ANTI-TAMPER. A caller claiming a different topic is overruled, so mastery for an
--    easy topic cannot be inflated using questions from a hard one.
do $$
declare
    v_topic uuid;
begin
    insert into public.question_attempts (user_id, question_id, topic_id, is_correct)
    values ('eeeeeeee-0000-4000-8000-000000000002', 'eeeeeeee-0000-4000-8000-0000000000a1',
            'eeeeeeee-0000-4000-8000-0000000000f2', true);

    select topic_id into v_topic from public.question_attempts
    where user_id = 'eeeeeeee-0000-4000-8000-000000000002';

    assert v_topic = 'eeeeeeee-0000-4000-8000-0000000000f1',
        'FAIL: a caller-supplied topic_id was trusted';
    raise notice 'PASS 3/8: caller-supplied topic_id is overwritten';
end $$;

-- 4. ANTI-TAMPER. Claiming "this was my first attempt" after several tries fails.
do $$
declare
    v_number int;
begin
    insert into public.question_attempts (user_id, question_id, is_correct, attempt_number)
    values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', true, 1);

    select max(attempt_number) into v_number from public.question_attempts
    where user_id = 'eeeeeeee-0000-4000-8000-000000000001';

    assert v_number = 4, format('FAIL: expected the 4th attempt, got %s', v_number);
    raise notice 'PASS 4/8: caller-supplied attempt_number is overwritten';
end $$;

-- 5. An attempt at a question that does not exist is refused.
do $$
begin
    begin
        insert into public.question_attempts (user_id, question_id, is_correct)
        values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000ff', true);

        raise exception 'FAIL: an attempt was recorded for a question that does not exist';
    exception
        when foreign_key_violation then
            raise notice 'PASS 5/8: attempt at a non-existent question rejected';
    end;
end $$;

-- 6. An unknown source would silently break the engines that weigh by source.
do $$
begin
    begin
        insert into public.question_attempts (user_id, question_id, is_correct, source)
        values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1',
                true, 'telepathy');

        raise exception 'FAIL: an unknown source was accepted';
    exception
        when check_violation then
            raise notice 'PASS 6/8: unknown attempt source rejected';
    end;
end $$;

-- ---------------------------------------------------------------------------
-- As learner one, from the browser.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"eeeeeeee-0000-4000-8000-000000000001"}';

-- 7. Own history is readable, somebody else's is not.
do $$
declare
    total int;
    others int;
begin
    select count(*) into total from public.question_attempts;
    select count(*) into others from public.question_attempts
    where user_id = 'eeeeeeee-0000-4000-8000-000000000002';

    assert others = 0, 'FAIL: RLS leak, learner one can see another learner''s attempts';
    assert total = 4, format('FAIL: learner one should see 4 attempts, saw %s', total);
    raise notice 'PASS 7/8: learner sees only their own attempt history';
end $$;

-- 8. Attempts are recorded by the backend. If the browser could write them, a learner
--    could mark every answer correct.
do $$
begin
    begin
        insert into public.question_attempts (user_id, question_id, is_correct)
        values ('eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000a1', true);

        raise exception 'FAIL: a learner recorded their own attempt';
    exception
        when insufficient_privilege then
            raise notice 'PASS 8/8: learner cannot write attempts, only the backend can';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
