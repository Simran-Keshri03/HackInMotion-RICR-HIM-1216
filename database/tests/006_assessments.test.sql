-- 006_assessments.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/006_assessments.test.sql
--
-- Rolled back at the end.

begin;

insert into auth.users (id, email)
values
    ('11111111-0000-4000-8000-000000000001', 'assess-one@adigam.test'),
    ('11111111-0000-4000-8000-000000000002', 'assess-two@adigam.test');

insert into public.topics (id, parent_id, name)
values ('11111111-0000-4000-8000-0000000000f1', null, 'Assessment Test Subject');

insert into public.questions (id, topic_id, question_type, body, options, correct_answer, is_verified)
values
    ('11111111-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000f1',
     'mcq', 'Assessment question one', array['a', 'b'], '[0]'::jsonb, true),
    ('11111111-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-0000000000f1',
     'mcq', 'Assessment question two', array['a', 'b'], '[1]'::jsonb, true);

insert into public.learning_goals (id, user_id, title, exam_date, daily_minutes)
values
    ('11111111-0000-4000-8000-0000000000b1', '11111111-0000-4000-8000-000000000001',
     'Assessment Goal One', current_date + 45, 60),
    ('11111111-0000-4000-8000-0000000000b2', '11111111-0000-4000-8000-000000000002',
     'Assessment Goal Two', current_date + 45, 60);

insert into public.assessments (id, user_id, goal_id, question_count)
values
    ('11111111-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-000000000001',
     '11111111-0000-4000-8000-0000000000b1', 2),
    ('11111111-0000-4000-8000-0000000000c2', '11111111-0000-4000-8000-000000000002',
     '11111111-0000-4000-8000-0000000000b2', 2);

insert into public.assessment_questions (assessment_id, question_id, position)
values
    ('11111111-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000a1', 1),
    ('11111111-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000a2', 2);

-- 1. accuracy is derived, so it moves on its own when correct_count changes.
do $$
declare
    v_acc numeric;
begin
    update public.assessments set correct_count = 1
    where id = '11111111-0000-4000-8000-0000000000c1';

    select accuracy into v_acc from public.assessments
    where id = '11111111-0000-4000-8000-0000000000c1';

    assert v_acc = 50.00, format('FAIL: expected accuracy 50.00, got %s', v_acc);
    raise notice 'PASS 1/8: accuracy is computed by the database';
end $$;

-- 2. More correct answers than questions is impossible.
do $$
begin
    begin
        update public.assessments set correct_count = 5
        where id = '11111111-0000-4000-8000-0000000000c1';

        raise exception 'FAIL: correct_count was allowed to exceed question_count';
    exception
        when check_violation then
            raise notice 'PASS 2/8: correct_count cannot exceed question_count';
    end;
end $$;

-- 3. "Completed" without a completion time is a half-finished record.
do $$
begin
    begin
        update public.assessments set status = 'completed'
        where id = '11111111-0000-4000-8000-0000000000c1';

        raise exception 'FAIL: an assessment was completed without a completed_at';
    exception
        when check_violation then
            raise notice 'PASS 3/8: completed status requires completed_at';
    end;
end $$;

-- 4. A second unfinished sitting would make "resume" ambiguous.
do $$
begin
    begin
        insert into public.assessments (user_id, goal_id, question_count)
        values ('11111111-0000-4000-8000-000000000001', '11111111-0000-4000-8000-0000000000b1', 5);

        raise exception 'FAIL: a learner has two assessments in progress';
    exception
        when unique_violation then
            raise notice 'PASS 4/8: only one in-progress assessment per learner';
    end;
end $$;

-- 5. Two questions cannot occupy the same slot in the paper.
do $$
begin
    begin
        insert into public.assessment_questions (assessment_id, question_id, position)
        values ('11111111-0000-4000-8000-0000000000c1', '11111111-0000-4000-8000-0000000000a1', 2);

        raise exception 'FAIL: two questions share a position';
    exception
        when unique_violation then
            raise notice 'PASS 5/8: question positions are unique within a paper';
    end;
end $$;

-- 6. Answering links the paper row to the attempt, without copying the result.
do $$
declare
    v_correct boolean;
begin
    insert into public.question_attempts (id, user_id, question_id, is_correct, source)
    values ('11111111-0000-4000-8000-0000000000d1', '11111111-0000-4000-8000-000000000001',
            '11111111-0000-4000-8000-0000000000a1', true, 'assessment');

    update public.assessment_questions
    set attempt_id = '11111111-0000-4000-8000-0000000000d1'
    where assessment_id = '11111111-0000-4000-8000-0000000000c1'
      and question_id = '11111111-0000-4000-8000-0000000000a1';

    select qa.is_correct into v_correct
    from public.assessment_questions aq
    join public.question_attempts qa on qa.id = aq.attempt_id
    where aq.assessment_id = '11111111-0000-4000-8000-0000000000c1'
      and aq.question_id = '11111111-0000-4000-8000-0000000000a1';

    assert v_correct, 'FAIL: the paper row does not reach its attempt';
    raise notice 'PASS 6/8: answered questions link to the attempt log';
end $$;

-- ---------------------------------------------------------------------------
-- As learner one, from the browser.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-0000-4000-8000-000000000001"}';

-- 7. Own sitting and own paper only.
do $$
declare
    mine int;
    others int;
    paper int;
begin
    select count(*) into mine from public.assessments;
    select count(*) into others from public.assessments
    where user_id = '11111111-0000-4000-8000-000000000002';
    select count(*) into paper from public.assessment_questions;

    assert others = 0, 'FAIL: RLS leak, learner one can see another learner''s assessment';
    assert mine = 1, format('FAIL: learner one should see 1 assessment, saw %s', mine);
    assert paper = 2, format('FAIL: learner one should see 2 paper rows, saw %s', paper);
    raise notice 'PASS 7/8: learner sees only their own sitting and paper';
end $$;

-- 8. A learner cannot mark their own assessment complete or invent one.
do $$
begin
    begin
        update public.assessments set correct_count = 2
        where id = '11111111-0000-4000-8000-0000000000c1';

        raise exception 'FAIL: a learner edited their own assessment score';
    exception
        when insufficient_privilege then
            raise notice 'PASS 8/8: learner cannot edit assessments, only the backend can';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
