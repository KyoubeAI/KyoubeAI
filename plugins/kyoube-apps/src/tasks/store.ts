import type { Pool } from "pg";
import { withMeta, type AuditEntry } from "../data/audit.js";
import { mapPgError } from "../data/errors.js";

export interface AppTaskRow {
  issueId: string;
  companyId: string;
  appId: string;
  appSlug: string;
  appVersion: number;
  template: string;
  agentId: string;
  tableName: string | null;
  rowId: string | null;
  startedBy: string;
  startedAt: string;
  waitingReason: string | null;
  closed: boolean;
}

interface TaskDbRow {
  issue_id: string;
  company_id: string;
  app_id: string;
  app_slug: string;
  app_version: number;
  template: string;
  agent_id: string;
  table_name: string | null;
  row_id: string | null;
  started_by: string;
  started_at: Date;
  waiting_reason: string | null;
  closed: boolean;
}

const COLUMNS = "issue_id, company_id, app_id, app_slug, app_version, template, agent_id, table_name, row_id, started_by, started_at, waiting_reason, closed";

function toTask(row: TaskDbRow): AppTaskRow {
  return {
    issueId: row.issue_id,
    companyId: row.company_id,
    appId: row.app_id,
    appSlug: row.app_slug,
    appVersion: row.app_version,
    template: row.template,
    agentId: row.agent_id,
    tableName: row.table_name,
    rowId: row.row_id,
    startedBy: row.started_by,
    startedAt: row.started_at.toISOString(),
    waitingReason: row.waiting_reason,
    closed: row.closed,
  };
}

/** The link between a core issue and the app, template and row that started it (docs/app-tasks.md). */
export class AppTaskStore {
  constructor(private readonly pool: Pool) {}

  /** Maps a raw Postgres error to its `DataError` (a duplicate issue id is a conflict), as `AppStore` does. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw mapPgError(error) ?? error;
    }
  }

  /** Inserts the row and its audit row in one transaction. */
  async insert(row: Omit<AppTaskRow, "startedAt" | "waitingReason" | "closed">, audit: AuditEntry): Promise<AppTaskRow> {
    return this.run(() =>
      withMeta(
        this.pool,
        async (client) => {
          const result = await client.query<TaskDbRow>(
            `INSERT INTO kyoube_meta.app_tasks (issue_id, company_id, app_id, app_slug, app_version, template, agent_id, table_name, row_id, started_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
            [row.issueId, row.companyId, row.appId, row.appSlug, row.appVersion, row.template, row.agentId, row.tableName, row.rowId, row.startedBy],
          );
          return toTask(result.rows[0]!);
        },
        () => audit,
      ),
    );
  }

  async get(companyId: string, appId: string, issueId: string): Promise<AppTaskRow | null> {
    return this.run(async () => {
      const result = await this.pool.query<TaskDbRow>(
        `SELECT ${COLUMNS} FROM kyoube_meta.app_tasks WHERE company_id = $1 AND app_id = $2 AND issue_id = $3`,
        [companyId, appId, issueId],
      );
      return result.rows[0] ? toTask(result.rows[0]) : null;
    });
  }

  /** Newest first. */
  async list(companyId: string, appId: string, filter: { template?: string; rowId?: string; limit: number }): Promise<AppTaskRow[]> {
    return this.run(async () => {
      const result = await this.pool.query<TaskDbRow>(
        `SELECT ${COLUMNS} FROM kyoube_meta.app_tasks
         WHERE company_id = $1 AND app_id = $2 AND ($3::text IS NULL OR template = $3) AND ($4::text IS NULL OR row_id = $4)
         ORDER BY started_at DESC, issue_id DESC LIMIT $5`,
        [companyId, appId, filter.template ?? null, filter.rowId ?? null, filter.limit],
      );
      return result.rows.map(toTask);
    });
  }

  /** Starts by this person on this app at or after `sinceMs` (epoch milliseconds). */
  async countStartedSince(companyId: string, appId: string, userId: string, sinceMs: number): Promise<number> {
    return this.run(async () => {
      const result = await this.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM kyoube_meta.app_tasks WHERE company_id = $1 AND app_id = $2 AND started_by = $3 AND started_at >= to_timestamp($4::double precision / 1000)",
        [companyId, appId, userId, sinceMs],
      );
      return Number(result.rows[0]!.n);
    });
  }

  /** Rows not yet seen done or cancelled (`closed` is a cache set by `markClosed`). */
  async openRows(companyId: string, appId: string): Promise<AppTaskRow[]> {
    return this.run(async () => {
      const result = await this.pool.query<TaskDbRow>(
        `SELECT ${COLUMNS} FROM kyoube_meta.app_tasks WHERE company_id = $1 AND app_id = $2 AND NOT closed ORDER BY started_at DESC, issue_id DESC`,
        [companyId, appId],
      );
      return result.rows.map(toTask);
    });
  }

  async setWaitingReason(issueId: string, reason: string | null): Promise<void> {
    await this.run(() => this.pool.query("UPDATE kyoube_meta.app_tasks SET waiting_reason = $2 WHERE issue_id = $1", [issueId, reason]));
  }

  async markClosed(issueId: string): Promise<void> {
    await this.run(() => this.pool.query("UPDATE kyoube_meta.app_tasks SET closed = true WHERE issue_id = $1", [issueId]));
  }

  /** A standalone audit row (the cancel), in its own meta transaction as `withMeta` requires. */
  async recordAudit(entry: AuditEntry): Promise<void> {
    await this.run(() => withMeta(this.pool, async () => undefined, () => entry));
  }

  async getTaskAgents(versionId: string): Promise<Record<string, string> | null> {
    return this.run(async () => {
      const result = await this.pool.query<{ task_agents: Record<string, string> | null }>("SELECT task_agents FROM kyoube_meta.app_versions WHERE id = $1", [versionId]);
      return result.rows[0]?.task_agents ?? null;
    });
  }

  async setTaskAgents(versionId: string, agents: Record<string, string> | null): Promise<void> {
    await this.run(() =>
      this.pool.query("UPDATE kyoube_meta.app_versions SET task_agents = $2::jsonb WHERE id = $1", [versionId, agents === null ? null : JSON.stringify(agents)]),
    );
  }
}
