import { parseMode, type CompileGroup, type VisibilityMode } from "@kyoube/visibility";
import type { Pool, PoolClient } from "pg";
import { DataError } from "../data/errors.js";
import { parseGroupLevel, type GroupLevel } from "./levels.js";

export interface GroupInput { name: string; dataLevel: GroupLevel | null; members: string[]; agents: string[]; apps: string[]; seesAll: boolean; projects: string[] }
export interface GroupRecord extends GroupInput { id: string; companyId: string; createdAt: string; updatedAt: string }
export interface AgentAccess { agentId: string; allowedUserIds: string[] }
export interface SyncReport { syncedAt: string; error: string | null }

type MetaDb = Pool | PoolClient;
interface GroupRow {
  id: string; company_id: string; name: string; data_level: string | null; sees_all: boolean; created_at: Date; updated_at: Date;
  members: string[] | null; agents: string[] | null; apps: string[] | null; projects: string[] | null;
}

const SELECT_GROUPS = `
  SELECT g.id, g.company_id, g.name, g.data_level, g.sees_all, g.created_at, g.updated_at,
         (SELECT array_agg(user_id ORDER BY user_id) FROM kyoube_meta.group_members m WHERE m.group_id = g.id) AS members,
         (SELECT array_agg(agent_id ORDER BY agent_id) FROM kyoube_meta.group_agents a WHERE a.group_id = g.id) AS agents,
         (SELECT array_agg(app_id::text ORDER BY app_id) FROM kyoube_meta.group_apps p WHERE p.group_id = g.id) AS apps,
         (SELECT array_agg(project_id ORDER BY project_id) FROM kyoube_meta.group_projects gp WHERE gp.group_id = g.id) AS projects
    FROM kyoube_meta.groups g`;

