import type { PaperclipPluginManifestV1, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.agent-rules";
export const PLUGIN_VERSION = "0.3.2";

function boardRoute(routeKey: string, path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method: "POST",
    path,
    auth: "board",
    capability: "api.routes.register",
    companyResolution: { from: "body", key: "companyId" },
  };
}

/**
 * Board-only. `kyoube agent-rules` calls reconcile for every company on each
 * pass, and revert on `kyoube agent-rules off`; groups.apply carries each
 * company's agent access from kyoube.apps' user groups. Each request runs inside a
 * host-issued invocation scoped to the body's company, which the
 * authorization and state host calls need; the worker's own start-up code has
 * no such scope.
 */
export const API_ROUTES: PluginApiRouteDeclaration[] = [
  boardRoute("guard.reconcile", "/reconcile"),
  boardRoute("guard.revert", "/revert"),
  boardRoute("groups.apply", "/groups/apply"),
];

// `minimumHostVersion` is deliberately absent, for the reason recorded in the
// terminal plugin's manifest: the image pins the core every plugin is built for, so a
// minimum would add nothing (and cores up to 2026.1005.0 rejected any minimum outright).
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Agent Rules",
  description: "Keeps work from moving up to a manager agent without a person's decision: manager agents are protected, and each manager may assign only within its own team; and keeps group agents assignable only by their groups' members.",
  author: "KyoubeAI",
  categories: ["automation"],
  capabilities: [
    "api.routes.register",
    "agents.read",
    "access.members.read",
    "authorization.policies.read",
    "authorization.policies.write",
    "authorization.grants.read",
    "authorization.grants.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  apiRoutes: API_ROUTES,
};

export default manifest;
