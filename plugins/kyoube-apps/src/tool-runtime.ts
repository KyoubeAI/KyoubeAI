import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { DataError } from "./data/errors.js";
import type { DataActor } from "./data/permissions.js";

/**
 * One agent tool: its declaration and the call it makes on a service. The
 * service is a type parameter so the Data tools and the Apps tools share this
 * runtime — and with it the actor rules, the validation errors, and the error
 * masking below — without either knowing about the other's service.
 */
export interface ToolDefinition<S> {
  name: string;
  displayName: string;
  description: string;
  schema: z.ZodTypeAny;
  // `params` is this tool's own parsed schema output, which differs per tool.
  run: (service: S, companyId: string, actor: DataActor, params: any) => Promise<unknown>;
}

const MAX_CONTENT_CHARS = 20_000;

export function formatToolResult(data: unknown): string {
  const text = JSON.stringify(data, null, 2) ?? "null";
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated; narrow the query or use limit/offset)` : text;
}

export function jsonSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export function declarationsFor<S>(definitions: ToolDefinition<S>[]): PluginToolDeclaration[] {
  return definitions.map((tool) => ({ name: tool.name, displayName: tool.displayName, description: tool.description, parametersSchema: jsonSchemaFor(tool.schema) }));
}

/** A `DataError` as an agent sees it: its message, then any caller-safe details as JSON. */
export function toolErrorText(error: DataError): string {
  return error.details && Object.keys(error.details).length > 0 ? `${error.message} ${JSON.stringify(error.details)}` : error.message;
}

export type ToolRunResult = { content: string; data: unknown } | { error: string; dataError?: DataError };

/**
 * Runs one tool for a given actor: validates `params`, calls the tool, and turns
 * the outcome into a result. Agent tools and MCP calls share it, so both get the
 * same validation text and error masking. `dataError` is returned for callers
 * (the MCP route) that map it to a status; the agent handler drops it.
 */
export async function runTool<S>(
  tool: ToolDefinition<S>,
  service: S,
  companyId: string,
  actor: DataActor,
  params: unknown,
  logWarn?: (message: string, meta: Record<string, unknown>) => void,
): Promise<ToolRunResult> {
  const parsed = tool.schema.safeParse(params ?? {});
  if (!parsed.success) {
    const text = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"} ${issue.message}`).join("; ");
    return { error: `invalid: ${text}`, dataError: new DataError("invalid", text) };
  }
  try {
    const data = await tool.run(service, companyId, actor, parsed.data);
    return { content: formatToolResult(data), data };
  } catch (error) {
    const message = error instanceof DataError ? error.message : `error: ${error instanceof Error ? error.message : String(error)}`;
    // Ruling P2-R24: meta stays free of `params` (untrusted agent input) —
    // only identifying info and the real error go to the operator log.
    // Ruling P4-R15 scrubs a mapped DataError's own message of driver detail, so the raw
    // error it was mapped from is logged alongside it: this is the operator log, not the
    // activity log, and an operator debugging a failed write needs the driver's text.
    const cause = error instanceof DataError && error.cause !== undefined
      ? { cause: error.cause instanceof Error ? error.cause.message : String(error.cause) }
      : {};
    logWarn?.("tool failed", { tool: tool.name, actorKind: actor.kind, actorId: actor.id, message, ...cause });
    // Never echo a raw JS/driver error message back; only a `DataError`'s own
    // message (already considered caller-safe) is.
    return error instanceof DataError ? { error: toolErrorText(error), dataError: error } : { error: "error: internal error" };
  }
}

export function registerToolHandlers<S>(ctx: PluginContext, definitions: ToolDefinition<S>[], service: S): void {
  for (const tool of definitions) {
    ctx.tools.register(tool.name, { displayName: tool.displayName, description: tool.description, parametersSchema: jsonSchemaFor(tool.schema) }, async (params, runCtx) => {
      // Ruling P2-R23: refuse before touching the service when the host-supplied
      // run context is missing the agent or company id, rather than letting a
      // hollow actor reach the service.
      if (!runCtx.agentId || !runCtx.companyId) {
        return { error: "invalid: tool run context is missing the agent or company" };
      }
      // Invariant: the actor is narrowed to "agent" from the host-authenticated
      // `runCtx` ONLY — never from `params` (untrusted model output).
      // `{ kind: "system" }` (see `systemActor()` in data/service.ts) grants
      // unconditional schema access and is plugin-internal only; no actor built
      // here may ever carry that kind.
      const actor: DataActor = { kind: "agent", id: runCtx.agentId, runId: runCtx.runId };
      const result = await runTool(tool, service, runCtx.companyId, actor, params, (message, meta) => ctx.logger.warn(message, meta));
      return "error" in result ? { error: result.error } : { content: result.content, data: result.data };
    });
  }
}
