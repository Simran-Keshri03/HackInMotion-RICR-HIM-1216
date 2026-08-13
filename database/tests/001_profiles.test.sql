-- 001_profiles.test.sql
--
-- Proves the two things 001_profiles.sql claims: signup creates a profile, and one
-- learner can never touch another learner's row.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/tests/001_profiles.test.sql
--
-- Everything runs inside a transaction that is rolled back at the end, so the database
-- is left exactly as it was and no fake users survive.

begin;

-- Two pretend signups. Inserting into auth.users is what Supabase Auth does when a
-- real user registers, so this exercises the same code path.
insert into auth.users (id, email)
values
    ('aaaaaaaa-0000-4000-8000-000000000001', 'learner-one@adigam.test'),
    ('aaaaaaaa-0000-4000-8000-000000000002', 'learner-two@adigam.test');

-- 1. The trigger must have created one profile per signup.
do $$
declare
    n int;
begin
    select count(*) into n
    from public.profiles
    where id in (
        'aaaaaaaa-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000002'
    );

    assert n = 2, format('FAIL: expected 2 profiles from the signup trigger, got %s', n);
    raise notice 'PASS 1/5: signup trigger created a profile for each new user';
end $$;

-- 2. The email was copied across from auth.users.
do $$
declare
    v_email text;
begin
    select email into v_email
    from public.profiles
    where id = 'aaaaaaaa-0000-4000-8000-000000000001';

    assert v_email = 'learner-one@adigam.test',
        format('FAIL: expected the email to be copied, got %L', v_email);
    raise notice 'PASS 2/5: profile carries the email from auth.users';
end $$;

-- ---------------------------------------------------------------------------
-- From here on we stop being a superuser and pretend to be learner one, exactly as a
-- browser request would arrive: role "authenticated", identity in the JWT claims.
-- Superusers bypass RLS, so without this switch the security tests would prove nothing.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001"}';

-- 3. Learner one may see their own row and nothing else.
do $$
declare
    n int;
    mine int;
begin
    select count(*) into n from public.profiles;
    select count(*) into mine
    from public.profiles
    where id = 'aaaaaaaa-0000-4000-8000-000000000001';

    assert mine = 1, 'FAIL: learner cannot read their own profile';
    assert n = 1, format('FAIL: RLS leak, learner one can see %s rows', n);
    raise notice 'PASS 3/5: learner sees only their own profile';
end $$;

-- 4. Updating somebody else's row must change nothing. RLS hides the row rather than
--    raising an error, so a silent zero-row update is the correct outcome.
do $$
declare
    n int;
begin
    update public.profiles
    set display_name = 'taken over'
    where id = 'aaaaaaaa-0000-4000-8000-000000000002';

    get diagnostics n = row_count;
    assert n = 0, format('FAIL: RLS leak, learner one updated %s of another learner''s rows', n);
    raise notice 'PASS 4/5: cross-user update affected no rows';
end $$;

-- 5. A learner must not be able to create a profile row by hand. Creation belongs to
--    the trigger, which is the whole point of not letting the browser do it.
do $$
begin
    begin
        insert into public.profiles (id, email)
        values ('aaaaaaaa-0000-4000-8000-000000000009', 'attacker@adigam.test');

        raise exception 'FAIL: a learner was able to insert a profile row directly';
    exception
        when insufficient_privilege then
            raise notice 'PASS 5/5: direct profile insert blocked (no INSERT policy)';
    end;
end $$;

rollback;

\echo ''
\echo 'All checks passed. Transaction rolled back - no test data left behind.'
