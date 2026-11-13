import { z } from "zod";
import type { AppService } from "../apps/service.js";
import { APP_TOOL_DEFINITIONS } from "../apps/tools.js";
import type { DataService } from "../data/service.js";
import { GUARD_NOTE } from "../decisions/guardrail.js";
import { jsonSchemaFor, type ToolDefinition } from "../tool-runtime.js";
import { TOOL_DEFINITIONS } from "../tools.js";
import { MCP_TASK_DEFINITIONS } from "./task-tools.js";

/**
 * The agent tools as MCP tools, for a person's assistant connected at
 * `/mcp/kyoubeai`. The core's bridge reads this catalogue through
 * `GET /mcp/tools` and calls a tool through `POST /mcp/call` (api-routes.ts),
 * which runs the same agent definition as the signed-in person.
 */
export type McpTier = "read" | "write" | "configure";

export interface McpToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: McpTier;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

// The agent text says "agents cannot publish such a version"; over MCP the caller is the person's assistant.
const CONFIRMATIONS = {
  decisionsConfirmed: "set true only after you showed the person what the version's new or changed decision sets send and they agreed",
  connectionsConfirmed: "set true only after you showed the person which outside services the version's new or changed connections reach and they agreed",
  tasksConfirmed: "set true only after you showed the person which agent each new or changed task template reaches and what it is told, and they agreed",
};

/**
 * One row per agent tool. A tool without a row fails `buildCatalogue` (and so
 * the tests), so a new agent tool can't reach MCP unclassified or silently
 * skip it. `description` replaces agent-facing text with text for a person;
 * `properties` does the same for parameter descriptions.
 */
export const MCP_SETTINGS: Record<string, { tier: McpTier; destructive?: true; description?: string; properties?: Record<string, string> }> = {
  data_list_tables: { tier: "read" },
  data_describe_table: { tier: "read" },
  data_list_review: {
    tier: "read",
    description: "List the rows whose AI column answers are waiting for a person to review: row id, field, the model's suggestion and its confidence. No row values; read the rows with kyoubeai_data_get.",
  },
  data_get: { tier: "read" },
  data_query: { tier: "read" },
  data_count: { tier: "read" },
  data_sql_select: { tier: "read" },
  data_my_access: { tier: "read" },
  apps_list: { tier: "read" },
  apps_get: {
    tier: "read",
    description: `${APP_TOOL_DEFINITIONS.find((tool) => tool.name === "apps_get")!.description} The app's task templates are under tasks in its manifest; start one with apps_task_start.`,
  },
  apps_task_list: { tier: "read" },
  apps_task_get: { tier: "read" },
  apps_task_start: { tier: "write" },
  apps_task_cancel: { tier: "write", destructive: true },
  data_insert: { tier: "write" },
  data_update: { tier: "write", destructive: true },
  data_delete: { tier: "write", destructive: true },
  apps_create: { tier: "write" },
  apps_update: { tier: "write" },
  data_create_table: { tier: "configure" },
  data_add_field: { tier: "configure" },
  data_update_field: { tier: "configure" },
  data_remove_field: { tier: "configure", destructive: true },
  data_drop_table: { tier: "configure", destructive: true },
  data_rename_table: { tier: "configure" },
  data_create_index: { tier: "configure" },
  apps_publish: {
    tier: "configure",
    description: "Publish a version (default: latest) so company members can open it. Declared tables must exist. Requires schema access. If the version adds or changes decision sets, connections or task templates, the call is refused until you show the person what changed and they agree; then send it again with a new requestId and decisionsConfirmed, connectionsConfirmed or tasksConfirmed set to true.",
    properties: CONFIRMATIONS,
  },
  apps_rollback: {
    tier: "configure",
    description: "Point the published app at an earlier version. Requires schema access. If that version has different decision sets, connections or task templates, the call is refused until you show the person what changed and they agree; then send it again with a new requestId and decisionsConfirmed, connectionsConfirmed or tasksConfirmed set to true.",
    properties: CONFIRMATIONS,
  },
  apps_archive: { tier: "configure", destructive: true },
};

export interface McpTool {
  entry: McpToolEntry;
  service: "data" | "apps";
  // Each definition's params type differs; the route runs it through `runTool`.
  definition: ToolDefinition<any>;
}

const MCP_PREFIX = "kyoubeai_";

// The core's own contract (public-mcp/contracts.js): its receipts store the id as a uuid.
const requestId = z.uuid().describe("A new UUID for this intended action. Reuse this UUID and identical arguments on retries; never invent a second ID after an uncertain result.");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The definition's parameters without the agent guardrail ids, with the person-facing property
 * descriptions, plus `requestId` for a change.
 */
function inputSchemaFor(name: string, schema: z.ZodTypeAny, tier: McpTier, properties: Record<string, string> = {}): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) throw new Error("MCP tools need an object schema");
  const { issueId: _issueId, confirmationId: _confirmationId, ...shape } = schema.shape as Record<string, z.ZodType>;
  for (const [property, text] of Object.entries(properties)) {
    const field = shape[property];
    if (!field) throw new Error(`MCP property ${property} missing on ${name}`);
    shape[property] = field.describe(text);
  }
  return jsonSchemaFor(z.object(tier === "read" ? shape : { ...shape, requestId }));
}

type Definitions = { data: ToolDefinition<DataService>[]; apps: ToolDefinition<AppService>[] };

function build(definitions: Definitions): McpTool[] {
  const all = [
    ...definitions.data.map((definition) => ({ service: "data" as const, definition })),
    ...definitions.apps.map((definition) => ({ service: "apps" as const, definition })),
  ];
  const names = new Set(all.map(({ definition }) => definition.name));
  for (const { definition } of all) {
    if (!MCP_SETTINGS[definition.name]) throw new Error(`MCP settings missing for ${definition.name}`);
  }
  for (const name of Object.keys(MCP_SETTINGS)) {
    if (!names.has(name)) throw new Error(`MCP settings for unknown tool ${name}`);
  }
  // Whole words only: `data_update` inside `data_update_field` has no word
  // boundary after it, so each name is replaced exactly once.
  const toolNames = new RegExp(`\\b(${[...names].map(escapeRegExp).join("|")})\\b`, "g");
  return all.map(({ service, definition }) => {
    const settings = MCP_SETTINGS[definition.name]!;
    const description = (settings.description ?? definition.description)
      .replace(GUARD_NOTE, "")
      .replace(toolNames, (name) => `${MCP_PREFIX}${name}`);
    return {
      service,
      definition,
      entry: {
        name: `${MCP_PREFIX}${definition.name}`,
        title: definition.displayName,
        description,
        inputSchema: inputSchemaFor(definition.name, definition.schema, settings.tier, settings.properties),
        tier: settings.tier,
        annotations: {
          readOnlyHint: settings.tier === "read",
          destructiveHint: settings.destructive === true,
          idempotentHint: settings.tier === "read",
          openWorldHint: false,
        },
      },
    };
  });
}

let memo: McpTool[] | undefined;

/**
 * The catalogue, built once from the agent definitions. Tests pass their own
 * definition lists to check the settings guard; those builds are not kept.
 */
export function buildCatalogue(definitions?: Definitions): McpTool[] {
  if (definitions) return build(definitions);
  memo ??= build({ data: TOOL_DEFINITIONS, apps: [...APP_TOOL_DEFINITIONS, ...MCP_TASK_DEFINITIONS] });
  return memo;
}
