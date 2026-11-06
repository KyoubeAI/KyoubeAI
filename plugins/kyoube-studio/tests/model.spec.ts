import { describe, expect, it } from "vitest";
import { awaitingSetup, buildHome, doneSince, gettingStarted, latestUpdates, needsYou, summarizeTeam, type AgentLike, type ApprovalLike, type IssueLike } from "../src/model.js";

const NOW = Date.parse("2026-09-24T09:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const agents: AgentLike[] = [
  { id: "a-writer", name: "Ambassador Content Agent", urlKey: "ambassador-content-agent", title: "LinkedIn Ambassador Content Agent", icon: "sparkles", status: "running", lastHeartbeatAt: ago(1) },
  { id: "a-pm", name: "AI Project Manager", urlKey: "ai-project-manager", title: "AI Project Manager", icon: "target", status: "idle", lastHeartbeatAt: ago(30) },
  { id: "a-lead", name: "AI Delivery Lead", urlKey: "ai-delivery-lead", icon: "rocket", status: "error", errorReason: "harness not logged in", lastHeartbeatAt: ago(90), updatedAt: ago(5) },
  { id: "a-mgr", name: "AI Manager", urlKey: "ai-manager", icon: null, status: "idle", lastHeartbeatAt: ago(600) },
  { id: "a-old", name: "Retired", urlKey: "retired", status: "terminated" },
  { id: "a-paused", name: "Marketing Manager", urlKey: "marketing-manager", icon: "heart", status: "paused" },
];

const issues: IssueLike[] = [
  { id: "i1", identifier: "BAP-41", title: "Approve LinkedIn post", status: "in_review", assigneeAgentId: "a-writer", createdAt: ago(60), updatedAt: ago(20) },
  { id: "i2", identifier: "BAP-45", title: "Three posts for the launch", status: "in_progress", assigneeAgentId: "a-writer", executionRunId: "run-1", createdAt: ago(50), updatedAt: ago(2) },
  { id: "i3", identifier: "BAP-38", title: "Q4 delivery plan", status: "in_review", assigneeAgentId: "a-pm", createdAt: ago(300), updatedAt: ago(60) },
  { id: "i4", identifier: "BAP-44", title: "CRM import", status: "blocked", assigneeAgentId: "a-lead", createdAt: ago(200), updatedAt: ago(120) },
  { id: "i5", identifier: "BAP-40", title: "Campaign brief", status: "done", assigneeAgentId: "a-paused", createdByAgentId: "a-mgr", createdAt: ago(3000), updatedAt: ago(1000), completedAt: ago(1000) },
  { id: "i6", identifier: "BAP-30", title: "Old work", status: "done", createdAt: ago(20000), updatedAt: ago(12000), completedAt: ago(12000) },
  { id: "i7", identifier: "BAP-50", title: "Hidden", status: "in_review", hiddenAt: ago(1), updatedAt: ago(1) },
  { id: "i8", identifier: "BAP-51", title: "Fresh idea", status: "todo", createdAt: ago(3), updatedAt: ago(3) },
];

const approvals: ApprovalLike[] = [
  { id: "ap1", type: "hire_agent", status: "pending", requestedByAgentId: "a-mgr", payload: { name: "Sales Scout" }, createdAt: ago(10) },
  { id: "ap2", type: "budget_override_required", status: "approved", createdAt: ago(10) },
];

