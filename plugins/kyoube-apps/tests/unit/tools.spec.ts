import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { DataError, mapPgError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";
import { z } from "zod";
import { runTool, toolErrorText, type ToolDefinition } from "../../src/tool-runtime.js";
import { TOOL_DEFINITIONS, formatToolResult, registerTools, toolDeclarations } from "../../src/tools.js";
import { createStubService } from "../stub-service.js";

const RUN = { agentId: "agent-1", runId: "run-1", companyId: "11111111-1111-4111-8111-111111111111", projectId: "p1" };

describe("tool declarations", () => {
  it("declares every tool with a JSON schema object", () => {
    const declarations = toolDeclarations();
    expect(declarations.map((tool) => tool.name)).toEqual([
      "data_list_tables", "data_describe_table", "data_list_review", "data_create_table", "data_add_field", "data_update_field", "data_remove_field",
      "data_drop_table", "data_rename_table", "data_create_index", "data_insert", "data_update", "data_delete", "data_get",
      "data_query", "data_count", "data_sql_select", "data_my_access",
    ]);
    for (const tool of declarations) {
      expect(tool.parametersSchema).toMatchObject({ type: "object" });
      expect(tool.parametersSchema).not.toHaveProperty("$schema");
      expect(tool.description.length).toBeGreaterThan(20);
    }
    // The manifest declares these alongside the `apps_*` tools (see
    // apps-tools.spec.ts), so every data tool must appear in it, in order.
    expect(manifest.tools?.slice(0, declarations.length).map((tool) => tool.name)).toEqual(declarations.map((tool) => tool.name));
  });
  it("formats results and truncates huge payloads", () => {
    expect(formatToolResult({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatToolResult("x".repeat(30_000))).toContain("truncated");
  });
});

describe("registerTools", () => {
  function setup(fail?: Error) {
    const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
    const stub = createStubService(fail);
    registerTools(harness.ctx, stub.service);
    return { harness, ...stub };
  }

  it("routes tool calls to the service with an agent actor", async () => {
    const { harness, calls } = setup();
    const result = await harness.executeTool("data_create_table", { name: "contacts", fields: [{ name: "email", kind: "email" }] }, RUN);
    expect(calls[0]).toEqual({ method: "createTable", args: [RUN.companyId, { kind: "agent", id: "agent-1", runId: "run-1" }, { name: "contacts", displayName: undefined, description: undefined, fields: [{ name: "email", kind: "email" }] }] });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("createTable");
    await harness.executeTool("data_query", { table: "contacts", where: { field: "email", op: "is_not_null" }, limit: 10 }, RUN);
    expect(calls[1]).toEqual({ method: "query", args: [RUN.companyId, { kind: "agent", id: "agent-1", runId: "run-1" }, "contacts", { where: { field: "email", op: "is_not_null" }, orderBy: undefined, limit: 10, offset: undefined, fields: undefined }] });
    const count = await harness.executeTool("data_count", { table: "contacts" }, RUN);
    expect(count.data).toEqual({ count: 3 });
  });

  it("returns validation problems and service errors as tool errors", async () => {
    const { harness } = setup();
    const bad = await harness.executeTool("data_insert", { table: "contacts" }, RUN);
    expect(bad.error).toContain("rows");
    const { harness: failing } = setup(new DataError("forbidden", "insert rows requires write access (you have none)"));
    const denied = await failing.executeTool("data_insert", { table: "contacts", rows: [{ a: 1 }] }, RUN);
    expect(denied.error).toBe("forbidden: insert rows requires write access (you have none)");
  });

  it("every declared tool has a registered handler", async () => {
    const { harness } = setup();
    for (const tool of TOOL_DEFINITIONS) {
      await expect(harness.executeTool(tool.name, {}, RUN)).resolves.toBeDefined();
    }
  });

  // Ruling P2-R23: the actor is narrowed from `runCtx` alone, so a run context
  // that is missing the agent or company id must be refused before the
  // service is ever called (a system-level actor is never derived from a
  // tool call — see the invariant on `systemActor()` in data/service.ts).
  it("refuses to call the service when the run context is missing the agent or company", async () => {
    const { harness, calls } = setup();
    const missingAgent = await harness.executeTool("data_my_access", {}, { ...RUN, agentId: "" });
    expect(missingAgent.error).toBe("invalid: tool run context is missing the agent or company");
    const missingCompany = await harness.executeTool("data_my_access", {}, { ...RUN, companyId: "" });
    expect(missingCompany.error).toBe("invalid: tool run context is missing the agent or company");
    expect(calls).toHaveLength(0);
  });

  // Ruling P2-R24: a non-DataError failure must never leak the raw JS/driver
  // error text back to the agent; the real message still reaches the
  // operator-facing log.
  it("returns a generic error for a non-DataError failure while logging the real one", async () => {
    const { harness } = setup(new Error("boom"));
    const result = await harness.executeTool("data_my_access", {}, RUN);
    expect(result.error).toBe("error: internal error");
    const warning = harness.logs.find((entry) => entry.level === "warn");
    expect(warning).toBeDefined();
    expect(String(warning?.meta?.message)).toContain("boom");
  });

  // Ruling P4-R15: the agent sees the scrubbed message; the operator log also gets the driver
  // error it was mapped from, since an operator log is not the activity log.
  it("logs the driver error a mapped DataError came from, without returning it", async () => {
    const raw = Object.assign(new Error('duplicate key value violates unique constraint "contacts_email_idx"'), {
      code: "23505",
      constraint: "contacts_email_idx",
      detail: "Key (email)=(ada@example.com) already exists.",
    });
    const { harness } = setup(mapPgError(raw)!);
    const result = await harness.executeTool("data_insert", { table: "contacts", rows: [{ email: "ada@example.com" }] }, RUN);
    expect(result.error).toBe('conflict: already exists (constraint "contacts_email_idx")');
    expect(result.error).not.toContain("ada@example.com");
    const warning = harness.logs.find((entry) => entry.level === "warn");
    expect(String(warning?.meta?.cause)).toContain("contacts_email_idx");
  });
});

describe("runTool", () => {
  const actor = { kind: "user" as const, id: "person-1" };
  const company = "11111111-1111-4111-8111-111111111111";
  const stub = (run: ToolDefinition<null>["run"]): ToolDefinition<null> => ({ name: "stub_tool", displayName: "Stub", description: "A stub tool for tests", schema: z.object({ n: z.number().optional() }), run });

  it("returns truncated content and the full data", async () => {
    const big = { text: "x".repeat(30_000) };
    const result = await runTool(stub(async () => big), null, company, actor, {});
    expect(result).toMatchObject({ data: big });
    expect((result as { content: string }).content.endsWith("(truncated; narrow the query or use limit/offset)")).toBe(true);
  });
  it("returns a DataError's text and the error itself", async () => {
    const error = new DataError("forbidden", "schema access required");
    const result = await runTool(stub(async () => { throw error; }), null, company, actor, {});
    expect(result).toEqual({ error: toolErrorText(error), dataError: error });
    expect((result as { dataError: DataError }).dataError.code).toBe("forbidden");
  });
  it("masks other errors and logs the real message", async () => {
    const logs: Array<{ message: string; meta: Record<string, unknown> }> = [];
    const result = await runTool(stub(async () => { throw new Error("pg: secret"); }), null, company, actor, {}, (message, meta) => logs.push({ message, meta }));
    expect(result).toEqual({ error: "error: internal error" });
    expect(logs[0]?.message).toBe("tool failed");
    expect(String(logs[0]?.meta.message)).toContain("pg: secret");
    expect(logs[0]?.meta).toMatchObject({ tool: "stub_tool", actorKind: "user", actorId: "person-1" });
  });
  it("rejects invalid params", async () => {
    const result = await runTool(stub(async () => 1), null, company, actor, { n: "no" });
    expect((result as { error: string }).error).toMatch(/^invalid:/);
    expect((result as { dataError?: DataError }).dataError?.code).toBe("invalid");
  });
});
