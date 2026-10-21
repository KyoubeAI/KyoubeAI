import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeSnapshot, TeamMember, TeamSnapshot } from "../src/model.js";
import { AgentProfilePage, StudioBuildLabel, StudioFooter, StudioHome, StudioRoutinesLink, StudioTeam, WorkspacePage } from "../src/ui/index.js";
import { parseTeamPath } from "../src/ui/Profile.js";
import { headline } from "../src/ui/Home.js";
import { memberDetail } from "../src/ui/nav.js";
import { isActivePath } from "../src/ui/shared.js";
import { ensureStyles } from "../src/ui/styles.js";
import { greeting, timeAgo } from "../src/ui/time.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
const context = { companyId: "c1", companyPrefix: "BAP", projectId: null, entityId: null, entityType: null, userId: "u1" };

function installBridge(data: Record<string, unknown>, pathname = "/BAP/dashboard") {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => context,
      useHostLocation: () => ({ pathname, search: "", hash: "" }),
      useHostNavigation: () => ({ resolveHref: (to: string) => `/BAP${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/BAP${to}`, onClick: () => {} }) }),
      usePluginData: (key: string) => (key in data ? { data: data[key], loading: false, error: null, refresh: () => {} } : { data: null, loading: true, error: null, refresh: () => {} }),
      usePluginToast: () => () => null,
      usePluginAction: () => async () => ({}),
    },
  };
}
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

const render = (component: unknown, props: Record<string, unknown> = { context }) => renderToStaticMarkup(createElement(component as never, props as never));

function member(i: number, overrides: Partial<TeamMember> = {}): TeamMember {
  return { id: `a${i}`, name: `Agent ${i}`, title: null, icon: "rocket", href: `/agents/agent-${i}`, state: "idle", detail: "Idle", lastActiveAt: null, task: null, ...overrides };
}
const team = (members: TeamMember[]): TeamSnapshot => ({ total: members.length, working: members.filter((m) => m.state === "working").length, waiting: 0, members });

describe("sidebar", () => {
  it("always renders the roster's marker, which the theme's skin is gated on", () => {
    installBridge({});
    expect(render(StudioTeam)).toContain('data-kyoube-studio="team"');
    installBridge({ team: team([]) });
    const empty = render(StudioTeam);
    expect(empty).toContain('data-kyoube-studio="team"');
    expect(empty).toContain("No agents yet");
  });

  it("says it is retrying, not that there are no agents, when the first read fails", () => {
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        useHostContext: () => context,
        useHostLocation: () => ({ pathname: "/BAP/dashboard", search: "", hash: "" }),
        useHostNavigation: () => ({ resolveHref: (to: string) => `/BAP${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/BAP${to}`, onClick: () => {} }) }),
        usePluginData: () => ({ data: null, loading: false, error: { code: "WORKER_UNAVAILABLE", message: "down" }, refresh: () => {} }),
      },
    };
    const team = render(StudioTeam);
    expect(team).toContain('data-kyoube-studio="team"');
    expect(team).toContain("Couldn’t load the team");
    expect(team).not.toContain("No agents yet");
    expect(render(StudioHome)).toContain("retrying");
  });

  it("lists agents with a face, a status dot and what they are doing", () => {
    installBridge({ team: team([member(1, { name: "Ambassador Content Agent", icon: "sparkles", state: "working", detail: "Three posts" })]) }, "/BAP/agents/agent-1");
    const html = render(StudioTeam);
    expect(html).toContain('href="/BAP/agents/agent-1"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-tint="violet"');
    expect(html).toContain('class="ks-dot" data-state="working"');
    expect(html).toContain("Three posts");
    expect(html).toContain("Team · 1");
  });

  it("shows the first eight agents and links to the rest", () => {
    installBridge({ team: team(Array.from({ length: 11 }, (_, i) => member(i))) });
    const html = render(StudioTeam);
    expect(html.match(/class="ks-row"/g)).toHaveLength(8);
    expect(html).toContain("All agents (11)");
  });

  it("marks the Build label, Routines link and Workspace link for the theme", () => {
    installBridge({}, "/BAP/routines");
    expect(render(StudioBuildLabel)).toContain('data-kyoube-studio="build"');
    const routines = render(StudioRoutinesLink);
    expect(routines).toContain('data-kyoube-nav="routines"');
    expect(routines).toContain('aria-current="page"');
    expect(render(StudioFooter)).toContain('href="/BAP/workspace"');
  });
});

