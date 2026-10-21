import { CoreApiError, createCoreClient, createJsonRequest, type CompanySummary, type CoreClientOptions } from "../core-api.js";
import type { Governance } from "./governance.js";

export interface AgentRef {
  id: string;
  name: string;
  status: string;
  /** The agent's metadata, where the ask level is copied (ask-levels.ts). Null when it has none. */
  metadata?: Record<string, unknown> | null;
}

/** `GET /api/agents/:id/instructions-bundle`, reduced to what decides whether KyoubeAI may edit the entry file. */
export interface InstructionsBundle {
  mode: string | null;
  entryFile: string;
  /** Whether the bundle's file list holds the entry file; a bundle without one is skipped, never created. */
  hasEntryFile: boolean;
  editable: boolean;
  legacyPromptTemplateActive: boolean;
}

/**
 * An instructions entry file as read, with the revision it was read at. Since core 2026.1005 a
 * write must name that revision (`baseRevisionId`; null for an entry with no revision yet), and
 * the core refuses it (409) when the file changed in between.
 */
export interface InstructionsFile {
  content: string;
  revisionId: string | null;
}

/** What `kyoube.agent-rules`'s reconcile route answers (plugins/kyoube-agent-rules/src/guard.ts), read defensively. */
export interface GuardReport {
  managers: string[];
  updated: string[];
  skipped: Array<{ agentId: string; name: string; reason: string }>;
  failures: Array<{ agentId: string; name: string; step: string; error: string }>;
  selfTest: { status: "pass" | "fail" | "not_applicable"; detail: string };
}

export interface GuardRevertReport {
  reverted: string[];
  failures: GuardReport["failures"];
}

export const GUARD_PLUGIN_ROUTES = {
  reconcile: "/api/plugins/kyoube.agent-rules/api/reconcile",
  revert: "/api/plugins/kyoube.agent-rules/api/revert",
} as const;

/** What `kyoube.agent-rules`'s groups/apply route answers, read defensively. */
export interface GroupsApplyReport {
  protected: string[];
  unprotected: string[];
  people: string[];
  skipped: Array<{ id: string; reason: string }>;
  failures: Array<{ id: string; step: string; error: string }>;
}

export const GROUP_ROUTES = {
  access: "/api/plugins/kyoube.apps/api/groups/agent-access",
  report: "/api/plugins/kyoube.apps/api/groups/sync-report",
  apply: "/api/plugins/kyoube.agent-rules/api/groups/apply",
} as const;

/** kyoube.studio keeps the ask levels people set on agent profiles (docs/agent-rules.md, "Agent questions"). */
export const STUDIO_ROUTES = {
  askLevels: "/api/plugins/kyoube.studio/api/ask-levels",
} as const;

/** Everything `kyoube agent-rules` asks of the core, all through its REST API with the board key. */
export interface RulesApi {
  listCompanies(): Promise<CompanySummary[]>;
  listAgents(companyId: string): Promise<AgentRef[]>;
  getGovernance(companyId: string): Promise<Governance>;
  setGovernance(companyId: string, governance: Governance): Promise<void>;
  getInstructionsBundle(agentId: string): Promise<InstructionsBundle>;
  readInstructionsFile(agentId: string, path: string): Promise<InstructionsFile>;
  writeInstructionsFile(agentId: string, path: string, content: string, baseRevisionId: string | null): Promise<void>;
  reconcileGuard(companyId: string): Promise<GuardReport>;
  revertGuard(companyId: string): Promise<GuardRevertReport>;
  getAgentAccess(companyId: string): Promise<Array<{ agentId: string; allowedUserIds: string[] }>>;
  applyGroups(companyId: string, agents: Array<{ agentId: string; allowedUserIds: string[] }>): Promise<GroupsApplyReport>;
  reportGroupSync(companyId: string, report: { syncedAt: string; error: string | null }): Promise<void>;
  /** kyoube.studio's map of agent id to "none" or "any"; an agent not in it is at "its line". Strict: an unreadable map throws. */
  getAskLevels(companyId: string): Promise<Record<string, "none" | "any">>;
  /** `PATCH /api/agents/:id` with the whole metadata object, which the core stores as given. */
  updateAgentMetadata(agentId: string, metadata: Record<string, unknown>): Promise<void>;
  /**
   * False while the core answers the plugin's routes 503, right after a start before its worker
   * runs, or 404 `Plugin not found`, before `ensure-plugins` has installed it (the first start after an update).
   */
  pluginReady(): Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null).map(record) : [];
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function failures(value: unknown): GuardReport["failures"] {
  return records(value).map((item) => ({ agentId: text(item.agentId), name: text(item.name), step: text(item.step), error: text(item.error) }));
}

