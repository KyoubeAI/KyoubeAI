import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalLike, IssueLike, TeamMember } from "../src/model.js";
import type { CommentLike, ProfileAgentLike } from "../src/profile.js";
import { AgentProfilePage, StudioBuildLabel, StudioFooter, StudioHome, StudioRoutinesLink, StudioTeam, WorkspacePage } from "../src/ui/index.js";
import { _resetBoardData, loadBoardSnapshot, loadIssueComments } from "../src/ui/board-data.js";
import { askLevelStep, parseTeamPath } from "../src/ui/Profile.js";
import { headline } from "../src/ui/Home.js";
import { memberDetail } from "../src/ui/nav.js";
import { isActivePath } from "../src/ui/shared.js";
import { ensureStyles, STUDIO_CSS } from "../src/ui/styles.js";
import { greeting, timeAgo } from "../src/ui/time.js";
import { openTasks } from "../src/ui/Workspace.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
const context = { companyId: "c1", companyPrefix: "BAP", projectId: null, entityId: null, entityType: null, userId: "u1" };

const ISSUES_URL = "/api/companies/c1/issues?limit=500";
const APPROVALS_URL = "/api/companies/c1/approvals?status=pending";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** What the core's board API answers the signed-in person: their tasks, pending approvals (or a 403) and comments per task. */
interface Board { issues: IssueLike[]; approvals: ApprovalLike[] | "forbidden"; comments?: Record<string, CommentLike[]> }
const EMPTY_BOARD: Board = { issues: [], approvals: [] };

const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

/** The browser's `fetch`, answering the three board routes Studio reads from `board`. */
function stubFetch(board: Board) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === ISSUES_URL) return answer(200, board.issues);
    if (url === APPROVALS_URL) return board.approvals === "forbidden" ? answer(403, { error: "Forbidden" }) : answer(200, board.approvals);
    const comments = url.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (comments) return answer(200, board.comments?.[decodeURIComponent(comments[1]!)] ?? []);
    return answer(404, { error: "Not found" });
  }) as typeof fetch;
}

function installBridge(data: Record<string, unknown>, pathname = "/BAP/dashboard", board: Board = EMPTY_BOARD) {
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
  stubFetch(board);
}
afterEach(() => {
  delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
  globalThis.fetch = realFetch;
  _resetBoardData();
});

/** What the views' effects do in the browser: read the company's tasks and approvals (static rendering runs no effects). */
const loadBoard = () => loadBoardSnapshot(context.companyId);

const render = (component: unknown, props: Record<string, unknown> = { context }) => renderToStaticMarkup(createElement(component as never, props as never));
/** The opening tag of the button with this label, so its attributes can be checked one at a time. */
const radioTag = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";

function agentRow(i: number, overrides: Partial<ProfileAgentLike> = {}): ProfileAgentLike {
  return { id: `a${i}`, name: `Agent ${i}`, urlKey: `agent-${i}`, title: null, icon: "rocket", status: "idle", lastHeartbeatAt: null, ...overrides };
}
const agents = (rows: ProfileAgentLike[]) => ({ agents: rows });

