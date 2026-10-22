import type { Prefs } from "./store.js";

/** A row from `ctx.access.members.list`. */
export interface MemberRow {
  principalType: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
}

export interface ActiveMember {
  userId: string;
  role: string;
}

export interface IssueLike {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  createdByUserId?: string | null;
  assigneeUserId?: string | null;
}

export interface InteractionLike {
  id: string;
  kind: string;
  status: string;
  title?: string | null;
  summary?: string | null;
  createdByAgentId?: string | null;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
}

/** Active people with a role, roles lower-cased. Agents, pending, suspended and archived members never get notifications. */
export function activeMembers(rows: MemberRow[]): ActiveMember[] {
  return rows
    .filter((row) => row.principalType === "user" && row.status === "active" && row.membershipRole)
    .map((row) => ({ userId: row.principalId, role: row.membershipRole!.toLowerCase() }));
}

/** The ids that are active members, each once, in order, without `exclude`. */
function only(members: ActiveMember[], ids: Array<string | null | undefined>, exclude: string | null): string[] {
  const active = new Set(members.map((member) => member.userId));
  const out: string[] = [];
  for (const id of ids) if (id && id !== exclude && active.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** An open question an agent asked a person (not another agent). */
export function isOpenAgentQuestion(interaction: InteractionLike): boolean {
  if (interaction.status !== "pending" || !interaction.createdByAgentId) return false;
  return !(interaction.addresseeAgentId && !interaction.addresseeUserId);
}

/** The person asked: the addressee (strict; left → nobody), or the first active member among creator and assignee. */
export function askRecipients(interaction: InteractionLike, issue: IssueLike, members: ActiveMember[]): string[] {
  if (interaction.addresseeUserId) {
    return only(members, [interaction.addresseeUserId], null);
  }
  // Find the first active member among creator and assignee
  const active = new Set(members.map((member) => member.userId));
  if (issue.createdByUserId && active.has(issue.createdByUserId)) {
    return [issue.createdByUserId];
  }
  if (issue.assigneeUserId && active.has(issue.assigneeUserId)) {
    return [issue.assigneeUserId];
  }
  return [];
}

/**
 * The core lets any member with write access decide an approval, so: every active member except viewers.
 * Need-to-know hides approvals entirely from `restricted` people, so they are left out too.
 */
export function approvalRecipients(members: ActiveMember[], actorUserId: string | null, restricted: Set<string>): string[] {
  return only(members, members.filter((member) => member.role !== "viewer" && !restricted.has(member.userId)).map((member) => member.userId), actorUserId);
}

/** A task's human creator and assignee, minus whoever caused the event. */
export function taskOwners(issue: IssueLike, members: ActiveMember[], actorUserId: string | null): string[] {
  return only(members, [issue.createdByUserId, issue.assigneeUserId], actorUserId);
}

export function failureRecipients(members: ActiveMember[], prefs: Map<string, Prefs>): string[] {
  return members.filter((member) => (member.role === "owner" || member.role === "admin") && prefs.get(member.userId)?.failures === true).map((member) => member.userId);
}

export function commentRecipients(issue: IssueLike, members: ActiveMember[], prefs: Map<string, Prefs>, authorUserId: string | null): string[] {
  return taskOwners(issue, members, authorUserId).filter((userId) => prefs.get(userId)?.comments === true);
}

/** "done" or "blocked" when a task moved into that status from a known different one; null otherwise. */
export function statusTransition(status: string, previous: string | null): "done" | "blocked" | null {
  if (status !== "done" && status !== "blocked") return null;
  if (previous === null || previous === status) return null;
  return status;
}
