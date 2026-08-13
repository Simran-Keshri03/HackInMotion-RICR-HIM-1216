-- 007_learner_profiles.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/007_learner_profiles.test.sql
--
-- Check 1 follows the whole chain: one signup should produce a profile AND a learner
-- profile, through two separate triggers.
--
-- Rolled back at the end.

begin;

insert into auth.users (id, email)
values
    ('22222222-0000-4000-8000-000000000001', 'learnermodel-one@adigam.test'),
    ('22222222-0000-4000-8000-000000000002', 'learnermodel-two@adigam.test');

-- 1. Signup -> profile -> learner profile, with zeros to start with.
do $$
declare
    v_total int;
    v_accuracy numeric;
begin
    select total_attempts, overall_accuracy into v_total, v_accuracy
    from public.learner_profiles
    where user_id = '22222222-0000-4000-8000-000000000001';

    assert v_total = 0, format('FAIL: a new learner should start at 0 attempts, got %s', v_total);
    assert v_accuracy is null, 'FAIL: accuracy should be NULL, not 0, before any attempt';
    raise notice 'PASS 1/8: signup creates a learner profile starting at zero';
end $$;

-- 2. Accuracy is derived from the two counts.
do $$
declare
    v_accuracy numeric;
begin
    update public.learner_profiles
    set total_attempts = 40, correct_attempts = 26
    where user_id = '22222222-0000-4000-8000-000000000001';

    select overall_accuracy into v_accuracy from public.learner_profiles
    where user_id = '22222222-0000-4000-8000-000000000001';

    assert v_accuracy = 65.00, format('FAIL: expected 65.00, got %s', v_accuracy);
    raise notice 'PASS 2/8: overall_accuracy is computed by the database';
end $$;

-- 3. Being right more often than you answered is impossible.
do $$
begin
    begin
        update public.learner_profiles
        set correct_attempts = 99
        where user_id = '22222222-0000-4000-8000-000000000001';

        raise exception 'FAIL: correct_attempts exceeded total_attempts';
    exception
        when check_violation then
            raise notice 'PASS 3/8: correct_attempts cannot exceed total_attempts';
    end;
end $$;

-- 4. A consistency score outside 0-100 would break the readiness maths downstream.
do $$
begin
    begin
        update public.learner_profiles
        set consistency_score = 140
        where user_id = '22222222-0000-4000-8000-000000000001';

        raise exception 'FAIL: consistency_score of 140 was accepted';
    exception
        when check_violation then
            raise notice 'PASS 4/8: consistency_score stays within 0-100';
    end;
end $$;

-- 5. A current streak longer than the longest streak ever is a contradiction.
do $$
begin
    begin
        update public.learner_profiles
        set current_streak_days = 10, longest_streak_days = 3
        where user_id = '22222222-0000-4000-8000-000000000001';

        raise exception 'FAIL: current streak was allowed to exceed the longest streak';
    exception
        when check_violation then
            raise notice 'PASS 5/8: current streak cannot exceed the longest streak';
    end;
end $$;

-- 6. Only the three known difficulty levels are accepted.
do $$
begin
    begin
        update public.learner_profiles
        set preferred_difficulty = 'impossible'
        where user_id = '22222222-0000-4000-8000-000000000001';

        raise exception 'FAIL: an unknown difficulty was accepted';
    exception
        when check_violation then
            raise notice 'PASS 6/8: preferred_difficulty must be easy, medium or hard';
    end;
end $$;

-- ---------------------------------------------------------------------------
-- As learner one, from the browser.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-0000-4000-8000-000000000001"}';

-- 7. Own numbers only.
do $$
declare
    total int;
    others int;
begin
    select count(*) into total from public.learner_profiles;
    select count(*) into others from public.learner_profiles
    where user_id = '22222222-0000-4000-8000-000000000002';

    assert others = 0, 'FAIL: RLS leak, learner one can see another learner''s model';
    assert total = 1, format('FAIL: learner one should see 1 row, saw %s', total);
    raise notice 'PASS 7/8: learner sees only their own learner profile';
end $$;

-- 8. THE IMPORTANT ONE. A learner editing their own mastery cache would make every
--    recommendation, plan and readiness score a lie.
do $$
begin
    begin
        update public.learner_profiles
        set total_attempts = 1000, correct_attempts = 1000, consistency_score = 100
        where user_id = '22222222-0000-4000-8000-000000000001';

        raise exception 'FAIL: a learner rewrote their own learner model';
    exception
        when insufficient_privilege then
            raise notice 'PASS 8/8: learner cannot edit their own learner model';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