const WRITER: ProfileAgentLike = {
  id: "a1", name: "Ambassador Content Agent", urlKey: "ambassador-content-agent", title: "LinkedIn Ambassador Content Agent", role: "designer", icon: "sparkles",
  status: "running", adapterType: "pi_local", reportsTo: "m1", lastHeartbeatAt: minutesAgo(1), spentMonthlyCents: 310, budgetMonthlyCents: 0,
  adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/kyoube-apps/kyoube-data", "humanizer"] } },
};
const MANAGER: ProfileAgentLike = { id: "m1", name: "AI Manager", urlKey: "ai-manager", title: null, icon: null, status: "idle", lastHeartbeatAt: minutesAgo(30) };
const ISSUES: IssueLike[] = [
  { id: "i45", identifier: "BAP-45", title: "Three posts for the launch", status: "in_progress", assigneeAgentId: "a1", executionRunId: "r1", hiddenAt: null, createdAt: minutesAgo(60), updatedAt: minutesAgo(2) },
  { id: "i41", identifier: "BAP-41", title: "Approve LinkedIn post", status: "in_review", assigneeAgentId: "a1", hiddenAt: null, createdAt: minutesAgo(120), updatedAt: minutesAgo(10) },
  { id: "i40", identifier: "BAP-40", title: "Campaign brief", status: "done", assigneeAgentId: "m1", createdByUserId: null, hiddenAt: null, createdAt: minutesAgo(600), updatedAt: minutesAgo(60), completedAt: minutesAgo(60) },
  { id: "i39", identifier: "BAP-39", title: "Fix the footer", status: "blocked", assigneeAgentId: "m1", hiddenAt: null, createdAt: minutesAgo(700), updatedAt: minutesAgo(90) },
];
const APPROVALS: ApprovalLike[] = [{ id: "ap1", type: "request_board_approval", status: "pending", requestedByAgentId: "m1", payload: { title: "New pricing page" }, createdAt: minutesAgo(5) }];
const COMMENTS: Record<string, CommentLike[]> = {
  i45: [
    { body: "Drafted post 1 of 3", authorAgentId: "a1", createdAt: minutesAgo(20) },
    { body: "Looks good, carry on", authorAgentId: null, createdAt: minutesAgo(15) },
    { body: "Writing post 2", authorAgentId: "a1", createdAt: minutesAgo(3) },
  ],
};
const BOARD: Board = { issues: ISSUES, approvals: APPROVALS, comments: COMMENTS };

