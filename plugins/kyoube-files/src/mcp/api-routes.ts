import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { FilesError, type FilesErrorCode } from "../errors.js";
import { buildFilesCatalogue, type FilesMcpContext } from "./catalogue.js";

function route(routeKey: string, method: "GET" | "POST", path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth: "board",
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

/** Board-only: an assistant connection always acts as the signed-in person. */
export const FILES_MCP_ROUTES: PluginApiRouteDeclaration[] = [
  route("mcp.tools", "GET", "/mcp/tools"),
  route("mcp.call", "POST", "/mcp/call"),
];

/** What the plugin supplies: access checks and the folder, so this module stays free of host calls. */
export interface FilesMcpDeps {
  contextFor(person: { companyId: string; userId: string }, args: { projectId: string; folderId?: string }, need: "read" | "write"): Promise<FilesMcpContext>;
  describeFolders(person: { companyId: string; userId: string }, projectId: string): Promise<unknown>;
}

const MAX_CONTENT_CHARS = 20_000;
const TRUNCATION_NOTE = "\n\n[Result truncated at 20000 characters. Narrow the request: list a subfolder, or read fewer lines with offset and limit.]";

const STATUS: Record<FilesErrorCode, number> = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409, exists: 409, limit: 413 };

const callBody = z.object({ companyId: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) });

const INTERNAL_ERROR: PluginApiResponse = { status: 500, body: { error: "error: internal error", code: "error" } };

function rejected(error: FilesError): PluginApiResponse {
  return { status: 200, body: { outcome: "rejected", status: STATUS[error.code], code: error.code, message: error.message } };
}

/**
 * The person-only half of the MCP connector for project files: the core's
 * bridge lists tools with `mcp.tools` and runs one with `mcp.call`, always as
 * the signed-in person. Returns `null` for a route that is not `mcp.*`.
 *
 * A refusal of ours answers 200 `{ outcome: "rejected", … }`: the core's
 * internal dispatch replaces every 4xx body with a generic message, and the
 * person's assistant needs ours. Only route-level refusals keep a 4xx.
 */
export async function handleFilesMcpRequest(
  deps: FilesMcpDeps,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse | null> {
  if (!input.routeKey.startsWith("mcp.")) return null;
  // Declared `board`, which the host enforces; checked again so a mis-declared
  // route could never let an agent act through a person's tools.
  if (input.actor.actorType === "agent") {
    return { status: 403, body: { error: "forbidden: assistant connections act as a person", code: "forbidden" } };
  }
  if (!input.actor.actorId) return { status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } };
  switch (input.routeKey) {
    case "mcp.tools":
      return { status: 200, body: { tools: buildFilesCatalogue().map((tool) => tool.entry) } };
    case "mcp.call":
      return call(deps, input, log);
    default:
      return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
  }
}

async function call(
  deps: FilesMcpDeps,
  input: PluginApiRequestInput,
  log?: (message: string, meta?: Record<string, unknown>) => void,
): Promise<PluginApiResponse> {
  const parsed = callBody.safeParse(input.body);
  if (!parsed.success) {
    const text = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; ");
    return { status: 400, body: { error: `invalid: ${text}`, code: "invalid" } };
  }
  const tool = buildFilesCatalogue().find((candidate) => candidate.entry.name === parsed.data.tool);
  if (!tool) return { status: 404, body: { error: `not_found: no tool ${parsed.data.tool}`, code: "not_found" } };
  // The request id belongs to the core's idempotency store, and the company
  // always comes from the connection, never from the arguments.
  const { requestId: _requestId, companyId: _companyId, ...rawArgs } = parsed.data.arguments;
  const checked = tool.schema.safeParse(rawArgs);
  if (!checked.success) {
    const text = checked.error.issues.map((issue) => `${issue.path.join(".") || "arguments"} ${issue.message}`).join("; ");
    return rejected(new FilesError("invalid", text));
  }
  const args = checked.data as { projectId: string; folderId?: string };
  const person = { companyId: input.companyId, userId: input.actor.userId ?? input.actor.actorId };
  try {
    const data = tool.folderScoped
      ? await tool.run(await deps.contextFor(person, { projectId: args.projectId, ...(args.folderId !== undefined ? { folderId: args.folderId } : {}) }, tool.entry.tier), args)
      : await deps.describeFolders(person, args.projectId);
    const text = JSON.stringify(data, null, 2) ?? "null";
    return text.length > MAX_CONTENT_CHARS
      ? { status: 200, body: { outcome: "completed", truncated: true, content: `${text.slice(0, MAX_CONTENT_CHARS)}${TRUNCATION_NOTE}` } }
      : { status: 200, body: { outcome: "completed", data } };
  } catch (error) {
    if (error instanceof FilesError) return rejected(error);
    log?.("mcp call failed", { tool: tool.entry.name, companyId: input.companyId, error: String(error) });
    return INTERNAL_ERROR;
  }
}