export function parseGuardReport(raw: unknown): GuardReport {
  const body = record(raw);
  const selfTest = record(body.selfTest);
  const status = selfTest.status === "pass" || selfTest.status === "fail" ? selfTest.status : "not_applicable";
  return {
    managers: strings(body.managers),
    updated: strings(body.updated),
    skipped: records(body.skipped).map((item) => ({ agentId: text(item.agentId), name: text(item.name), reason: text(item.reason) })),
    failures: failures(body.failures),
    selfTest: { status, detail: text(selfTest.detail) },
  };
}

export function parseGroupsReport(raw: unknown): GroupsApplyReport {
  const body = record(raw);
  return {
    protected: strings(body.protected),
    unprotected: strings(body.unprotected),
    people: strings(body.people),
    skipped: records(body.skipped).map((item) => ({ id: text(item.id), reason: text(item.reason) })),
    failures: records(body.failures).map((item) => ({ id: text(item.id), step: text(item.step), error: text(item.error) })),
  };
}

export function parseRevertReport(raw: unknown): GuardRevertReport {
  const body = record(raw);
  return { reverted: strings(body.reverted), failures: failures(body.failures) };
}

/**
 * `rulesToken` is the kyoube CLI's rules token (key-store.ts, ruling R18). It goes in the body of
 * every call to the agent-rules and group routes, never in a URL, and is never logged.
 */