const home: HomeSnapshot = {
  team: team([member(1, { state: "working", task: { identifier: "BAP-45", title: "Three posts", href: "/issues/BAP-45" } })]),
  needs: [{ kind: "review", id: "i1", title: "Approve LinkedIn post", action: "Review", href: "/issues/BAP-41", identifier: "BAP-41", agentName: "Agent 1", at: null }],
  needsTotal: 3,
  doneThisWeek: 12,
  updates: [{ id: "i2", label: "Done", identifier: "BAP-40", title: "Campaign brief", href: "/issues/BAP-40", agentName: "Agent 1", tone: "teal", at: new Date().toISOString() }],
  steps: { hireAgent: true, giveTask: true, seenThrough: false },
};

describe("Home", () => {
  it("opens with what needs you and the week, then the getting-started strip", () => {
    installBridge({ home });
    const html = render(StudioHome);
    expect(html).toContain('data-kyoube-studio="home"');
    expect(html).toContain("<em>3 things</em> need you.");
    expect(html).toContain("<b>12 tasks</b>");
    expect(html).toContain('aria-label="Getting started"');
    expect(html).toContain('href="/BAP/issues/BAP-41"');
    expect(html).toContain("BAP-45 · Three posts");
    expect(html).toContain("Done: BAP-40");
    expect(html).toContain("<b>See it through</b>");
    expect(html).not.toContain("hand work to each other");
  });

  it("prefixes its links itself, because the core's Dashboard gives its widgets no company prefix", () => {
    // What the host does on the Dashboard (core 2026.916): context `{ companyId }` only, and
    // `linkProps` adds a prefix only when the context has one.
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        useHostContext: () => ({ ...context, companyPrefix: null }),
        useHostLocation: () => ({ pathname: "/BAP/dashboard", search: "", hash: "" }),
        useHostNavigation: () => ({ resolveHref: (to: string) => to, navigate: () => {}, linkProps: (to: string) => ({ href: to, onClick: () => {} }) }),
        usePluginData: (key: string) => (key === "home" ? { data: { ...home, team: team([{ ...member(1), href: "/team/agent-1" }]) }, loading: false, error: null, refresh: () => {} } : { data: null, loading: true, error: null, refresh: () => {} }),
      },
    };
    const html = render(StudioHome);
    expect(html).toContain('href="/BAP/team/agent-1"');
    expect(html).toContain('href="/BAP/issues/BAP-41"');
    expect(html).toContain('href="/BAP/agents/new"');
    expect(html).not.toMatch(/href="\/(team|issues|agents|inbox)\b/);
  });

  it("drops the strip once every step is done", () => {
    installBridge({ home: { ...home, steps: { hireAgent: true, giveTask: true, seenThrough: true } } });
    expect(render(StudioHome)).not.toContain("Getting started");
  });

  it("renders a greeting while the first answer loads", () => {
    installBridge({});
    const html = render(StudioHome);
    expect(html).toContain('data-kyoube-studio="home"');
    expect(html).toContain("Good ");
  });

  it("words the headline for none, one and many", () => {
    expect(headline(0)).toEqual({ lead: "Nothing needs you", count: null, tail: " right now." });
    expect(headline(1).count).toBe("1 thing");
    expect(headline(4).count).toBe("4 things");
  });
});

describe("Workspace", () => {
  it("links every card into the app and hides admin cards from members", () => {
    installBridge({ workspace: { agents: 5, people: 2, projects: 3, openTasks: 7, isAdmin: false } });
    const html = render(WorkspacePage);
    expect(html).toContain('data-kyoube-page="workspace"');
    expect(html).toContain('href="/BAP/agents/all"');
    expect(html).toContain('href="/BAP/activity/costs"');
    expect(html).toContain('href="/BAP/apps"');
    expect(html).not.toContain('href="/BAP/org"');
    expect(html).toContain("5 agents");
    expect(html).not.toContain('href="/BAP/terminal"');
    installBridge({ workspace: { agents: 1, people: 1, projects: 0, openTasks: 0, isAdmin: true } });
    const admin = render(WorkspacePage);
    expect(admin).toContain('href="/BAP/terminal"');
    expect(admin).toContain("1 agent<");
  });
});

