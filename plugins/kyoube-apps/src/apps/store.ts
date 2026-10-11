import type { Pool } from "pg";
import { withMeta, type AuditPlan } from "../data/audit.js";
import { DataError, mapPgError } from "../data/errors.js";
import type { AppManifest } from "./manifest.js";

export interface AppVersion { id: string; version: number; manifest: AppManifest; source: string; createdByKind: string; createdById: string | null; notes: string | null; createdAt: string }
/** Which version a caller wants: a number, the published one, or the newest draft. */
export type VersionRef = number | "current" | "latest";
/** What a create or an update leaves behind: the version written, and the app row as it now stands. */
export interface AppEdit { app: AppRecord; version: AppVersion }
export interface AppRecord { id: string; companyId: string; slug: string; name: string; description: string | null; icon: string | null; status: "draft" | "published" | "archived"; currentVersion: number | null; latestVersion: number; createdAt: string; updatedAt: string }

interface AppRow { id: string; company_id: string; slug: string; name: string; description: string | null; icon: string | null; status: AppRecord["status"]; current_version: number | null; latest_version: number; created_at: Date; updated_at: Date }
interface VersionRow { id: string; version: number; manifest: AppManifest; source: string; created_by_kind: string; created_by_id: string | null; notes: string | null; created_at: Date }

const APP_COLUMNS = "id, company_id, slug, name, description, icon, status, current_version, latest_version, created_at, updated_at";
const VERSION_COLUMNS = "id, version, manifest, source, created_by_kind, created_by_id, notes, created_at";

