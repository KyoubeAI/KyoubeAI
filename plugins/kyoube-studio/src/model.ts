/**
 * Pure functions from the host's agents, tasks and approvals to what Studio
 * shows. No I/O here: the pages read the agents from the worker and the tasks
 * and approvals from the core's board API (ui/board-data.ts), these shape
 * them, and the tests exercise them directly.
 *
 * Dates arrive over the plugin bridge and the board API as ISO strings even
 * where the SDK types say `Date`, so everything goes through `toMs`.
 */

export type AgentState = "working" | "waiting" | "attention" | "paused" | "idle";

export interface AgentLike {
  id: string;
  name: string;
  urlKey?: string | null;
  title?: string | null;
  icon?: string | null;
  status: string;
  errorReason?: string | null;
  lastHeartbeatAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface IssueLike {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  executionRunId?: string | null;
  hiddenAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  completedAt?: Date | string | null;
}

export interface ApprovalLike {
  id: string;
  type: string;
  status: string;
  requestedByAgentId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

export interface TaskRef {
  identifier: string;
  title: string;
  href: string;
}

export interface TeamMember {
  id: string;
  name: string;
  title: string | null;
  icon: string | null;
  href: string;
  state: AgentState;
  /** One short line under the name: what they are doing, or when they last did something. */
  detail: string;
  /** For idle agents, when they last ran (ISO), so the UI can say "2h ago". */
  lastActiveAt: string | null;
  task: TaskRef | null;
}

export type NeedKind = "approval" | "review" | "blocked" | "agent";

export interface NeedItem {
  kind: NeedKind;
  id: string;
  title: string;
  /** The verb on the item's button. */
  action: string;
  href: string;
  identifier: string | null;
  agentName: string | null;
  at: string | null;
}

export interface UpdateItem {
  id: string;
  label: string;
  identifier: string;
  title: string;
  href: string;
  agentName: string | null;
  tone: "teal" | "sky" | "violet" | "amber" | "rose";
  at: string;
}

export interface GettingStarted {
  hireAgent: boolean;
  giveTask: boolean;
  /** A task a person gave an agent has been finished by that agent (docs/agent-rules.md: agents finish their own tasks). */
  seenThrough: boolean;
}

export interface TeamSnapshot {
  total: number;
  working: number;
  waiting: number;
  members: TeamMember[];
}

export interface HomeSnapshot {
  team: TeamSnapshot;
  needs: NeedItem[];
  needsTotal: number;
  doneThisWeek: number;
  updates: UpdateItem[];
  steps: GettingStarted;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

/** An agent's page in KyoubeAI: the Studio profile (`/team/<key>`), which the core agent links also open. */
export function agentHref(agent: Pick<AgentLike, "id" | "urlKey">): string {
  return `/team/${encodeURIComponent(agent.urlKey || agent.id)}`;
}

export function issueHref(issue: Pick<IssueLike, "id" | "identifier">): string {
  return `/issues/${encodeURIComponent(issue.identifier || issue.id)}`;
}

function visibleIssues(issues: IssueLike[]): IssueLike[] {
  return issues.filter((issue) => issue.hiddenAt == null);
}

function newestFirst<T extends { updatedAt?: Date | string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));
}

function taskRef(issue: IssueLike): TaskRef {
  return { identifier: issue.identifier ?? "", title: issue.title, href: issueHref(issue) };
}

const STATE_RANK: Record<AgentState, number> = { working: 0, attention: 1, waiting: 2, paused: 3, idle: 4 };

/** Who is doing what, most active first. Terminated agents are left out. */
export function summarizeTeam(agents: AgentLike[], issues: IssueLike[]): TeamSnapshot {
  const live = agents.filter((agent) => agent.status !== "terminated");
  const tasks = newestFirst(visibleIssues(issues));
  const members = live.map((agent): TeamMember => {
    const mine = tasks.filter((issue) => issue.assigneeAgentId === agent.id);
    const running = mine.find((issue) => issue.executionRunId) ?? mine.find((issue) => issue.status === "in_progress") ?? null;
    const waitingOn = mine.find((issue) => issue.status === "in_review" || issue.status === "blocked") ?? null;
    let state: AgentState;
    let task: IssueLike | null = null;
    let detail: string;
    if (agent.status === "running") {
      state = "working";
      task = running;
      detail = task ? task.title : "Working";
    } else if (agent.status === "error") {
      state = "attention";
      detail = "Needs attention";
    } else if (waitingOn) {
      state = "waiting";
      task = waitingOn;
      detail = `Waiting on you${waitingOn.identifier ? ` · ${waitingOn.identifier}` : ""}`;
    } else if (agent.status === "paused") {
      state = "paused";
      detail = "Paused";
    } else if (agent.status === "pending_approval") {
      state = "paused";
      detail = "Awaiting approval";
    } else {
      state = "idle";
      task = running;
      detail = running ? `Next: ${running.title}` : "Idle";
    }
    return {
      id: agent.id,
      name: agent.name,
      title: agent.title ?? null,
      icon: agent.icon ?? null,
      href: agentHref(agent),
      state,
      detail,
      lastActiveAt: toIso(agent.lastHeartbeatAt),
      task: task ? taskRef(task) : null,
    };
  });
  members.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (toMs(b.lastActiveAt) ?? 0) - (toMs(a.lastActiveAt) ?? 0) || a.name.localeCompare(b.name));
  return {
    total: members.length,
    working: members.filter((member) => member.state === "working").length,
    waiting: members.filter((member) => member.state === "waiting").length,
    members,
  };
}

