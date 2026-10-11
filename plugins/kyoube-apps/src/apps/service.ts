import type { Pool } from "pg";
import type { AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import { coerceValue } from "../data/field-kinds.js";
import type { QuerySpec } from "../data/filter.js";
import { assertLevel, levelAllows, type AccessLevel, type DataActor, type Operation } from "../data/permissions.js";
import { UUID_RE, type Row, type RowTarget } from "../data/records-service.js";
import type { TableInfo } from "../data/schema-service.js";
import type { DataService, MutationEvent } from "../data/service.js";
import { schemaNameFor } from "../db/company-scope.js";
import { QUESTION_KEY_RE, type DecideResult, type Question } from "../decisions/contract.js";
import type { GuardAgentAction, GuardContext, GuardedAction } from "../decisions/guardrail.js";
import type { DecisionService } from "../decisions/service.js";
import { getLoggedDecision, recordOutcome, type Outcome } from "../decisions/store.js";
import type { ConnectionResponse, ConnectionService } from "../connections/service.js";
import type { AppTask, TaskService } from "../tasks/service.js";
import type { AppTaskStore } from "../tasks/store.js";
import { assertAppSource, connectionChanges, connectionsChanged, decisionSetsChanged, taskTemplatesChanged, templateChanges, validateAppManifest, type AppManifest, type TaskInput } from "./manifest.js";
import { AppStore, type AppRecord, type AppVersion } from "./store.js";

/** What a running app is told about itself, its viewer, and the tables it may touch. */
export interface AppContext {
  companyId: string;
  viewer: { id: string | null; name: string; level: AccessLevel };
  app: { slug: string; name: string; version: number };
  tables: string[];
  /** The decision sets this version declares, and whether the company lets apps use them right now. */
  decisions: { available: boolean; sets: string[] };
  /** The connections this version declares, and whether each can be called right now. */
  connections: Array<{ name: string; access: "read" | "read-write"; available: boolean }>;
  /**
   * The task templates this version declares (docs/app-tasks.md), and whether the installation can
   * start tasks. Never the instructions or the agent: those are fixed at publish and stay server-side.
   */
  tasks: { available: boolean; templates: Array<{ key: string; table: string | null; inputs: Record<string, TaskInput>; writes: string[] }> };
}

export type RuntimeMethod = "query" | "get" | "count" | "describe" | "insert" | "update" | "delete";
export const RUNTIME_METHODS: readonly RuntimeMethod[] = ["query", "get", "count", "describe", "insert", "update", "delete"];
const WRITE_METHODS: readonly RuntimeMethod[] = ["insert", "update", "delete"];

/**
 * Narrows an untrusted `method` (it arrives from a running app, through the
 * host bridge) to the runtime's own surface, so a boundary can reject an
 * unknown name — `sqlSelect`, say — before `AppService` is called at all.
 * Mirrors `parseLevel` in data/permissions.ts.
 */
export function parseRuntimeMethod(value: unknown): RuntimeMethod {
  if (typeof value === "string" && (RUNTIME_METHODS as readonly string[]).includes(value)) return value as RuntimeMethod;
  throw new DataError("invalid", `unknown app data method "${String(value)}"`);
}

const NO_APP_ACCESS = "You don't have access to this app. Ask a company admin.";

export interface AppServiceDeps {
  pool: Pool;
  data: DataService;
  /** Typed decisions (docs/decisions.md). Absent, an app's decision calls answer `disabled`. */
  decisions?: Pick<DecisionService, "decide" | "status">;
  /** External API connections (docs/connections.md). Absent, an app's connection calls answer `disabled`. */
  connections?: Pick<ConnectionService, "status" | "call">;
  onMutation?: (event: MutationEvent) => Promise<void>;
  onMutationError?: (error: unknown, event: MutationEvent) => void;
  /** The clock `decideOutcome` measures its 24-hour window with; tests replace it. */
  now?: () => number;
  /** The guardrail on risky agent actions (milestone 4). */
  guardAgentAction?: GuardAgentAction;
  /**
   * Apps this person may not open because they are in a group none of whose groups includes them
   * (docs/groups.md). Absent, every app is open as before. People only: an agent's calls never ask.
   */
  hiddenApps?: (companyId: string, userId: string) => Promise<Set<string>>;
  /** App tasks (docs/app-tasks.md). Absent, an app's task calls answer `disabled`. */
  tasks?: Pick<TaskService, "start" | "get" | "list" | "cancel">;
  /** The company's agents, to resolve each template's agent name to an id at publish. */
  agents?: { list(companyId: string): Promise<Array<{ id: string; name: string; status: string }>> };
  /** Where a published version's template → agent id mapping lives. */
  taskStore?: Pick<AppTaskStore, "getTaskAgents" | "setTaskAgents">;
  /** Operator log for failures the caller is told about only in general terms. Ids only, never contents. */
  log?: (message: string, meta: Record<string, unknown>) => void;
}

/** What publishing and rolling back accept besides the version. */
export interface PublishOptions {
  /** The publisher reviewed the version's new or changed decision sets and what they send. */
  decisionsConfirmed?: boolean;
  /** The publisher reviewed the version's new or changed connections and the services they reach. */
  connectionsConfirmed?: boolean;
  /** The publisher reviewed the version's new or changed task templates: which agent each reaches and what it is told. */
  tasksConfirmed?: boolean;
  /** The guardrail's task and confirmation ids; only an agent's call carries them. */
  guard?: GuardContext;
}

/**
 * The confirmations a publish or rollback request carries, for every entry point (action, tool, REST).
 * Only a literal `true` confirms anything; the flags besides `decisionsConfirmed` appear only when set.
 */
export function confirmations(raw: { decisionsConfirmed?: unknown; connectionsConfirmed?: unknown; tasksConfirmed?: unknown }): Pick<PublishOptions, "decisionsConfirmed" | "connectionsConfirmed" | "tasksConfirmed"> {
  return {
    decisionsConfirmed: raw.decisionsConfirmed === true,
    ...(raw.connectionsConfirmed === true ? { connectionsConfirmed: true } : {}),
    ...(raw.tasksConfirmed === true ? { tasksConfirmed: true } : {}),
  };
}

export type DecideInputRef = { rowId: string } | { values: Record<string, unknown> };

/**
 * Narrows what a running app sent as `input` to one of the two shapes `runtimeDecide` takes. It
 * arrives from app code through the bridge, so it is checked rather than cast.
 */
export function parseDecideInput(raw: unknown): DecideInputRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DataError("invalid", "decide needs { rowId } or { values }");
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input.rowId === "string" && input.rowId.length > 0) return { rowId: input.rowId };
  if (keys.length === 1 && input.values && typeof input.values === "object" && !Array.isArray(input.values)) return { values: input.values as Record<string, unknown> };
  throw new DataError("invalid", "decide needs exactly one of { rowId } or { values }");
}

