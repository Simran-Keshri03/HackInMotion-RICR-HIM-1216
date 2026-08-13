-- 002_topics.test.sql
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/002_topics.test.sql
--
-- Rolled back at the end, so it leaves no rows behind.

begin;

-- A subject with two topics under it.
insert into public.topics (id, parent_id, name, weight, sort_order)
values
    ('bbbbbbbb-0000-4000-8000-000000000001', null, 'Test Subject', 2.00, 1),
    ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001', 'Test Topic A', 1.00, 1),
    ('bbbbbbbb-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000001', 'Test Topic B', 1.50, 2);

-- 1. The tree reads back the way we stored it.
do $$
declare
    n int;
begin
    select count(*) into n
    from public.topics
    where parent_id = 'bbbbbbbb-0000-4000-8000-000000000001';

    assert n = 2, format('FAIL: expected 2 child topics, got %s', n);
    raise notice 'PASS 1/6: subject has its two topics';
end $$;

-- 2. Two topics with the same name under the same subject must be rejected.
do $$
begin
    begin
        insert into public.topics (parent_id, name)
        values ('bbbbbbbb-0000-4000-8000-000000000001', 'Test Topic A');

        raise exception 'FAIL: duplicate topic name under the same subject was allowed';
    exception
        when unique_violation then
            raise notice 'PASS 2/6: duplicate topic name under one subject rejected';
    end;
end $$;

-- 3. Two subjects with the same name must also be rejected. This is the case a plain
--    UNIQUE would have missed, because both parent_ids are NULL.
do $$
begin
    begin
        insert into public.topics (parent_id, name) values (null, 'Test Subject');

        raise exception 'FAIL: duplicate subject name was allowed (nulls not distinct is missing)';
    exception
        when unique_violation then
            raise notice 'PASS 3/6: duplicate subject name rejected';
    end;
end $$;

-- 4. Weight has to stay in a sane range, or the planner maths goes strange.
do $$
begin
    begin
        insert into public.topics (parent_id, name, weight)
        values (null, 'Silly Weight Subject', 99);

        raise exception 'FAIL: weight of 99 was accepted';
    exception
        when check_violation then
            raise notice 'PASS 4/6: out-of-range weight rejected';
    end;
end $$;

-- 5. Deleting a subject takes its topics with it.
do $$
declare
    n int;
begin
    delete from public.topics where id = 'bbbbbbbb-0000-4000-8000-000000000001';

    select count(*) into n
    from public.topics
    where id in (
        'bbbbbbbb-0000-4000-8000-000000000002',
        'bbbbbbbb-0000-4000-8000-000000000003'
    );

    assert n = 0, format('FAIL: %s orphan topics survived the subject delete', n);
    raise notice 'PASS 5/6: deleting a subject cascades to its topics';
end $$;

-- 6. A learner may read the syllabus but must not be able to change it.
insert into public.topics (id, parent_id, name)
values ('bbbbbbbb-0000-4000-8000-000000000004', null, 'Readable Subject');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001"}';

do $$
declare
    n int;
begin
    select count(*) into n from public.topics
    where id = 'bbbbbbbb-0000-4000-8000-000000000004';
    assert n = 1, 'FAIL: learner cannot read the syllabus';

    begin
        insert into public.topics (parent_id, name) values (null, 'Injected Subject');
        raise exception 'FAIL: a learner was able to add a subject';
    exception
        when insufficient_privilege then
            raise notice 'PASS 6/6: learner can read the syllabus but not write to it';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
