import { compileCompanyPolicy, parseMode, restrictedPeople, type CompileGroup, type VisibilityMode } from "@kyoube/visibility";
import type { Pool } from "pg";
import { z } from "zod";
import { withMeta, type AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import type { DataActor } from "../data/permissions.js";
import type { MutationEvent } from "../data/service.js";
import { ensureCompany, schemaNameFor } from "../db/company-scope.js";
import { isManagerRole, parseGroupLevel, type GroupLevel } from "./levels.js";
import type { LicenceGate } from "./licence.js";
import { GroupStore, type AgentAccess, type GroupInput, type GroupRecord, type SyncReport } from "./store.js";

export const MAX_GROUPS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = z.array(z.string().min(1).max(200)).max(5000).transform((list) => [...new Set(list)].sort());
const body = z.object({
  id: z.string().regex(UUID).optional(),
  name: z.string().transform((name) => name.trim()).pipe(z.string().min(1).max(80)),
  dataLevel: z.unknown().optional(),
  members: ids,
  agents: ids,
  apps: z.array(z.string().regex(UUID, "apps must be app ids")).max(5000).transform((list) => [...new Set(list.map((id) => id.toLowerCase()))].sort()),
  seesAll: z.boolean().optional().default(false),
  projects: ids.optional().default([]),
});

/**
 * What the Groups page shows of a company's visibility, ids and roles only. `seesAll` and
 * `restricted` always come from a need-to-know compile of the current groups, whatever the mode:
 * in an open company they are who would see everything and who would be restricted on switching
 * (what the switch's confirmation lists); in a need-to-know company, who does and who is.
 */
export interface VisibilitySummary { mode: VisibilityMode; seesAll: string[]; restricted: Array<{ userId: string; role: string | null }> }

export interface GroupServiceDeps {
  pool: Pool;
  resolveUserRole: (companyId: string, userId: string, fresh: boolean) => Promise<string | null>;
  licence: LicenceGate;
  /** Every project of the company, from the core: a group may only include these. */
  listProjectIds: (companyId: string) => Promise<Set<string>>;
  /** The company's active people, roles lower-cased. */
  listMembers: (companyId: string) => Promise<Array<{ userId: string; role: string | null }>>;
  /** Rewrites the policy files the core reads; runs after every committed change to groups or the mode. */
  afterVisibilityChange?: (companyId: string) => Promise<void>;
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
}

export class GroupService {
  private readonly store: GroupStore;

  constructor(private readonly deps: GroupServiceDeps) {
    this.store = new GroupStore(deps.pool);
  }

  async list(companyId: string, actor: DataActor): Promise<{ unlocked: boolean; groups: GroupRecord[]; sync: SyncReport | null; visibility: VisibilitySummary }> {
    await this.assertManager(companyId, actor);
    const [unlocked, groups, sync, mode] = await Promise.all([
      this.deps.licence.unlocked(), this.store.list(companyId), this.store.getSync(companyId), this.store.getMode(companyId),
    ]);
    return { unlocked, groups, sync, visibility: await this.summarise(companyId, mode, groups) };
  }

  async save(companyId: string, actor: DataActor, raw: unknown): Promise<GroupRecord> {
    await this.assertManager(companyId, actor);
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "group"} ${issue.message}`).join("; "));
    const input: GroupInput = {
      name: parsed.data.name, dataLevel: parseGroupLevel(parsed.data.dataLevel), members: parsed.data.members, agents: parsed.data.agents, apps: parsed.data.apps,
      seesAll: parsed.data.seesAll, projects: parsed.data.projects,
    };
    if (!(await this.deps.licence.unlocked())) throw new DataError("disabled", "managing groups needs a KyoubeAI licence; existing groups are still enforced and can be deleted");
    await ensureCompany(this.deps.pool, companyId);
    await this.assertOwnApps(companyId, input.apps);
    await this.assertOwnProjects(companyId, input.projects);
    const id = parsed.data.id;
    if (!id && (await this.store.count(companyId)) >= MAX_GROUPS) throw new DataError("limit", `a company can have at most ${MAX_GROUPS} groups`);
    const saved = await withMeta(this.deps.pool, async (client) => {
      if (!id) return this.store.create(client, companyId, input);
      const replaced = await this.store.replace(client, companyId, id, input);
      if (!replaced) throw new DataError("not_found", "no such group");
      return replaced;
    }, (group) => this.entry(companyId, actor, id ? "group_update" : "group_create", group));
    await this.notify(companyId, actor, id ? "group_update" : "group_create", saved.id, `${id ? "updated" : "created"} a group`);
    await this.visibilityChanged(companyId, actor);
    return saved;
  }

  /** Allowed without a licence: deleting can only lift restrictions, and must never be blocked. */
  async remove(companyId: string, actor: DataActor, id: string): Promise<{ deleted: GroupRecord }> {
    await this.assertManager(companyId, actor);
    if (!UUID.test(id)) throw new DataError("invalid", "id must be a group id");
    const deleted = await withMeta(this.deps.pool, async (client) => {
      const removed = await this.store.remove(client, companyId, id);
      if (!removed) throw new DataError("not_found", "no such group");
      return removed;
    }, (group) => this.entry(companyId, actor, "group_delete", group));
    await this.notify(companyId, actor, "group_delete", deleted.id, "deleted a group");
    await this.visibilityChanged(companyId, actor);
    return { deleted };
  }

  /** Switching to need-to-know needs a licence; switching back to open never does, as deleting a group never does. */
  async setVisibilityMode(companyId: string, actor: DataActor, raw: unknown): Promise<VisibilitySummary> {
    await this.assertManager(companyId, actor);
    const mode = parseMode(raw);
    if (mode === null) throw new DataError("invalid", "mode must be open or need_to_know");
    if (mode === "need_to_know" && !(await this.deps.licence.unlocked())) {
      throw new DataError("disabled", "switching to need-to-know needs a KyoubeAI licence; switching back to open never does");
    }
    await ensureCompany(this.deps.pool, companyId);
    const summary = await this.summarise(companyId, mode, (await this.store.visibilityInput(companyId)).groups);
    // The audit row records who is restricted after the change: nobody, once the company is open.
    const restricted = mode === "need_to_know" ? summary.restricted.map((person) => person.userId) : [];
    await withMeta(this.deps.pool, (client) => this.store.setMode(client, companyId, mode),
      () => ({ companyId, actor, operation: "visibility_mode", table: null, details: { mode, restricted } }));
    await this.notify(companyId, actor, "visibility_mode", null, `set visibility to ${mode}`);
    await this.visibilityChanged(companyId, actor);
    return summary;
  }

  levelsForUser(companyId: string, userId: string): Promise<GroupLevel[]> {
    return this.store.levelsForUser(companyId, userId);
  }

  async hiddenApps(companyId: string, userId: string): Promise<Set<string>> {
    if (isManagerRole(await this.deps.resolveUserRole(companyId, userId, false))) return new Set();
    return this.store.hiddenAppIds(companyId, userId);
  }

  async agentAccess(companyId: string, keep: { userIds: Set<string>; agentIds: Set<string> }): Promise<AgentAccess[]> {
    schemaNameFor(companyId);
    // An empty user listing is never believed: a failed or odd host listing must not wipe membership.
    // An empty agent listing is real (a company with no agents), so agents are still pruned.
    let userIds = keep.userIds;
    if (userIds.size === 0) userIds = new Set((await this.store.list(companyId)).flatMap((group) => group.members));
    await this.store.prune(companyId, { userIds, agentIds: keep.agentIds });
    return this.store.agentAccess(companyId);
  }

  async recordSync(companyId: string, report: SyncReport): Promise<void> {
    schemaNameFor(companyId);
    await ensureCompany(this.deps.pool, companyId);
    await this.store.setSync(companyId, report);
  }

  /**
   * Who sees everything and who is held back under need-to-know, decided as the core decides it,
   * over a policy compiled in memory from these groups (see VisibilitySummary).
   */
  private async summarise(companyId: string, mode: VisibilityMode, groups: CompileGroup[]): Promise<VisibilitySummary> {
    // A need-to-know compile always yields a policy; only an open one is null.
    const policy = compileCompanyPolicy({ companyId, mode: "need_to_know", groups, writtenAt: new Date().toISOString() })!;
    return { mode, seesAll: policy.seesAll, restricted: restrictedPeople({ state: "need_to_know", policy }, await this.deps.listMembers(companyId)) };
  }

  /** Project ids live in the core, so only its listing proves a project is this company's. */
  private async assertOwnProjects(companyId: string, projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    const own = await this.deps.listProjectIds(companyId);
    if (!projectIds.every((projectId) => own.has(projectId))) throw new DataError("invalid", "projects must be this company's projects");
  }

  /** The store's FK only proves an app exists, not that it is this company's. */
  private async assertOwnApps(companyId: string, appIds: string[]): Promise<void> {
    if (appIds.length === 0) return;
    const found = await this.deps.pool.query<{ id: string }>("SELECT id FROM kyoube_meta.apps WHERE company_id = $1 AND id = ANY($2::uuid[])", [companyId, appIds]);
    if (found.rows.length !== appIds.length) throw new DataError("invalid", "apps must be this company's apps");
  }

  private async assertManager(companyId: string, actor: DataActor): Promise<void> {
    schemaNameFor(companyId);
    if (actor.kind !== "user" || !actor.id) throw new DataError("forbidden", "only company owners and admins manage groups");
    if (!isManagerRole(await this.deps.resolveUserRole(companyId, actor.id, true))) throw new DataError("forbidden", "only company owners and admins manage groups");
  }

  private entry(companyId: string, actor: DataActor, operation: string, group: GroupRecord): AuditEntry {
    // Ids only: a group's name can name people ("Alice's team"), and audit rows never carry them.
    return {
      companyId, actor, operation, table: null,
      details: { groupId: group.id, dataLevel: group.dataLevel, members: group.members, agents: group.agents, apps: group.apps, seesAll: group.seesAll, projects: group.projects },
    };
  }

  private async notify(companyId: string, actor: DataActor, operation: string, entityId: string | null, summary: string): Promise<void> {
    if (!this.deps.onMutation) return;
    const event: MutationEvent = { companyId, actor, operation, table: null, entityId, summary };
    try { await this.deps.onMutation(event); } catch (error) { this.deps.onMutationError?.(error, event); }
  }

  /** The change already committed, so a failed policy write is reported, never thrown at the caller; the job writes again within five minutes. */
  private async visibilityChanged(companyId: string, actor: DataActor): Promise<void> {
    if (!this.deps.afterVisibilityChange) return;
    try {
      await this.deps.afterVisibilityChange(companyId);
    } catch (error) {
      this.deps.onMutationError?.(error, { companyId, actor, operation: "visibility_write", table: null, entityId: null, summary: "rewrote the visibility policy" });
    }
  }
}