describe("sidebar", () => {
  it("always renders the roster's marker, which the theme's skin is gated on", async () => {
    installBridge({});
    expect(render(StudioTeam)).toContain('data-kyoube-studio="team"');
    installBridge({ agents: agents([]) });
    await loadBoard();
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

  it("the roster shows each agent's state from the browser-loaded tasks", async () => {
    installBridge({ agents: agents([WRITER, MANAGER, agentRow(3)]) }, "/BAP/dashboard", BOARD);
    // Until the tasks are in, the roster waits rather than calling everyone idle.
    expect(render(StudioTeam)).not.toContain('class="ks-row"');
    await loadBoard();
    const html = render(StudioTeam);
    expect(html).toContain('<span data-state="working">Three posts for the launch</span>');
    expect(html).toContain('<span data-state="waiting">Waiting on you · BAP-39</span>');
    expect(html).toContain('<span data-state="idle">Idle</span>');
    expect(html).toContain("Team · 3");
    expect(fetchCalls.map((call) => call.url)).toEqual([ISSUES_URL, APPROVALS_URL]);
    expect(fetchCalls.every((call) => call.init?.credentials === "include")).toBe(true);
  });

  it("lists agents with a face, a status dot and what they are doing", async () => {
    installBridge({ agents: agents([agentRow(1, { name: "Ambassador Content Agent", icon: "sparkles", status: "running" })]) }, "/BAP/agents/agent-1", {
      issues: [{ id: "i1", identifier: "BAP-45", title: "Three posts", status: "in_progress", assigneeAgentId: "a1", hiddenAt: null, updatedAt: minutesAgo(1) }],
      approvals: [],
    });
    await loadBoard();
    const html = render(StudioTeam);
    expect(html).toContain('href="/BAP/team/agent-1"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-tint="violet"');
    expect(html).toContain('class="ks-dot" data-state="working"');
    expect(html).toContain("Three posts");
    expect(html).toContain("Team · 1");
  });

  it("shows the first eight agents and links to the rest", async () => {
    installBridge({ agents: agents(Array.from({ length: 11 }, (_, i) => agentRow(i))) });
    await loadBoard();
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

describe("Home", () => {
  it("opens with what needs you and the week, then the getting-started strip", async () => {
    installBridge({ agents: agents([WRITER, MANAGER]) }, "/BAP/dashboard", BOARD);
    await loadBoard();
    const html = render(StudioHome);
    expect(html).toContain('data-kyoube-studio="home"');
    expect(html).toContain("<em>3 things</em> need you.");
    expect(html).toContain("Approval requested: New pricing page");
    expect(html).toContain("<b>1 task</b>");
    expect(html).toContain('aria-label="Getting started"');
    expect(html).toContain('href="/BAP/issues/BAP-41"');
    expect(html).toContain("BAP-45 · Three posts for the launch");
    expect(html).toContain("Done: BAP-40");
    expect(html).toContain("<b>See it through</b>");
    expect(html).not.toContain("hand work to each other");
    expect(html).not.toContain("Approvals are not shown to you.");
  });

  it("Home says approvals are not shown when the approvals call is refused", async () => {
    installBridge({ agents: agents([WRITER, MANAGER]) }, "/BAP/dashboard", { ...BOARD, approvals: "forbidden" });
    await loadBoard();
    const html = render(StudioHome);
    expect(html).toContain("Approvals are not shown to you.");
    expect(html).not.toContain("New pricing page");
    expect(html).toContain("<em>2 things</em> need you.");
    expect(fetchCalls.map((call) => call.url)).toEqual([ISSUES_URL, APPROVALS_URL]);
  });

  it("prefixes its links itself, because the core's Dashboard gives its widgets no company prefix", async () => {
    // What the host does on the Dashboard (core 2026.916): context `{ companyId }` only, and
    // `linkProps` adds a prefix only when the context has one.
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        useHostContext: () => ({ ...context, companyPrefix: null }),
        useHostLocation: () => ({ pathname: "/BAP/dashboard", search: "", hash: "" }),
        useHostNavigation: () => ({ resolveHref: (to: string) => to, navigate: () => {}, linkProps: (to: string) => ({ href: to, onClick: () => {} }) }),
        usePluginData: (key: string) => (key === "agents" ? { data: agents([WRITER, MANAGER]), loading: false, error: null, refresh: () => {} } : { data: null, loading: true, error: null, refresh: () => {} }),
      },
    };
    stubFetch(BOARD);
    await loadBoard();
    const html = render(StudioHome);
    expect(html).toContain('href="/BAP/team/ambassador-content-agent"');
    expect(html).toContain('href="/BAP/issues/BAP-41"');
    expect(html).toContain('href="/BAP/agents/new"');
    expect(html).not.toMatch(/href="\/(team|issues|agents|inbox)\b/);
  });

  it("drops the strip once every step is done", async () => {
    const seenThrough = ISSUES.map((row) => (row.id === "i40" ? { ...row, createdByUserId: "u1" } : row));
    installBridge({ agents: agents([WRITER, MANAGER]) }, "/BAP/dashboard", { ...BOARD, issues: seenThrough });
    await loadBoard();
    const html = render(StudioHome);
    expect(html).toContain("need you.");
    expect(html).not.toContain("Getting started");
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
    installBridge({ workspace: { agents: 5, people: 2, projects: 3, isAdmin: false } });
    const html = render(WorkspacePage);
    expect(html).toContain('data-kyoube-page="workspace"');
    expect(html).toContain('href="/BAP/agents/all"');
    expect(html).toContain('href="/BAP/activity/costs"');
    expect(html).toContain('href="/BAP/apps"');
    expect(html).not.toContain('href="/BAP/org"');
    expect(html).toContain("5 agents");
    expect(html).not.toContain('href="/BAP/terminal"');
    installBridge({ workspace: { agents: 1, people: 1, projects: 0, isAdmin: true } });
    const admin = render(WorkspacePage);
    expect(admin).toContain('href="/BAP/terminal"');
    expect(admin).toContain("1 agent<");
  });

  it("counts open tasks from the browser-loaded tasks, leaving out done, cancelled and hidden ones", () => {
    const rows: IssueLike[] = [...ISSUES, { ...ISSUES[0]!, id: "i9", status: "cancelled" }, { ...ISSUES[0]!, id: "i8", hiddenAt: minutesAgo(1) }];
    expect(openTasks(rows)).toBe(3);
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
    const idle: TeamMember = { id: "a1", name: "Agent 1", title: null, icon: "rocket", href: "/team/agent-1", state: "idle", detail: "Idle", lastActiveAt: "2026-09-24T11:40:00Z", task: null };
    expect(timeAgo("2026-09-24T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-09-23T10:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-09-24T11:59:30Z", now)).toBe("just now");
    expect(memberDetail(idle, now)).toBe("Idle · 20 min ago");
    expect(greeting(new Date(2026, 8, 24, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 8, 24, 20))).toBe("Good evening");
  });

  it("does nothing without a document", () => {
    expect(() => ensureStyles(undefined)).not.toThrow();
  });
});

describe("agent profile", () => {
  const PROFILE_PATH = "/BAP/team/ambassador-content-agent";
  /** The worker's `agent` read: the agent and, when the host would say, its access. */
  const read = (agent: ProfileAgentLike = WRITER, access: Record<string, unknown> | null = null) => ({ found: true, agent, access });
  const installProfile = (agentRead: unknown = read(), pathname = PROFILE_PATH) => installBridge({ agents: agents([WRITER, MANAGER]), agent: agentRead }, pathname, BOARD);

  it("parses the team path", () => {
    expect(parseTeamPath("/BAP/team")).toEqual({ ref: null, view: "overview" });
    expect(parseTeamPath("/BAP/team/ai-manager")).toEqual({ ref: "ai-manager", view: "overview" });
    expect(parseTeamPath("/BAP/team/ai-manager/tasks")).toEqual({ ref: "ai-manager", view: "tasks" });
  });

  it("the profile shows the agent's current task and notes", async () => {
    installProfile();
    // Until its tasks are in, the page shows its placeholder rather than an agent with no work.
    expect(render(AgentProfilePage)).not.toContain("<h1>");
    await loadBoard();
    await loadIssueComments("i45");
    const html = render(AgentProfilePage);
    expect(html).toContain("Working now");
    expect(html).toContain("Three posts for the launch");
    expect(html).toContain('href="/BAP/issues/BAP-45"');
    expect(html).toContain("Drafted post 1 of 3");
    expect(html).toContain("Writing post 2");
    expect(html).not.toContain("Looks good");
    expect(fetchCalls.map((call) => call.url)).toEqual([ISSUES_URL, APPROVALS_URL, "/api/issues/i45/comments"]);
    expect(fetchCalls.every((call) => call.init?.credentials === "include")).toBe(true);
  });

  it("renders Concept C: character, name, reports-to, harness, duty switch, tabs and overview", async () => {
    installProfile();
    await loadBoard();
    const html = render(AgentProfilePage);
    expect(html).toContain('data-kyoube-page="team"');
    expect(html).toContain("<h1>Ambassador Content Agent</h1>");
    expect(html).toContain('href="/BAP/team/ai-manager"');
    expect(html).toContain("pi");
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain(">On duty");
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/instructions"');
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/runtime"');
    expect(html).toContain('href="/BAP/activity/runs?agentId=a1"');
    expect(html).toContain("Working now");
    expect(html).toContain('href="/BAP/issues/BAP-45"');
    expect(html).toContain("Kyoube Data");
    expect(html).toContain("Its manager");
    expect(html).toContain("Tasks done this week");
    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/overview?classic=1"');
  });

  it("has a Can change agents switch: off without the grant, on with it, and locked for anyone but an owner or admin", async () => {
    installProfile();
    await loadBoard();
    expect(render(AgentProfilePage)).not.toContain("Can change agents");
    installProfile(read(WRITER, { canChangeAgents: false, canManage: true }));
    const off = render(AgentProfilePage);
    expect(off).toContain('aria-label="Permissions"');
    expect(off).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Can change agents"/);
    expect(off).toContain("instructions, skills and settings");
    installProfile(read(WRITER, { canChangeAgents: true, canManage: false }));
    const locked = render(AgentProfilePage);
    expect(locked).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Can change agents"[^>]*disabled=""/);
    expect(locked).toContain("Only company owners and admins can change this");
  });

  it("has a Can ask other agents control with three levels, locked for anyone but an owner or admin", async () => {
    installProfile(read(WRITER, { canChangeAgents: false, canManage: true, askLevel: "line" }));
    await loadBoard();
    const html = render(AgentProfilePage);
    expect(html).toContain('role="radiogroup" aria-label="Can ask other agents"');
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>No agents</);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Its line</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Any agent</);
    expect(html).toContain("The task stays with it. Takes effect within a minute.");
    // An owner or admin can use the radios, so none is disabled. Only the checked one is a tab stop (roving tabindex).
    expect(html).not.toMatch(/role="radio"[^>]*disabled/);
    expect(radioTag(html, "Its line")).toContain('tabindex="0"');
    expect(radioTag(html, "No agents")).toContain('tabindex="-1"');
    expect(radioTag(html, "Any agent")).toContain('tabindex="-1"');
    installProfile(read(WRITER, { canChangeAgents: false, canManage: false, askLevel: "none" }));
    const locked = render(AgentProfilePage);
    expect(locked).toMatch(/role="radio" aria-checked="true"[^>]*disabled=""[^>]*>No agents</);
    expect(locked).toContain("Only company owners and admins can change this");
  });

  it("locks the ask control for a pending agent, even for an owner or admin, and says why", async () => {
    installProfile(read({ ...WRITER, status: "pending_approval" }, { canChangeAgents: false, canManage: true, askLevel: "line" }));
    await loadBoard();
    const html = render(AgentProfilePage);
    expect(html.match(/role="radio"[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).toContain('title="Available once the agent is approved"');
  });

  it("moves the ask level with the arrow keys, wrapping at the ends", () => {
    expect(askLevelStep("none", "ArrowRight")).toBe("line");
    expect(askLevelStep("line", "ArrowDown")).toBe("any");
    expect(askLevelStep("any", "ArrowRight")).toBe("none");
    expect(askLevelStep("none", "ArrowLeft")).toBe("any");
    expect(askLevelStep("line", "ArrowUp")).toBe("none");
    expect(askLevelStep("line", "Enter")).toBeNull();
  });

  it("keeps the checked label readable on hover, and drops the control under the text on a narrow row", () => {
    expect(STUDIO_CSS).toContain('.ks-seg button:hover:not(:disabled):not([aria-checked="true"])');
    expect(STUDIO_CSS).not.toMatch(/@media \(max-width: 560px\)[^}]*\.ks-perm-wide/);
    expect(STUDIO_CSS).toContain(".ks-perm-wide { flex-wrap: wrap; }");
    expect(STUDIO_CSS).toContain(".ks-perm-wide .ks-text { flex: 1 1 200px; }");
  });

  it("leaves the ask control out for a built-in agent or an older worker", async () => {
    installProfile(read(WRITER, { canChangeAgents: false, canManage: true, askLevel: null }));
    await loadBoard();
    expect(render(AgentProfilePage)).not.toContain("Can ask other agents");
    installProfile(read(WRITER, { canChangeAgents: false, canManage: true }));
    expect(render(AgentProfilePage)).not.toContain("Can ask other agents");
  });

  it("shows the task lists on the Tasks tab", async () => {
    installProfile(read(), `${PROFILE_PATH}/tasks`);
    await loadBoard();
    const html = render(AgentProfilePage);
    expect(html).toContain("Waiting on you");
    expect(html).toContain("Approve LinkedIn post");
    expect(html).not.toContain("Working now");
  });

  it("shows an off-duty switch for a paused agent and never renders another agent's data", async () => {
    installProfile(read({ ...WRITER, status: "paused" }));
    await loadBoard();
    expect(render(AgentProfilePage)).toContain('role="switch" aria-checked="false"');
    installProfile(read(), "/BAP/team/someone-else");
    expect(render(AgentProfilePage)).not.toContain("Ambassador Content Agent");
  });

  it("says when the agent does not exist, and lists the team without an agent", async () => {
    installBridge({ agent: { found: false, agent: null, access: null } }, "/BAP/team/nobody");
    expect(render(AgentProfilePage)).toContain("does not exist");
    installBridge({ agents: agents([MANAGER]) }, "/BAP/team");
    await loadBoard();
    const index = render(AgentProfilePage);
    expect(index).toContain("<h1>Team</h1>");
    expect(index).toContain("AI Manager");
    expect(index).toContain('href="/BAP/agents/new"');
  });
});
