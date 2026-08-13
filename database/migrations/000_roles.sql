-- 000_roles.sql
--
-- Runs before everything else.
--
-- This project has Supabase's "automatically expose new tables" turned off, so no role
-- gets access to anything unless we say so. For the browser roles that is exactly the
-- behaviour we want: `authenticated` is granted, table by table and sometimes column by
-- column, in each table's own migration, and `anon` is granted nothing at all.
--
-- service_role is a different case. It is the backend's identity, it lives only in
-- backend/.env, it never reaches a browser, and it is expected to be able to do everything
-- -- grade answers against stored answers, append to the attempt log, rewrite the mastery
-- cache. Without the grants below the API cannot so much as read the question bank.
--
-- So the security story stays intact: the dangerous role is powerful but unreachable from
-- the outside, and the role the browser actually holds is restricted deliberately.

-- Being able to see the schema at all.
grant usage on schema public to service_role, authenticated, anon;

-- Everything that exists right now.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- And everything a later migration creates, so nobody has to remember this file.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
