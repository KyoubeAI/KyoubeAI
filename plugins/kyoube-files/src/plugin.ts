import { definePlugin, type PaperclipPlugin, type PluginContext, type PluginWorkspace } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import { createPolicyReader, type PolicyReader } from "@kyoube/visibility";
import { RoleResolver } from "./auth.js";
import { FilesError } from "./errors.js";
import { WorkspaceFiles } from "./fs-service.js";
import { PLUGIN_ID } from "./manifest.js";
import { joinRelative, normalizeRelativePath, validateEntryName } from "./paths.js";
import { resolveSettings, type FilesSettings } from "./settings.js";
import { projectVisibleFor } from "./visibility.js";

export interface FilesPluginDeps {
  now?: () => number;
  /** Test seam: the service bound to a resolved workspace root. */
  createFiles?: (root: string, opts: { maxReadBytes: number; maxWriteBytes: number }) => WorkspaceFiles;
  /** Test seam: where the visibility policy is read from (default: the app's policy files, re-checked every two seconds). */
  policyReader?: PolicyReader;
}

type Params = Record<string, unknown>;

/** What the UI needs to know about one browsable folder of a project. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  path: string;
  isPrimary: boolean;
  /** `managed` is the folder the core creates for a project with no configured workspace; `configured` is a workspace row's own path. */
  source: "managed" | "configured";
}

const KB = 1024;
const MB = 1024 * 1024;

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new FilesError("invalid", `${key} is required`);
  return value;
}

function optionalNumber(params: Params, key: string): number | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new FilesError("invalid", `${key} must be a number`);
  return value;
}

/**
 * The host's company scope wins (the same rule as the terminal and apps
 * plugins): a caller-supplied `companyId` is only a fallback for a bridge call
 * the host did not scope; a different one alongside a host scope is a spoofing
 * attempt and is rejected outright.
 */
function companyOf(context: PluginPerformActionContext, params: Params): string {
  const claimed = typeof params.companyId === "string" && params.companyId.length > 0 ? params.companyId : null;
  if (context.companyId && claimed && claimed !== context.companyId) {
    throw new FilesError("invalid", "companyId does not match the authorized company scope");
  }
  const companyId = context.companyId ?? claimed;
  if (!companyId) throw new FilesError("invalid", "companyId is required");
  return companyId;
}

/**
 * The folders of one project, as the plugin lets people browse them. The
 * primary entry is what `ctx.projects.getPrimaryWorkspace` reports, which is
 * the project's *effective* local folder: the configured primary workspace's
 * path when one exists, and otherwise the managed folder the core creates for
 * the project (`<instance>/projects/<companyId>/<projectId>/_default`) — the
 * same resolution the core's own run scheduler uses to pick an agent's working
 * directory, so what people see here is what agents work in. Any further
 * configured workspaces of the project come after it.
 */
export async function resolveWorkspaces(projects: PluginContext["projects"], projectId: string, companyId: string): Promise<WorkspaceSummary[]> {
  const primary = await projects.getPrimaryWorkspace(projectId, companyId);
  if (!primary) throw new FilesError("not_found", "project not found in this company");
  const out: WorkspaceSummary[] = [];
  const managed = primary.id.endsWith(":managed");
  if (primary.path) out.push({ id: primary.id, name: primary.name, path: primary.path, isPrimary: true, source: managed ? "managed" : "configured" });
  const rows: PluginWorkspace[] = await projects.listWorkspaces(projectId, companyId);
  for (const row of rows) {
    if (row.id === primary.id || !row.path) continue;
    out.push({ id: row.id, name: row.name, path: row.path, isPrimary: false, source: "configured" });
  }
  return out;
}