describe("summarizeTeam", () => {
  const team = summarizeTeam(agents, issues);

  it("leaves terminated agents out and counts who is working or waiting", () => {
    expect(team.total).toBe(5);
    expect(team.members.map((m) => m.name)).not.toContain("Retired");
    expect(team.working).toBe(1);
    expect(team.waiting).toBe(1);
  });

  it("carries each agent's manager and the current task's id", () => {
    const team = summarizeTeam(
      [{ id: "m", name: "Ava", status: "idle" }, { id: "a", name: "Kai", status: "running", reportsTo: "m" }],
      [{ id: "i1", identifier: "CUBE-12", title: "Ship it", status: "in_progress", assigneeAgentId: "a", executionRunId: "r1" }],
    );
    const kai = team.members.find((m) => m.id === "a")!;
    expect(kai.reportsTo).toBe("m");
    expect(kai.task).toMatchObject({ id: "i1", identifier: "CUBE-12" });
    expect(team.members.find((m) => m.id === "m")!.reportsTo).toBeNull();
  });

  it("orders working, then needs attention, then waiting, then paused, then idle", () => {
    expect(team.members.map((m) => m.state)).toEqual(["working", "attention", "waiting", "paused", "idle"]);
  });

  it("says what a working agent is doing and what a waiting one waits on", () => {
    const writer = team.members.find((m) => m.id === "a-writer")!;
    expect(writer.detail).toBe("Three posts for the launch");
    expect(writer.task).toEqual({ id: "i2", identifier: "BAP-45", title: "Three posts for the launch", href: "/issues/BAP-45" });
    const pm = team.members.find((m) => m.id === "a-pm")!;
    expect(pm.detail).toBe("Waiting on you · BAP-38");
    expect(pm.href).toBe("/team/ai-project-manager");
  });

  // Core 2026.1023's lifecycle keeps status "paused" while an agent resumes, until its worker finishes.
  it("shows an agent the core is still resuming as coming back on duty, and one it is pausing as paused", () => {
    const resuming = summarizeTeam([{ id: "a-r", name: "R", status: "paused", lifecycleState: "resuming" }], []).members[0]!;
    expect([resuming.state, resuming.detail]).toEqual(["idle", "Coming back on duty"]);
    const pausing = summarizeTeam([{ id: "a-p", name: "P", status: "paused", lifecycleState: "pausing" }], []).members[0]!;
    expect([pausing.state, pausing.detail]).toEqual(["paused", "Paused"]);
  });

  // Since 2026.1023 a new agent takes work only once its harness answers the core's check, retried every minute.
  it("shows an agent the core is still setting up as checking, and one whose check failed as waiting for its AI connection", () => {
    const member = (agent: Partial<AgentLike>) => summarizeTeam([{ id: "a-n", name: "N", status: "paused", ...agent }], []).members[0]!;
    expect([member({ lifecycleState: "preparing" }).state, member({ lifecycleState: "preparing" }).detail]).toEqual(["idle", "Getting ready"]);
    expect([member({ lifecycleState: "verifying" }).state, member({ lifecycleState: "verifying" }).detail]).toEqual(["idle", "Checking its AI connection"]);
    const failed = member({ lifecycleState: "verifying", lifecycleError: "The lifecycle step failed. Retry the operation." });
    expect([failed.state, failed.detail]).toEqual(["attention", "Waiting for its AI connection"]);
    const failedSetup = member({ lifecycleState: "preparing", lifecycleError: "The lifecycle step failed. Retry the operation." });
    expect([failedSetup.state, failedSetup.detail]).toEqual(["attention", "Could not get ready"]);
    // A ready agent with a stale error is just its status.
    expect(member({ status: "idle", lifecycleState: "ready", lifecycleError: "old" }).detail).toBe("Idle");
  });

  it("knows which lifecycle states are on their way to on duty, as the core's isAgentAwaitingSetup does", () => {
    expect(["preparing", "verifying", "resuming"].every((s) => awaitingSetup(s))).toBe(true);
    expect([null, undefined, "ready", "paused", "pausing", "terminating"].some((s) => awaitingSetup(s))).toBe(false);
  });

  it("marks an agent in error as needing attention, even with work in review", () => {
    expect(team.members.find((m) => m.id === "a-lead")!.detail).toBe("Needs attention");
  });

  it("keeps the last run time of an idle agent for the UI", () => {
    const mgr = team.members.find((m) => m.id === "a-mgr")!;
    expect(mgr.state).toBe("idle");
    expect(mgr.lastActiveAt).toBe(ago(600));
  });
});

describe("needsYou", () => {
  const needs = needsYou(agents, issues, approvals);

  it("lists pending approvals, then reviews, then blocked tasks, then agents in error", () => {
    expect(needs.map((n) => `${n.kind}:${n.id}`)).toEqual(["approval:ap1", "review:i1", "review:i3", "blocked:i4", "agent:a-lead"]);
  });

  it("gives every item one verb and a link into the app", () => {
    expect(needs.map((n) => n.action)).toEqual(["Decide", "Review", "Review", "Unblock", "Check"]);
    expect(needs[0]).toMatchObject({ title: "Approve hiring Sales Scout", href: "/approvals/ap1", agentName: "AI Manager" });
    expect(needs[1]).toMatchObject({ identifier: "BAP-41", agentName: "Ambassador Content Agent", href: "/issues/BAP-41" });
    expect(needs[4]!.title).toBe("AI Delivery Lead stopped: harness not logged in");
  });

  it("skips hidden tasks", () => {
    expect(needs.some((n) => n.id === "i7")).toBe(false);
  });
});

describe("latestUpdates", () => {
  it("shows the newest task changes with a label for their state", () => {
    const updates = latestUpdates(agents, issues, 4);
    expect(updates.map((u) => `${u.label}: ${u.identifier}`)).toEqual(["In progress: BAP-45", "Created: BAP-51", "Ready for review: BAP-41", "Ready for review: BAP-38"]);
    expect(updates[0]).toMatchObject({ tone: "sky", agentName: "Ambassador Content Agent", href: "/issues/BAP-45" });
  });
});

describe("counts and steps", () => {
  it("counts tasks finished in the window", () => {
    expect(doneSince(issues, NOW - 7 * 24 * 60 * 60_000)).toBe(1);
  });

  it("ticks off the getting-started steps from what exists", () => {
    expect(gettingStarted([], [])).toEqual({ hireAgent: false, giveTask: false, seenThrough: false });
    expect(gettingStarted(agents, issues)).toEqual({ hireAgent: true, giveTask: true, seenThrough: false });
    const finished: IssueLike = { id: "i9", identifier: "BAP-52", title: "Post written", status: "done", assigneeAgentId: "a-writer", createdByUserId: "user-1", updatedAt: ago(5) };
    expect(gettingStarted(agents, [...issues, finished])).toEqual({ hireAgent: true, giveTask: true, seenThrough: true });
    // The step is about a person's task: one an agent created does not count.
    expect(gettingStarted(agents, [{ ...finished, createdByUserId: null, createdByAgentId: "a-mgr" }]).seenThrough).toBe(false);
  });

  it("builds the whole Home snapshot and caps the Needs you list", () => {
    const home = buildHome(agents, issues, approvals, NOW, 3);
    expect(home.needs).toHaveLength(3);
    expect(home.needsTotal).toBe(5);
    expect(home.doneThisWeek).toBe(1);
    expect(home.team.total).toBe(5);
    expect(home.updates.length).toBeGreaterThan(0);
  });

  it("accepts Date objects as well as the ISO strings the bridge delivers", () => {
    const withDates = issues.map((i) => ({ ...i, updatedAt: i.updatedAt ? new Date(i.updatedAt as string) : null }));
    expect(latestUpdates(agents, withDates, 1)[0]!.identifier).toBe("BAP-45");
  });
});
