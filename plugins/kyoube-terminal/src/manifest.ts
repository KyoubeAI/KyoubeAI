import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.terminal";
export const PLUGIN_VERSION = "0.2.5";
export const PAGE_ROUTE = "terminal";

// We intentionally do not set `minimumHostVersion`. Cores 2026.831.1 to 2026.1005.0 compared
// it against `instanceInfo.hostVersion`, which the server never actually set (it
// defaulted to "0.0.0"), so any minimum rejected the install outright. Core 2026.1012.0
// passes its own version, but the image pins the core every plugin is built for, so a
// minimum would add nothing.
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Terminal",
  description: "Browser terminal inside the KyoubeAI container, with sudo, for instance administration and installing agent harnesses. Limited to company owners/admins.",
  author: "KyoubeAI",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.page.register",
    "ui.sidebar.register",
    "access.members.read",
    "activity.log.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      idleTimeoutMinutes: { type: "number", title: "Idle timeout (minutes)", default: 30, minimum: 1 },
      maxSessionsPerUser: { type: "number", title: "Max open sessions per user", default: 3, minimum: 1 },
      allowedRoles: {
        type: "array",
        title: "Company roles allowed to open a terminal",
        items: { type: "string", enum: ["owner", "admin", "operator", "member", "viewer"] },
        default: ["owner", "admin"],
      },
      shell: { type: "string", title: "Shell", default: "/bin/bash" },
      scrollbackKb: { type: "number", title: "Scrollback buffer (KiB)", default: 256, minimum: 16 },
    },
  },
  ui: {
    slots: [
      { type: "page", id: "terminal-page", displayName: "Terminal", exportName: "TerminalPage", routePath: PAGE_ROUTE },
      { type: "sidebar", id: "terminal-nav", displayName: "Terminal", exportName: "SidebarEntry", order: 90 },
    ],
  },
};

export default manifest;