/** How long an app may report what its viewer chose for one of its decisions. */
export const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PublishPreview {
  version: number;
  /** The version adds or changes decision sets: a person must publish it, with `decisionsConfirmed`. */
  changed: boolean;
  provider: string | null;
  available: boolean;
  sets: Array<{ key: string; table: string; fields: string[]; advisory: boolean; questions: Array<{ key: string; type: Question["type"]; text: string }> }>;
  connections: {
    /** The version adds or changes connections: a person must publish it, with `connectionsConfirmed`. */
    changed: boolean;
    /**
     * Each declared connection as the dialog shows it. `added` (the published version lacks it) and
     * `widened` (read → read-write) mark the entries the confirmation is about; `changed` is true
     * exactly when one of them is.
     */
    list: Array<{ name: string; access: "read" | "read-write"; baseUrl: string | null; auth: string | null; methods: string | null; available: boolean; missing: boolean; added: boolean; widened: boolean }>;
  };
  tasks: {
    /** The version adds or changes task templates: a person must publish it, with `tasksConfirmed`. */
    changed: boolean;
    /**
     * Each declared template as the dialog shows it, unfilled. `agentFound` says whether the name
     * resolves to an agent that can take work today; `agentCanWrite` is null unless the template `writes`.
     */
    list: Array<{ key: string; agent: string; agentFound: boolean; agentCanWrite: boolean | null; title: string; instructions: string; table: string | null; fields: string[]; inputs: Record<string, TaskInput>; writes: string[]; added: boolean; changed: boolean }>;
  };
}

type CompanyAgent = { id: string; name: string; status: string };
/** Agents the core never assigns work to. */
const UNUSABLE_AGENT = new Set(["terminated", "pending_approval"]);

/**
 * The agent a template's name means: an exact match first, then a case-insensitive one. A terminated
 * or pending agent left behind under the same name as a live one does not make the name ambiguous;
 * two live candidates do. Returns the agent (possibly unusable, for the caller to report), or why not.
 */
export function findAgentByName(agents: CompanyAgent[], name: string): CompanyAgent | "missing" | "ambiguous" {
  const pick = (matches: CompanyAgent[]): CompanyAgent | "missing" | "ambiguous" => {
    if (matches.length <= 1) return matches[0] ?? "missing";
    const live = matches.filter((agent) => !UNUSABLE_AGENT.has(agent.status));
    if (live.length === 1) return live[0]!;
    return live.length === 0 ? matches[0]! : "ambiguous";
  };
  const exact = agents.filter((agent) => agent.name === name);
  if (exact.length > 0) return pick(exact);
  const folded = name.toLowerCase();
  return pick(agents.filter((agent) => agent.name.toLowerCase() === folded));
}

// ---- runtime parameter shapes ------------------------------------------
// An app's data calls arrive as untyped JSON written by an agent-built page,
// so every value below is checked before it reaches DataService rather than
// cast: the query compiler calls .map on `fields`/`orderBy` and indexes
// `where`, so a wrong shape has to surface as an "invalid" DataError here
// instead of a TypeError escaping the DataError contract.

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new DataError("invalid", `${key} is required`);
  return value;
}

function optionalArray(params: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new DataError("invalid", `${key} must be an array`);
  return value;
}

function stringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  return optionalArray(params, key)?.map((entry) => {
    if (typeof entry !== "string") throw new DataError("invalid", `${key} must be an array of strings`);
    return entry;
  });
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DataError("invalid", `${key} must be a number`);
  return value;
}

function sortDirection(value: unknown): "asc" | "desc" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "asc" || value === "desc") return value;
  throw new DataError("invalid", "orderBy direction must be asc or desc");
}

function querySpec(params: Record<string, unknown>): QuerySpec {
  const orderBy = optionalArray(params, "orderBy")?.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new DataError("invalid", "orderBy must be an array of objects");
    const { field, direction } = entry as { field?: unknown; direction?: unknown };
    if (typeof field !== "string") throw new DataError("invalid", "each orderBy entry needs a field name");
    return { field, direction: sortDirection(direction) };
  });
  return { where: params.where, orderBy, limit: optionalNumber(params, "limit"), offset: optionalNumber(params, "offset"), fields: stringArray(params, "fields") };
}

function rowTarget(params: Record<string, unknown>): RowTarget {
  return { ids: stringArray(params, "ids"), where: params.where };
}

function patch(params: Record<string, unknown>): Row {
  const value = params.patch;
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new DataError("invalid", "patch must be an object");
  return value as Row;
}

/**
 * The actor-aware app service: the only way in to apps for the UI, the tools,
 * and the API routes. It resolves the caller's access level through
 * `DataService` (users by company role, agents by grant), authorises the
 * lifecycle operation, and — for a running app — proxies data calls with the
 * *viewer's own* actor, so an app's manifest can only ever narrow what its
 * viewer may do, never widen it.
 */
