import { createPolicyReader, isRestricted, MAX_ANCESTORS, restrictedPeople, taskVisible, type PolicyReader, type TaskFacts } from "@kyoube/visibility";
import type { ActiveMember } from "./routing.js";

/** What the company's need-to-know policy lets each person be told about. */
export interface VisibilityGate {
  /** The ids among `members` that need-to-know holds back from approvals: everyone but owners, admins and sees-all groups (everyone but owners and admins when the policy cannot be read). */
  restricted(companyId: string, members: ActiveMember[]): Promise<Set<string>>;
  /** Whether the person may see the task: they are involved in it or in one of its parents, or their groups list its project. Fails closed when the policy cannot be read. */
  canReadTask(companyId: string, person: ActiveMember, issueId: string): Promise<boolean>;
}

export function createVisibilityGate(deps: {
  reader?: PolicyReader;
  issues: { get(issueId: string, companyId: string): Promise<(TaskFacts & { parentId: string | null }) | null> };
}): VisibilityGate {
  const reader = deps.reader ?? createPolicyReader();

  return {
    async restricted(companyId, members) {
      return new Set(restrictedPeople(await reader.read(companyId), members).map((member) => member.userId));
    },

    async canReadTask(companyId, person, issueId) {
      const state = await reader.read(companyId);
      const restricted = isRestricted(state, person);
      if (restricted === false) return true;
      if (restricted === "closed" || state.state !== "need_to_know") return false;
      // The task, then its parents, at most MAX_ANCESTORS of them; a missing parent or a repeated id ends the walk.
      const chain: TaskFacts[] = [];
      const seen = new Set<string>();
      let id: string | null = issueId;
      while (id !== null && chain.length <= MAX_ANCESTORS && !seen.has(id)) {
        seen.add(id);
        const row = await deps.issues.get(id, companyId);
        if (!row) break;
        chain.push(row);
        id = row.parentId;
      }
      return taskVisible(state.policy, person, chain);
    },
  };
}
