-- ============================================================================
-- 0011_day8.sql - Schema cache FK fix
-- ----------------------------------------------------------------------------
-- Day 7 created the departments table and migrated agents.department to use
-- slug values (e.g. "engineering", "executive"), but never added a foreign key
-- constraint linking agents.department -> departments.slug. This caused the
-- standup ritual to log on every fire:
--
--   [standup] department join failed (Could not find a relationship between
--   'agents' and 'departments' in the schema cache), falling back to plain query
--
-- The fallback path works correctly, but it's noisy and skips the join-based
-- ordering. Adding the FK + refreshing the PostgREST schema cache fixes both.
--
-- Idempotent: drops the constraint first if it exists, then re-adds.
-- ============================================================================

-- Drop the constraint if it already exists (idempotent re-runs)
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'agents_department_fkey'
      and conrelid = 'agents'::regclass
  ) then
    alter table agents drop constraint agents_department_fkey;
  end if;
end $$;

-- Sanity check: any agents.department values that don't match a departments.slug?
-- If so, set them to null so the FK can be added cleanly.
update agents
set department = null
where department is not null
  and department not in (select slug from departments);

-- Add the FK
alter table agents
add constraint agents_department_fkey
foreign key (department) references departments(slug)
on update cascade
on delete set null;

-- Refresh PostgREST schema cache so the join shows up immediately.
-- Without this, the cache may take up to 10 minutes to pick up the new FK.
notify pgrst, 'reload schema';