export class AppService {
  private readonly pool: Pool;
  private readonly store: AppStore;
  private readonly data: DataService;
  private readonly decisions: AppServiceDeps["decisions"];
  private readonly connections: AppServiceDeps["connections"];
  private readonly onMutation: AppServiceDeps["onMutation"];
  private readonly onMutationError: AppServiceDeps["onMutationError"];
  private readonly now: () => number;
  private readonly guardAgentAction: AppServiceDeps["guardAgentAction"];
  private readonly hiddenApps: AppServiceDeps["hiddenApps"];
  private readonly tasks: AppServiceDeps["tasks"];
  private readonly agents: AppServiceDeps["agents"];
  private readonly taskStore: AppServiceDeps["taskStore"];
  private readonly log: AppServiceDeps["log"];

  constructor(deps: AppServiceDeps) {
    this.pool = deps.pool;
    this.data = deps.data;
    this.store = new AppStore(deps.pool);
    this.decisions = deps.decisions;
    this.connections = deps.connections;
    this.onMutation = deps.onMutation;
    this.onMutationError = deps.onMutationError;
    this.now = deps.now ?? Date.now;
    this.guardAgentAction = deps.guardAgentAction;
    this.hiddenApps = deps.hiddenApps;
    this.tasks = deps.tasks;
    this.agents = deps.agents;
    this.taskStore = deps.taskStore;
    this.log = deps.log;
  }

  /** Live apps for this company: drafts are visible only to those who can edit them. */
  async list(companyId: string, actor: DataActor): Promise<AppRecord[]> {
    const level = await this.authorize(companyId, actor, "read", "list apps");
    const all = await this.store.list(companyId);
    const visible = levelAllows(level, "write") ? all : all.filter((app) => app.status === "published");
    const hidden = await this.hiddenFor(companyId, actor);
    return visible.filter((app) => !hidden.has(app.id));
  }

  async get(companyId: string, actor: DataActor, slug: string, version: number | "current" | "latest" = "latest"): Promise<{ app: AppRecord; version: AppVersion | null }> {
    const level = await this.authorize(companyId, actor, "read", "read an app");
    const editor = levelAllows(level, "write");
    const app = await this.store.get(companyId, slug);
    if (!app || (app.status !== "published" && !editor)) throw new DataError("not_found", `app "${slug}" not found`);
    await this.assertAppAccess(companyId, actor, app);
    // Read access buys the published app and nothing behind it: a viewer's
    // "latest" is the published version, and any other version number is a
    // miss. Without this, read access to one published app would also hand
    // out the source of every unpublished draft version stacked behind it.
    const wanted = editor || version !== "latest" ? version : "current";
    const record = await this.store.getVersion(app, wanted);
    if (record && !editor && record.version !== app.currentVersion) throw new DataError("not_found", `app "${slug}" has no version ${String(version)}`);
    return { app, version: record };
  }

  async create(companyId: string, actor: DataActor, rawManifest: unknown, rawSource: unknown, notes: string | null = null): Promise<{ app: AppRecord; version: AppVersion }> {
    await this.authorize(companyId, actor, "write", "create an app");
    const manifest = validateAppManifest(rawManifest);
    const source = assertAppSource(rawSource);
    await this.assertDecisionFields(companyId, actor, manifest, true);
    await this.assertTaskFields(companyId, actor, manifest, true);
    const created = await this.store.create(companyId, manifest, source, { kind: actor.kind, id: actor.id }, notes,
      (result) => this.entry(companyId, actor, "app_create", result.app, { version: result.version.version }));
    await this.notify(companyId, actor, "app_create", created.app, `created app ${manifest.slug} (draft)`);
    return created;
  }

  /** Saves a new version. It stays a draft until someone with schema access publishes it. */
  async update(companyId: string, actor: DataActor, slug: string, rawManifest: unknown, rawSource: unknown, notes: string | null = null): Promise<AppVersion> {
    await this.authorize(companyId, actor, "write", "update an app");
    await this.assertSlugAccess(companyId, actor, slug);
    const manifest = validateAppManifest(rawManifest);
    if (manifest.slug !== slug) throw new DataError("invalid", "the manifest slug must match the app being updated");
    const source = assertAppSource(rawSource);
    await this.assertDecisionFields(companyId, actor, manifest, true);
    await this.assertTaskFields(companyId, actor, manifest, true);
    const saved = await this.store.addVersion(companyId, slug, manifest, source, { kind: actor.kind, id: actor.id }, notes,
      (result) => this.entry(companyId, actor, "app_update", result.app, { version: result.version.version }));
    await this.notify(companyId, actor, "app_update", saved.app, `saved app ${slug} version ${saved.version.version} (draft)`);
    return saved.version;
  }