const APPROVAL_TITLES: Record<string, string> = {
  hire_agent: "Approve a new hire",
  approve_ceo_strategy: "Approve the strategy",
  budget_override_required: "Budget override needed",
  request_board_approval: "Approval requested",
};

function approvalTitle(approval: ApprovalLike): string {
  const payload = approval.payload ?? {};
  const named = [payload.title, payload.summary, payload.name].find((value) => typeof value === "string" && value.trim().length > 0) as string | undefined;
  const base = APPROVAL_TITLES[approval.type] ?? "Approval requested";
  if (!named) return base;
  return approval.type === "hire_agent" ? `Approve hiring ${named.trim()}` : `${base}: ${named.trim()}`;
}

/** What is waiting on a person, most urgent first: approvals, reviews, blocked tasks, agents in error. */
export function needsYou(agents: AgentLike[], issues: IssueLike[], approvals: ApprovalLike[]): NeedItem[] {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const items: NeedItem[] = [];
  for (const approval of [...approvals].sort((a, b) => (toMs(b.createdAt) ?? 0) - (toMs(a.createdAt) ?? 0))) {
    if (approval.status !== "pending" && approval.status !== "revision_requested") continue;
    items.push({
      kind: "approval",
      id: approval.id,
      title: approvalTitle(approval),
      action: "Decide",
      href: `/approvals/${encodeURIComponent(approval.id)}`,
      identifier: null,
      agentName: approval.requestedByAgentId ? names.get(approval.requestedByAgentId) ?? null : null,
      at: toIso(approval.createdAt),
    });
  }
  const tasks = newestFirst(visibleIssues(issues));
  for (const [status, kind, action] of [["in_review", "review", "Review"], ["blocked", "blocked", "Unblock"]] as const) {
    for (const issue of tasks.filter((row) => row.status === status)) {
      items.push({
        kind,
        id: issue.id,
        title: issue.title,
        action,
        href: issueHref(issue),
        identifier: issue.identifier ?? null,
        agentName: issue.assigneeAgentId ? names.get(issue.assigneeAgentId) ?? null : null,
        at: toIso(issue.updatedAt),
      });
    }
  }
  for (const agent of agents) {
    if (agent.status !== "error") continue;
    items.push({
      kind: "agent",
      id: agent.id,
      title: `${agent.name} stopped${agent.errorReason ? `: ${agent.errorReason}` : " with an error"}`,
      action: "Check",
      href: agentHref(agent),
      identifier: null,
      agentName: agent.name,
      at: toIso(agent.updatedAt),
    });
  }
  return items;
}

const UPDATE_LABELS: Record<string, { label: string; tone: UpdateItem["tone"] }> = {
  done: { label: "Done", tone: "teal" },
  in_review: { label: "Ready for review", tone: "violet" },
  blocked: { label: "Blocked", tone: "amber" },
  in_progress: { label: "In progress", tone: "sky" },
  cancelled: { label: "Cancelled", tone: "rose" },
};

/** The latest task changes, newest first. */
export function latestUpdates(agents: AgentLike[], issues: IssueLike[], limit = 5): UpdateItem[] {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  return newestFirst(visibleIssues(issues))
    .filter((issue) => toMs(issue.updatedAt) != null)
    .slice(0, limit)
    .map((issue) => {
      const created = toMs(issue.createdAt);
      const updated = toMs(issue.updatedAt) ?? 0;
      const known = UPDATE_LABELS[issue.status];
      const fresh = created != null && updated - created < 60_000;
      const { label, tone } = known ?? (fresh ? { label: "Created", tone: "sky" as const } : { label: "Updated", tone: "sky" as const });
      return {
        id: issue.id,
        label,
        identifier: issue.identifier ?? "",
        title: issue.title,
        href: issueHref(issue),
        agentName: issue.assigneeAgentId ? names.get(issue.assigneeAgentId) ?? null : null,
        tone,
        at: new Date(updated).toISOString(),
      };
    });
}

export function doneSince(issues: IssueLike[], sinceMs: number): number {
  return visibleIssues(issues).filter((issue) => issue.status === "done" && (toMs(issue.completedAt ?? issue.updatedAt) ?? 0) >= sinceMs).length;
}

export function gettingStarted(agents: AgentLike[], issues: IssueLike[]): GettingStarted {
  return {
    hireAgent: agents.some((agent) => agent.status !== "terminated"),
    giveTask: issues.length > 0,
    seenThrough: issues.some((issue) => issue.status === "done" && issue.createdByUserId != null && issue.assigneeAgentId != null),
  };
}

export function buildHome(agents: AgentLike[], issues: IssueLike[], approvals: ApprovalLike[], now: number, needsLimit = 6): HomeSnapshot {
  const needs = needsYou(agents, issues, approvals);
  return {
    team: summarizeTeam(agents, issues),
    needs: needs.slice(0, needsLimit),
    needsTotal: needs.length,
    doneThisWeek: doneSince(issues, now - 7 * DAY_MS),
    updates: latestUpdates(agents, issues),
    steps: gettingStarted(agents, issues),
  };
}
