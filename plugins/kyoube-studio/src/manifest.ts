import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.studio";
export const PLUGIN_VERSION = "0.4.0";
/** The Workspace page's route under a company: `/<prefix>/workspace`. */
export const WORKSPACE_ROUTE = "workspace";
/** The team and agent profiles: `/<prefix>/team` and `/<prefix>/team/<agent>[/tasks]`. */
export const TEAM_ROUTE = "team";

/**
 * Sidebar order. The host sorts every plugin's `sidebar` slots by `order`
 * (lower first) inside the Work section, after Tasks and Projects. Studio's
 * entries interleave with the Data and Apps links the kyoube.apps plugin
 * contributes (orders 20 and 30) and the Terminal link (90, which the theme
 * moves to the Workspace page). Keep these in step with those manifests.
 */
export const SIDEBAR_ORDER = { build: 10, data: 20, apps: 30, routines: 40, team: 50, terminal: 90 } as const;

// `minimumHostVersion` is deliberately absent, for the reason recorded in the
// terminal plugin's manifest: the image pins the core every plugin is built for, so a
// minimum would add nothing (and cores up to 2026.1005.0 rejected any minimum outright).
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Studio",
  description: "KyoubeAI's Studio layout: a Home page that opens with what needs you and what your team is doing, a live team roster in the sidebar, and one Workspace page for everything you don't need every day.",
  author: "KyoubeAI",
  categories: ["ui"],
  capabilities: [
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "agents.read",
    "issues.read",
    "approvals.read",
    "issue.comments.read",
    "projects.read",
    "access.members.read",
    // The profile's "Can change agents" switch (agents:configure): the core
    // board API lists no agent's grants and replaces them all on write.
    "authorization.grants.read",
    "authorization.grants.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      { type: "sidebar", id: "studio-build", displayName: "Build", exportName: "StudioBuildLabel", order: SIDEBAR_ORDER.build },
      { type: "sidebar", id: "studio-routines", displayName: "Routines", exportName: "StudioRoutinesLink", order: SIDEBAR_ORDER.routines },
      { type: "sidebar", id: "studio-team", displayName: "Team", exportName: "StudioTeam", order: SIDEBAR_ORDER.team },
      { type: "sidebarPanel", id: "studio-footer", displayName: "Workspace", exportName: "StudioFooter" },
      { type: "dashboardWidget", id: "studio-home", displayName: "Home", exportName: "StudioHome", order: 0 },
      { type: "page", id: "studio-workspace", displayName: "Workspace", exportName: "WorkspacePage", routePath: WORKSPACE_ROUTE },
      { type: "page", id: "studio-profiles", displayName: "Team", exportName: "AgentProfilePage", routePath: TEAM_ROUTE },
    ],
  },
};

export default manifest;