  // Ruling P4-R13: publish, rollback and archive change what every viewer of this company runs,
  // so each takes a fresh role lookup rather than up to 30 s of cached membership.
  async publish(companyId: string, actor: DataActor, slug: string, version?: number, opts: PublishOptions = {}): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "publish an app", { fresh: true });
    const published = await this.makeCurrent(companyId, actor, slug, version ?? "latest", "app_publish", opts);
    await this.notify(companyId, actor, "app_publish", published.app, `published app ${slug} version ${published.version}`);
    return published.app;
  }

  async rollback(companyId: string, actor: DataActor, slug: string, version: number, opts: PublishOptions = {}): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "roll back an app", { fresh: true });
    const rolled = await this.makeCurrent(companyId, actor, slug, version, "app_rollback", opts);
    await this.notify(companyId, actor, "app_rollback", rolled.app, `rolled app ${slug} back to version ${rolled.version}`);
    return rolled.app;
  }

  /** Terminal in Phase 3 (ruling P3-R10): the app disappears and its slug is free again. */
  async archive(companyId: string, actor: DataActor, slug: string, opts: { guard?: GuardContext } = {}): Promise<AppRecord> {
    await this.authorize(companyId, actor, "schema", "archive an app", { fresh: true });
    await this.assertSlugAccess(companyId, actor, slug);
    // The app's id, not just its slug, is what a person allows: a slug is free again once its app is
    // archived (ruling P3-R10), so an "Allow once" must never carry over to a replacement app. Reading
    // the app first also gives a missing one the same not_found as without the guardrail, before any
    // check or card.
    await this.guarded(companyId, actor, async () => {
      const app = await this.store.require(companyId, slug);
      return { operation: "app_archive", app: slug, params: { slug, appId: app.id } };
    }, opts.guard);
    const app = await this.store.setStatus(companyId, slug, "archived",
      (archived) => this.entry(companyId, actor, "app_archive", archived, {}));
    await this.notify(companyId, actor, "app_archive", app, `archived app ${slug}`);
    return app;
  }

  /** The published page a viewer runs, plus the context handed to it. */
  async runtime(companyId: string, actor: DataActor, slug: string, viewerName: string): Promise<{ context: AppContext; source: string }> {
    const { app, version, level } = await this.open(companyId, actor, slug);
    const sets = Object.keys(version.manifest.decisions ?? {});
    let available = false;
    if (sets.length > 0 && this.decisions) {
      // A context is never refused over this: an app that cannot use its sets right now still runs.
      try { available = (await this.decisions.status(companyId, actor, "apps")).available; } catch { available = false; }
    }
    const declaredConnections = version.manifest.connections ?? [];
    const templates = Object.entries(version.manifest.tasks ?? {});
    let connectionRows: Array<{ name: string; available: boolean }> = [];
    if (declaredConnections.length > 0 && this.connections) {
      // As with decisions, a context is never refused over this.
      try { connectionRows = (await this.connections.status(companyId)).connections; } catch { connectionRows = []; }
    }
    return {
      context: {
        companyId,
        viewer: { id: actor.id, name: viewerName, level },
        app: { slug: app.slug, name: app.name, version: version.version },
        tables: version.manifest.tables.map((table) => table.name),
        decisions: { available, sets },
        connections: declaredConnections.map((entry) => ({ name: entry.name, access: entry.access, available: connectionRows.find((row) => row.name === entry.name)?.available === true })),
        tasks: {
          available: this.tasks !== undefined && templates.length > 0,
          templates: templates.map(([key, template]) => ({ key, table: template.table, inputs: template.inputs, writes: template.writes })),
        },
      },
      source: version.source,
    };
  }

  /**
   * One data call from a running app. Three gates, in order: the app must be
   * published to this viewer, the *current published* version must declare the
   * table (a table declared only by a newer draft is not reachable), and a
   * write needs that declaration to be "readwrite". Only then does the call go
   * to `DataService` under the viewer's own actor, which authorises, audits,
   * and logs it there — the manifest can narrow the viewer's access, never
   * widen it, and this method never re-audits what DataService already did.
   */
  async runtimeData(companyId: string, actor: DataActor, slug: string, method: RuntimeMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!RUNTIME_METHODS.includes(method)) throw new DataError("invalid", `unknown app data method "${String(method)}"`);
    if (typeof params !== "object" || params === null) throw new DataError("invalid", "params must be an object");
    const { version } = await this.open(companyId, actor, slug);
    const table = str(params, "table");
    const declared = version.manifest.tables.find((entry) => entry.name === table);
    if (!declared) throw new DataError("forbidden", `app "${slug}" does not declare table "${table}"`);
    if (WRITE_METHODS.includes(method) && declared.access !== "readwrite") throw new DataError("forbidden", `app "${slug}" only has read access to "${table}"`);
    // Ruling P4-R21: the audit row still names the *viewer* as the actor, so the app a write was
    // made through is a separate fact and cannot be inferred from it. It is taken from the
    // published version resolved above — never from the app's own message, which names only a
    // table and a payload.
    const via = { app: slug, version: version.version };
    switch (method) {
      case "describe": return this.data.describeTable(companyId, actor, table);
      case "query": return this.data.query(companyId, actor, table, querySpec(params));
      case "get": return this.data.get(companyId, actor, table, str(params, "id"));
      case "count": return { count: await this.data.count(companyId, actor, table, params.where) };
      case "insert": return this.data.insert(companyId, actor, table, optionalArray(params, "rows") ?? [], via);
      case "update": return this.data.update(companyId, actor, table, rowTarget(params), patch(params), via);
      case "delete": return this.data.delete(companyId, actor, table, rowTarget(params), via);
    }
  }

  /**
   * One typed decision from a running app (docs/decisions.md). Four gates, in order: the app must be
   * published to this viewer, the *current published* version must declare the set, the viewer must
   * be able to read the set's table, and the company must have decisions switched on for apps (the
   * decision service checks that last one). The state is built here, from the set's declared fields
   * and nothing else — read from a stored row under the viewer, or taken from unsaved values checked
   * against each field's kind — so app code can never send free text or extra data of its own.
   */
  async runtimeDecide(companyId: string, actor: DataActor, slug: string, set: string, input: DecideInputRef): Promise<DecideResult> {
    const { version } = await this.open(companyId, actor, slug);
    const sets = version.manifest.decisions ?? {};
    if (!Object.hasOwn(sets, set)) throw new DataError("forbidden", `app "${slug}" does not declare decision set "${set}"`);
    const declared = sets[set]!;
    const info = await this.data.describeTable(companyId, actor, declared.table);
    let state: Record<string, unknown>;
    if ("rowId" in input) {
      const row = await this.data.get(companyId, actor, declared.table, input.rowId);
      if (!row) throw new DataError("not_found", `row ${input.rowId} was not found in "${declared.table}"`);
      state = Object.fromEntries(declared.fields.map((name) => [name, row[name] ?? null]));
    } else {
      const extra = Object.keys(input.values).filter((name) => !declared.fields.includes(name));
      if (extra.length > 0) throw new DataError("invalid", `decision set "${set}" does not send field(s) ${extra.join(", ")}`);
      const fields = new Map(info.fields.map((field) => [field.name, field]));
      state = {};
      for (const name of declared.fields) {
        const field = fields.get(name);
        if (!field) throw new DataError("invalid", `table "${declared.table}" no longer has field "${name}"`);
        // A form being filled in may leave any field empty, whatever the table requires.
        state[name] = coerceValue({ ...field, required: false }, input.values[name]);
      }
    }
    if (!this.decisions) throw new DataError("disabled", "typed decisions are not available in this installation");
    return this.decisions.decide(companyId, actor, "apps", { state, questions: declared.questions }, { via: `${slug}@${version.version}`, advisory: declared.advisory });
  }

  /**
   * One call to an external API from a running app (docs/connections.md). The app must be published
   * to this viewer and the *current published* version must declare the connection; the declared
   * access travels with the call, and the connection service never trusts the app's own word for it.
   */
  async runtimeConnection(companyId: string, actor: DataActor, slug: string, name: string, raw: unknown): Promise<ConnectionResponse> {
    const { version } = await this.open(companyId, actor, slug);
    const declared = (version.manifest.connections ?? []).find((entry) => entry.name === name);
    if (!declared) throw new DataError("forbidden", `app "${slug}" does not declare connection "${String(name)}"`);
    if (!this.connections) throw new DataError("disabled", "connections are not available in this installation");
    return this.connections.call(companyId, actor, name, raw, { kind: "app", slug, version: version.version, declared: declared.access });
  }

  /**
   * Starts one task from a running app (docs/app-tasks.md). The app must be published to this viewer
   * and its *current published* version must declare the template; the agent is the one resolved when
   * a person published that version, never a name the app sends. Everything after that — the row, the
   * inputs, the agent's state, the core's assignment decision and the limits — is `TaskService`'s.
   */
  async runtimeTaskStart(companyId: string, actor: DataActor, slug: string, template: string, raw: { rowId?: unknown; inputs?: unknown }): Promise<AppTask> {
    const { app, version, level } = await this.open(companyId, actor, slug);
    const templates = version.manifest.tasks ?? {};
    if (!Object.hasOwn(templates, template)) throw new DataError("not_found", `app "${slug}" has no task template "${String(template)}"`);
    const declared = templates[template]!;
    const tasks = this.requireTasks();
    const agents = this.taskStore ? await this.taskStore.getTaskAgents(version.id) : null;
    // Every version published with templates has its agents stored, so this is a guard, not a path.
    const agentId = agents && Object.hasOwn(agents, template) ? agents[template] : undefined;
    if (!agentId) throw new DataError("disabled", `This app's agent '${declared.agent}' isn't set up. Ask a person to republish it.`);
    return tasks.start({
      companyId, viewer: actor,
      app: { id: app.id, slug: app.slug, name: app.name, version: version.version, versionId: version.id },
      templateKey: template, template: declared, agentId, viewerLevel: level,
    }, raw);
  }

  /** One task this app started. The app gate runs here: `TaskService` only checks that the task is this app's. */
  async runtimeTaskGet(companyId: string, actor: DataActor, slug: string, id: string): Promise<AppTask> {
    const { app } = await this.open(companyId, actor, slug);
    return this.requireTasks().get(companyId, app.id, id);
  }

  async runtimeTaskList(companyId: string, actor: DataActor, slug: string, filter: { template?: string; rowId?: string }): Promise<AppTask[]> {
    const { app } = await this.open(companyId, actor, slug);
    return this.requireTasks().list(companyId, app.id, filter);
  }

  async runtimeTaskCancel(companyId: string, actor: DataActor, slug: string, id: string): Promise<AppTask & { runMayContinue: boolean }> {
    const { app, version } = await this.open(companyId, actor, slug);
    return this.requireTasks().cancel(companyId, actor, { id: app.id, slug: app.slug, version: version.version }, id);
  }

  /**
   * What the viewer chose in an app's review lane. Only for a decision this app made for this
   * viewer in the last 24 hours, once; every other case gets the same `not_found`, so the call
   * cannot be used to probe other people's decisions. Logged as `outcome_via: app`, apart from the
   * Data page's outcomes, because app code could call this without a person acting.
   */
  async decideOutcome(companyId: string, actor: DataActor, slug: string, decisionId: string, question: string, value: unknown): Promise<{ outcome: Outcome }> {
    await this.open(companyId, actor, slug);
    if (actor.kind !== "user" || !actor.id) throw new DataError("forbidden", "only the person using an app can record what they chose");
    if (!UUID_RE.test(decisionId)) throw new DataError("invalid", "decisionId must be a uuid");
    if (!QUESTION_KEY_RE.test(question)) throw new DataError("invalid", "question must be a question key");
    if (typeof value !== "string" && typeof value !== "boolean") throw new DataError("invalid", "value must be a string or a boolean");
    const logged = await getLoggedDecision(this.pool, companyId, decisionId, question);
    const ours = logged !== null
      && logged.surface === "apps" && logged.actorKind === "user" && logged.actorId === actor.id
      && (logged.via ?? "").startsWith(`${slug}@`)
      && this.now() - Date.parse(logged.createdAt) <= OUTCOME_WINDOW_MS;
    if (!ours) throw new DataError("not_found", "no decision by this app for you in the last 24 hours matches that id and question");
    const outcome: Outcome = String(value) === logged!.answer ? "human_confirmed" : "human_changed";
    // The write itself refuses a decision that already has an outcome, so of two reports racing for
    // one decision exactly one is recorded and the other is told so.
    if (!(await recordOutcome(this.pool, { companyId, decisionId, questionKey: question, outcome, via: "app", by: actor.id }))) {
      throw new DataError("conflict", "an outcome is already recorded for this decision");
    }
    return { outcome };
  }

  /** What publishing `version` would send, for the publish dialog. Same gate as publishing. */
  async publishPreview(companyId: string, actor: DataActor, slug: string, version: number | "latest" = "latest"): Promise<PublishPreview> {
    await this.authorize(companyId, actor, "schema", "publish an app", { fresh: true });
    const target = await this.store.getVersion(companyId, slug, version);
    if (!target) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
    await this.assertSlugAccess(companyId, actor, slug);
    const current = await this.currentManifest(companyId, slug);
    const sets = target.manifest.decisions ?? {};
    let provider: string | null = null;
    let available = false;
    if (this.decisions && Object.keys(sets).length > 0) {
      try {
        const status = await this.decisions.status(companyId, actor, "apps");
        provider = status.provider;
        available = status.available;
      } catch {
        // The dialog still shows what would be sent; it just cannot name the provider.
      }
    }
    const declared = connectionChanges(current, target.manifest);
    let configured: Awaited<ReturnType<NonNullable<AppServiceDeps["connections"]>["status"]>>["connections"] = [];
    if (declared.length > 0 && this.connections) {
      try { configured = (await this.connections.status(companyId)).connections; } catch { configured = []; }
    }
    const templateRows = templateChanges(current, target.manifest);
    let companyAgents: CompanyAgent[] = [];
    if (templateRows.length > 0 && this.agents) {
      // As with connections, the dialog still shows the templates when the directory cannot be read.
      try { companyAgents = await this.agents.list(companyId); } catch { companyAgents = []; }
    }
    const taskList = await Promise.all(templateRows.map(async (entry) => {
      const template = target.manifest.tasks![entry.key]!;
      const found = findAgentByName(companyAgents, template.agent);
      const agent = typeof found === "object" && !UNUSABLE_AGENT.has(found.status) ? found : null;
      let agentCanWrite: boolean | null = null;
      if (agent && template.writes.length > 0) {
        try { agentCanWrite = levelAllows(await this.data.levelFor(companyId, { kind: "agent", id: agent.id, runId: null }), "write"); } catch { agentCanWrite = null; }
      }
      return {
        key: entry.key, agent: template.agent, agentFound: agent !== null, agentCanWrite,
        title: template.title, instructions: template.instructions, table: template.table, fields: template.fields, inputs: template.inputs, writes: template.writes,
        added: entry.added, changed: entry.changed,
      };
    }));
    return {
      version: target.version,
      changed: decisionSetsChanged(current, target.manifest),
      tasks: { changed: taskList.some((entry) => entry.added || entry.changed), list: taskList },
      connections: {
        changed: declared.some((entry) => entry.added || entry.widened),
        list: declared.map((entry) => {
          const row = configured.find((candidate) => candidate.name === entry.name);
          return {
            name: entry.name, access: entry.access, baseUrl: row?.baseUrl ?? null, auth: row?.auth ?? null, methods: row?.methods ?? null,
            available: row?.available === true, missing: !row, added: entry.added, widened: entry.widened,
          };
        }),
      },
      provider,
      available,
      sets: Object.entries(sets).map(([key, set]) => ({
        key, table: set.table, fields: set.fields, advisory: set.advisory,
        questions: Object.entries(set.questions).map(([questionKey, question]) => ({ key: questionKey, type: question.type, text: question.type === "check" ? question.statement : question.instructions })),
      })),
    };
  }

  // ---- internals --------------------------------------------------------

  /**
   * The gate every entry point above passes through before touching the
   * store: it validates the companyId, resolves the actor's level through
   * `DataService`, and refuses the call unless that level allows `op`.
   */
  private async authorize(companyId: string, actor: DataActor, op: Operation, what: string, opts: { fresh?: boolean } = {}): Promise<AccessLevel> {
    // The store puts companyId straight into its kyoube_meta queries (Task 1
    // deferred the check to here), so the same uuid rule ensureCompany and
    // withCompany enforce for a company's schema and role is applied first:
    // schemaNameFor throws DataError("invalid", ...) for anything that is not
    // a uuid, before any store or DataService call.
    schemaNameFor(companyId);
    const level = await this.data.levelFor(companyId, actor, opts);
    assertLevel(level, op, what);
    // Ruling P4-R17: `levelFor` no longer provisions, so a write has to ask for it here — the
    // apps tables reference kyoube_meta.companies. A read provisions nothing: the store simply
    // finds no apps for a company that has none.
    if (op !== "read") await this.data.scope(companyId);
    return level;
  }

  /**
   * Points an app at `version` and publishes it, for both `publish` and
   * `rollback`. The declared tables are verified for either path: rolling back
   * lands on the same `setCurrent` (which also flips a draft to published), so
   * without the check here rollback would be a way around publish's rule and
   * could leave viewers an app that can only error. `describeTable` runs as
   * the caller — who holds schema access by the time they get here, and so
   * certainly read access — so it never reads anything they could not read
   * themselves.
   */
  private async makeCurrent(companyId: string, actor: DataActor, slug: string, version: number | "latest", operation: string, opts: PublishOptions = {}): Promise<{ app: AppRecord; version: number }> {
    const target = await this.store.getVersion(companyId, slug, version);
    if (!target) throw new DataError("not_found", `app "${slug}" has no version ${version}`);
    await this.assertSlugAccess(companyId, actor, slug);
    for (const table of target.manifest.tables) await this.data.describeTable(companyId, actor, table.name);
    await this.assertDecisionFields(companyId, actor, target.manifest, false);
    // Spec §5: new or changed decision sets change what leaves the server for every viewer, so a
    // person publishes them, after reviewing what they send — never an agent, whatever its grant.
    const currentManifest = await this.currentManifest(companyId, slug);
    const changed = decisionSetsChanged(currentManifest, target.manifest);
    if (changed && actor.kind !== "user") {
      throw new DataError("forbidden", "decision sets need a person to publish; save the draft and ask a company admin to publish it from the Apps page");
    }
    if (changed && opts.decisionsConfirmed !== true) {
      throw new DataError("invalid", "this version adds or changes decision sets; review what they send, then publish with decisionsConfirmed: true");
    }
    // Connections change which outside services every viewer's app can reach with a company secret, so
    // they are held to the same rule: a person publishes them, after reviewing what they reach.
    const connectionsChange = connectionsChanged(currentManifest, target.manifest);
    if (connectionsChange && actor.kind !== "user") {
      throw new DataError("forbidden", "this version adds or changes connections, which need a person to publish; save the draft and ask a company admin to publish it from the Apps page");
    }
    if (connectionsChange && opts.connectionsConfirmed !== true) {
      throw new DataError("invalid", "this version adds or changes connections; review which services it calls, then publish with connectionsConfirmed: true");
    }
    await this.assertDeclaredConnections(companyId, target.manifest);
    // Task templates hand work to an agent in every viewer's name, with instructions fixed here, so
    // they too need a person who has read them — a change to the instructions alone included.
    const tasksChange = taskTemplatesChanged(currentManifest, target.manifest);
    if (tasksChange && actor.kind !== "user") {
      throw new DataError("forbidden", "this version adds or changes task templates, which need a person to publish; save the draft and ask a company admin to publish it from the Apps page");
    }
    if (tasksChange && opts.tasksConfirmed !== true) {
      throw new DataError("invalid", "this version adds or changes task templates; review which agent each one reaches and what it is told, then publish with tasksConfirmed: true");
    }
    await this.assertTaskFields(companyId, actor, target.manifest, false);
    const taskAgents = await this.resolveTaskAgents(companyId, target.manifest);
    // Milestone 4: the guardrail screens an agent's publish or rollback of this exact version. The
    // version's own id is in the fingerprint, so a person's "Allow once" covers the version they were
    // shown: never a newer draft saved in between, nor a same-numbered version of a replacement app
    // that took the slug after this one was archived.
    await this.guarded(companyId, actor, async () => ({
      operation: operation === "app_rollback" ? "app_rollback" : "app_publish", app: slug, version: target.version,
      params: { slug, version: target.version, versionId: target.id },
    }), opts.guard);
    const sets = Object.keys(target.manifest.decisions ?? {});
    const connectionNames = (target.manifest.connections ?? []).map((entry) => entry.name);
    const taskKeys = Object.keys(target.manifest.tasks ?? {});
    const app = await this.store.setCurrent(companyId, slug, target.version,
      (published) => this.entry(companyId, actor, operation, published, {
        version: target.version,
        ...(sets.length > 0 ? { decisionSets: sets, decisionsConfirmed: changed } : {}),
        ...(connectionNames.length > 0 ? { connections: connectionNames, connectionsConfirmed: connectionsChange } : {}),
        ...(taskKeys.length > 0 ? { tasks: taskKeys, tasksConfirmed: tasksChange } : {}),
      }));
    if (this.taskStore) {
      try {
        await this.taskStore.setTaskAgents(target.id, taskAgents);
      } catch (error) {
        // The version is already current and this cannot undo that, so the publisher is told it failed;
        // a retry (the same version, now needing no confirmation) writes the mapping again. Until then
        // the app's task starts answer `disabled`.
        this.log?.("app task agents not recorded after publish", { companyId, appId: app.id, version: target.version, error: String(error) });
        throw error;
      }
    }
    return { app, version: target.version };
  }

  /** Every declared connection must be set up, and no declared access may be wider than the connection's methods. */
  private async assertDeclaredConnections(companyId: string, manifest: AppManifest): Promise<void> {
    const declared = manifest.connections ?? [];
    if (declared.length === 0) return;
    if (!this.connections) throw new DataError("invalid", "this version declares connections, which are not available in this installation");
    const configured = (await this.connections.status(companyId)).connections;
    const missing = declared.filter((entry) => !configured.some((row) => row.name === entry.name)).map((entry) => entry.name);
    if (missing.length > 0) throw new DataError("invalid", `connection(s) ${missing.join(", ")} are not set up; ask a company admin to add them in the plugin settings`);
    const wide = declared.filter((entry) => entry.access === "read-write" && configured.find((row) => row.name === entry.name)!.methods !== "read-write").map((entry) => entry.name);
    if (wide.length > 0) throw new DataError("invalid", `connection(s) ${wide.join(", ")} only allow read access, but the app declares read-write`);
  }

  /** The manifest viewers run today, or null when the app has never been published. */
  private async currentManifest(companyId: string, slug: string): Promise<AppManifest | null> {
    const app = await this.store.get(companyId, slug);
    if (!app || app.currentVersion === null) return null;
    return (await this.store.getVersion(app, "current"))?.manifest ?? null;
  }

  /**
   * Resolves the published app a viewer may open. Archived apps are already
   * invisible to the store's by-slug lookups (ruling P3-R10), and a draft, an
   * archived app, and a slug that never existed all get the same "not
   * published" answer, so read access cannot be used to probe for drafts.
   */
  /**
   * Every field a decision set may send must exist on its table. At save a table that does not exist
   * yet is skipped (`tolerateMissingTable`) — an app may be drafted before its tables, exactly as
   * declared tables are only checked at publish — and `makeCurrent` checks again with no exceptions.
   * `describeTable` runs as the caller, so this reads nothing they could not read themselves.
   */
  private async assertDecisionFields(companyId: string, actor: DataActor, manifest: AppManifest, tolerateMissingTable: boolean): Promise<void> {
    for (const [key, set] of Object.entries(manifest.decisions ?? {})) {
      let info: TableInfo;
      try {
        info = await this.data.describeTable(companyId, actor, set.table);
      } catch (error) {
        if (tolerateMissingTable && error instanceof DataError && error.code === "not_found") continue;
        throw error;
      }
      const known = new Set(info.fields.map((field) => field.name));
      const missing = set.fields.filter((field) => !known.has(field));
      if (missing.length > 0) {
        throw new DataError("invalid", `decision set "${key}" names field(s) ${missing.join(", ")} that table "${set.table}" does not have`);
      }
    }
  }

  /** The task-template sibling of `assertDecisionFields`, with the same `tolerateMissingTable` rule. */
  private async assertTaskFields(companyId: string, actor: DataActor, manifest: AppManifest, tolerateMissingTable: boolean): Promise<void> {
    for (const [key, template] of Object.entries(manifest.tasks ?? {})) {
      if (!template.table) continue;
      let info: TableInfo;
      try {
        info = await this.data.describeTable(companyId, actor, template.table);
      } catch (error) {
        if (tolerateMissingTable && error instanceof DataError && error.code === "not_found") continue;
        throw error;
      }
      const known = new Set(info.fields.map((field) => field.name));
      const missing = template.fields.filter((field) => !known.has(field));
      if (missing.length > 0) {
        throw new DataError("invalid", `task template "${key}" names field(s) ${missing.join(", ")} that table "${template.table}" does not have`);
      }
    }
  }

  /**
   * Each template's agent name → that agent's id as it stands at publish (null without templates).
   * Every name must mean exactly one agent that can take work; otherwise `invalid`, naming each one.
   */
  private async resolveTaskAgents(companyId: string, manifest: AppManifest): Promise<Record<string, string> | null> {
    const templates = Object.entries(manifest.tasks ?? {});
    if (templates.length === 0) return null;
    if (!this.agents || !this.taskStore) throw new DataError("invalid", "this version declares task templates, which are not available in this installation");
    const agents = await this.agents.list(companyId);
    const resolved: Record<string, string> = {};
    const problems: string[] = [];
    for (const [key, template] of templates) {
      const found = findAgentByName(agents, template.agent);
      if (found === "missing") problems.push(`task template "${key}" names agent "${template.agent}", which this company doesn't have`);
      else if (found === "ambiguous") problems.push(`task template "${key}" names agent "${template.agent}", which matches more than one agent; use the exact name`);
      else if (UNUSABLE_AGENT.has(found.status)) problems.push(`task template "${key}" names agent "${template.agent}", which is ${found.status === "terminated" ? "terminated" : "waiting for approval"}`);
      else resolved[key] = found.id;
    }
    if (problems.length > 0) throw new DataError("invalid", problems.join("; "));
    return resolved;
  }

  private requireTasks(): NonNullable<AppServiceDeps["tasks"]> {
    if (!this.tasks) throw new DataError("disabled", "app tasks are not available in this installation");
    return this.tasks;
  }

  private async open(companyId: string, actor: DataActor, slug: string): Promise<{ app: AppRecord; version: AppVersion; level: AccessLevel }> {
    const level = await this.authorize(companyId, actor, "read", "open an app");
    const app = await this.store.get(companyId, slug);
    const version = app?.status === "published" ? await this.store.getVersion(app, "current") : null;
    if (!app || !version) throw new DataError("not_found", `app "${slug}" is not published`);
    await this.assertAppAccess(companyId, actor, app);
    return { app, version, level };
  }

  private async hiddenFor(companyId: string, actor: DataActor): Promise<Set<string>> {
    if (actor.kind !== "user" || !actor.id || !this.hiddenApps) return new Set();
    return this.hiddenApps(companyId, actor.id);
  }

  /** Every path that names one app runs this after it has found the app. */
  private async assertAppAccess(companyId: string, actor: DataActor, app: AppRecord): Promise<void> {
    if ((await this.hiddenFor(companyId, actor)).has(app.id)) throw new DataError("forbidden", NO_APP_ACCESS);
  }

  /** For paths that go on to act by slug: load the app and gate it; a missing app is left to that action's own not_found. */
  private async assertSlugAccess(companyId: string, actor: DataActor, slug: string): Promise<void> {
    if (actor.kind !== "user" || !this.hiddenApps) return;
    const app = await this.store.get(companyId, slug);
    if (app) await this.assertAppAccess(companyId, actor, app);
  }

  /**
   * The audit row for one lifecycle change. Ruling P4-R28: it is never written here — it is
   * handed to the store method, which writes it inside the *same* transaction as the change
   * (see `withMeta`), so a lifecycle change is never committed unrecorded and a record never
   * outlives one that rolled back. The row reaches the store as a plan rather than a value
   * because the app it names is what the change itself returns.
   *
   * The app is named by *both* its slug (what a person reads) and its id: a slug is reusable as
   * soon as its app is archived (ruling P3-R10), so slug alone cannot identify which app a row
   * is about once one has been replaced.
   */
  private entry(companyId: string, actor: DataActor, operation: string, app: AppRecord, details: Record<string, unknown>): AuditEntry {
    return { companyId, actor, operation, table: null, details: { app: app.slug, appId: app.id, ...details } };
  }

  /**
   * The guardrail, as in DataService: agents only, after authorisation, before the change. `action` is
   * built only when the check runs, so a person's call reads nothing extra.
   */
  private async guarded(companyId: string, actor: DataActor, action: () => Promise<Omit<GuardedAction, "companyId" | "actor" | "guard">>, guard?: GuardContext): Promise<void> {
    if (actor.kind !== "agent" || !this.guardAgentAction) return;
    await this.guardAgentAction({ ...(await action()), companyId, actor, guard });
  }

  /**
   * The activity-log summariser, after the change and its audit row have committed. Mirrors
   * `DataService.notify`: a subscriber's failure must never surface as a failed call — the
   * caller could retry and create a second app or a duplicate version.
   */
  private async notify(companyId: string, actor: DataActor, operation: string, app: AppRecord, summary: string): Promise<void> {
    if (!this.onMutation) return;
    // The activity entry points at the app, not at a table — this service changes no rows.
    const event: MutationEvent = { companyId, actor, operation, table: null, entityId: app.id, summary };
    try {
      await this.onMutation(event);
    } catch (error) {
      if (this.onMutationError) this.onMutationError(error, event);
    }
  }
}