describe("helpers", () => {
  it("matches the current page and pages under it", () => {
    expect(isActivePath("/BAP/agents/ai-manager/runs", "/BAP/agents/ai-manager")).toBe(true);
    expect(isActivePath("/BAP/agents/ai-manager-2", "/BAP/agents/ai-manager")).toBe(false);
    expect(isActivePath("/BAP/workspace", "/BAP/workspace?x=1")).toBe(true);
  });

  it("says when an idle agent last worked", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(timeAgo("2026-09-24T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-09-23T10:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-09-24T11:59:30Z", now)).toBe("just now");
    expect(memberDetail(member(1, { lastActiveAt: "2026-09-24T11:40:00Z" }), now)).toBe("Idle · 20 min ago");
    expect(greeting(new Date(2026, 8, 24, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 24, 20))).toBe("Good evening");
  });

  it("does nothing without a document", () => {
    expect(() => ensureStyles(undefined)).not.toThrow();
  });
});

describe("agent profile", () => {
  const profile = {
    found: true,
    agent: { id: "a1", name: "Ambassador Content Agent", urlKey: "ambassador-content-agent", title: "LinkedIn Ambassador Content Agent", roleLabel: "Designer", icon: "sparkles", status: "running", harness: "pi", about: null, errorReason: null, pausedAt: null, lastActiveAt: null },
    state: "working",
    detail: "Three posts",
    reportsTo: { id: "m1", name: "AI Manager", href: "/team/ai-manager" },
    current: { task: { id: "i45", identifier: "BAP-45", title: "Three posts for the launch", status: "in_progress", statusLabel: "In progress", href: "/issues/BAP-45", at: null, action: null }, notes: [{ text: "Drafted post 1 of 3", at: null }, { text: "Writing post 2", at: null }] },
    waitingOn: null,
    recent: [{ id: "i41", identifier: "BAP-41", title: "Approve LinkedIn post", status: "in_review", statusLabel: "Waiting for your review", href: "/issues/BAP-41", at: null, action: "Review" }],
    tasks: { active: [], waiting: [], queued: [], done: [] },
    stats: { doneThisWeek: 9, open: 3, spentMonthlyCents: 310, budgetMonthlyCents: 0 },
    skills: ["Kyoube Data", "Humanizer"],
    worksWith: [{ id: "m1", name: "AI Manager", icon: null, href: "/team/ai-manager", relation: "Its manager" }],
    links: { instructions: "/agents/ambassador-content-agent/instructions", skills: "/agents/ambassador-content-agent/skills", runs: "/activity/runs?agentId=writer", settings: "/agents/ambassador-content-agent/runtime", classic: "/agents/ambassador-content-agent/overview?classic=1" },
  };

  it("parses the team path", () => {
    expect(parseTeamPath("/BAP/team")).toEqual({ ref: null, view: "overview" });
    expect(parseTeamPath("/BAP/team/ai-manager")).toEqual({ ref: "ai-manager", view: "overview" });
    expect(parseTeamPath("/BAP/team/ai-manager/tasks")).toEqual({ ref: "ai-manager", view: "tasks" });
  });

  it("renders Concept C: character, name, reports-to, harness, duty switch, tabs and overview", () => {
    installBridge({ agent: profile }, "/BAP/team/ambassador-content-agent");
    const html = render(AgentProfilePage);
    expect(html).toContain('data-kyoube-page="team"');
    expect(html).toContain("<h1>Ambassador Content Agent</h1>");
    expect(html).toContain('href="/BAP/team/ai-manager"');
    expect(html).toContain("pi");
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain(">On duty");
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/instructions"');
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/runtime"');
    expect(html).toContain('href="/BAP/activity/runs?agentId=writer"');
    expect(html).toContain("Working now");
    expect(html).toContain("Writing post 2");
    expect(html).toContain('href="/BAP/issues/BAP-45"');
    expect(html).toContain("Kyoube Data");
    expect(html).toContain("Its manager");
    expect(html).toContain("Tasks done this week");
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/overview?classic=1"');
  });

  it("has a Can change agents switch: off without the grant, on with it, and locked for anyone but an owner or admin", () => {
    installBridge({ agent: profile }, "/BAP/team/ambassador-content-agent");
    expect(render(AgentProfilePage)).not.toContain("Can change agents");
    installBridge({ agent: { ...profile, access: { canChangeAgents: false, canManage: true } } }, "/BAP/team/ambassador-content-agent");
    const off = render(AgentProfilePage);
    expect(off).toContain('aria-label="Permissions"');
    expect(off).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Can change agents"/);
    expect(off).toContain("instructions, skills and settings");
    installBridge({ agent: { ...profile, access: { canChangeAgents: true, canManage: false } } }, "/BAP/team/ambassador-content-agent");
    const locked = render(AgentProfilePage);
    expect(locked).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Can change agents"[^>]*disabled=""/);
    expect(locked).toContain("Only company owners and admins can change this");
  });

  it("has a Can ask other agents control with three levels, locked for anyone but an owner or admin", () => {
    installBridge({ agent: { ...profile, access: { canChangeAgents: false, canManage: true, askLevel: "line" } } }, "/BAP/team/ambassador-content-agent");
    const html = render(AgentProfilePage);
    expect(html).toContain('role="radiogroup" aria-label="Can ask other agents"');
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>No agents</);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Its line</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Any agent</);
    expect(html).toContain("The task stays with it. Takes effect within a minute.");
    installBridge({ agent: { ...profile, access: { canChangeAgents: false, canManage: false, askLevel: "none" } } }, "/BAP/team/ambassador-content-agent");
    const locked = render(AgentProfilePage);
    expect(locked).toMatch(/role="radio" aria-checked="true"[^>]*disabled=""[^>]*>No agents</);
    expect(locked).toContain("Only company owners and admins can change this");
  });

  it("leaves the ask control out for a built-in agent or an older worker", () => {
    installBridge({ agent: { ...profile, access: { canChangeAgents: false, canManage: true, askLevel: null } } }, "/BAP/team/ambassador-content-agent");
    expect(render(AgentProfilePage)).not.toContain("Can ask other agents");
    installBridge({ agent: { ...profile, access: { canChangeAgents: false, canManage: true } } }, "/BAP/team/ambassador-content-agent");
    expect(render(AgentProfilePage)).not.toContain("Can ask other agents");
  });

  it("shows the task lists on the Tasks tab", () => {
    installBridge({ agent: { ...profile, tasks: { ...profile.tasks, waiting: profile.recent } } }, "/BAP/team/ambassador-content-agent/tasks");
    const html = render(AgentProfilePage);
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Approve LinkedIn post");
    expect(html).not.toContain("Working now");
  });

  it("shows an off-duty switch for a paused agent and never renders another agent's data", () => {
    installBridge({ agent: { ...profile, state: "paused", agent: { ...profile.agent, status: "paused" } } }, "/BAP/team/ambassador-content-agent");
    expect(render(AgentProfilePage)).toContain('role="switch" aria-checked="false"');
    installBridge({ agent: profile }, "/BAP/team/someone-else");
    expect(render(AgentProfilePage)).not.toContain("Ambassador Content Agent");
  });

  it("says when the agent does not exist, and lists the team without an agent", () => {
    installBridge({ agent: { found: false } }, "/BAP/team/nobody");
    expect(render(AgentProfilePage)).toContain("does not exist");
    installBridge({ team: team([member(1, { name: "AI Manager", state: "idle" })]) }, "/BAP/team");
    const index = render(AgentProfilePage);
    expect(index).toContain("<h1>Team</h1>");
    expect(index).toContain("AI Manager");
    expect(index).toContain('href="/BAP/agents/new"');
  });
});