export function createFilesPlugin(deps: FilesPluginDeps): PaperclipPlugin {
  let ready = false;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const roles = new RoleResolver(ctx.access.members, { now: deps.now });
      const createFiles = deps.createFiles ?? ((root, opts) => new WorkspaceFiles(root, opts));
      const policyReader = deps.policyReader ?? createPolicyReader();

      interface Authorized {
        companyId: string;
        userId: string;
        role: string;
        settings: FilesSettings;
        projectId: string;
        workspace: WorkspaceSummary;
        files: WorkspaceFiles;
      }

      /**
       * Every action goes through here. The actor comes from the host (never
       * from `params`), must be a signed-in user, and must hold a company role
       * in `readRoles` (or `writeRoles` for a mutation — checked against a
       * fresh read of the members API, so a demotion lands at once). A company
       * in need-to-know mode shows a restricted person only the projects their
       * groups list; the others are refused. The project must be in the host's
       * company scope, which `getPrimaryWorkspace` enforces by answering `null`
       * otherwise.
       */
      async function authorize(context: PluginPerformActionContext, params: Params, need: "read" | "write"): Promise<Authorized> {
        const companyId = companyOf(context, params);
        const actor = context.actor;
        if (actor.type !== "user" || !actor.userId) throw new FilesError("forbidden", "project files require a signed-in user");
        const settings = resolveSettings(await ctx.config.get(companyId));
        const role = await roles.assertAllowed(companyId, actor.userId, need === "read" ? settings.readRoles : settings.writeRoles, need === "read" ? "browsing project files" : "changing project files", { fresh: need === "write" });
        const projectId = str(params, "projectId");
        if (!(await projectVisibleFor(policyReader, companyId, { userId: actor.userId, role }, projectId))) {
          throw new FilesError("forbidden", "this project is outside what you can see");
        }
        const workspaces = await resolveWorkspaces(ctx.projects, projectId, companyId);
        const wanted = typeof params.workspaceId === "string" && params.workspaceId.length > 0 ? params.workspaceId : null;
        const workspace = wanted ? workspaces.find((item) => item.id === wanted) : workspaces[0];
        if (!workspace) throw new FilesError("not_found", wanted ? "no such workspace in this project" : "this project has no folder");
        const files = createFiles(workspace.path, { maxReadBytes: settings.maxDownloadMb * MB, maxWriteBytes: settings.maxUploadMb * MB });
        return { companyId, userId: actor.userId, role, settings, projectId, workspace, files };
      }

      /** One activity-log line per mutation: what and where, never content. */
      const audit = async (auth: Authorized, operation: string, target: string, extra: Record<string, unknown> = {}) => {
        await ctx.activity.log({
          companyId: auth.companyId,
          message: `Kyoube files: ${operation} ${target} in project folder ${auth.workspace.name}`,
          entityType: "project",
          entityId: auth.projectId,
          metadata: { operation, path: target, workspaceId: auth.workspace.id, userId: auth.userId, ...extra },
        });
      };

      ctx.actions.register("files.workspaces", async (params, context) => {
        const companyId = companyOf(context, params);
        const actor = context.actor;
        if (actor.type !== "user" || !actor.userId) throw new FilesError("forbidden", "project files require a signed-in user");
        const settings = resolveSettings(await ctx.config.get(companyId));
        const role = await roles.resolveRole(companyId, actor.userId);
        const mayRead = role !== null && settings.readRoles.includes(role);
        const canWrite = role !== null && settings.writeRoles.includes(role);
        const projectId = str(params, "projectId");
        // A person who may not browse, or whose groups do not include this
        // project, learns only that the tab is closed to them — not the
        // folder's path.
        const canRead = mayRead && (await projectVisibleFor(policyReader, companyId, { userId: actor.userId, role }, projectId));
        const workspaces = canRead ? await resolveWorkspaces(ctx.projects, projectId, companyId) : [];
        return {
          role,
          canRead,
          canWrite,
          limits: { maxEditableBytes: settings.maxEditableKb * KB, maxUploadBytes: settings.maxUploadMb * MB, maxDownloadBytes: settings.maxDownloadMb * MB },
          workspaces,
        };
      });

      /**
       * The project behind a task, for the breadcrumb-bar button: the host's
       * global toolbar context carries no entity, so the button sends the
       * task reference from the URL (`BAP-12` or a UUID — `ctx.issues.get`
       * accepts both) and learns which project folder to dock. Answers, never
       * throws, for the cases where the button should simply not appear.
       */
      ctx.actions.register("files.locate", async (params, context) => {
        const companyId = companyOf(context, params);
        const actor = context.actor;
        if (actor.type !== "user" || !actor.userId) return { projectId: null, projectName: null, canRead: false };
        const settings = resolveSettings(await ctx.config.get(companyId));
        const role = await roles.resolveRole(companyId, actor.userId);
        const canRead = role !== null && settings.readRoles.includes(role);
        if (!canRead) return { projectId: null, projectName: null, canRead: false };
        const issueRef = typeof params.issueRef === "string" ? params.issueRef.trim() : "";
        if (!issueRef || issueRef.length > 200) return { projectId: null, projectName: null, canRead };
        const issue = await ctx.issues.get(issueRef, companyId);
        if (!issue || !issue.projectId) return { projectId: null, projectName: null, canRead };
        if (!(await projectVisibleFor(policyReader, companyId, { userId: actor.userId, role }, issue.projectId))) return { projectId: null, projectName: null, canRead };
        const project = await ctx.projects.get(issue.projectId, companyId);
        return { projectId: project?.id ?? null, projectName: project?.name ?? null, canRead };
      });

      ctx.actions.register("files.list", async (params, context) => {
        const auth = await authorize(context, params, "read");
        return auth.files.list(params.path);
      });

      ctx.actions.register("files.stat", async (params, context) => {
        const auth = await authorize(context, params, "read");
        return auth.files.stat(params.path);
      });

      ctx.actions.register("files.read", async (params, context) => {
        const auth = await authorize(context, params, "read");
        const encoding = params.encoding === "base64" ? "base64" : "utf8";
        // Text for the editor is bounded by `maxEditableKb`; raw bytes for a
        // download (or an image preview) by `maxDownloadMb`.
        const maxBytes = encoding === "utf8" ? auth.settings.maxEditableKb * KB : auth.settings.maxDownloadMb * MB;
        return auth.files.read(params.path, { encoding, maxBytes });
      });

      ctx.actions.register("files.write", async (params, context) => {
        const auth = await authorize(context, params, "write");
        const content = params.content;
        if (typeof content !== "string") throw new FilesError("invalid", "content must be a string");
        const path = normalizeRelativePath(params.path);
        const result = await auth.files.write(path, content, { encoding: "utf8", baseMtimeMs: optionalNumber(params, "baseMtimeMs"), mustExist: params.mustExist === true });
        await audit(auth, "saved", path, { size: result.size });
        return result;
      });

      ctx.actions.register("files.create", async (params, context) => {
        const auth = await authorize(context, params, "write");
        const dir = normalizeRelativePath(params.dir);
        const name = validateEntryName(params.name);
        const target = joinRelative(dir, name);
        const kind = params.kind === "dir" ? "dir" : "file";
        const result = kind === "dir" ? await auth.files.mkdir(target) : await auth.files.write(target, "", { mustCreate: true });
        await audit(auth, kind === "dir" ? "created folder" : "created file", target);
        return result;
      });

      ctx.actions.register("files.upload", async (params, context) => {
        const auth = await authorize(context, params, "write");
        const dir = normalizeRelativePath(params.dir);
        const name = validateEntryName(params.name);
        const target = joinRelative(dir, name);
        const result = await auth.files.write(target, str(params, "contentBase64"), { encoding: "base64", mustCreate: params.overwrite !== true });
        await audit(auth, "uploaded", target, { size: result.size });
        return result;
      });

      ctx.actions.register("files.rename", async (params, context) => {
        const auth = await authorize(context, params, "write");
        const from = normalizeRelativePath(params.path);
        const to = normalizeRelativePath(params.newPath);
        const result = await auth.files.rename(from, to);
        await audit(auth, "renamed", from, { to });
        return result;
      });

      ctx.actions.register("files.delete", async (params, context) => {
        const auth = await authorize(context, params, "write");
        const path = normalizeRelativePath(params.path);
        const result = await auth.files.remove(path, { recursive: params.recursive === true });
        await audit(auth, result.kind === "dir" ? "deleted folder" : "deleted", path);
        return { ok: true, ...result };
      });

      ready = true;
      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onHealth() {
      return ready ? { status: "ok", message: `${PLUGIN_ID} ready` } : { status: "degraded", message: `${PLUGIN_ID} not ready` };
    },

    async onShutdown() {
      ready = false;
    },
  });
}