function toGroup(row: GroupRow): GroupRecord {
  return {
    id: row.id, companyId: row.company_id, name: row.name, dataLevel: parseGroupLevel(row.data_level),
    members: row.members ?? [], agents: row.agents ?? [], apps: row.apps ?? [], seesAll: row.sees_all, projects: row.projects ?? [],
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

/** The column's CHECK allows only the two modes; anything else is a broken row, never read as open. */
function toMode(value: string): VisibilityMode {
  const mode = parseMode(value);
  if (mode === null) throw new Error("kyoube_meta.company_settings holds an unknown visibility mode");
  return mode;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/** SQL over the group tables. No authorization here: GroupService decides who may call what. */
export class GroupStore {
  constructor(private readonly pool: Pool) {}

  async list(companyId: string): Promise<GroupRecord[]> {
    const result = await this.pool.query<GroupRow>(`${SELECT_GROUPS} WHERE g.company_id = $1 ORDER BY lower(g.name)`, [companyId]);
    return result.rows.map(toGroup);
  }

  async get(companyId: string, id: string, db: MetaDb = this.pool): Promise<GroupRecord | null> {
    const result = await db.query<GroupRow>(`${SELECT_GROUPS} WHERE g.company_id = $1 AND g.id = $2`, [companyId, id]);
    return result.rows[0] ? toGroup(result.rows[0]) : null;
  }

  async count(companyId: string): Promise<number> {
    const result = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM kyoube_meta.groups WHERE company_id = $1", [companyId]);
    return Number(result.rows[0]!.n);
  }

  async create(client: PoolClient, companyId: string, input: GroupInput): Promise<GroupRecord> {
    let id: string;
    try {
      id = (await client.query<{ id: string }>(
        "INSERT INTO kyoube_meta.groups (company_id, name, data_level, sees_all) VALUES ($1, $2, $3, $4) RETURNING id", [companyId, input.name, input.dataLevel, input.seesAll])).rows[0]!.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DataError("conflict", `a group named "${input.name}" already exists`);
      throw error;
    }
    await this.writeLinks(client, id, input);
    return (await this.get(companyId, id, client))!;
  }

  async replace(client: PoolClient, companyId: string, id: string, input: GroupInput): Promise<GroupRecord | null> {
    let updated: number;
    try {
      updated = (await client.query("UPDATE kyoube_meta.groups SET name = $3, data_level = $4, sees_all = $5, updated_at = now() WHERE company_id = $1 AND id = $2",
        [companyId, id, input.name, input.dataLevel, input.seesAll])).rowCount ?? 0;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DataError("conflict", `a group named "${input.name}" already exists`);
      throw error;
    }
    if (updated === 0) return null;
    for (const table of ["group_members", "group_agents", "group_apps", "group_projects"]) await client.query(`DELETE FROM kyoube_meta.${table} WHERE group_id = $1`, [id]);
    await this.writeLinks(client, id, input);
    return this.get(companyId, id, client);
  }

  async remove(client: PoolClient, companyId: string, id: string): Promise<GroupRecord | null> {
    const before = await this.get(companyId, id, client);
    if (!before) return null;
    await client.query("DELETE FROM kyoube_meta.groups WHERE company_id = $1 AND id = $2", [companyId, id]);
    return before;
  }

  async levelsForUser(companyId: string, userId: string): Promise<GroupLevel[]> {
    const result = await this.pool.query<{ data_level: string }>(
      `SELECT g.data_level FROM kyoube_meta.groups g JOIN kyoube_meta.group_members m ON m.group_id = g.id
        WHERE g.company_id = $1 AND m.user_id = $2 AND g.data_level IS NOT NULL`, [companyId, userId]);
    return result.rows.map((row) => parseGroupLevel(row.data_level)!);
  }

  /** Apps in at least one group of which this person is in none. */
  async hiddenAppIds(companyId: string, userId: string): Promise<Set<string>> {
    const result = await this.pool.query<{ app_id: string }>(
      `SELECT DISTINCT p.app_id::text AS app_id
         FROM kyoube_meta.group_apps p JOIN kyoube_meta.groups g ON g.id = p.group_id
        WHERE g.company_id = $1
          AND NOT EXISTS (SELECT 1 FROM kyoube_meta.group_apps p2
                            JOIN kyoube_meta.group_members m ON m.group_id = p2.group_id
                           WHERE p2.app_id = p.app_id AND m.user_id = $2)`, [companyId, userId]);
    return new Set(result.rows.map((row) => row.app_id));
  }

  /** Every agent in at least one group, with the people of all its groups. Sorted for stable diffs. */
  async agentAccess(companyId: string): Promise<AgentAccess[]> {
    const result = await this.pool.query<{ agent_id: string; users: string[] | null }>(
      `SELECT a.agent_id, array_agg(DISTINCT m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL) AS users
         FROM kyoube_meta.group_agents a
         JOIN kyoube_meta.groups g ON g.id = a.group_id
         LEFT JOIN kyoube_meta.group_members m ON m.group_id = a.group_id
        WHERE g.company_id = $1
        GROUP BY a.agent_id ORDER BY a.agent_id`, [companyId]);
    return result.rows.map((row) => ({ agentId: row.agent_id, allowedUserIds: row.users ?? [] }));
  }

  /** Drops members who left the company and agents that no longer exist. */
  async prune(companyId: string, keep: { userIds: Set<string>; agentIds: Set<string> }): Promise<void> {
    await this.pool.query(
      `DELETE FROM kyoube_meta.group_members m USING kyoube_meta.groups g
        WHERE m.group_id = g.id AND g.company_id = $1 AND NOT (m.user_id = ANY($2::text[]))`, [companyId, [...keep.userIds]]);
    await this.pool.query(
      `DELETE FROM kyoube_meta.group_agents a USING kyoube_meta.groups g
        WHERE a.group_id = g.id AND g.company_id = $1 AND NOT (a.agent_id = ANY($2::text[]))`, [companyId, [...keep.agentIds]]);
  }

  async setSync(companyId: string, report: SyncReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO kyoube_meta.group_sync (company_id, synced_at, error) VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE SET synced_at = EXCLUDED.synced_at, error = EXCLUDED.error`, [companyId, report.syncedAt, report.error]);
  }

  async getSync(companyId: string): Promise<SyncReport | null> {
    const row = (await this.pool.query<{ synced_at: Date; error: string | null }>("SELECT synced_at, error FROM kyoube_meta.group_sync WHERE company_id = $1", [companyId])).rows[0];
    return row ? { syncedAt: row.synced_at.toISOString(), error: row.error } : null;
  }

  async getMode(companyId: string): Promise<VisibilityMode> {
    const row = (await this.pool.query<{ visibility_mode: string }>("SELECT visibility_mode FROM kyoube_meta.company_settings WHERE company_id = $1", [companyId])).rows[0];
    return row ? toMode(row.visibility_mode) : "open";
  }

  /** Upserts like `setCompanySettings`: a company without a settings row gets the other columns' defaults. */
  async setMode(client: PoolClient, companyId: string, mode: VisibilityMode): Promise<void> {
    await client.query(
      `INSERT INTO kyoube_meta.company_settings (company_id, visibility_mode, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (company_id) DO UPDATE SET visibility_mode = EXCLUDED.visibility_mode, updated_at = now()`, [companyId, mode]);
  }

  /** What a company's policy is compiled from, groups in the order they were made. */
  async visibilityInput(companyId: string): Promise<{ mode: VisibilityMode; groups: CompileGroup[] }> {
    const [mode, result] = await Promise.all([
      this.getMode(companyId),
      this.pool.query<GroupRow>(`${SELECT_GROUPS} WHERE g.company_id = $1 ORDER BY g.created_at, g.id`, [companyId]),
    ]);
    return { mode, groups: result.rows.map(toGroup).map(({ seesAll, members, projects }) => ({ seesAll, members, projects })) };
  }

  /** Every company the plugin knows, with its mode; one without a settings row is open. */
  async allModes(): Promise<Array<{ companyId: string; mode: VisibilityMode }>> {
    const result = await this.pool.query<{ company_id: string; mode: string }>(
      `SELECT c.company_id, coalesce(s.visibility_mode, 'open') AS mode
         FROM kyoube_meta.companies c LEFT JOIN kyoube_meta.company_settings s ON s.company_id = c.company_id
        ORDER BY c.company_id`);
    return result.rows.map((row) => ({ companyId: row.company_id, mode: toMode(row.mode) }));
  }

  private async writeLinks(client: PoolClient, id: string, input: GroupInput): Promise<void> {
    if (input.members.length) await client.query("INSERT INTO kyoube_meta.group_members (group_id, user_id) SELECT $1, unnest($2::text[])", [id, input.members]);
    if (input.agents.length) await client.query("INSERT INTO kyoube_meta.group_agents (group_id, agent_id) SELECT $1, unnest($2::text[])", [id, input.agents]);
    if (input.apps.length) await client.query("INSERT INTO kyoube_meta.group_apps (group_id, app_id) SELECT $1, unnest($2::uuid[])", [id, input.apps]);
    if (input.projects.length) await client.query("INSERT INTO kyoube_meta.group_projects (group_id, project_id) SELECT $1, unnest($2::text[])", [id, input.projects]);
  }
}
