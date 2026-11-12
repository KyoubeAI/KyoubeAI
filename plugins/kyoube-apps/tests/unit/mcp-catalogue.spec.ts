import { describe, expect, it } from "vitest";
import { z } from "zod";
import { APP_TOOL_DEFINITIONS } from "../../src/apps/tools.js";
import { buildCatalogue } from "../../src/mcp/catalogue.js";
import { TOOL_DEFINITIONS } from "../../src/tools.js";

// The spec's section 2 lists, verbatim.
const READ = ["data_list_tables", "data_describe_table", "data_list_review", "data_get", "data_query", "data_count", "data_sql_select", "data_my_access", "apps_list", "apps_get"];
const WRITE = ["data_insert", "data_update", "data_delete", "apps_create", "apps_update"];
const CONFIGURE = ["data_create_table", "data_add_field", "data_update_field", "data_remove_field", "data_drop_table", "data_rename_table", "data_create_index", "apps_publish", "apps_rollback", "apps_archive"];
const DESTRUCTIVE = ["data_update", "data_delete", "data_remove_field", "data_drop_table", "apps_archive"];

const kyoube = (names: string[]) => names.map((name) => `kyoubeai_${name}`).sort();

describe("the MCP catalogue", () => {
  const catalogue = buildCatalogue();
  const entries = catalogue.map((tool) => tool.entry);
  const schemaOf = (entry: (typeof entries)[number]) => entry.inputSchema as { properties?: Record<string, unknown>; required?: string[] };

  it("has one entry per agent tool definition", () => {
    expect(entries).toHaveLength(25);
    expect(entries.map((entry) => entry.name).sort()).toEqual(kyoube([...TOOL_DEFINITIONS, ...APP_TOOL_DEFINITIONS].map((tool) => tool.name)));
    expect(catalogue.filter((tool) => tool.service === "data")).toHaveLength(18);
    expect(catalogue.filter((tool) => tool.service === "apps")).toHaveLength(7);
  });

  it("names, titles and describes every entry", () => {
    for (const entry of entries) {
      expect(entry.name).toMatch(/^kyoubeai_(data|apps)_[a-z_]+$/);
      expect(entry.name.length).toBeLessThanOrEqual(64);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    expect(entries.find((entry) => entry.name === "kyoubeai_data_query")!.title).toBe("Query rows");
  });

  it("leaves the guard and company parameters out of every input schema", () => {
    for (const entry of entries) {
      const properties = schemaOf(entry).properties ?? {};
      expect(properties).not.toHaveProperty("issueId");
      expect(properties).not.toHaveProperty("confirmationId");
      expect(properties).not.toHaveProperty("companyId");
      expect(entry.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("requires a requestId on write and configure tools only", () => {
    for (const entry of entries) {
      const schema = schemaOf(entry);
      if (entry.tier === "read") {
        expect(schema.properties ?? {}).not.toHaveProperty("requestId");
        expect(schema.required ?? []).not.toContain("requestId");
      } else {
        expect(schema.properties).toHaveProperty("requestId");
        expect(schema.required).toContain("requestId");
      }
    }
  });

  it("matches the spec's tier and destructive lists exactly", () => {
    const names = (pick: (entry: (typeof entries)[number]) => boolean) => entries.filter(pick).map((entry) => entry.name).sort();
    expect(names((entry) => entry.tier === "read")).toEqual(kyoube(READ));
    expect(names((entry) => entry.tier === "write")).toEqual(kyoube(WRITE));
    expect(names((entry) => entry.tier === "configure")).toEqual(kyoube(CONFIGURE));
    expect(names((entry) => entry.annotations.destructiveHint)).toEqual(kyoube(DESTRUCTIVE));
    for (const entry of entries) {
      expect(entry.annotations).toEqual({ readOnlyHint: entry.tier === "read", destructiveHint: DESTRUCTIVE.includes(entry.name.slice("kyoubeai_".length)), idempotentHint: entry.tier === "read", openWorldHint: false });
    }
  });

  it("speaks to a person: no task id, no bare agent tool names", () => {
    for (const entry of entries) {
      expect(entry.description).not.toContain("$PAPERCLIP_TASK_ID");
      expect(entry.description).not.toMatch(/(?<!kyoubeai_)\b(data|apps)_[a-z]/);
    }
    expect(entries.find((entry) => entry.name === "kyoubeai_data_list_review")!.description).toBe(
      "List the rows whose AI column answers are waiting for a person to review: row id, field, the model's suggestion and its confidence. No row values; read the rows with kyoubeai_data_get.",
    );
    expect(entries.find((entry) => entry.name === "kyoubeai_apps_create")!.description).toContain("Publish it with kyoubeai_apps_publish.");
    for (const entry of entries) {
      expect(entry.description).not.toContain("the person who started the task");
      expect(entry.description).not.toContain("your task");
    }
    expect(entries.find((entry) => entry.name === "kyoubeai_apps_publish")!.description).toBe(
      "Publish a version (default: latest) so company members can open it. Declared tables must exist. Requires schema access. If the version adds or changes decision sets, connections or task templates, the call is refused until you show the person what changed and they agree; then send it again with decisionsConfirmed, connectionsConfirmed or tasksConfirmed set to true.",
    );
    expect(entries.find((entry) => entry.name === "kyoubeai_apps_rollback")!.description).toBe(
      "Point the published app at an earlier version. Requires schema access. If that version has different decision sets, connections or task templates, the call is refused until you show the person what changed and they agree; then send it again with decisionsConfirmed, connectionsConfirmed or tasksConfirmed set to true.",
    );
    expect(entries.find((entry) => entry.name === "kyoubeai_data_drop_table")!.description).toBe("Drop a table. Recoverable for 30 days unless the company enabled hard deletes. Requires schema access.");
  });

  it("keeps each entry's agent definition to run", () => {
    const query = catalogue.find((tool) => tool.entry.name === "kyoubeai_data_query")!;
    expect(query.service).toBe("data");
    expect(query.definition).toBe(TOOL_DEFINITIONS.find((tool) => tool.name === "data_query"));
  });

  it("refuses an agent tool without MCP settings", () => {
    const extra = { name: "data_x", displayName: "X", description: "x", schema: z.object({}), run: async () => null };
    expect(() => buildCatalogue({ data: [...TOOL_DEFINITIONS, extra], apps: APP_TOOL_DEFINITIONS })).toThrow("MCP settings missing for data_x");
  });

  it("refuses MCP settings for a tool that does not exist", () => {
    expect(() => buildCatalogue({ data: TOOL_DEFINITIONS.filter((tool) => tool.name !== "data_get"), apps: APP_TOOL_DEFINITIONS })).toThrow("MCP settings for unknown tool data_get");
  });

  it("is built once", () => {
    expect(buildCatalogue()).toBe(buildCatalogue());
  });
});