function toApp(row: AppRow): AppRecord {
  return { id: row.id, companyId: row.company_id, slug: row.slug, name: row.name, description: row.description, icon: row.icon, status: row.status, currentVersion: row.current_version, latestVersion: row.latest_version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function toVersion(row: VersionRow): AppVersion {
  return { id: row.id, version: row.version, manifest: row.manifest, source: row.source, createdByKind: row.created_by_kind, createdById: row.created_by_id, notes: row.notes, createdAt: row.created_at.toISOString() };
}

export class AppStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Runs `fn`, mapping any raw Postgres error it throws (by SQLSTATE) to the
   * matching `DataError` (ruling P3-R4: a duplicate slug or a version race
   * must surface as "conflict", never a raw driver error). Mirrors
   * SchemaService/RecordsService's private run() helper: an error this file
   * already threw as a `DataError` (whose `code` is never a 5-character
   * SQLSTATE) maps to null here and passes through unchanged. Task 1 has no
   * company schema for apps metadata, so unlike those services this wraps
   * plain pool queries/transactions instead of withCompany.
   */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw mapPgError(error) ?? error;
    }
  }

  async list(companyId: string, opts: { includeArchived?: boolean } = {}): Promise<AppRecord[]> {
    return this.run(async () => {
      const result = await this.pool.query<AppRow>(
        `SELECT ${APP_COLUMNS} FROM kyoube_meta.apps WHERE company_id = $1 ${opts.includeArchived ? "" : "AND status <> 'archived'"} ORDER BY name`,
        [companyId],
      );
      return result.rows.map(toApp);
    });
  }

  /**
   * Resolves only the *live* (non-archived) app for this slug (ruling P3-R10):
   * archiving is a terminal soft delete, so a slug is free for a new app once
   * the old one is archived, and the archived row is then reachable only via
   * list({ includeArchived: true }), identified by id. Every by-slug lookup in
   * this store (create()'s pre-check, addVersion/setCurrent/setStatus via
   * require()) goes through this method, so they all inherit that rule.
   */
  async get(companyId: string, slug: string): Promise<AppRecord | null> {
    return this.run(async () => {
      const result = await this.pool.query<AppRow>(`SELECT ${APP_COLUMNS} FROM kyoube_meta.apps WHERE company_id = $1 AND slug = $2 AND status <> 'archived'`, [companyId, slug]);
      return result.rows[0] ? toApp(result.rows[0]) : null;
    });
  }

  /**
   * One version of one app. The second form takes an `AppRecord` the caller has
   * already resolved: `AppService.open()` and `get()` both hold one by the time
   * they ask for a version, and looking the same row up again by slug is both a
   * wasted round trip and a second point in time — the app could have been
   * archived in between, which would turn a resolved app into a null version
   * for reasons the caller has no way to report.
   */
  async getVersion(companyId: string, slug: string, version: VersionRef): Promise<AppVersion | null>;
  async getVersion(app: AppRecord, version: VersionRef): Promise<AppVersion | null>;
  async getVersion(first: string | AppRecord, second: string | VersionRef, third?: VersionRef): Promise<AppVersion | null> {
    const resolved = typeof first === "string" ? await this.get(first, second as string) : first;
    if (!resolved) return null;
    const version = typeof first === "string" ? third! : (second as VersionRef);
    const number = version === "current" ? resolved.currentVersion : version === "latest" ? resolved.latestVersion : version;
    if (number === null || number <= 0) return null;
    return this.run(async () => {
      const result = await this.pool.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM kyoube_meta.app_versions WHERE app_id = $1 AND version = $2`, [resolved.id, number]);
      return result.rows[0] ? toVersion(result.rows[0]) : null;
    });
  }

  async create(companyId: string, manifest: AppManifest, source: string, by: { kind: string; id: string | null }, notes: string | null = null, audit?: AuditPlan<AppEdit>): Promise<AppEdit> {
    if (await this.get(companyId, manifest.slug)) throw new DataError("conflict", `app "${manifest.slug}" already exists`);
    return this.run(() => withMeta(this.pool, async (client) => {
      const app = await client.query<AppRow>(
        `INSERT INTO kyoube_meta.apps (company_id, slug, name, description, icon, latest_version) VALUES ($1, $2, $3, $4, $5, 1) RETURNING ${APP_COLUMNS}`,
        [companyId, manifest.slug, manifest.name, manifest.description, manifest.icon],
      );
      const version = await client.query<VersionRow>(
        `INSERT INTO kyoube_meta.app_versions (app_id, version, manifest, source, created_by_kind, created_by_id, notes) VALUES ($1, 1, $2, $3, $4, $5, $6) RETURNING ${VERSION_COLUMNS}`,
        [app.rows[0]!.id, JSON.stringify(manifest), source, by.kind, by.id, notes],
      );
      return { app: toApp(app.rows[0]!), version: toVersion(version.rows[0]!) };
    }, audit));
  }

  /**
   * Saves a new draft version. It answers with the app row as well as the
   * version: the caller's audit row names the app by id (a slug is reusable
   * once an app is archived), and reading that back afterwards would be both a
   * second round trip and a second point in time.
   */
  async addVersion(companyId: string, slug: string, manifest: AppManifest, source: string, by: { kind: string; id: string | null }, notes: string | null = null, audit?: AuditPlan<AppEdit>): Promise<AppEdit> {
    const app = await this.require(companyId, slug);
    return this.run(() => withMeta(this.pool, async (client) => {
      // The gallery's name, description and icon are *not* written here
      // (published metadata only). This manifest belongs to a draft, and the
      // app row is what every viewer sees — including the ones who cannot see
      // drafts at all. `setCurrent` copies them across when the version
      // carrying them is published.
      const bumped = await client.query<AppRow>(
        `UPDATE kyoube_meta.apps SET latest_version = latest_version + 1, updated_at = now() WHERE id = $1 RETURNING ${APP_COLUMNS}`,
        [app.id],
      );
      const version = await client.query<VersionRow>(
        `INSERT INTO kyoube_meta.app_versions (app_id, version, manifest, source, created_by_kind, created_by_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${VERSION_COLUMNS}`,
        [app.id, bumped.rows[0]!.latest_version, JSON.stringify(manifest), source, by.kind, by.id, notes],
      );
      return { app: toApp(bumped.rows[0]!), version: toVersion(version.rows[0]!) };
    }, audit));
  }

  /**
   * Publishes `version`: the app row points at it, goes live, and takes the
   * gallery metadata *from that version's manifest*. Publishing is the only
   * thing that changes what a viewer sees, so it is the only thing that
   * renames an app — and a rollback, which lands here too, carries the older
   * name, description and icon back with the version it restores.
   *
   * `taskAgents`, when given, is the version's template → agent id mapping (null clears it). It is
   * written in the same transaction, so a version never becomes current without the agents a person
   * confirmed for it: a failed write rolls the whole publish back.
   */
  async setCurrent(companyId: string, slug: string, version: number, audit?: AuditPlan<AppRecord>, taskAgents?: Record<string, string> | null): Promise<AppRecord> {
    const app = await this.require(companyId, slug);
    return this.run(() => withMeta(this.pool, async (client) => {
      const target = await client.query<{ manifest: AppManifest }>("SELECT manifest FROM kyoube_meta.app_versions WHERE app_id = $1 AND version = $2", [app.id, version]);
      const manifest = target.rows[0]?.manifest;
      if (!manifest) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
      if (taskAgents !== undefined) {
        await client.query("UPDATE kyoube_meta.app_versions SET task_agents = $3::jsonb WHERE app_id = $1 AND version = $2", [app.id, version, taskAgents === null ? null : JSON.stringify(taskAgents)]);
      }
      const result = await client.query<AppRow>(
        `UPDATE kyoube_meta.apps SET current_version = $2, status = 'published', name = $3, description = $4, icon = $5, updated_at = now() WHERE id = $1 RETURNING ${APP_COLUMNS}`,
        [app.id, version, manifest.name, manifest.description, manifest.icon],
      );
      return toApp(result.rows[0]!);
    }, audit));
  }

  async setStatus(companyId: string, slug: string, status: AppRecord["status"], audit?: AuditPlan<AppRecord>): Promise<AppRecord> {
    const app = await this.require(companyId, slug);
    return this.run(() => withMeta(this.pool, async (client) => {
      const result = await client.query<AppRow>(`UPDATE kyoube_meta.apps SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${APP_COLUMNS}`, [app.id, status]);
      return toApp(result.rows[0]!);
    }, audit));
  }

  /** The live app behind `slug`, or the not_found every by-slug change gives. */
  async require(companyId: string, slug: string): Promise<AppRecord> {
    const app = await this.get(companyId, slug);
    if (!app) throw new DataError("not_found", `app "${slug}" not found`);
    return app;
  }
}
