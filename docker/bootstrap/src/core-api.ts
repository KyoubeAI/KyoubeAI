import type { InstalledAdapterInfo } from "./adapters.js";

export interface HealthInfo {
  status: string;
  /**
   * Only present on the full (board-authenticated, or non-`authenticated`
   * deployment mode) `/api/health` payload. An anonymous probe against an
   * `authenticated` instance — which is what `kyoube doctor` makes — gets the
   * redacted body, which carries `commit` but no `version`.
   */
  version?: string;
  /** Build commit SHA of the running core server; present on both payloads. */
  commit?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
  bootstrapStatus?: string;
}

export interface InstalledPlugin {
  id: string;
  pluginKey: string;
  version: string;
  status: string;
  packagePath: string | null;
}

export interface CliAuthChallenge {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

export type CliAuthStatus = "pending" | "approved" | "cancelled" | "expired";

export interface CompanySummary {
  id: string;
  name: string;
}

/** One entry of a company's skill library (`GET /api/companies/:id/skills`), reduced to what `kyoube` checks. */
export interface CompanySkill {
  slug: string;
  key: string;
  name: string;
}

/** One agent from `GET /api/companies/:companyId/agents`, reduced to what `kyoube` checks. */
export interface AgentSummary {
  id: string;
  name: string;
  adapterType: string;
  status: string;
}

/** One active person in a company (`GET /api/companies/:companyId/members`), the role lower-cased. */
export interface CompanyMember {
  userId: string;
  role: string | null;
}

/** What the `skills.install` route answers: the host's resolution status for each managed skill. */
export interface SkillInstallResult {
  data: { status: string };
  apps: { status: string };
}

export interface CoreClient {
  apiBase: string;
  getHealth(): Promise<HealthInfo>;
  waitForHealth(opts?: { timeoutMs?: number; intervalMs?: number }): Promise<HealthInfo>;
  listPlugins(): Promise<InstalledPlugin[]>;
  /** `GET /api/companies` — every company the key may see (all of them for an instance-admin board key). */
  listCompanies(): Promise<CompanySummary[]>;
  /** `GET /api/companies/:companyId/skills` — the company's skill library. */
  listCompanySkills(companyId: string): Promise<CompanySkill[]>;
  /** `GET /api/companies/:companyId/agents` — the company's agents (an instance-admin board key sees them all). */
  listAgents(companyId: string): Promise<AgentSummary[]>;
  /** `GET /api/companies/:companyId/members` — the company's active people; agents and inactive memberships are left out. */
  listMembers(companyId: string): Promise<CompanyMember[]>;
  /**
   * `POST /api/plugins/kyoube.apps/api/skills/install` — asks the `kyoube.apps`
   * worker to import its two managed skills into one company's library. A
   * board-only plugin route: the request itself is the company-scoped
   * invocation the host demands for that import.
   */
  installPluginSkills(companyId: string): Promise<SkillInstallResult>;
  installLocalPlugin(localPath: string): Promise<InstalledPlugin>;
  /**
   * `POST /api/plugins/:pluginId/upgrade`. Upstream re-reads the stored
   * `packagePath` from disk, so no body is needed for a local-path plugin
   * whose bundle directory already holds the new version.
   */
  upgradePlugin(pluginId: string): Promise<InstalledPlugin>;
  /**
   * `DELETE /api/plugins/:pluginId`. Soft delete by default (30-day retention,
   * the row is reactivated by a later install); `purge` hard-deletes the row
   * and all plugin-scoped data.
   */
  uninstallPlugin(pluginId: string, opts?: { purge?: boolean }): Promise<void>;
  createCliAuthChallenge(input: { command: string; clientName: string }): Promise<CliAuthChallenge>;
  getCliAuthChallengeStatus(pollPath: string, token: string): Promise<CliAuthStatus>;
  whoAmI(token: string): Promise<{ userId: string | null }>;
  /** `PUT /api/admin/users/:userId/company-access` — the companies the user belongs to; `[]` archives every membership. */
  setUserCompanyAccess(userId: string, companyIds: string[]): Promise<void>;
  /** `POST /api/admin/users/:userId/demote-instance-admin`. */
  demoteInstanceAdmin(userId: string): Promise<void>;
  /** `GET /api/adapters` — lists all registered built-in and external adapters. */
  listAdapters?(): Promise<InstalledAdapterInfo[]>;
  /** `POST /api/adapters/install` with `isLocalPath` — registers, or re-registers, a local external adapter package. */
  installLocalAdapter?(localPath: string): Promise<InstalledAdapterInfo>;
}

export class CoreApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** `METHOD /path` of the refused request, so a message can say which call a core update broke. */
  readonly route: string;
  constructor(status: number, body: unknown, message: string, route = "") {
    super(message);
    this.name = "CoreApiError";
    this.status = status;
    this.body = body;
    this.route = route;
  }
}

