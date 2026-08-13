-- 008_concept_mastery.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/008_concept_mastery.test.sql
--
-- Check 4 is the interesting one: it catches the bug where an update bumps the total but
-- forgets the difficulty bucket, which would silently corrupt every mastery score.
-- Check 9 is the one that matters most: a learner cannot set their own mastery.
--
-- Rolled back at the end.

begin;

insert into auth.users (id, email)
values
    ('33333333-0000-4000-8000-000000000001', 'mastery-one@adigam.test'),
    ('33333333-0000-4000-8000-000000000002', 'mastery-two@adigam.test');

insert into public.topics (id, parent_id, name, sort_order)
values
    ('33333333-0000-4000-8000-0000000000f1', null, 'Mastery Test Subject', 1),
    ('33333333-0000-4000-8000-0000000000f2', '33333333-0000-4000-8000-0000000000f1', 'Strong Topic', 1),
    ('33333333-0000-4000-8000-0000000000f3', '33333333-0000-4000-8000-0000000000f1', 'Weak Topic', 2),
    ('33333333-0000-4000-8000-0000000000f4', '33333333-0000-4000-8000-0000000000f1', 'Middling Topic', 3);

-- A learner who is good at one topic, bad at another, average at a third.
insert into public.concept_mastery (
    user_id, topic_id, mastery_score,
    total_attempts, correct_attempts,
    recent_attempts, recent_correct,
    easy_attempts, easy_correct,
    medium_attempts, medium_correct,
    hard_attempts, hard_correct,
    last_attempt_at, last_correct_at, correct_streak
)
values
    ('33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-0000000000f2', 82.00,
     10, 9, 5, 5, 3, 3, 5, 5, 2, 1, now(), now(), 5),
    ('33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-0000000000f3', 31.50,
     8, 3, 5, 1, 4, 3, 3, 0, 1, 0, now() - interval '9 days', now() - interval '20 days', 0),
    ('33333333-0000-4000-8000-000000000001', '33333333-0000-4000-8000-0000000000f4', 55.00,
     6, 4, 4, 3, 2, 2, 3, 2, 1, 0, now() - interval '2 days', now() - interval '2 days', 1),
    ('33333333-0000-4000-8000-000000000002', '33333333-0000-4000-8000-0000000000f2', 90.00,
     10, 10, 5, 5, 3, 3, 5, 5, 2, 2, now(), now(), 10);

-- 1. Both accuracy columns are derived, historical and recent.
do $$
declare
    v_acc numeric;
    v_recent numeric;
begin
    select accuracy, recent_accuracy into v_acc, v_recent
    from public.concept_mastery
    where user_id = '33333333-0000-4000-8000-000000000001'
      and topic_id = '33333333-0000-4000-8000-0000000000f3';

    assert v_acc = 37.50, format('FAIL: expected historical 37.50, got %s', v_acc);
    assert v_recent = 20.00, format('FAIL: expected recent 20.00, got %s', v_recent);
    raise notice 'PASS 1/9: historical and recent accuracy are both computed by the database';
end $$;

-- 2. A score outside the scale is refused.
do $$
begin
    begin
        update public.concept_mastery set mastery_score = 150
        where user_id = '33333333-0000-4000-8000-000000000001'
          and topic_id = '33333333-0000-4000-8000-0000000000f2';

        raise exception 'FAIL: a mastery score of 150 was accepted';
    exception
        when check_violation then
            raise notice 'PASS 2/9: mastery_score stays within 0-100';
    end;
end $$;

-- 3. Recent attempts cannot outnumber all attempts.
do $$
begin
    begin
        update public.concept_mastery set recent_attempts = 99
        where user_id = '33333333-0000-4000-8000-000000000001'
          and topic_id = '33333333-0000-4000-8000-0000000000f2';

        raise exception 'FAIL: recent_attempts exceeded total_attempts';
    exception
        when check_violation then
            raise notice 'PASS 3/9: recent_attempts cannot exceed total_attempts';
    end;
end $$;

-- 4. THE SILENT-CORRUPTION CHECK. Bumping the total without bumping a difficulty bucket
--    is exactly the bug that would skew the difficulty part of every score.
do $$
begin
    begin
        update public.concept_mastery set total_attempts = total_attempts + 1
        where user_id = '33333333-0000-4000-8000-000000000001'
          and topic_id = '33333333-0000-4000-8000-0000000000f2';

        raise exception 'FAIL: total_attempts moved without a difficulty bucket moving';
    exception
        when check_violation then
            raise notice 'PASS 4/9: difficulty buckets must add up to total_attempts';
    end;
end $$;

-- 5. Moving both together is fine, which is what a correct update looks like.
do $$
declare
    v_total int;
begin
    update public.concept_mastery
    set total_attempts = total_attempts + 1,
        medium_attempts = medium_attempts + 1,
        correct_attempts = correct_attempts + 1,
        medium_correct = medium_correct + 1,
        correct_streak = correct_streak + 1,
        last_attempt_at = now(),
        last_correct_at = now()
    where user_id = '33333333-0000-4000-8000-000000000001'
      and topic_id = '33333333-0000-4000-8000-0000000000f2';

    select total_attempts into v_total from public.concept_mastery
    where user_id = '33333333-0000-4000-8000-000000000001'
      and topic_id = '33333333-0000-4000-8000-0000000000f2';

    assert v_total = 11, format('FAIL: expected 11 attempts after a correct update, got %s', v_total);
    raise notice 'PASS 5/9: a consistent update is accepted';
end $$;

-- 6. A topic cannot have been answered correctly before it was ever answered.
do $$
begin
    begin
        update public.concept_mastery
        set last_correct_at = now() + interval '1 day'
        where user_id = '33333333-0000-4000-8000-000000000001'
          and topic_id = '33333333-0000-4000-8000-0000000000f2';

        raise exception 'FAIL: last_correct_at was allowed to be after last_attempt_at';
    exception
        when check_violation then
            raise notice 'PASS 6/9: last_correct_at cannot be later than last_attempt_at';
    end;
end $$;

-- 7. The query the adaptive engine actually runs: weakest topics first.
do $$
declare
    weakest uuid;
begin
    select topic_id into weakest
    from public.concept_mastery
    where user_id = '33333333-0000-4000-8000-000000000001'
    order by mastery_score
    limit 1;

    assert weakest = '33333333-0000-4000-8000-0000000000f3',
        'FAIL: the weakest topic query returned the wrong topic';
    raise notice 'PASS 7/9: weakest-topic-first query returns the weak topic';
end $$;

-- ---------------------------------------------------------------------------
-- As learner one, from the browser.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-0000-4000-8000-000000000001"}';

-- 8. Own mastery only. Another learner's strengths are none of their business.
do $$
declare
    mine int;
    others int;
begin
    select count(*) into mine from public.concept_mastery;
    select count(*) into others from public.concept_mastery
    where user_id = '33333333-0000-4000-8000-000000000002';

    assert others = 0, 'FAIL: RLS leak, learner one can see another learner''s mastery';
    assert mine = 3, format('FAIL: learner one should see 3 topics, saw %s', mine);
    raise notice 'PASS 8/9: learner sees only their own mastery rows';
end $$;

-- 9. THE ONE THAT MATTERS MOST. If this ever passes, the product is a toy: a learner
--    could declare themselves exam ready without answering a question.
do $$
begin
    begin
        update public.concept_mastery set mastery_score = 100
        where user_id = '33333333-0000-4000-8000-000000000001';

        raise exception 'FAIL: a learner set their own mastery to 100';
    exception
        when insufficient_privilege then
            raise notice 'PASS 9/9: learner cannot write their own mastery score';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
