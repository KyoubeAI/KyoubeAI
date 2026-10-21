import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import { applyGroups, parseAccess, parseGroupsRecord, type GroupsPort } from "./groups.js";
import { EMPTY_RECORD, reconcileGuard, revertGuard, type GuardPort, type GuardRecord } from "./guard.js";
import { PLUGIN_ID } from "./manifest.js";
import { rulesTokenMatches, RULES_TOKEN_PATH } from "./rules-token.js";
import type { Grant } from "./policy.js";

type HostGrant = Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"][number];

/** Plugin state key of the per-company record of what the guardrail changed. */
const RECORD_KEY = "guard-record";
/** Plugin state key of the per-company record of what user groups changed (src/groups.ts). */
const GROUPS_RECORD_KEY = "groups-record";

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** The stored record, tolerating a missing or hand-edited value. */
export function parseRecord(value: unknown): GuardRecord {
  if (typeof value !== "object" || value === null) return { ...EMPTY_RECORD };
  const raw = value as Record<string, unknown>;
  const changeGranted = typeof raw.changeGranted === "object" && raw.changeGranted !== null ? raw.changeGranted as Record<string, unknown> : {};
  return {
    protected: ids(raw.protected),
    scoped: ids(raw.scoped),
    broadRemoved: ids(raw.broadRemoved),
    changeGranted: Object.fromEntries(Object.entries(changeGranted).filter(([, keys]) => Array.isArray(keys)).map(([id, keys]) => [id, ids(keys)])),
  };
}

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Whether core's metadata marks an agent as one of its bundled agents, by core's
 * own rule (readBuiltInAgentMarker, server/src/services/built-in-agent-metadata.ts):
 * a non-blank key and a featureKeys list of non-blank strings. Core refuses to add
 * or change a marker it would read, so an agent cannot give itself one and drop
 * out of the top-agent count; a looser check would let it.
 */
function isBuiltIn(metadata: unknown): boolean {
  const marker = plain(plain(metadata)?.paperclipBuiltInAgent);
  if (marker === null || typeof marker.key !== "string" || marker.key.trim() === "") return false;
  const { featureKeys } = marker;
  return Array.isArray(featureKeys) && featureKeys.filter((key) => typeof key === "string" && key.trim() !== "").length === featureKeys.length;
}

/** The guardrail's view of the host, built only from the plugin SDK. */
export function portFromContext(ctx: PluginContext): GuardPort {
  const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: RECORD_KEY });
  return {
    async listAgents(companyId) {
      const rows = await ctx.agents.list({ companyId });
      return rows.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, reportsTo: agent.reportsTo ?? null, builtIn: isBuiltIn(agent.metadata) }));
    },
    async getPolicy(companyId, agentId) {
      const record = await ctx.authorization.policies.get({ companyId, resourceType: "agent", resourceId: agentId });
      return record?.policy ?? null;
    },
    async setPolicy(companyId, agentId, policy) {
      await ctx.authorization.policies.update({ companyId, resourceType: "agent", resourceId: agentId, policy });
    },
    async listGrants(companyId, agentId) {
      const rows = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
      return rows.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
    },
    async setGrants(companyId, agentId, grants: Grant[]) {
      await ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: agentId,
        grants: grants.map((grant) => ({ permissionKey: grant.permissionKey as HostGrant["permissionKey"], scope: grant.scope })),
      });
    },
    async previewAssign(companyId, actorAgentId, assigneeAgentId) {
      const decision = await ctx.authorization.policies.previewAssignment({
        companyId,
        actor: { type: "agent", agentId: actorAgentId, companyId },
        target: { assigneeAgentId },
      });
      return { allowed: decision.allowed, reason: decision.reason };
    },
    async readRecord(companyId) {
      return parseRecord(await ctx.state.get(scope(companyId)));
    },
    async writeRecord(companyId, record) {
      await ctx.state.set(scope(companyId), record);
    },
  };
}

/** The user-groups view of the host: the guard's agent and policy calls, plus people and their grants. */
export function groupsPortFromContext(ctx: PluginContext): GroupsPort {
  const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: GROUPS_RECORD_KEY });
  const guard = portFromContext(ctx);
  return {
    listAgents: guard.listAgents,
    getPolicy: guard.getPolicy,
    setPolicy: guard.setPolicy,
    async listMembers(companyId) {
      // Archived members too: groups forgets a person only once they are gone from this list.
      const rows = await ctx.access.members.list({ companyId, includeArchived: true });
      return rows
        .filter((row) => row.principalType === "user")
        .map((row) => ({ userId: row.principalId, role: row.membershipRole ? row.membershipRole.toLowerCase() : null, status: row.status }));
    },
    async listUserGrants(companyId, userId) {
      const rows = await ctx.authorization.grants.list({ companyId, principalType: "user", principalId: userId });
      return rows.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope ?? null }));
    },
    async setUserGrants(companyId, userId, grants) {
      await ctx.authorization.grants.set({
        companyId,
        principalType: "user",
        principalId: userId,
        grants: grants.map((grant) => ({ permissionKey: grant.permissionKey as HostGrant["permissionKey"], scope: grant.scope })),
      });
    },
    async readGroupsRecord(companyId) {
      return parseGroupsRecord(await ctx.state.get(scope(companyId)));
    },
    async writeGroupsRecord(companyId, record) {
      await ctx.state.set(scope(companyId), record);
    },
  };
}

