// The gate the core mounts in front of every board route addressed by a task or a project
// (`visibility-route-gate`, in server/dist/app.js). Many of those routes check only company
// membership, and a task can be addressed by its sequential identifier (`PAP-17`), so without the
// gate a restricted person could read, change or delete a hidden task or project by naming it. For a
// person, the gate looks the task or project up, asks the core's own decision whether they may read
// it, and answers the core's own not-found for a visibility denial. Everything else (agents, an
// unknown ref, any other denial, a failed lookup) goes on to the core's route unchanged: the gate
// adds a refusal and never an error. Bundled into decide.mjs, so no dependencies.

import { CLOSED, HIDDEN } from "./decide.js";

export type GateKind = "issue" | "project";

/** The columns the core's own issue:read decision is built from (routes/issues.js decideIssueAccess). */
export interface GateIssue {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status?: string | null;
}

export interface GateProject {
  id: string;
  companyId: string;
}

export type GateDecision = { allowed: boolean; reason?: string | null } | null | undefined;

export interface RouteGateDeps {
  /** The core's authorization decision (`authorizationService(db).decide`). */
  decide(input: { actor: unknown; action: string; resource: Record<string, unknown>; scope?: Record<string, unknown> }): Promise<GateDecision>;
  /** Every task a ref names: by id, or by identifier in any company. */
  findIssues(ref: string): Promise<GateIssue[]>;
  /** Every project a ref names: by id, or by shortname in the company the request names. */
  findProjects(ref: string, companyId: string | null): Promise<GateProject[]>;
  /** Told about a failed lookup or decision; the request goes on to the core. */
  report?(error: unknown): void;
}

export interface GateRequest {
  actor?: { type?: string } | null;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

export interface GateResponse {
  status(code: number): { json(body: unknown): unknown };
}

export type GateNext = () => unknown;

/** The core's own answers for a task or project the actor may not reach (routes/authz.js getAccessibleResource). */
export const GATE_NOT_FOUND: Record<GateKind, { error: string }> = {
  issue: { error: "Issue not found" },
  project: { error: "Project not found" },
};

const VISIBILITY_REASONS = new Set<string>([HIDDEN.reason, CLOSED.reason]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function issueDecision(issue: GateIssue) {
  return {
    action: "issue:read",
    resource: {
      type: "issue",
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId ?? null,
      parentIssueId: issue.parentId ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
      status: issue.status ?? null,
    },
    scope: {
      issueId: issue.id,
      projectId: issue.projectId ?? null,
      parentIssueId: issue.parentId ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
    },
  };
}

/** True when the core's decision hides any row the ref names from this board actor. */
async function hidden(deps: RouteGateDeps, kind: GateKind, req: GateRequest): Promise<boolean> {
  const ref = text(req.params?.kyoubeRef);
  if (ref === null) return false;
  const asks =
    kind === "issue"
      ? (await deps.findIssues(ref)).map(issueDecision)
      : (await deps.findProjects(ref, text(req.params?.kyoubeCompanyId) ?? text(req.query?.companyId))).map((project) => ({
          action: "project:read",
          resource: { type: "project", companyId: project.companyId, projectId: project.id },
          scope: undefined,
        }));
  const decisions = await Promise.all(asks.map(({ action, resource, scope }) => deps.decide({ actor: req.actor, action, resource, ...(scope ? { scope } : {}) })));
  return decisions.some((decision) => decision?.allowed !== true && typeof decision?.reason === "string" && VISIBILITY_REASONS.has(decision.reason));
}

/**
 * The gate: `gate(kind, req, res, next)` answers 404 for a board actor's visibility denial and calls
 * `next()` in every other case. It never rejects, and calls `next` at most once.
 */
export function routeGate(deps: RouteGateDeps): (kind: GateKind, req: GateRequest, res: GateResponse, next: GateNext) => Promise<void> {
  return async (kind, req, res, next) => {
    let refuse = false;
    try {
      refuse = req?.actor?.type === "board" && (await hidden(deps, kind, req));
    } catch (error) {
      try {
        deps.report?.(error);
      } catch {
        // A failing logger changes nothing.
      }
    }
    if (refuse) {
      res.status(404).json(GATE_NOT_FOUND[kind] ?? GATE_NOT_FOUND.issue);
      return;
    }
    next();
  };
}

/** What the core hands over: drizzle, its two tables, `eq`, and its project shortname resolver. */
export interface CoreLookupInput {
  db: any;
  tables: { issues: any; projects: any };
  ops: { eq: any };
  /** projectService(db).resolveByReference; without it a project shortname finds nothing. */
  resolveProjectReference?: (companyId: string, reference: string) => Promise<{ project: { id: string; companyId: string } | null; ambiguous?: boolean } | null>;
}

/** The two lookups over the core's database, as the core's own routes resolve a ref. */
export function coreLookups({ db, tables: { issues, projects }, ops: { eq }, resolveProjectReference }: CoreLookupInput): Pick<RouteGateDeps, "findIssues" | "findProjects"> {
  return {
    async findIssues(ref) {
      // A uuid column refuses a non-uuid value, so a ref is an id or an identifier, never both.
      const where = isUuid(ref) ? eq(issues.id, ref) : eq(issues.identifier, ref.toUpperCase());
      const rows: GateIssue[] = await db
        .select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, status: issues.status })
        .from(issues)
        .where(where);
      return rows;
    },
    async findProjects(ref, companyId) {
      if (isUuid(ref)) {
        const rows: GateProject[] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects).where(eq(projects.id, ref));
        return rows;
      }
      if (companyId === null || resolveProjectReference === undefined) return [];
      // An ambiguous shortname finds nothing here; the core answers it with its own 409.
      const resolved = await resolveProjectReference(companyId, ref);
      return resolved?.project && !resolved.ambiguous ? [{ id: resolved.project.id, companyId: resolved.project.companyId }] : [];
    },
  };
}
