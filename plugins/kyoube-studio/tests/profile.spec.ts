import { describe, expect, it } from "vitest";
import type { IssueLike } from "../src/model.js";
import { agentSkills, buildProfile, coreAgentHref, noteText, profileHref, skillLabel, type AgentProfile, type ProfileAgentLike } from "../src/profile.js";

const NOW = Date.parse("2026-09-24T09:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const agents: ProfileAgentLike[] = [
  { id: "mgr", name: "AI Manager", urlKey: "ai-manager", icon: null, status: "idle", role: "general", title: "BAP AI Manager", adapterType: "pi_local" },
  {
    id: "writer", name: "Ambassador Content Agent", urlKey: "ambassador-content-agent", icon: "sparkles", status: "running", role: "designer",
    title: "LinkedIn Ambassador Content Agent", reportsTo: "mgr", adapterType: "pi_local", capabilities: "Writes posts in the brand voice.",
    lastHeartbeatAt: ago(1), spentMonthlyCents: 310, budgetMonthlyCents: 5000,
    adapterConfig: { paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/paperclip", "plugin/kyoube-apps/kyoube-data", { key: "blader/humanizer/humanizer", versionId: null }, "plugin/kyoube-apps/kyoube-data"] } },
  },
  { id: "mkt", name: "Marketing Manager", urlKey: "marketing-manager", icon: "heart", status: "idle", role: "cmo", reportsTo: "writer", adapterType: "claude_local" },
  { id: "gone", name: "Retired", urlKey: "retired", status: "terminated" },
];

const issues: IssueLike[] = [
  { id: "i45", identifier: "BAP-45", title: "Three posts for the launch", status: "in_progress", assigneeAgentId: "writer", executionRunId: "run-1", createdByAgentId: "mgr", updatedAt: ago(2) },
  { id: "i41", identifier: "BAP-41", title: "Approve LinkedIn post", status: "in_review", assigneeAgentId: "writer", createdByAgentId: "mgr", updatedAt: ago(20) },
  { id: "i36", identifier: "BAP-36", title: "Tone of voice guide", status: "done", assigneeAgentId: "writer", completedAt: ago(60 * 24), updatedAt: ago(60 * 24) },
  { id: "i20", identifier: "BAP-20", title: "Old brief", status: "done", assigneeAgentId: "writer", completedAt: ago(60 * 24 * 12), updatedAt: ago(60 * 24 * 12) },
  { id: "i50", identifier: "BAP-50", title: "Next idea", status: "todo", assigneeAgentId: "writer", updatedAt: ago(300) },
  { id: "i60", identifier: "BAP-60", title: "Review drafts", status: "todo", assigneeAgentId: "mkt", createdByAgentId: "writer", updatedAt: ago(30) },
  { id: "i99", identifier: "BAP-99", title: "Hidden", status: "in_review", assigneeAgentId: "writer", hiddenAt: ago(1), updatedAt: ago(1) },
];

const comments = [
  { body: "Read the **ambassador brief** in Files", authorAgentId: "writer", createdAt: ago(40) },
  { body: "Someone else", authorAgentId: "mgr", createdAt: ago(35) },
  { body: "## Drafted post 1 of 3", authorAgentId: "writer", createdAt: ago(20) },
  { body: "Writing post 2: [A week with our ambassadors](https://example.com)", authorAgentId: "writer", createdAt: ago(5) },
];

function profileOf(ref: string, withComments = comments): AgentProfile {
  const result = buildProfile(ref, agents, issues, withComments, NOW);
  if (!result.found) throw new Error("not found");
  return result;
}

describe("buildProfile", () => {
  it("finds an agent by URL key or id, never a terminated one", () => {
    expect(profileOf("ambassador-content-agent").agent.id).toBe("writer");
    expect(profileOf("writer").agent.urlKey).toBe("ambassador-content-agent");
    expect(buildProfile("retired", agents, issues, [], NOW)).toEqual({ found: false });
    expect(buildProfile("nobody", agents, issues, [], NOW)).toEqual({ found: false });
  });

  it("describes the agent the way the header shows it", () => {
    const { agent, reportsTo, state } = profileOf("writer");
    expect(agent).toMatchObject({ name: "Ambassador Content Agent", title: "LinkedIn Ambassador Content Agent", roleLabel: "Designer", harness: "pi", about: "Writes posts in the brand voice." });
    expect(reportsTo).toEqual({ id: "mgr", name: "AI Manager", href: "/team/ai-manager" });
    expect(state).toBe("working");
    expect(profileOf("mkt").agent.harness).toBe("Claude Code");
    expect(profileOf("mkt").agent.roleLabel).toBe("CMO");
    const agyProfile = buildProfile("mkt", [{ ...agents[2]!, adapterType: "antigravity_local" }], [], [], NOW);
    expect(agyProfile.found && agyProfile.agent.harness).toBe("Antigravity");
  });

  it("shows what it is working on with its own latest notes, oldest first, as plain text", () => {
    const { current } = profileOf("writer");
    expect(current!.task).toMatchObject({ identifier: "BAP-45", href: "/issues/BAP-45", statusLabel: "In progress" });
    expect(current!.notes.map((n) => n.text)).toEqual(["Read the ambassador brief in Files", "Drafted post 1 of 3", "Writing post 2: A week with our ambassadors"]);
  });

  it("groups its tasks, skips hidden ones, and counts the week", () => {
    const { tasks, recent, stats } = profileOf("writer");
    expect(tasks.active.map((t) => t.identifier)).toEqual(["BAP-45"]);
    expect(tasks.waiting.map((t) => [t.identifier, t.action])).toEqual([["BAP-41", "Review"]]);
    expect(tasks.queued.map((t) => t.identifier)).toEqual(["BAP-50"]);
    expect(tasks.done.map((t) => t.identifier)).toEqual(["BAP-36", "BAP-20"]);
    expect(recent.map((t) => t.identifier)).toEqual(["BAP-45", "BAP-41", "BAP-50", "BAP-36", "BAP-20"]);
    expect(stats).toEqual({ doneThisWeek: 1, open: 3, spentMonthlyCents: 310, budgetMonthlyCents: 5000 });
  });

  it("lists who it works with: manager, reports, and who hands it work or takes its work", () => {
    expect(profileOf("writer").worksWith.map((w) => `${w.name}: ${w.relation}`)).toEqual(["AI Manager: Its manager", "Marketing Manager: Reports to it"]);
    expect(profileOf("mgr").worksWith.map((w) => `${w.name}: ${w.relation}`)).toEqual(["Ambassador Content Agent: Reports to it"]);
    expect(profileOf("mkt").worksWith.map((w) => w.relation)).toEqual(["Its manager"]);
  });

  it("lists its skills by name, without the core's built-in ones or duplicates", () => {
    expect(profileOf("writer").skills).toEqual(["Kyoube Data", "Humanizer"]);
    expect(agentSkills({ id: "x", name: "x", status: "idle" })).toEqual([]);
  });

  it("links the core's own agent views, its runs under Audit, and keeps the core overview reachable", () => {
    expect(profileOf("writer").links).toEqual({
      instructions: "/agents/ambassador-content-agent/instructions",
      skills: "/agents/ambassador-content-agent/skills",
      runs: "/activity/runs?agentId=writer",
      settings: "/agents/ambassador-content-agent/runtime",
      classic: "/agents/ambassador-content-agent/overview?classic=1",
    });
  });

  it("says what waits on you when the agent is waiting", () => {
    const waitingAgents = agents.map((a) => (a.id === "writer" ? { ...a, status: "idle" } : a));
    const result = buildProfile("writer", waitingAgents, issues.filter((i) => i.status !== "in_progress"), [], NOW);
    expect(result.found && result.state).toBe("waiting");
    expect(result.found && result.waitingOn?.identifier).toBe("BAP-41");
    expect(result.found && result.current).toBeNull();
  });
});

describe("helpers", () => {
  it("names skills and paths", () => {
    expect(skillLabel("plugin/kyoube-apps/kyoube-data")).toBe("Kyoube Data");
    expect(skillLabel("company/abc/teams-ambassador-post")).toBe("Teams Ambassador Post");
    expect(profileHref({ id: "x", urlKey: "ai-manager" })).toBe("/team/ai-manager");
    expect(coreAgentHref({ id: "x", urlKey: null }, "runs")).toBe("/agents/x/runs");
  });

  it("turns a markdown comment into one short line", () => {
    expect(noteText("\n\n> **Done**: shipped it")).toBe("Done: shipped it");
    expect(noteText("```\ncode\n```\nAfter the block")).toBe("code");
    expect(noteText("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });
});
