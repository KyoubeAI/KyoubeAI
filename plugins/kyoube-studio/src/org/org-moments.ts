import type { OrgAgent, OrgState } from "./org-types.js";

export interface MomentSnapshot {
  agents: Map<string, { state: OrgState; taskId: string | null }>;
  done: Set<string>;
}

export type Moment = { kind: "finished" | "handover" | "problem"; agentId: string };

/** Freeze one poll of the team: each agent's state and task, plus the finished task ids. */
export function momentSnapshot(agents: OrgAgent[], doneTaskIds: Iterable<string>): MomentSnapshot {
  return {
    agents: new Map(agents.map((a) => [a.id, { state: a.state, taskId: a.task?.id ?? null }])),
    done: new Set(doneTaskIds),
  };
}

/** Compare two polls and name the small moments worth animating, finished first, cut to `limit`. */
export function diffMoments(previous: MomentSnapshot | null, next: MomentSnapshot, limit = 3): Moment[] {
  if (!previous) return [];

  const finished: Moment[] = [];
  const handovers: Moment[] = [];
  const problems: Moment[] = [];

  for (const [agentId, now] of next.agents) {
    const before = previous.agents.get(agentId);
    if (!before) continue;

    // Only the poll where the task turns done: a run that goes on keeps its done task on the card.
    if (before.taskId !== null && next.done.has(before.taskId) && !previous.done.has(before.taskId)) {
      finished.push({ kind: "finished", agentId });
    }
    if (now.taskId !== null && now.taskId !== before.taskId && !next.done.has(now.taskId)) {
      handovers.push({ kind: "handover", agentId });
    }
    if (before.state !== "attention" && now.state === "attention") {
      problems.push({ kind: "problem", agentId });
    }
  }

  return [...finished, ...handovers, ...problems].slice(0, limit);
}
