import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { GUARD_NOTE, guardOption, guardToolParams } from "../decisions/guardrail.js";
import { declarationsFor, registerToolHandlers, type ToolDefinition } from "../tool-runtime.js";
import { APP_MANIFEST_SCHEMA, APP_SLUG_RE, MAX_APP_NOTES } from "./manifest.js";
import { confirmations, type AppService } from "./service.js";

const slug = z.string().regex(APP_SLUG_RE, "slug must match ^[a-z][a-z0-9-]{1,48}$");
const manifestSchema = APP_MANIFEST_SCHEMA.describe("app manifest: which Data tables the app may use and with what access");
const source = z.string().min(1).describe("one complete HTML document; window.kyoube is injected before it runs (see the kyoube-apps skill)");
const notes = z.string().max(MAX_APP_NOTES).optional().describe("optional note recorded with this version");
// The UI and `AppService.get` both take this union; a tool may ask for a
// numbered version, the published one, or the newest draft.
const versionRef = z.union([z.number().int(), z.enum(["current", "latest"])]);

type WithSource = { source: string };
type WithVersion = { version: WithSource | null };

/** One version, with its document replaced by its size. */
function summarise(version: WithSource): unknown {
  const { source, ...rest } = version;
  return { ...rest, sourceBytes: Buffer.byteLength(source, "utf8") };
}

/**
 * An app's source is a whole HTML document, so no tool answer pastes one back
 * into the agent's context — it reports the size instead, and the agent asks
 * for the text explicitly with `apps_get`'s `includeSource` when it is about
 * to edit it. `apps_create` and `apps_update` echo nothing back either
 * (ruling P3-R20): the agent has just sent that document. Both service shapes
 * are handled: `{ app, version }` (get, create) and a bare version (update).
 */
function withoutSource<T extends WithSource | WithVersion>(result: T, includeSource = false): unknown {
  if (includeSource) return result;
  if ("source" in result) return summarise(result);
  return result.version ? { ...result, version: summarise(result.version) } : result;
}

const connectionsConfirmed = z.boolean().optional().describe("set true only after the person reviewed which outside services the version's new or changed connections reach; agents cannot publish such a version");
const decisionsConfirmed = z.boolean().optional().describe("set true only after the person reviewed what the version's new or changed decision sets send; agents cannot publish such a version");
const tasksConfirmed = z.boolean().optional().describe("set true only after the person reviewed which agent each new or changed task template reaches and what it is told; agents cannot publish such a version");

export const APP_TOOL_DEFINITIONS: ToolDefinition<AppService>[] = [
  { name: "apps_list", displayName: "List apps", description: "List this company's apps (published apps, plus drafts if you have write access).", schema: z.object({}), run: (s, c, a) => s.list(c, a) },
  { name: "apps_get", displayName: "Get app", description: "Get an app and one of its versions (default latest). Set includeSource to read the HTML.", schema: z.object({ slug, version: versionRef.optional(), includeSource: z.boolean().optional() }), run: async (s, c, a, p) => withoutSource(await s.get(c, a, p.slug, p.version ?? "latest"), p.includeSource ?? false) },
  { name: "apps_create", displayName: "Create app", description: "Create a new app as a draft (version 1) from a manifest and a single-file HTML source. Publish it with apps_publish. Requires write access.", schema: z.object({ manifest: manifestSchema, source, notes }), run: async (s, c, a, p) => withoutSource(await s.create(c, a, p.manifest, p.source, p.notes ?? null)) },
  { name: "apps_update", displayName: "Update app", description: "Save a new draft version of an existing app (manifest + full source). The published version is unchanged until apps_publish. Requires write access.", schema: z.object({ slug, manifest: manifestSchema, source, notes }), run: async (s, c, a, p) => withoutSource(await s.update(c, a, p.slug, p.manifest, p.source, p.notes ?? null)) },
  { name: "apps_publish", displayName: "Publish app", description: `Publish a version (default: latest) so company members can open it. Declared tables must exist. Requires schema access. A version that adds or changes decision sets, connections or task templates needs a person to publish it: save the draft and ask the person who started the task.${GUARD_NOTE}`, schema: z.object({ slug, version: z.number().int().optional(), decisionsConfirmed, connectionsConfirmed, tasksConfirmed, ...guardToolParams }), run: (s, c, a, p) => s.publish(c, a, p.slug, p.version, { ...confirmations(p), ...guardOption(p) }) },
  { name: "apps_rollback", displayName: "Roll back app", description: `Point the published app at an earlier version. Requires schema access. Rolling back to a version with different decision sets, connections or task templates needs a person.${GUARD_NOTE}`, schema: z.object({ slug, version: z.number().int(), decisionsConfirmed, connectionsConfirmed, tasksConfirmed, ...guardToolParams }), run: (s, c, a, p) => s.rollback(c, a, p.slug, p.version, { ...confirmations(p), ...guardOption(p) }) },
  { name: "apps_archive", displayName: "Archive app", description: `Hide an app from the gallery (its versions are kept). Requires schema access.${GUARD_NOTE}`, schema: z.object({ slug, ...guardToolParams }), run: (s, c, a, p) => s.archive(c, a, p.slug, guardOption(p)) },
];

export const appToolDeclarations = (): PluginToolDeclaration[] => declarationsFor(APP_TOOL_DEFINITIONS);
export const registerAppTools = (ctx: PluginContext, apps: AppService): void => registerToolHandlers(ctx, APP_TOOL_DEFINITIONS, apps);
