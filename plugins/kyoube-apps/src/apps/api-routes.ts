import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { actorFromRequest, errorBody, statusForError } from "../api-routes.js";
import { DataError } from "../data/errors.js";
import { guardOption, guardToolParams } from "../decisions/guardrail.js";
import { APP_MANIFEST_SCHEMA, MAX_APP_NOTES } from "./manifest.js";
import { confirmations, type AppService } from "./service.js";

type Method = "GET" | "POST";

function route(routeKey: string, method: Method, path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth: "board-or-agent",
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

export const APP_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("apps.list", "GET", "/apps"),
  route("apps.create", "POST", "/apps"),
  route("apps.get", "GET", "/apps/:slug"),
  route("apps.update", "POST", "/apps/:slug"),
  route("apps.publish", "POST", "/apps/:slug/publish"),
  route("apps.rollback", "POST", "/apps/:slug/rollback"),
  route("apps.archive", "POST", "/apps/:slug/archive"),
];

// Bodies stay non-strict at the top level: the host resolves the company from
// `body.companyId` (see `companyResolution` above), so it arrives alongside
// these fields. The manifest itself is the shared strict schema, so a typo
// inside it is rejected rather than silently dropped.
const writeBody = z.object({ manifest: APP_MANIFEST_SCHEMA, source: z.string().min(1), notes: z.string().max(MAX_APP_NOTES).nullable().optional() });
const confirmFields = { decisionsConfirmed: z.boolean().optional(), connectionsConfirmed: z.boolean().optional(), tasksConfirmed: z.boolean().optional() };
const publishBody = z.object({ version: z.number().int().optional(), ...confirmFields, ...guardToolParams });
const rollbackBody = z.object({ version: z.number().int(), ...confirmFields, ...guardToolParams });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; "));
  return parsed.data;
}

function slugOf(input: PluginApiRequestInput): string {
  const value = input.params.slug;
  if (!value) throw new DataError("invalid", "slug is required");
  return value;
}

/** `?version=` accepts an integer, `current`, or `latest` (the default). */
function versionOf(input: PluginApiRequestInput): number | "current" | "latest" {
  const raw = typeof input.query.version === "string" ? input.query.version.trim() : "";
  if (raw === "" || raw === "latest") return "latest";
  if (raw === "current") return "current";
  const version = Number(raw);
  if (!Number.isInteger(version)) throw new DataError("invalid", "version must be an integer, current, or latest");
  return version;
}

/**
 * The REST half of the Apps surface. Returns `null` — not a 404 — for a route
 * that belongs to the Data half, so `plugin.ts` can try this dispatcher first
 * and fall through to `handleApiRequest`. Every apps route key is answered
 * here, so an unknown one can never reach the data dispatcher.
 */
export async function handleAppsApiRequest(
  apps: AppService,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("apps.")) return null;
  // Ruling P2-R23, carried by P3-R7: refuse before dispatching when the
  // host-supplied actor carries no id, rather than letting a hollow actor
  // reach `AppService`.
  if (!input.actor.actorId) {
    return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  }
  const companyId = input.companyId;
  // Invariant (P2-R23): "user" | "agent" from the host-authenticated actor
  // only — never from the body — so `{ kind: "system" }` is unreachable here.
  const actor = actorFromRequest(input);
  try {
    let body: unknown;
    switch (input.routeKey) {
      case "apps.list": body = await apps.list(companyId, actor); break;
      case "apps.create": { const b = parse(writeBody, input.body); body = await apps.create(companyId, actor, b.manifest, b.source, b.notes ?? null); break; }
      case "apps.get": body = await apps.get(companyId, actor, slugOf(input), versionOf(input)); break;
      case "apps.update": { const b = parse(writeBody, input.body); body = await apps.update(companyId, actor, slugOf(input), b.manifest, b.source, b.notes ?? null); break; }
      // The guardrail's ids ride along only when the body carries them (docs/decisions.md).
      case "apps.publish": { const b = parse(publishBody, input.body); body = await apps.publish(companyId, actor, slugOf(input), b.version, { ...confirmations(b), ...guardOption(input.body) }); break; }
      case "apps.rollback": { const b = parse(rollbackBody, input.body); body = await apps.rollback(companyId, actor, slugOf(input), b.version, { ...confirmations(b), ...guardOption(input.body) }); break; }
      case "apps.archive": body = await apps.archive(companyId, actor, slugOf(input), guardOption(input.body)); break;
      default: return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
    }
    return { status: 200, body };
  } catch (error) {
    if (error instanceof DataError) return { status: statusForError(error), body: errorBody(error) };
    // Ruling P2-R24: never echo a raw JS/driver error message to the caller.
    // Log the real error for operators instead (never the request body, which
    // carries an app's whole source).
    log?.("apps api request failed", { routeKey: input.routeKey, companyId, error: String(error) });
    return { status: statusForError(error), body: { error: "error: internal error", code: "error" } };
  }
}
