// The need-to-know decision: who is restricted, and which work objects a restricted person
// may see. Pure functions over the compiled policy. No dependencies on purpose: this file is
// bundled into the core's dependency-free decision module.

import type { CompanyPolicy } from "./policy.js";

/** What the loader knows about a company: open, need-to-know with its policy, or unreadable. */
export type PolicyState = { state: "open" } | { state: "need_to_know"; policy: CompanyPolicy } | { state: "closed"; reason: string };

export interface Person {
  userId: string;
  /** The person's membership role in the company, if they have one. */
  role: string | null;
  instanceAdmin?: boolean;
}

/** Roles that always see everything in their company. */
export const MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function isManager(role: string | null): boolean {
  return role !== null && MANAGER_ROLES.has(role.toLowerCase());
}

/**
 * False when the person sees everything (open company, manager, instance admin, sees-all group),
 * true when need-to-know applies, "closed" when the policy could not be read and the person is
 * not a manager (managers and instance admins are never locked out by a broken policy).
 */
export function isRestricted(state: PolicyState, person: Person): false | true | "closed" {
  if (state.state === "open") return false;
  if (person.instanceAdmin === true || isManager(person.role)) return false;
  if (state.state === "closed") return "closed";
  return !state.policy.seesAll.includes(person.userId);
}

/** One work object, with the columns that say who is involved in it. */
export interface TaskFacts {
  id: string;
  projectId: string | null;
  parentId: string | null;
  createdByUserId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  conversationUserId: string | null;
}

/** How many parents above a task count towards its visibility. */
export const MAX_ANCESTORS = 20;

/**
 * A person without a user id (null, undefined, empty) matches nothing. The type says `string`, but the
 * core's plain-JS patch calls this bundle, and a null id would otherwise equal every null column.
 */
function hasUserId(person: Person): boolean {
  return typeof person.userId === "string" && person.userId !== "";
}

/** True iff a group the person is in includes the project. */
export function projectVisible(policy: CompanyPolicy, person: Person, projectId: string | null): boolean {
  if (!hasUserId(person) || projectId === null || !Object.hasOwn(policy.projects, projectId)) return false;
  return policy.projects[projectId]?.includes(person.userId) ?? false;
}

/** True when the person made, holds, answers for or talks in the task, or can see its project. */
export function involved(policy: CompanyPolicy, person: Person, facts: TaskFacts): boolean {
  if (!hasUserId(person)) return false;
  return (
    facts.createdByUserId === person.userId ||
    facts.assigneeUserId === person.userId ||
    facts.responsibleUserId === person.userId ||
    facts.conversationUserId === person.userId ||
    projectVisible(policy, person, facts.projectId)
  );
}

/**
 * `chain[0]` is the task, then its parent, its grandparent and so on. Visible when the person is
 * involved in the task or in any of its first MAX_ANCESTORS ancestors. A repeated id is a cycle
 * and ends the walk.
 */
export function taskVisible(policy: CompanyPolicy, person: Person, chain: TaskFacts[]): boolean {
  const seen = new Set<string>();
  for (const facts of chain.slice(0, MAX_ANCESTORS + 1)) {
    if (seen.has(facts.id)) return false;
    seen.add(facts.id);
    if (involved(policy, person, facts)) return true;
  }
  return false;
}

/** The authorization actions need-to-know applies to. Every other action passes through. */
export const COVERED_ACTIONS = ["issue:read", "issue:comment", "issue:mutate", "project:read", "company_scope:read", "tasks:assign"] as const;

export function isCoveredAction(action: string): boolean {
  return (COVERED_ACTIONS as readonly string[]).includes(action);
}

export const MESSAGES = {
  hidden: "This is outside what you can see in this company. Ask an owner or admin to add you to a group that includes it.",
  closed: "KyoubeAI could not read this company's visibility policy, so this is refused. An instance admin can run kyoube doctor to see why.",
} as const;

export type Denial = { reason: "deny_kyoube_visibility" | "deny_kyoube_visibility_unavailable"; explanation: string };

export const HIDDEN: Denial = { reason: "deny_kyoube_visibility", explanation: MESSAGES.hidden };
export const CLOSED: Denial = { reason: "deny_kyoube_visibility_unavailable", explanation: MESSAGES.closed };

/** The members need-to-know (or a closed policy) holds back, in input order. */
export function restrictedPeople(state: PolicyState, members: Array<{ userId: string; role: string | null }>): Array<{ userId: string; role: string | null }> {
  return members.filter((member) => isRestricted(state, member) !== false);
}
