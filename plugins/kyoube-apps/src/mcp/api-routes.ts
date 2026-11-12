import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { route, statusForError } from "../api-routes.js";
import type { AppService } from "../apps/service.js";
import type { DataActor } from "../data/permissions.js";
import type { DataService } from "../data/service.js";
import { MAX_CONTENT_CHARS, runTool } from "../tool-runtime.js";
import { PLUGIN_VERSION } from "../version.js";
import { buildCatalogue, type McpTool } from "./catalogue.js";

/** Board-only: an assistant connection always acts as the signed-in person. */
export const MCP_API_ROUTES: PluginApiRouteDeclaration[] = [
  route("mcp.tools", "GET", "/mcp/tools", "board"),
  route("mcp.call", "POST", "/mcp/call", "board"),
];

const callBody = z.object({ companyId: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) });

const INTERNAL_ERROR: PluginApiResponse = { status: 500, body: { error: "error: internal error", code: "error" } };

/**
 * The person-only half of the MCP connector: the core's bridge lists tools with
 * `mcp.tools` and runs one with `mcp.call`, always as the signed-in person.
 * Returns `null` for a route that is not `mcp.*`, so `plugin.ts` can chain it.
 *
 * A Kyoube refusal answers 200 `{ outcome: "rejected", … }`: the core's
 * internal dispatch replaces every 4xx body with a generic message, and the
 * person's assistant needs ours. Only route-level refusals keep a 4xx.
 */
export async function handleMcpApiRequest(
  services: { data: DataService; apps: AppService },
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("mcp.")) return null;
  // The routes are declared `board`, which the host enforces; checked again so
  // a mis-declared route could never let an agent act through a person's tools.
  if (input.actor.actorType === "agent") {
    return { status: 403, body: { error: "forbidden: assistant connections act as a person", code: "forbidden" } };
  }
  // Ruling P2-R23: no hollow actor reaches a service.
  if (!input.actor.actorId) return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  switch (input.routeKey) {
    case "mcp.tools":
      return { status: 200, body: { version: PLUGIN_VERSION, tools: buildCatalogue().map((tool) => tool.entry) } };
    case "mcp.call":
      return call(services, input, log);
    default:
      return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
  }
}

async function call(
  services: { data: DataService; apps: AppService },
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse> {
  const parsed = callBody.safeParse(input.body);
  if (!parsed.success) {
    const text = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; ");
    return { status: 400, body: { error: `invalid: ${text}`, code: "invalid" } };
  }
  const tool: McpTool | undefined = buildCatalogue().find((candidate) => candidate.entry.name === parsed.data.tool);
  if (!tool) return { status: 404, body: { error: `not_found: no tool ${parsed.data.tool}`, code: "not_found" } };
  // The request id belongs to the core's idempotency store, and the company
  // always comes from the connection, never from the arguments.
  const { requestId: _requestId, companyId: _companyId, ...args } = parsed.data.arguments;
  // Ruling P2-R23: the actor comes from the host-authenticated `input.actor` only.
  const actor: DataActor = { kind: "user", id: input.actor.userId ?? input.actor.actorId, runId: null };
  try {
    const result = await runTool(tool.definition, services[tool.service], input.companyId, actor, args, log);
    if ("error" in result) {
      const status = result.dataError ? statusForError(result.dataError) : 500;
      if (result.dataError && status < 500) {
        return { status: 200, body: { outcome: "rejected", status, code: result.dataError.code, message: result.error } };
      }
      return INTERNAL_ERROR;
    }
    // Truncated exactly when an agent's result would be: `formatToolResult` only
    // grows the text past the limit by appending its truncation note.
    return result.content.length > MAX_CONTENT_CHARS
      ? { status: 200, body: { outcome: "completed", truncated: true, content: result.content } }
      : { status: 200, body: { outcome: "completed", data: result.data } };
  } catch (error) {
    log?.("mcp call failed", { tool: tool.entry.name, companyId: input.companyId, error: String(error) });
    return INTERNAL_ERROR;
  }
}
