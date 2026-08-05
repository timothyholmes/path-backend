-- Fixture for the migration-rollback test. Creates a table, then fails, so the
-- test can confirm the whole migration is rolled back rather than half applied.
create table public.should_not_survive (id integer primary key);

select 1 / 0;
