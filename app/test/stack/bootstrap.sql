-- TEST ONLY: recreates the roles and defaults a hosted Supabase project already has,
-- so the real migrations in supabase/migrations can be tested against plain Postgres.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'authpass';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login createrole noinherit password 'authpass';
create schema auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants new public tables and functions to the API roles by default.
-- That is why every DaySpear table turns on row level security.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
