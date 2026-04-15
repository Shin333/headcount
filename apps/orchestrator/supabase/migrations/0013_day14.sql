-- ============================================================================
-- 0013_day14.sql - projects table for Eleanor's routing layer
-- ----------------------------------------------------------------------------
-- Day 14 adds a minimal projects table that anchors multi-deliverable work
-- in the database with a stable ID. Eleanor's project_create tool inserts
-- rows here when the CEO brings her a multi-specialty request.
--
-- v1 design: deliberately minimal. No project_members, no project_messages,
-- no project_status_history. Coordination happens via existing dms rows
-- referencing the project ID in their bodies. We add tables only when we
-- have actual usage data showing they're needed.
-- ============================================================================

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,

  -- The brief: what is this project, what does success look like
  title text not null,
  description text not null,

  -- Lifecycle: 'active' | 'completed' | 'cancelled'
  status text not null default 'active',

  -- Provenance: who created it (typically Eleanor, but the tool isn't
  -- locked to her in code - the grant script controls who has access)
  created_by uuid references agents(id),

  created_at timestamptz not null default now()
);

create index if not exists projects_tenant_status_idx
  on projects (tenant_id, status, created_at desc);

create index if not exists projects_created_by_idx
  on projects (created_by, created_at desc);

-- No RLS for v1. Headcount is single-tenant in practice; the orchestrator
-- uses the service role key. Add RLS when there's a second tenant.