/** A person's company role (lower case), or null when they are not an active member. */
export type CompanyRoleReader = (companyId: string, userId: string) => Promise<string | null>;

/** Reads the role fresh from the core on every call: no cache, so a demotion applies at once. */
export function companyRoleFromContext(ctx: PluginContext): CompanyRoleReader {
  return async (companyId, userId) => {
    const rows = await ctx.access.members.list({ companyId });
    const row = rows.find((m) => m.principalType === "user" && m.status === "active" && m.principalId === userId);
    return row?.membershipRole ? row.membershipRole.toLowerCase() : null;
  };
}

function isManager(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

export interface AgentRulesPluginDeps {
  /** Tests swap the host adapters for fakes; production adapts `ctx`. */
  port?: (ctx: PluginContext) => GuardPort;
  groupsPort?: (ctx: PluginContext) => GroupsPort;
  /** Where the kyoube CLI's rules token lives; tests point it at a temporary file. */
  rulesTokenPath?: string;
}

export const FORBIDDEN_MESSAGE = "forbidden: the kyoube CLI's rules token or a company owner or admin is required";

export function createAgentRulesPlugin(deps: AgentRulesPluginDeps = {}): PaperclipPlugin {
  const tokenPath = deps.rulesTokenPath ?? RULES_TOKEN_PATH;
  // `onApiRequest` runs outside `setup`, so the port and logger live in this
  // instance's closure, never in a module-level singleton two instances in
  // one process would share.
  let port: GuardPort | null = null;
  let groupsPort: GroupsPort | null = null;
  let roleOf: CompanyRoleReader | null = null;
  let logError: ((message: string, meta?: Record<string, unknown>) => void) | null = null;
  // Serialized per company, so a reconcile and a revert never interleave their reads and writes of the record.
  const lastCall = new Map<string, Promise<unknown>>();
  const serialized = <T>(companyId: string, run: () => Promise<T>): Promise<T> => {
    const result = (lastCall.get(companyId) ?? Promise.resolve()).then(run);
    // A failed call must not break the chain for the next one; its own caller still sees the error.
    lastCall.set(companyId, result.catch(() => undefined));
    return result;
  };

  return definePlugin({
    async setup(ctx: PluginContext) {
      port = (deps.port ?? portFromContext)(ctx);
      groupsPort = (deps.groupsPort ?? groupsPortFromContext)(ctx);
      roleOf = companyRoleFromContext(ctx);
      logError = (message, meta) => ctx.logger.error(message, meta);
      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onApiRequest(input) {
      const guard = port;
      const groups = groupsPort;
      if (!guard || !groups) return { status: 503, body: { error: "plugin not ready" } };
      // Declared `auth: "board"`, which the host enforces before the request
      // reaches this worker; checked again so a mis-declared route could never
      // let an agent loosen its own guardrail.
      if (input.actor.actorType === "agent") return { status: 403, body: { error: "forbidden: board access required", code: "forbidden" } };
      const readRole = roleOf;
      if (!readRole) return { status: 503, body: { error: "plugin not ready" } };
      try {
        // "board" admits every signed-in person. Before any work, the caller must be the kyoube CLI,
        // proven by the rules token in the body (ruling R18), or a company owner or admin, by a fresh
        // read of the core's members list (ruling R13).
        if (!(await rulesTokenMatches(tokenPath, (input.body as { rulesToken?: unknown } | undefined)?.rulesToken))) {
          const userId = input.actor.userId ?? input.actor.actorId;
          if (input.actor.actorType !== "user" || !userId || !isManager(await readRole(input.companyId, userId))) {
            return { status: 403, body: { error: FORBIDDEN_MESSAGE, code: "forbidden" } };
          }
        }
        // Agents user groups restrict: the manager rule never unprotects them.
        const keep = async () => new Set((await groups.readGroupsRecord(input.companyId)).required);
        if (input.routeKey === "guard.reconcile") return { status: 200, body: await serialized(input.companyId, async () => reconcileGuard(guard, input.companyId, await keep())) };
        if (input.routeKey === "guard.revert") return { status: 200, body: await serialized(input.companyId, async () => revertGuard(guard, input.companyId, await keep())) };
        if (input.routeKey === "groups.apply") {
          const access = parseAccess((input.body as { agents?: unknown } | undefined)?.agents);
          if (!access) return { status: 400, body: { error: "agents must be a list of { agentId, allowedUserIds }", code: "invalid" } };
          return { status: 200, body: await serialized(input.companyId, () => applyGroups(groups, input.companyId, access)) };
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logError?.(`${input.routeKey} failed`, { companyId: input.companyId, error: text });
        // Board-only: the caller is the operator's own `kyoube` CLI, which
        // shows this reason in `kyoube doctor`.
        return { status: 500, body: { error: `${input.routeKey} failed: ${text}`, code: "error" } };
      }
      return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
    },

    async onHealth() {
      return port ? { status: "ok", message: `${PLUGIN_ID} ready` } : { status: "degraded", message: `${PLUGIN_ID} not ready` };
    },
  });
}