export interface CoreClientOptions {
  apiBase: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type JsonRequest = <T>(path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<T>;

/**
 * The one HTTP helper every `kyoube` client shares: JSON in and out, the board
 * key as a bearer token, and a `CoreApiError` naming the route for any non-2xx.
 */
export function createJsonRequest(opts: Pick<CoreClientOptions, "apiBase" | "apiKey" | "fetchImpl">): JsonRequest {
  const apiBase = opts.apiBase.trim().replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async <T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    const token = init.token ?? opts.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const body: unknown = text ? safeJson(text) : null;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `KyoubeAI API request failed: ${response.status} ${method} ${path}`;
      throw new CoreApiError(response.status, body, message, `${method} ${path}`);
    }
    return body as T;
  };
}

function toInstalledPlugin(raw: unknown): InstalledPlugin {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? ""),
    pluginKey: String(record.pluginKey ?? ""),
    version: String(record.version ?? ""),
    status: String(record.status ?? ""),
    packagePath: typeof record.packagePath === "string" ? record.packagePath : null,
  };
}

export function createCoreClient(opts: CoreClientOptions): CoreClient {
  const apiBase = opts.apiBase.trim().replace(/\/+$/, "");
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const request = createJsonRequest(opts);

  return {
    apiBase,
    getHealth: () => request<HealthInfo>("/api/health"),
    async waitForHealth({ timeoutMs = 180_000, intervalMs = 1000 } = {}) {
      const deadline = now() + timeoutMs;
      let lastError: unknown = null;
      while (now() < deadline) {
        try {
          return await request<HealthInfo>("/api/health");
        } catch (error) {
          lastError = error;
          await sleep(intervalMs);
        }
      }
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`KyoubeAI at ${apiBase} did not become healthy within ${timeoutMs}ms (${reason})`);
    },
    async listCompanies() {
      const raw = await request<unknown>("/api/companies");
      // Upstream answers with a bare array today; tolerate an envelope so a
      // future `{ companies: [...] }` does not read as "no companies".
      const rows = Array.isArray(raw) ? raw : ((raw as { companies?: unknown[] } | null)?.companies ?? []);
      return rows.map((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        return { id: String(record.id ?? ""), name: String(record.name ?? "") };
      });
    },
    async listCompanySkills(companyId) {
      const raw = await request<unknown>(`/api/companies/${encodeURIComponent(companyId)}/skills`);
      const rows = Array.isArray(raw) ? raw : ((raw as { skills?: unknown[] } | null)?.skills ?? []);
      return rows.map((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        return { slug: String(record.slug ?? ""), key: String(record.key ?? ""), name: String(record.name ?? "") };
      });
    },
    async listAgents(companyId) {
      const raw = await request<unknown>(`/api/companies/${encodeURIComponent(companyId)}/agents`);
      const rows = Array.isArray(raw) ? raw : ((raw as { agents?: unknown[] } | null)?.agents ?? []);
      return rows.map((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        return {
          id: String(record.id ?? ""),
          name: String(record.name ?? ""),
          adapterType: String(record.adapterType ?? ""),
          status: String(record.status ?? ""),
        };
      });
    },
    async listMembers(companyId) {
      const raw = await request<unknown>(`/api/companies/${encodeURIComponent(companyId)}/members`);
      // Upstream answers `{ members: [...] }`; take a bare array too, as scripts/smoke.sh does (`.members // .`).
      const rows = Array.isArray(raw) ? raw : ((raw as { members?: unknown[] } | null)?.members ?? []);
      return rows.flatMap((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        if (record.principalType !== "user" || record.status !== "active" || typeof record.principalId !== "string") return [];
        return [{ userId: record.principalId, role: typeof record.membershipRole === "string" ? record.membershipRole.toLowerCase() : null }];
      });
    },
    async installPluginSkills(companyId) {
      const raw = await request<{ data?: { status?: unknown }; apps?: { status?: unknown } } | null>(
        "/api/plugins/kyoube.apps/api/skills/install",
        { method: "POST", body: { companyId } },
      );
      return { data: { status: String(raw?.data?.status ?? "") }, apps: { status: String(raw?.apps?.status ?? "") } };
    },
    async listPlugins() {
      const rows = await request<unknown[]>("/api/plugins");
      return rows.map(toInstalledPlugin);
    },
    async installLocalPlugin(localPath) {
      const raw = await request<unknown>("/api/plugins/install", {
        method: "POST",
        body: { packageName: localPath, isLocalPath: true },
      });
      return toInstalledPlugin(raw);
    },
    async upgradePlugin(pluginId) {
      const raw = await request<unknown>(`/api/plugins/${encodeURIComponent(pluginId)}/upgrade`, {
        method: "POST",
        // The route reads an optional `{ version?: string }`; omitting `version`
        // means "whatever the package path now declares".
        body: {},
      });
      return toInstalledPlugin(raw);
    },
    async uninstallPlugin(pluginId, opts = {}) {
      const query = opts.purge ? "?purge=true" : "";
      await request<unknown>(`/api/plugins/${encodeURIComponent(pluginId)}${query}`, { method: "DELETE" });
    },
    async setUserCompanyAccess(userId, companyIds) {
      await request(`/api/admin/users/${encodeURIComponent(userId)}/company-access`, { method: "PUT", body: { companyIds } });
    },
    async demoteInstanceAdmin(userId) {
      await request(`/api/admin/users/${encodeURIComponent(userId)}/demote-instance-admin`, { method: "POST" });
    },
    createCliAuthChallenge: (input) =>
      request<CliAuthChallenge>("/api/cli-auth/challenges", {
        method: "POST",
        body: { command: input.command, clientName: input.clientName, requestedAccess: "instance_admin_required", requestedCompanyId: null },
      }),
    async getCliAuthChallengeStatus(pollPath, token) {
      const result = await request<{ status: CliAuthStatus }>(`/api${pollPath}?token=${encodeURIComponent(token)}`);
      return result.status;
    },
    async whoAmI(token) {
      const me = await request<{ userId?: string; user?: { id?: string } | null }>("/api/cli-auth/me", { token });
      return { userId: me.userId ?? me.user?.id ?? null };
    },
    async listAdapters() {
      const rows = await request<unknown[]>("/api/adapters");
      return (Array.isArray(rows) ? rows : []).map((row) => {
        const record = (row ?? {}) as Record<string, unknown>;
        return {
          type: String(record.type ?? ""),
          packageName: typeof record.packageName === "string" ? record.packageName : undefined,
          version: typeof record.version === "string" ? record.version : undefined,
          isLocalPath: record.isLocalPath === true,
          source: typeof record.source === "string" ? record.source : undefined,
          disabled: typeof record.disabled === "boolean" ? record.disabled : undefined,
        };
      });
    },
    async installLocalAdapter(localPath) {
      const raw = await request<Record<string, unknown>>("/api/adapters/install", {
        method: "POST",
        body: { packageName: localPath, isLocalPath: true },
      });
      return {
        type: String(raw?.type ?? ""),
        packageName: typeof raw?.packageName === "string" ? raw.packageName : undefined,
        version: typeof raw?.version === "string" ? raw.version : undefined,
        isLocalPath: true,
      };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
