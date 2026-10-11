-- Tasks an app handed to an agent (docs/app-tasks.md). Status and result are always read live from
-- the core issue; this table only links an issue to the app, template and row that started it.
CREATE TABLE IF NOT EXISTS kyoube_meta.app_tasks (
  issue_id       text PRIMARY KEY,
  company_id     text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  app_id         uuid NOT NULL REFERENCES kyoube_meta.apps(id) ON DELETE CASCADE,
  app_slug       text NOT NULL,
  app_version    integer NOT NULL,
  template       text NOT NULL,
  agent_id       text NOT NULL,
  table_name     text,
  row_id         text,
  started_by     text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  waiting_reason text,
  closed         boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS app_tasks_app ON kyoube_meta.app_tasks (company_id, app_id, started_at DESC);
CREATE INDEX IF NOT EXISTS app_tasks_starter ON kyoube_meta.app_tasks (company_id, app_id, started_by, started_at DESC);
-- Template name → agent id, resolved when a version is published or rolled back to.
ALTER TABLE kyoube_meta.app_versions ADD COLUMN IF NOT EXISTS task_agents jsonb;
