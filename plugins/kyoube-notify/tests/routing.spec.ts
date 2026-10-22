import { describe, expect, it } from "vitest";
import {
  activeMembers, approvalRecipients, askRecipients, commentRecipients, failureRecipients, isOpenAgentQuestion, statusTransition, taskOwners,
  type InteractionLike, type IssueLike, type MemberRow,
} from "../src/routing.js";

const row = (principalId: string, membershipRole: string | null, status = "active", principalType = "user"): MemberRow => ({ principalType, principalId, status, membershipRole });
const members = activeMembers([
  row("owner", "owner"), row("admin", "ADMIN"), row("operator", "operator"), row("viewer", "viewer"),
  row("left", "admin", "archived"), row("pending", "admin", "pending"), row("agent-1", "admin", "active", "agent"), row("norole", null),
]);
const issue: IssueLike = { id: "i1", identifier: "ACM-1", title: "Launch post", status: "in_progress", createdByUserId: "owner", assigneeUserId: "operator" };
const question = (over: Partial<InteractionLike> = {}): InteractionLike => ({ id: "q1", kind: "request_confirmation", status: "pending", title: "Ship it?", createdByAgentId: "agent-1", ...over });
const prefs = (entries: Array<[string, { failures?: boolean; comments?: boolean }]>) => new Map(entries.map(([u, p]) => [u, { failures: p.failures ?? false, comments: p.comments ?? false }]));

describe("activeMembers", () => {
  it("keeps active people with a role, lower-cased", () => {
    expect(members).toEqual([
      { userId: "owner", role: "owner" }, { userId: "admin", role: "admin" }, { userId: "operator", role: "operator" }, { userId: "viewer", role: "viewer" },
    ]);
  });
});

describe("agent questions", () => {
  it("counts only open questions an agent asked a person", () => {
    expect(isOpenAgentQuestion(question())).toBe(true);
    expect(isOpenAgentQuestion(question({ status: "answered" }))).toBe(false);
    expect(isOpenAgentQuestion(question({ createdByAgentId: null }))).toBe(false);
    expect(isOpenAgentQuestion(question({ addresseeAgentId: "agent-2" }))).toBe(false);
    expect(isOpenAgentQuestion(question({ addresseeAgentId: "agent-2", addresseeUserId: "admin" }))).toBe(true);
  });

  it("goes to the addressee, else the task's creator, else its assignee", () => {
    expect(askRecipients(question({ addresseeUserId: "admin" }), issue, members)).toEqual(["admin"]);
    expect(askRecipients(question(), issue, members)).toEqual(["owner"]);
    expect(askRecipients(question(), { ...issue, createdByUserId: null }, members)).toEqual(["operator"]);
    expect(askRecipients(question(), { ...issue, createdByUserId: null, assigneeUserId: null }, members)).toEqual([]);
  });

  it("sends nothing when the person asked is no longer an active member", () => {
    expect(askRecipients(question({ addresseeUserId: "left" }), issue, members)).toEqual([]);
  });

  it("reaches the assignee when the creator has left", () => {
    expect(askRecipients(question(), { ...issue, createdByUserId: "left" }, members)).toEqual(["operator"]);
  });
});

describe("approvals", () => {
  it("go to every active member except viewers, never to whoever asked", () => {
    expect(approvalRecipients(members, null, new Set())).toEqual(["owner", "admin", "operator"]);
    expect(approvalRecipients(members, "admin", new Set())).toEqual(["owner", "operator"]);
  });

  it("leaves out restricted people", () => {
    expect(approvalRecipients(members, null, new Set(["operator"]))).toEqual(["owner", "admin"]);
    expect(approvalRecipients(members, "admin", new Set(["operator", "viewer"]))).toEqual(["owner"]);
    expect(approvalRecipients(members, null, new Set(["owner", "admin", "operator"]))).toEqual([]);
  });
});

describe("task status", () => {
  it("notifies on a move into done or blocked only", () => {
    expect(statusTransition("done", "in_progress")).toBe("done");
    expect(statusTransition("blocked", "todo")).toBe("blocked");
    expect(statusTransition("done", "done")).toBeNull();
    expect(statusTransition("done", null)).toBeNull();
    expect(statusTransition("in_review", "in_progress")).toBeNull();
  });

  it("tells the creator and the assignee once each, never the person who made the change", () => {
    expect(taskOwners(issue, members, null)).toEqual(["owner", "operator"]);
    expect(taskOwners(issue, members, "operator")).toEqual(["owner"]);
    expect(taskOwners({ ...issue, assigneeUserId: "owner" }, members, null)).toEqual(["owner"]);
    expect(taskOwners({ ...issue, createdByUserId: "left" }, members, null)).toEqual(["operator"]);
  });
});

describe("opt-ins", () => {
  it("sends failures to owners and admins who turned them on", () => {
    expect(failureRecipients(members, prefs([["owner", { failures: true }], ["operator", { failures: true }], ["admin", {}]]))).toEqual(["owner"]);
  });

  it("sends comments to the task's people who turned them on, never to the author", () => {
    const p = prefs([["owner", { comments: true }], ["operator", { comments: true }]]);
    expect(commentRecipients(issue, members, p, null)).toEqual(["owner", "operator"]);
    expect(commentRecipients(issue, members, p, "owner")).toEqual(["operator"]);
    expect(commentRecipients(issue, members, prefs([]), null)).toEqual([]);
  });
});
