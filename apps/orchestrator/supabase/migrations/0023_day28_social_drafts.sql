-- ============================================================================
-- 0023_day28_social_drafts.sql — Genviral draft tracking
-- ----------------------------------------------------------------------------
-- Every time an agent posts a draft through the Genviral API, we insert a row
-- here. The row records the platform, account, caption, image URLs, and the
-- Genviral post_id so the dashboard can show pending drafts + their status
-- without re-hitting Genviral for every page load. A poller (or on-demand
-- refresh) updates `status` + `external_url` once the draft is reviewed and
-- published on the user's side.
-- ============================================================================

create table if not exists social_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_id uuid not null,
  project_id uuid,

  platform text not null check (platform in ('instagram', 'tiktok', 'youtube', 'facebook', 'pinterest', 'linkedin')),
  account_id text not null, -- Genviral's ID for the connected account

  -- What the agent drafted
  post_type text not null check (post_type in ('slideshow', 'image', 'video')),
  caption text not null,
  hashtags text[] not null default '{}',
  image_urls text[] not null default '{}', -- public Supabase Storage URLs
  audio_suggestion text, -- TikTok only — URL or identifier

  -- Genviral bookkeeping
  genviral_post_id text, -- null while insert is in flight
  genviral_post_mode text, -- 'MEDIA_UPLOAD' (draft) or 'DIRECT'
  status text not null default 'drafting' check (status in (
    'drafting',    -- we're still building the post
    'uploaded',    -- sent to Genviral, awaiting CEO approval in the native app
    'published',   -- CEO approved + posted
    'error',       -- Genviral returned an error
    'cancelled'    -- CEO rejected
  )),
  error_message text,
  external_url text, -- final IG/TikTok URL once published

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz
);

create index if not exists social_drafts_status_idx on social_drafts (tenant_id, status, created_at desc);
create index if not exists social_drafts_project_idx on social_drafts (project_id, created_at desc) where project_id is not null;
create index if not exists social_drafts_genviral_post_idx on social_drafts (genviral_post_id) where genviral_post_id is not null;

alter table social_drafts enable row level security;

drop policy if exists "anon_authenticated_select_tenant" on social_drafts;
create policy "anon_authenticated_select_tenant" on social_drafts
  for select to anon, authenticated
  using (tenant_id = '00000000-0000-0000-0000-000000000001');