export function createRulesApi(opts: CoreClientOptions, rulesToken: string): RulesApi {
  const core = createCoreClient(opts);
  const request = createJsonRequest(opts);
  const id = encodeURIComponent;
  return {
    listCompanies: () => core.listCompanies(),
    async listAgents(companyId) {
      const raw = await request<unknown>(`/api/companies/${id(companyId)}/agents`);
      return records(Array.isArray(raw) ? raw : record(raw).agents).map((row) => {
        const metadata = row.metadata;
        return {
          id: text(row.id),
          name: text(row.name),
          status: text(row.status),
          metadata: typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null,
        };
      });
    },
    async getGovernance(companyId) {
      const company = record(await request<unknown>(`/api/companies/${id(companyId)}`));
      if (typeof company.id !== "string") throw new Error(`the core returned no company for ${companyId}`);
      const governance = company.interactionResolverGovernance;
      if (governance !== null && governance !== undefined && typeof governance !== "object") {
        throw new Error(`the core returned an unreadable interactionResolverGovernance for ${companyId}`);
      }
      if (governance !== null && governance !== undefined && Array.isArray(governance)) {
        throw new Error(`the core returned an unreadable interactionResolverGovernance for ${companyId}`);
      }
      return governance === null || governance === undefined ? {} : (record(governance) as Governance);
    },
    async setGovernance(companyId, governance) {
      await request<unknown>(`/api/companies/${id(companyId)}`, { method: "PATCH", body: { interactionResolverGovernance: governance } });
    },
    async getInstructionsBundle(agentId) {
      const raw = record(await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle`));
      const entryFile = typeof raw.entryFile === "string" && raw.entryFile.length > 0 ? raw.entryFile : "AGENTS.md";
      return {
        mode: typeof raw.mode === "string" ? raw.mode : null,
        entryFile,
        hasEntryFile: records(raw.files).some((file) => file.path === entryFile),
        editable: raw.editable === true,
        legacyPromptTemplateActive: raw.legacyPromptTemplateActive === true,
      };
    },
    async readInstructionsFile(agentId, path) {
      const raw = record(await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle/file?path=${id(path)}`));
      // Never treat a missing body as an empty file: the next step would write
      // the block over whatever the agent's instructions really hold.
      if (typeof raw.content !== "string") throw new Error(`the core returned no content for ${path}`);
      const revisionId = record(raw.revision).id;
      return { content: raw.content, revisionId: typeof revisionId === "string" && revisionId.length > 0 ? revisionId : null };
    },
    async writeInstructionsFile(agentId, path, content, baseRevisionId) {
      await request<unknown>(`/api/agents/${id(agentId)}/instructions-bundle/file`, { method: "PUT", body: { path, content, baseRevisionId } });
    },
    async reconcileGuard(companyId) {
      return parseGuardReport(await request<unknown>(GUARD_PLUGIN_ROUTES.reconcile, { method: "POST", body: { companyId, rulesToken } }));
    },
    async revertGuard(companyId) {
      return parseRevertReport(await request<unknown>(GUARD_PLUGIN_ROUTES.revert, { method: "POST", body: { companyId, rulesToken } }));
    },
    async getAgentAccess(companyId) {
      // Strict on purpose: an unreadable list applied as "no groups" would lift every restriction.
      const raw: unknown = await request<unknown>(GROUP_ROUTES.access, { method: "POST", body: { companyId, rulesToken } });
      const unreadable = (why: string) => new Error(`kyoube.apps returned an unreadable agent-access list: ${why}`);
      const agents = record(raw).agents;
      if (!Array.isArray(agents)) throw unreadable("no agents array");
      return agents.map((entry: unknown) => {
        const item = record(entry);
        if (typeof item.agentId !== "string" || item.agentId.length === 0) throw unreadable("an entry has no agentId");
        const allowed = item.allowedUserIds;
        if (!Array.isArray(allowed) || !allowed.every((user) => typeof user === "string")) throw unreadable(`allowedUserIds of ${item.agentId} is not a list of strings`);
        return { agentId: item.agentId, allowedUserIds: allowed as string[] };
      });
    },
    async applyGroups(companyId, agents) {
      return parseGroupsReport(await request<unknown>(GROUP_ROUTES.apply, { method: "POST", body: { companyId, agents, rulesToken } }));
    },
    async reportGroupSync(companyId, report) {
      await request<unknown>(GROUP_ROUTES.report, { method: "POST", body: { companyId, ...report, rulesToken } });
    },
    async getAskLevels(companyId) {
      // Strict, like the agent-access read: an unreadable map applied as "no levels" would put
      // every agent back at its line.
      const raw: unknown = await request<unknown>(STUDIO_ROUTES.askLevels, { method: "POST", body: { companyId, rulesToken } });
      const unreadable = (why: string) => new Error(`kyoube.studio returned an unreadable ask-level map: ${why}`);
      const levels = record(raw).levels;
      if (typeof levels !== "object" || levels === null || Array.isArray(levels)) throw unreadable("no levels object");
      const out: Record<string, "none" | "any"> = {};
      for (const [agentId, level] of Object.entries(levels as Record<string, unknown>)) {
        if (level !== "none" && level !== "any") throw unreadable(`${agentId} has level ${JSON.stringify(level)}`);
        out[agentId] = level;
      }
      return out;
    },
    async updateAgentMetadata(agentId, metadata) {
      await request<unknown>(`/api/agents/${id(agentId)}`, { method: "PATCH", body: { metadata } });
    },
    async pluginReady() {
      // The route takes POST only. The core checks the plugin's status and
      // worker before it matches a route, so a GET answers 503 until the worker
      // runs and 404 after, and never reaches the worker. A plugin not installed
      // yet answers 404 `Plugin not found`. Anything else is left for the pass
      // to report.
      try {
        await request<unknown>(GUARD_PLUGIN_ROUTES.reconcile);
        return true;
      } catch (error) {
        if (!(error instanceof CoreApiError)) return true;
        return !(error.status === 503 || (error.status === 404 && error.message === "Plugin not found"));
      }
    },
  };
}
