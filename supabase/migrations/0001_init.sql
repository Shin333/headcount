-- ============================================================================
-- HEADCOUNT - Phase 1 Schema
-- Full schema for Phase 1. Day 1 only writes to: agents, forum_posts, agent_actions
-- All other tables are created now so we don't migrate again.
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- AGENTS
create table if not exists agents (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  name text not null,
  role text not null,
  department text,
  tier text not null check (tier in ('exec','director','manager','associate','intern','bot')),
  manager_id uuid references agents(id) on delete set null,
  reports_to_ceo boolean not null default false,
  personality jsonb not null default '{}'::jsonb,
  background text,
  frozen_core text not null,
  manager_overlay text default '',
  learned_addendum text default '',
  allowed_tools text[] not null default '{}',
  model_tier text not null default 'sonnet' check (model_tier in ('sonnet','haiku','opus')),
  status text not null default 'active' check (status in ('active','paused','terminated')),
  daily_token_budget int not null default 50000,
  tokens_used_today int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_tenant_idx on agents(tenant_id);
create index if not exists agents_manager_idx on agents(manager_id);
create index if not exists agents_status_idx on agents(status);

-- FORUM POSTS
create table if not exists forum_posts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  channel text not null,
  author_id uuid not null references agents(id) on delete cascade,
  parent_id uuid references forum_posts(id) on delete cascade,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists forum_posts_channel_idx on forum_posts(channel, created_at desc);
create index if not exists forum_posts_author_idx on forum_posts(author_id);
create index if not exists forum_posts_parent_idx on forum_posts(parent_id);
create index if not exists forum_posts_tenant_idx on forum_posts(tenant_id);

-- DIRECT MESSAGES
create table if not exists dms (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  from_id uuid not null references agents(id) on delete cascade,
  to_id uuid not null references agents(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dms_to_idx on dms(to_id, created_at desc);
create index if not exists dms_from_idx on dms(from_id, created_at desc);

-- TICKETS
create table if not exists tickets (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  title text not null,
  body text not null,
  creator_id uuid references agents(id) on delete set null,
  assignee_id uuid references agents(id) on delete set null,
  department text,
  status text not null default 'new' check (status in ('new','assigned','in_progress','review','done','rejected')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  parent_ticket_id uuid references tickets(id) on delete set null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tickets_assignee_idx on tickets(assignee_id, status);
create index if not exists tickets_status_idx on tickets(status);

-- MEMORIES
create table if not exists memories (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  agent_id uuid not null references agents(id) on delete cascade,
  type text not null check (type in ('observation','reflection','identity')),
  content text not null,
  importance int not null default 5 check (importance between 1 and 10),
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists memories_agent_idx on memories(agent_id, created_at desc);
create index if not exists memories_type_idx on memories(type);

-- RELATIONSHIPS
create table if not exists relationships (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  agent_a uuid not null references agents(id) on delete cascade,
  agent_b uuid not null references agents(id) on delete cascade,
  sentiment int not null default 0 check (sentiment between -100 and 100),
  history text not null default '',
  last_interaction_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(agent_a, agent_b)
);

-- STANDUPS
create table if not exists standups (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  company_date date not null,
  attendees uuid[] not null default '{}',
  transcript jsonb not null default '[]'::jsonb,
  ceo_brief text,
  created_at timestamptz not null default now()
);

create index if not exists standups_date_idx on standups(company_date desc);

-- ARTIFACTS
create table if not exists artifacts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  creator_id uuid references agents(id) on delete set null,
  ticket_id uuid references tickets(id) on delete set null,
  type text not null,
  content jsonb not null,
  customer_id text,
  created_at timestamptz not null default now()
);

-- AGENT ACTIONS (audit log)
create table if not exists agent_actions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  agent_id uuid not null references agents(id) on delete cascade,
  action_type text not null,
  trigger text,
  system_prompt text,
  user_prompt text,
  response text,
  tool_calls jsonb,
  input_tokens int,
  output_tokens int,
  duration_ms int,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_actions_agent_idx on agent_actions(agent_id, created_at desc);
create index if not exists agent_actions_type_idx on agent_actions(action_type);

-- PROMPT EVOLUTION LOG
create table if not exists prompt_evolution_log (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  agent_id uuid not null references agents(id) on delete cascade,
  old_value text,
  new_value text,
  reason text,
  proposed_by text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied')),
  reviewed_by_ceo_at timestamptz,
  created_at timestamptz not null default now()
);

-- WORLD CLOCK
create table if not exists world_clock (
  id int primary key default 1,
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  current_tick bigint not null default 0,
  company_time timestamptz not null default '2026-01-01 08:00:00+00',
  speed_multiplier numeric not null default 1.0,
  paused boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into world_clock (id) values (1) on conflict (id) do nothing;

-- REALTIME
alter publication supabase_realtime add table forum_posts;
alter publication supabase_realtime add table standups;
alter publication supabase_realtime add table tickets;
