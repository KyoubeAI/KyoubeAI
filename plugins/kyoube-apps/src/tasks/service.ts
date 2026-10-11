// Starts, follows and cancels the tasks an app hands to a company agent (docs/app-tasks.md). The task
// is a core issue created as the person using the app, after the same assignment decision the core
// makes for that person, so an app never gets an agent to do work the core would refuse its viewer.
// `app_tasks` only links the issue to the app; status and result are always read live from the issue.
import type { AppTaskTemplate } from "../apps/manifest.js";
import type { AuditEntry } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import { levelAllows, type AccessLevel, type DataActor } from "../data/permissions.js";
import { isManagerRole } from "../groups/levels.js";
import type { AppTaskRow, AppTaskStore } from "./store.js";
import { buildDescription, buildTitle, isOpenStatus, mapIssueStatus, resultText, validateInputs, type AppTaskStatus, type DescriptionInput } from "./template.js";

/** The slice of `ctx.issues` the service uses (core 2026.1005.0). */
export interface TaskIssues {
  create(input: { companyId: string; title: string; description: string; status: "todo"; assigneeAgentId: string; actor: { actorUserId: string } }): Promise<{ id: string; identifier?: string | null }>;
  get(issueId: string, companyId: string): Promise<{ id: string; identifier?: string | null; status: string; assigneeAgentId?: string | null; updatedAt?: string | Date } | null>;
  update(issueId: string, patch: { status: "cancelled" }, companyId: string, actor: { actorUserId: string }): Promise<unknown>;
  /** Throws for a real refusal (paused agent, budget, blockers); `queued: false` is a soft skip. */
  requestWakeup(issueId: string, companyId: string, opts: { reason: string; actorUserId: string }): Promise<{ queued: boolean; runId: string | null }>;
  listComments(issueId: string, companyId: string): Promise<Array<{ body: string; authorType: string; authorAgentId?: string | null; createdAt: string | Date; deletedAt?: string | Date | null }>>;
}

export interface TaskServiceDeps {
  store: AppTaskStore;
  issues: TaskIssues;
  previewAssignment(companyId: string, userId: string, agentId: string): Promise<{ allowed: boolean; explanation: string }>;
  agent(companyId: string, agentId: string): Promise<{ id: string; name: string; status: string } | null>;
  levelFor(companyId: string, actor: DataActor): Promise<AccessLevel>;
  /** DataService.get as the viewer: a level below `read` throws DataService's own `forbidden`. */
  readRow(companyId: string, actor: DataActor, table: string, rowId: string): Promise<Record<string, unknown> | null>;
  resolveUserRole(companyId: string, userId: string, fresh: boolean): Promise<string | null>;
  taskUrl(companyId: string, issue: { id: string; identifier?: string | null }): Promise<string>;
  /** Operator log for failures that must not change the answer. Ids only, never contents. */
  log?(message: string, meta: Record<string, unknown>): void;
  now?(): number;
}

/** What `AppService` has already settled: the app is open to the viewer and the template is published. */
export interface StartContext {
  companyId: string;
  viewer: DataActor;
  app: { id: string; slug: string; name: string; version: number; versionId: string };
  templateKey: string;
  template: AppTaskTemplate;
  agentId: string;
  viewerLevel: AccessLevel;
}

export interface AppTask {
  id: string;
  template: string;
  rowId: string | null;
  status: AppTaskStatus;
  waitingReason: string | null;
  startedBy: { userId: string };
  startedAt: string;
  updatedAt: string;
  result: string | null;
  url: string;
}

export const START_PER_MINUTE = 10;
export const MAX_OPEN_PER_APP = 25;
export const LIST_LIMIT = 50;
/** Issues read at once by `list` and the open-task count. */
const READ_CONCURRENCY = 10;
const START_WINDOW_MS = 60_000;
/** A task left waiting by a refused wake-up is woken again at most this often while the app follows it. */
const WAKE_RETRY_MS = 60_000;
const WAKE_REASON = "kyoube_app_task";
const SCHEDULING_REASON = "The agent will pick this up when the company's scheduling allows.";

