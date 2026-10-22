-- Work-object visibility (docs/groups.md, "Visibility"): a company's mode, groups that see every
-- work object, and the projects each group includes. The groups worker compiles these into the
-- policy files the core reads. Ids only: people's and projects' names stay in the core.
ALTER TABLE kyoube_meta.company_settings ADD COLUMN IF NOT EXISTS visibility_mode text NOT NULL DEFAULT 'open' CHECK (visibility_mode IN ('open', 'need_to_know'));

ALTER TABLE kyoube_meta.groups ADD COLUMN IF NOT EXISTS sees_all boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS kyoube_meta.group_projects (
  group_id uuid NOT NULL REFERENCES kyoube_meta.groups(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  PRIMARY KEY (group_id, project_id)
);
CREATE INDEX IF NOT EXISTS group_projects_project ON kyoube_meta.group_projects (project_id);
