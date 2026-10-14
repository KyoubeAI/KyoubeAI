import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTES } from "./api-routes.js";
import { APP_API_ROUTES } from "./apps/api-routes.js";
import { DECISION_API_ROUTES } from "./decisions/api-routes.js";
import { GROUP_API_ROUTES } from "./groups/api-routes.js";
import { decisionToolDeclarations } from "./decisions/tools.js";
import { APPS_PAGE_ROUTE } from "./apps/page-route.js";
import { appToolDeclarations } from "./apps/tools.js";
import { CONNECTION_API_ROUTES } from "./connections/api-routes.js";
import { connectionToolDeclarations } from "./connections/tools.js";
import { DECISIONS_CONFIG_SCHEMA } from "./decisions/config.js";
import { CONNECTIONS_CONFIG_SCHEMA } from "./connections/config.js";
import appsSkillMarkdown from "./skills/kyoube-apps.md";
import decisionsSkillMarkdown from "./skills/kyoube-decisions.md";
import skillMarkdown from "./skills/kyoube-data.md";
import { toolDeclarations } from "./tools.js";

export const PLUGIN_ID = "kyoube.apps";
export const PLUGIN_VERSION = "0.13.0";
export const DATA_PAGE_ROUTE = "data";
export const DATA_ACCESS_SETTINGS_ROUTE = "data-access";
export const GROUPS_SETTINGS_ROUTE = "groups";
export { APPS_PAGE_ROUTE };
export const DATA_SKILL_KEY = "kyoube-data";
export const APPS_SKILL_KEY = "kyoube-apps";
export const DECISIONS_SKILL_KEY = "kyoube-decisions";
export const PURGE_JOB_KEY = "purge-trash";
export const FILL_JOB_KEY = "fill-ai-columns";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Data & Apps",
  description: "Per-company organisation database that agents and people can design and populate, plus AI-built apps on top of it.",
  author: "KyoubeAI",
  categories: ["workspace", "automation", "ui"],
  capabilities: [
    "agent.tools.register",
    "api.routes.register",
    "access.members.read",
    "agents.read",
    "activity.log.write",
    "skills.managed",
    // The worker installs the two managed skills into a company whenever it is
    // first touched inside a company-scoped invocation — the board-only
    // `skills.install` route that `kyoube ensure-plugins` calls for every
    // company, the `data.access` read behind the sidebar, the Data-access
    // page's button — and, through this capability, on `company.created`
    // (see `installSkills` in plugin.ts). It never enumerates companies
    // itself: a host call made outside an invocation has no company scope and
    // the host refuses `skills.managed.reconcile` without one.
    "events.subscribe",
    "jobs.schedule",
    "ui.page.register",
    "ui.sidebar.register",
    // Required by the `companySettingsPage` slot below: upstream's
    // UI_SLOT_CAPABILITIES (server/src/services/plugin-capability-validator.ts)
    // maps both `settingsPage` and `companySettingsPage` to
    // `instance.settings.register`, and POST /api/plugins/install rejects the
    // whole manifest with "inconsistent capabilities" when it is absent.
    "instance.settings.register",
    // Typed decisions (docs/decisions.md): the worker calls the company's configured
    // `/v1/systemone` provider through `ctx.http.fetch` and reads its API key secret.
    // kyoube.apps never declares issue.interactions.respond or approvals.respond, so no decision
    // can ever answer a card or an approval (tests/unit/decision-config.spec.ts).
    "http.outbound",
    "secrets.read-ref",
    // The guardrail (milestone 4): read the agent's task, raise a human-only confirmation card on
    // it, and read that card's answer. Answering cards (issue.interactions.respond) and approvals
    // (approvals.respond) are never declared: a decision can hold an action, never approve one.
    "issues.read",
    "issue.interactions.create",
    "issue.interactions.read",
    // App tasks (docs/app-tasks.md): create the task as the person using the app, wake its agent,
    // cancel it, read the agent's reply, ask the core whether that person may assign the agent, and
    // read the company's issue prefix for the task link. The plugin never declares
    // issue.comments.create: it never speaks on a task, it only reads the agent's answer.
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.read",
    "authorization.policies.read",
    "companies.read",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  instanceConfigSchema: {
    ...DECISIONS_CONFIG_SCHEMA,
    properties: { ...DECISIONS_CONFIG_SCHEMA.properties, ...CONNECTIONS_CONFIG_SCHEMA.properties },
  },
  tools: [...toolDeclarations(), ...appToolDeclarations(), ...decisionToolDeclarations(), ...connectionToolDeclarations()],
  apiRoutes: [...API_ROUTES, ...APP_API_ROUTES, ...DECISION_API_ROUTES, ...GROUP_API_ROUTES, ...CONNECTION_API_ROUTES],
  jobs: [
    { jobKey: PURGE_JOB_KEY, displayName: "Purge trashed tables and fields", description: "Drops tables/fields soft-deleted more than 30 days ago.", schedule: "0 3 * * *" },
    { jobKey: FILL_JOB_KEY, displayName: "Fill AI columns", description: "Asks the company's typed-decision model about new and changed rows of AI columns (docs/decisions.md).", schedule: "*/5 * * * *" },
  ],
  skills: [
    { skillKey: DATA_SKILL_KEY, displayName: "Kyoube Data", slug: "kyoube-data", description: "Design and use the company's Kyoube organisation database through the kyoube.apps tools.", markdown: skillMarkdown },
    { skillKey: APPS_SKILL_KEY, displayName: "Kyoube Apps", slug: "kyoube-apps", description: "Build and publish single-file apps over the company's Kyoube Data tables.", markdown: appsSkillMarkdown },
    { skillKey: DECISIONS_SKILL_KEY, displayName: "Kyoube Decisions", slug: "kyoube-decisions", description: "Ask the company's typed-decision model closed questions about text, JSON or Data rows; never instead of a person's approval.", markdown: decisionsSkillMarkdown },
  ],
  ui: {
    slots: [
      { type: "page", id: "data-page", displayName: "Data", exportName: "DataPage", routePath: DATA_PAGE_ROUTE },
      { type: "sidebar", id: "data-nav", displayName: "Data", exportName: "SidebarEntry", order: 20 },
      { type: "companySettingsPage", id: "data-access", displayName: "Data access", exportName: "DataAccessSettingsPage", routePath: DATA_ACCESS_SETTINGS_ROUTE },
      { type: "companySettingsPage", id: "groups", displayName: "Groups", exportName: "GroupsSettingsPage", routePath: GROUPS_SETTINGS_ROUTE },
      { type: "page", id: "apps-page", displayName: "Apps", exportName: "AppsPage", routePath: APPS_PAGE_ROUTE },
      { type: "sidebar", id: "apps-nav", displayName: "Apps", exportName: "AppsSidebarEntry", order: 30 },
    ],
  },
};

export default manifest;
