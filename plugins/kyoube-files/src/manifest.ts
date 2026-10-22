import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.files";
export const PLUGIN_VERSION = "0.4.0";
/** The `detailTab` slot id; the project sidebar link opens `?tab=plugin:<PLUGIN_ID>:<TAB_SLOT_ID>`. */
export const TAB_SLOT_ID = "project-files";

const ROLES = ["owner", "admin", "operator", "member", "viewer"];

// `minimumHostVersion` is deliberately absent, for the reason recorded in the
// terminal plugin's manifest: the image pins the core every plugin is built for, so a
// minimum would add nothing (and cores up to 2026.1005.0 rejected any minimum outright).
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Files",
  description: "Browse, edit and manage the folders and files in each project's working folder — the same folder the project's agents read and write — from a Files tab on the project page.",
  author: "KyoubeAI",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.detailTab.register",
    "ui.sidebar.register",
    "ui.action.register",
    "projects.read",
    "issues.read",
    "project.workspaces.read",
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
      readRoles: {
        type: "array",
        title: "Company roles allowed to browse and download project files",
        items: { type: "string", enum: ROLES },
        default: ROLES,
      },
      writeRoles: {
        type: "array",
        title: "Company roles allowed to create, edit, upload, rename and delete project files",
        items: { type: "string", enum: ROLES },
        default: ["owner", "admin", "operator", "member"],
      },
      maxEditableKb: { type: "number", title: "Largest file the editor opens (KiB); larger files are download-only", default: 1024, minimum: 1 },
      maxUploadMb: { type: "number", title: "Largest single upload (MiB)", default: 5, minimum: 1, maximum: 7 },
      maxDownloadMb: { type: "number", title: "Largest single download (MiB)", default: 25, minimum: 1 },
    },
  },
  ui: {
    slots: [
      { type: "detailTab", id: TAB_SLOT_ID, displayName: "Files", exportName: "ProjectFilesTab", entityTypes: ["project"] },
      { type: "projectSidebarItem", id: "project-files-nav", displayName: "Files", exportName: "ProjectSidebarItem", entityTypes: ["project"] },
      // The right end of the breadcrumb bar ("Tasks › BAP-12 Title"). The
      // component reads the current route, shows a folder icon on task pages
      // whose task is in a project, and docks the project's folder in a panel
      // on the right of the screen — beside the chat, not over it.
      { type: "globalToolbarButton", id: "task-files", displayName: "Files", exportName: "GlobalFilesButton" },
    ],
  },
};

export default manifest;
