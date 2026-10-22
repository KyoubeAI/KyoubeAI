import type { IconName } from "./icons.js";

export type Tone = "teal" | "sky" | "violet" | "amber" | "rose" | "zinc";

export interface WorkspaceCard {
  id: string;
  title: string;
  description: string;
  to: string;
  icon: IconName;
  tone: Tone;
  /** Shown only to company owners and admins. */
  adminOnly?: boolean;
  /** Which figure from the "workspace" data call to show under the card, if any. */
  meta?: "agents" | "people" | "projects";
}

export interface WorkspaceGroup {
  title: string;
  cards: WorkspaceCard[];
}

/**
 * Everything the Studio sidebar moves off the sidebar. docker/theme hides the
 * core's Org section (and Artifacts, Skills and Terminal), so every link it
 * hid must have a card here: docker/theme/anchors.mjs lists the Org routes it
 * expects, and tests/links.spec.ts checks each one appears below. Routes are
 * the core's canonical ones (2026.916 moved the org chart onto All agents and
 * timeline and costs under Audit).
 */
export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
  {
    title: "People and agents",
    cards: [
      { id: "team", title: "Team", description: "Every agent's profile and what it is doing now.", to: "/team", icon: "users", tone: "teal", meta: "agents" },
      { id: "agents", title: "All agents", description: "Every agent as a list or an org chart, with model and controls.", to: "/agents/all", icon: "org", tone: "teal" },
      { id: "members", title: "Members and invites", description: "Invite people and choose what they can do.", to: "/company/settings/members", icon: "mail", tone: "sky", meta: "people" },
    ],
  },
  {
    title: "Oversight",
    cards: [
      { id: "activity", title: "Audit", description: "Every change people and agents made, newest first.", to: "/activity", icon: "history", tone: "sky" },
      { id: "timeline", title: "Timeline", description: "Tasks and runs laid out over time.", to: "/activity/timeline", icon: "timeline", tone: "sky" },
      { id: "costs", title: "Costs", description: "Spend by agent, project and model, with budgets.", to: "/activity/costs", icon: "dollar", tone: "amber" },
      { id: "approvals", title: "Approvals", description: "Decisions agents are waiting on.", to: "/approvals", icon: "shield", tone: "amber" },
    ],
  },
  {
    title: "Library and connections",
    cards: [
      { id: "skills", title: "Skills", description: "Reusable know-how you can give to agents.", to: "/skills", icon: "book", tone: "violet" },
      { id: "artifacts", title: "Artifacts", description: "Files and documents agents produced.", to: "/artifacts", icon: "package", tone: "violet" },
      { id: "projects", title: "Projects", description: "Every project and its working folder.", to: "/projects", icon: "folder", tone: "violet", meta: "projects" },
      { id: "connectors", title: "Connectors", description: "Outside tools your agents are allowed to use.", to: "/apps", icon: "plug", tone: "rose" },
    ],
  },
  {
    title: "Administration",
    cards: [
      { id: "notifications", title: "Notifications", description: "Get notified on your phone or computer, and choose what you hear about.", to: "/notifications", icon: "bell", tone: "zinc" },
      { id: "settings", title: "Settings", description: "Company name, defaults, secrets and environments.", to: "/company/settings", icon: "sliders", tone: "zinc" },
      { id: "plugins", title: "Plugins", description: "Installed plugins and their settings.", to: "/company/settings/instance/plugins", icon: "gear", tone: "zinc", adminOnly: true },
      { id: "terminal", title: "Terminal", description: "Sign agent tools in and administer the server.", to: "/terminal", icon: "terminal", tone: "zinc", adminOnly: true },
    ],
  },
];
