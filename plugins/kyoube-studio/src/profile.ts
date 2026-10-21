/**
 * The agent profile (Concept C): everything the Studio agent page shows about
 * one agent, shaped from the same snapshot as the roster and Home. Pure: the
 * worker passes in the agent's comments on its current task.
 */
import type { AskLevel } from "./ask-levels.js";
import { summarizeTeam, toMs, type AgentLike, type AgentState, type IssueLike } from "./model.js";

export interface ProfileAgentLike extends AgentLike {
  role?: string | null;
  reportsTo?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  capabilities?: string | null;
  pausedAt?: Date | string | null;
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number | null;
}

export interface CommentLike {
  body: string;
  authorAgentId?: string | null;
  createdAt?: Date | string | null;
}

export interface ProfileTask {
  id: string;
  identifier: string;
  title: string;
  status: string;
  statusLabel: string;
  href: string;
  at: string | null;
  /** The verb for a task that waits on a person ("Review", "Unblock"), else null. */
  action: string | null;
}

export interface WorkRelation {
  id: string;
  name: string;
  icon: string | null;
  href: string;
  relation: string;
}

export interface AgentProfile {
  found: true;
  agent: {
    id: string;
    name: string;
    urlKey: string;
    title: string | null;
    roleLabel: string;
    icon: string | null;
    status: string;
    harness: string | null;
    about: string | null;
    errorReason: string | null;
    pausedAt: string | null;
    lastActiveAt: string | null;
  };
  state: AgentState;
  detail: string;
  reportsTo: { id: string; name: string; href: string } | null;
  /** What it is working on now, with its own latest notes on that task (oldest first). */
  current: { task: ProfileTask; notes: Array<{ text: string; at: string | null }> } | null;
  /** The task that waits on a person, when it is waiting. */
  waitingOn: ProfileTask | null;
  recent: ProfileTask[];
  tasks: { active: ProfileTask[]; waiting: ProfileTask[]; queued: ProfileTask[]; done: ProfileTask[] };
  stats: { doneThisWeek: number; open: number; spentMonthlyCents: number; budgetMonthlyCents: number };
  skills: string[];
  worksWith: WorkRelation[];
  /** The core pages the profile's tab row links to. */
  links: { instructions: string; skills: string; runs: string; settings: string; classic: string };
  /**
   * Added by the worker: whether it may change agents, which agents it may ask (null for a
   * built-in agent, which keeps the default), and whether the viewer may change either.
   * Null when the host would not say.
   */
  access?: { canChangeAgents: boolean; canManage: boolean; askLevel: AskLevel | null } | null;
}

export type ProfileResult = AgentProfile | { found: false };

const DAY_MS = 24 * 60 * 60 * 1000;

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO", cto: "CTO", cmo: "CMO", cfo: "CFO", coo: "COO", security: "Security", engineer: "Engineer",
  designer: "Designer", pm: "PM", qa: "QA", devops: "DevOps", researcher: "Researcher", general: "General",
};

/** The harness an agent runs on, as people call it. */
const HARNESS_LABELS: Record<string, string> = {
  claude_local: "Claude Code", pi_local: "pi", hermes_local: "Hermes", codex_local: "Codex", gemini_local: "Gemini CLI",
  cursor_local: "Cursor", cursor: "Cursor", cursor_cloud: "Cursor Cloud", opencode_local: "OpenCode", grok_local: "Grok",
  kimi_local: "Kimi", openclaw_gateway: "OpenClaw",
};

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress", in_review: "Waiting for your review", blocked: "Blocked", todo: "To do",
  backlog: "Backlog", done: "Done", cancelled: "Cancelled",
};

/** The Studio profile page for an agent. */
export function profileHref(agent: Pick<AgentLike, "id" | "urlKey">): string {
  return `/team/${encodeURIComponent(agent.urlKey || agent.id)}`;
}

/** One of the core's own agent views (instructions, skills, runtime, overview). */
export function coreAgentHref(agent: Pick<AgentLike, "id" | "urlKey">, tab: string): string {
  return `/agents/${encodeURIComponent(agent.urlKey || agent.id)}/${tab}`;
}