const forbidden = (message: string): DataError => new DataError("forbidden", message);
const noTask = (): DataError => new DataError("not_found", "no task from this app has that id");

/**
 * The person-facing reason for a refused wake-up. The core's own text can name blockers or budget
 * details, so it is never passed on: only these fixed sentences reach the app.
 */
export function waitingReasonFor(error: unknown): string {
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").toLowerCase();
  if (message.includes("not invokable")) return "The agent is paused or not available right now.";
  if (message.includes("budget")) return "The agent is over its budget.";
  return "The agent couldn't be started right now.";
}

function iso(value: string | Date | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function time(value: string | Date): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of `items`. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class TaskService {
  /** When `get` last tried to wake each waiting task (issue id → epoch ms). Per worker, best effort. */
  private readonly lastWake = new Map<string, number>();

  constructor(private readonly deps: TaskServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string, meta: Record<string, unknown>): void {
    try { this.deps.log?.(message, meta); } catch { /* the operator log is best effort */ }
  }

  /** The start checks after `AppService`'s (spec §2, steps 3–8), then create, record and wake. */
  async start(ctx: StartContext, raw: { rowId?: unknown; inputs?: unknown }): Promise<AppTask> {
    const { companyId, viewer, app, template, agentId } = ctx;
    const deps = this.deps;
    if (viewer.kind !== "user" || !viewer.id) throw forbidden("only a person using an app can start a task");
    const viewerId = viewer.id;

    // Row: read as the viewer, so a level below `read` fails with DataService's own `forbidden`.
    let row: DescriptionInput["row"] = null;
    if (template.table) {
      if (typeof raw.rowId !== "string" || raw.rowId.length === 0) throw new DataError("invalid", "this task needs a rowId");
      const values = await deps.readRow(companyId, viewer, template.table, raw.rowId);
      if (!values) throw new DataError("not_found", `no row in ${template.table} has that id`);
      row = { table: template.table, id: raw.rowId, values };
    } else if (raw.rowId !== undefined && raw.rowId !== null) {
      throw new DataError("invalid", "this task doesn't take a rowId");
    }

    if (template.writes.length > 0 && !levelAllows(ctx.viewerLevel, "write")) {
      throw forbidden("You can only read Data, so you can't ask an agent to change it.");
    }

    const inputs = validateInputs(template.inputs, raw.inputs);

    const agent = await deps.agent(companyId, agentId);
    if (!agent || agent.status === "terminated" || agent.status === "pending_approval") {
      throw new DataError("disabled", `This app's agent '${template.agent}' no longer exists. Ask a person to republish it.`);
    }
    if (template.writes.length > 0 && !levelAllows(await deps.levelFor(companyId, { kind: "agent", id: agentId }), "write")) {
      throw forbidden(`Ask an admin to give ${agent.name} write access to Data.`);
    }

    // The core's own decision for this person and agent: a group's "can't assign" rule holds here too.
    const preview = await deps.previewAssignment(companyId, viewerId, agentId);
    if (!preview.allowed) throw forbidden(preview.explanation || `You can't assign work to ${agent.name}.`);

    if (await deps.store.countStartedSince(companyId, app.id, viewerId, this.now() - START_WINDOW_MS) >= START_PER_MINUTE) {
      throw new DataError("limit", `at most ${START_PER_MINUTE} tasks a minute from this app`);
    }
    if (await this.openCount(companyId, app.id) >= MAX_OPEN_PER_APP) {
      throw new DataError("limit", `this app already has ${MAX_OPEN_PER_APP} open tasks`);
    }

    const described: DescriptionInput = { template, templateKey: ctx.templateKey, app: { name: app.name, slug: app.slug, version: app.version }, row, inputs };
    const issue = await deps.issues.create({
      companyId,
      title: buildTitle(described),
      description: buildDescription(described),
      status: "todo",
      assigneeAgentId: agentId,
      actor: { actorUserId: viewerId },
    });

    let inserted: AppTaskRow;
    try {
      inserted = await deps.store.insert(
        {
          issueId: issue.id, companyId, appId: app.id, appSlug: app.slug, appVersion: app.version,
          template: ctx.templateKey, agentId, tableName: template.table, rowId: row?.id ?? null, startedBy: viewerId,
        },
        this.audit("app_task_start", companyId, viewer, app, ctx.templateKey, agentId, issue.id, template.table),
      );
    } catch (error) {
      // Review Focus 3: no link, no task. The issue is cancelled before anything wakes the agent.
      try {
        await deps.issues.update(issue.id, { status: "cancelled" }, companyId, { actorUserId: viewerId });
      } catch (cancelError) {
        this.log("app task issue not cancelled after its row failed", { companyId, appId: app.id, issueId: issue.id, error: String(cancelError) });
      }
      throw error;
    }

    // Only now that the row has committed may the agent see the task.
    const waitingReason = await this.wake(companyId, issue.id, viewerId);
    if (waitingReason !== null) await this.setReason(inserted, waitingReason);
    return {
      id: issue.id, template: ctx.templateKey, rowId: inserted.rowId, status: "waiting", waitingReason,
      startedBy: { userId: viewerId }, startedAt: inserted.startedAt, updatedAt: inserted.startedAt,
      result: null, url: await deps.taskUrl(companyId, issue),
    };
  }

  async get(companyId: string, appId: string, issueId: string): Promise<AppTask> {
    const row = await this.deps.store.get(companyId, appId, issueId);
    if (!row) throw noTask();
    const task = await this.load(row);
    if (!task) throw noTask();
    return task;
  }

  async list(companyId: string, appId: string, filter: { template?: string; rowId?: string }): Promise<AppTask[]> {
    const rows = await this.deps.store.list(companyId, appId, { template: filter.template, rowId: filter.rowId, limit: LIST_LIMIT });
    const tasks = await mapLimited(rows, READ_CONCURRENCY, (row) => this.load(row));
    return tasks.filter((task): task is AppTask => task !== null);
  }

  async cancel(companyId: string, actor: DataActor, app: { id: string; slug: string; version: number }, issueId: string): Promise<AppTask & { runMayContinue: boolean }> {
    if (actor.kind !== "user" || !actor.id) throw forbidden("only a person using an app can cancel a task");
    const actorId = actor.id;
    const row = await this.deps.store.get(companyId, app.id, issueId);
    if (!row) throw noTask();
    if (actorId !== row.startedBy && !isManagerRole(await this.deps.resolveUserRole(companyId, actorId, true))) {
      throw forbidden("only the person who started this task or a company admin can cancel it");
    }
    const issue = await this.deps.issues.get(row.issueId, row.companyId);
    if (!issue) throw noTask();
    const previous = mapIssueStatus(issue.status);
    if (!isOpenStatus(previous)) {
      await this.close(row);
      throw new DataError("conflict", `this task is already ${previous}`);
    }
    await this.deps.issues.update(row.issueId, { status: "cancelled" }, row.companyId, { actorUserId: actorId });
    await this.deps.store.recordAudit(this.audit("app_task_cancel", row.companyId, actor, app, row.template, row.agentId, row.issueId, row.tableName));
    await this.close(row);
    this.lastWake.delete(row.issueId);
    return {
      ...this.shape(row, issue, "cancelled", null, null, await this.deps.taskUrl(row.companyId, issue)),
      updatedAt: new Date(this.now()).toISOString(),
      runMayContinue: previous === "working",
    };
  }

  /** The audit row for a start or cancel: ids only, never row values, inputs or the filled text. */
  private audit(operation: "app_task_start" | "app_task_cancel", companyId: string, actor: DataActor, app: { id: string; slug: string; version: number }, template: string, agentId: string, issueId: string, table: string | null): AuditEntry {
    return {
      companyId, actor, operation, table,
      details: { app: app.slug, appId: app.id, version: app.version, template, agentId, issueId, via: `app@${app.slug}@${app.version}` },
    };
  }

  /**
   * Wakes the agent on a task and records why it did not start, if it didn't. Never throws: a refused
   * wake-up leaves the task waiting in `todo`, and `get` tries again while the app follows it.
   * Returns the waiting reason (null when a run was queued).
   */
  private async wake(companyId: string, issueId: string, userId: string): Promise<string | null> {
    this.lastWake.set(issueId, this.now());
    let reason: string | null;
    try {
      const result = await this.deps.issues.requestWakeup(issueId, companyId, { reason: WAKE_REASON, actorUserId: userId });
      reason = result.queued ? null : SCHEDULING_REASON;
    } catch (error) {
      reason = waitingReasonFor(error);
    }
    if (reason === null) this.lastWake.delete(issueId);
    return reason;
  }

  /** Counts the app's open tasks from the issues themselves, caching the closed ones as closed. */
  private async openCount(companyId: string, appId: string): Promise<number> {
    const rows = await this.deps.store.openRows(companyId, appId);
    const open = await mapLimited(rows, READ_CONCURRENCY, async (row) => {
      const issue = await this.deps.issues.get(row.issueId, row.companyId);
      if (!issue) return false; // the core no longer returns it: not counted
      if (isOpenStatus(mapIssueStatus(issue.status))) return true;
      await this.close(row);
      return false;
    });
    return open.filter(Boolean).length;
  }

  private async close(row: AppTaskRow): Promise<void> {
    if (row.closed) return;
    try {
      // Keyed by issue id only; `row` came from a company- and app-scoped read.
      await this.deps.store.markClosed(row.issueId);
    } catch (error) {
      this.log("app task not marked closed", { companyId: row.companyId, appId: row.appId, issueId: row.issueId, error: String(error) });
    }
  }

  private async setReason(row: AppTaskRow, reason: string | null): Promise<void> {
    try {
      await this.deps.store.setWaitingReason(row.issueId, reason);
    } catch (error) {
      this.log("app task waiting reason not recorded", { companyId: row.companyId, appId: row.appId, issueId: row.issueId, error: String(error) });
    }
  }

  /** A task as the app sees it, or null when the core no longer returns its issue. */
  private async load(row: AppTaskRow): Promise<AppTask | null> {
    const issue = await this.deps.issues.get(row.issueId, row.companyId);
    if (!issue) return null;
    const status = mapIssueStatus(issue.status);
    let waitingReason = row.waitingReason;
    if (issue.status === "todo" && waitingReason !== null) {
      const last = this.lastWake.get(row.issueId);
      if (last === undefined || this.now() - last >= WAKE_RETRY_MS) {
        const reason = await this.wake(row.companyId, row.issueId, row.startedBy);
        if (reason !== waitingReason) await this.setReason(row, reason);
        waitingReason = reason;
      }
    } else {
      this.lastWake.delete(row.issueId);
    }
    let result: string | null = null;
    if (status === "done" || status === "needs_review") {
      const replies = (await this.deps.issues.listComments(row.issueId, row.companyId))
        .filter((c) => c.authorType === "agent" && c.authorAgentId === row.agentId && !c.deletedAt)
        .sort((a, b) => time(b.createdAt) - time(a.createdAt));
      result = resultText(replies[0]?.body);
    }
    if (!isOpenStatus(status)) await this.close(row);
    return this.shape(row, issue, status, status === "waiting" ? waitingReason : null, result, await this.deps.taskUrl(row.companyId, issue));
  }

  private shape(row: AppTaskRow, issue: { updatedAt?: string | Date }, status: AppTaskStatus, waitingReason: string | null, result: string | null, url: string): AppTask {
    return {
      id: row.issueId, template: row.template, rowId: row.rowId, status, waitingReason,
      startedBy: { userId: row.startedBy }, startedAt: row.startedAt, updatedAt: iso(issue.updatedAt, row.startedAt),
      result, url,
    };
  }
}
