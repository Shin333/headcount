-- ============================================================================
-- 0021_day27_rls_policies.sql — enable RLS + read policies on all tables
-- ----------------------------------------------------------------------------
-- Until today every table had RLS disabled. The orchestrator uses the
-- service_role key (which bypasses RLS regardless), so this never broke
-- anything — but the dashboard's anon key client (used for realtime
-- subscriptions) had unfiltered SELECT on every table. If the anon key
-- ever leaked, the entire database was readable by anyone.
--
-- This migration:
--   1. Enables row-level security on every tenant-scoped table.
--   2. Adds a permissive SELECT policy for anon + authenticated, scoped to
--      the single tenant_id we currently operate as. The hardcoded UUID
--      makes the multi-tenant transition trivial later — swap it for
--      `(auth.jwt() ->> 'tenant_id')::uuid` when JWT tenancy is wired.
--   3. Does NOT add insert/update/delete policies. Writes go through API
--      routes that use service_role (which bypasses RLS). Anon and
--      authenticated cannot write directly.
--
-- service_role bypass: Supabase grants service_role the BYPASSRLS attribute
-- on database roles, so no policy is needed for it. Verified at
-- supabase.com/docs/guides/database/postgres/row-level-security.
--
-- Tables WITHOUT a tenant_id column (project_members, project_messages,
-- world_clock, ritual_state) get a permissive `using (true)` because there's
-- nothing to filter on directly. world_clock and ritual_state are global
-- singletons; project_members and project_messages are implicitly tenant-
-- scoped via project_id FK (would need a JOIN-policy if/when multi-tenant).
-- ============================================================================

-- Helper: enable RLS + add a tenant-scoped SELECT policy in one block.
-- Wrapped in DO ... so we can short-circuit per-table.
do $$
declare
  the_tenant constant uuid := '00000000-0000-0000-0000-000000000001';
  tenant_tables constant text[] := array[
    'agents', 'forum_posts', 'dms', 'tickets', 'memories', 'relationships',
    'standups', 'artifacts', 'agent_actions', 'prompt_evolution_log',
    'wall_token_spend', 'reflection_triggers', 'tool_result_cache', 'reports',
    'report_runs', 'departments', 'projects',
    'commitments', 'agent_credentials', 'real_action_audit', 'cost_alerts'
  ];
  global_tables constant text[] := array[
    'project_members', 'project_messages', 'world_clock', 'ritual_state'
  ];
  t text;
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    -- Drop any prior version of the same policy so re-runs are idempotent.
    execute format('drop policy if exists "anon_authenticated_select_tenant" on %I', t);
    execute format(
      'create policy "anon_authenticated_select_tenant" on %I for select to anon, authenticated using (tenant_id = %L)',
      t, the_tenant
    );
  end loop;

  foreach t in array global_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon_authenticated_select_all" on %I', t);
    execute format(
      'create policy "anon_authenticated_select_all" on %I for select to anon, authenticated using (true)',
      t
    );
  end loop;
end$$;
