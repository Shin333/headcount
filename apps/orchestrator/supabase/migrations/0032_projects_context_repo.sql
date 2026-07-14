-- 0032_projects_context_repo.sql
--
-- (Numbered 0032: 0029/0030 are the security migrations, 0031 is the model
--  columns. Apply ONLY these two statements in the Supabase SQL editor.)
--
-- Group projects by the GitHub repo they edit. `context_repo` holds the repo
-- NAME from the Jarvis registry (~/jarvis-repos.json), e.g. 'dua'. NULL groups
-- under the "general" bucket. Free-text on purpose — the repo namespace lives
-- in the registry, not Postgres, so there is no FK.
--
-- Archiving reuses the existing free-text `status` (no constraint change):
-- status='archived' hides a project from the default list (hide, never delete),
-- the same hide-don't-destroy pattern artifacts already use.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS context_repo text;
CREATE INDEX IF NOT EXISTS projects_context_repo_idx
  ON projects (tenant_id, context_repo);