function iso(value: Date | string | null | undefined): string | null {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function task(issue: IssueLike): ProfileTask {
  return {
    id: issue.id,
    identifier: issue.identifier ?? "",
    title: issue.title,
    status: issue.status,
    statusLabel: STATUS_LABELS[issue.status] ?? issue.status,
    href: `/issues/${encodeURIComponent(issue.identifier || issue.id)}`,
    at: iso(issue.status === "done" ? issue.completedAt ?? issue.updatedAt : issue.updatedAt),
    action: issue.status === "in_review" ? "Review" : issue.status === "blocked" ? "Unblock" : null,
  };
}

/** A readable name for a skill key: "plugin/kyoube-apps/kyoube-data" is "Kyoube Data". */
export function skillLabel(key: string): string {
  const slug = key.split("/").filter(Boolean).pop() ?? key;
  return slug.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * The skills an agent is set to use, from its adapter configuration. The
 * core's own built-in operating skills (`paperclipai/...`) come with every
 * agent, so they are not listed.
 */
export function agentSkills(agent: ProfileAgentLike): string[] {
  const sync = (agent.adapterConfig?.paperclipSkillSync ?? null) as { desiredSkills?: unknown } | null;
  const desired = Array.isArray(sync?.desiredSkills) ? sync!.desiredSkills : [];
  const keys = desired
    .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string" ? (entry as { key: string }).key : null))
    .filter((key): key is string => !!key && !key.startsWith("paperclipai/"));
  return [...new Set(keys.map(skillLabel))];
}

/** First line of a markdown comment as plain text, trimmed to one short line. */
export function noteText(body: string, max = 140): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !/^(```|---)/.test(l)) ?? "";
  const plain = line.replace(/^[#>*\-\d.\s]+/, "").replace(/[*_`~]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export function buildProfile(
  ref: string,
  agents: ProfileAgentLike[],
  issues: IssueLike[],
  comments: CommentLike[],
  now: number,
): ProfileResult {
  const agent = agents.find((a) => a.status !== "terminated" && (a.urlKey === ref || a.id === ref));
  if (!agent) return { found: false };

  const member = summarizeTeam(agents, issues).members.find((m) => m.id === agent.id)!;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const mine = issues
    .filter((issue) => issue.hiddenAt == null && issue.assigneeAgentId === agent.id)
    .sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));

  const active = mine.filter((i) => i.status === "in_progress");
  const waiting = mine.filter((i) => i.status === "in_review" || i.status === "blocked");
  const queued = mine.filter((i) => i.status === "todo" || i.status === "backlog");
  const done = mine.filter((i) => i.status === "done");

  const currentIssue = member.state === "working" ? (mine.find((i) => i.executionRunId) ?? active[0] ?? null) : null;
  const notes = currentIssue
    ? comments
      .filter((c) => c.authorAgentId === agent.id)
      .sort((a, b) => (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0))
      .slice(-3)
      .map((c) => ({ text: noteText(c.body), at: iso(c.createdAt) }))
      .filter((n) => n.text.length > 0)
    : [];

  // Who it works with: its manager, its reports, and the agents that hand it
  // work or take work from it (from who created the tasks). One line each.
  const relations = new Map<string, WorkRelation>();
  const relate = (id: string | null | undefined, relation: string) => {
    if (!id || id === agent.id || relations.has(id)) return;
    const other = byId.get(id);
    if (!other || other.status === "terminated") return;
    relations.set(id, { id, name: other.name, icon: other.icon ?? null, href: profileHref(other), relation });
  };
  relate(agent.reportsTo, "Its manager");
  for (const other of agents) if (other.reportsTo === agent.id) relate(other.id, "Reports to it");
  const counts = (pairs: Array<string | null | undefined>) => {
    const tally = new Map<string, number>();
    for (const id of pairs) if (id && id !== agent.id) tally.set(id, (tally.get(id) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]);
  };
  for (const [id, n] of counts(mine.map((i) => i.createdByAgentId))) relate(id, `Gives it work · ${n} ${n === 1 ? "task" : "tasks"}`);
  for (const [id, n] of counts(issues.filter((i) => i.createdByAgentId === agent.id && i.hiddenAt == null).map((i) => i.assigneeAgentId))) relate(id, `Takes its work · ${n} ${n === 1 ? "task" : "tasks"}`);

  const manager = agent.reportsTo ? byId.get(agent.reportsTo) : undefined;
  return {
    found: true,
    agent: {
      id: agent.id,
      name: agent.name,
      urlKey: agent.urlKey || agent.id,
      title: agent.title ?? null,
      roleLabel: (agent.role && ROLE_LABELS[agent.role]) || (agent.role ? agent.role.charAt(0).toUpperCase() + agent.role.slice(1) : "Agent"),
      icon: agent.icon ?? null,
      status: agent.status,
      harness: agent.adapterType ? HARNESS_LABELS[agent.adapterType] ?? agent.adapterType : null,
      about: agent.capabilities?.trim() || null,
      errorReason: agent.errorReason ?? null,
      pausedAt: iso(agent.pausedAt),
      lastActiveAt: iso(agent.lastHeartbeatAt),
    },
    state: member.state,
    detail: member.detail,
    reportsTo: manager && manager.status !== "terminated" ? { id: manager.id, name: manager.name, href: profileHref(manager) } : null,
    current: currentIssue ? { task: task(currentIssue), notes } : null,
    waitingOn: member.state === "waiting" && waiting[0] ? task(waiting[0]) : null,
    recent: mine.slice(0, 5).map(task),
    tasks: { active: active.map(task), waiting: waiting.map(task), queued: queued.map(task), done: done.slice(0, 20).map(task) },
    stats: {
      doneThisWeek: done.filter((i) => (toMs(i.completedAt ?? i.updatedAt) ?? 0) >= now - 7 * DAY_MS).length,
      open: active.length + waiting.length + queued.length,
      spentMonthlyCents: agent.spentMonthlyCents ?? 0,
      budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
    },
    skills: agentSkills(agent),
    worksWith: [...relations.values()].slice(0, 5),
    links: {
      instructions: coreAgentHref(agent, "instructions"),
      skills: coreAgentHref(agent, "skills"),
      // Since core 2026.916 an agent's runs live under Audit, filtered to it.
      runs: `/activity/runs?agentId=${encodeURIComponent(agent.id)}`,
      settings: coreAgentHref(agent, "runtime"),
      classic: `${coreAgentHref(agent, "overview")}?classic=1`,
    },
  };
}
