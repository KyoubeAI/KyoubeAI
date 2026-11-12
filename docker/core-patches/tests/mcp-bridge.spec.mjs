import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findTool, KYOUBE_MCP_PATH, listTools, REMOVED_TOOLS, registerDispatch, resetForTests, titleFor, UNAVAILABLE } from "../mcp-bridge.mjs";

class CapabilityError extends Error {}
const deps = { z, CapabilityError };
const p = { grant: { companyId: "c1" } };

const QUERY = { name: "kyoubeai_data_query", title: "Data query", description: "Run a query", inputSchema: { type: "object" }, tier: "read", annotations: { readOnlyHint: true } };
const DROP = { name: "kyoubeai_data_drop_table", title: "Data drop table", description: "Drop a table", inputSchema: { type: "object", properties: { table: { type: "string" } } }, tier: "configure", annotations: { destructiveHint: true } };

let now;
let calls;
let dispatch;
beforeEach(() => {
  now = 1_000_000;
  calls = [];
  dispatch = vi.fn(async (...args) => {
    calls.push(args);
    return { version: 1, tools: [QUERY, DROP] };
  });
  resetForTests(() => now);
  registerDispatch(dispatch);
});

describe("constants", () => {
  it("exposes the path, removed tools and message", () => {
    expect(KYOUBE_MCP_PATH).toBe("/mcp/kyoubeai");
    expect(REMOVED_TOOLS).toEqual(["kyoubeai_search_api", "kyoubeai_call_api"]);
    expect(UNAVAILABLE).toBe("KyoubeAI's table and app tools are unavailable right now. Try again in a minute.");
  });
});

describe("titleFor", () => {
  it("strips the prefix and capitalises", () => {
    expect(titleFor("kyoubeai_list_project_repositories")).toBe("List project repositories");
    expect(titleFor("kyoubeai_search_tasks")).toBe("Search tasks");
  });
});

describe("listTools", () => {
  it("returns the catalogue without tier", async () => {
    const tools = await listTools(p);
    expect(tools).toEqual([
      { name: QUERY.name, title: QUERY.title, description: QUERY.description, inputSchema: QUERY.inputSchema, annotations: QUERY.annotations },
      { name: DROP.name, title: DROP.title, description: DROP.description, inputSchema: DROP.inputSchema, annotations: DROP.annotations },
    ]);
    expect(tools[0]).not.toHaveProperty("tier");
    expect(calls).toEqual([[p, "GET", "/plugins/kyoube.apps/api/mcp/tools?companyId=c1"]]);
  });

  it("caches for 60 seconds per company", async () => {
    await listTools(p);
    now += 60_000;
    await listTools(p);
    expect(dispatch).toHaveBeenCalledTimes(1);
    now += 1;
    await listTools(p);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await listTools({ grant: { companyId: "c2" } });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("returns [] and warns once per window when the fetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockRejectedValue(new Error("down"));
    expect(await listTools(p)).toEqual([]);
    expect(await listTools(p)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns [] with no dispatch registered", async () => {
    resetForTests(() => now);
    expect(await listTools(p)).toEqual([]);
  });
});

describe("findTool", () => {
  it("builds a configure capability with a required requestId", async () => {
    const tool = await findTool(p, DROP.name, deps);
    expect(tool).toMatchObject({ name: DROP.name, description: DROP.description, write: false, configure: true, destructive: true });
    expect(() => tool.schema.parse({})).toThrow();
    expect(tool.schema.parse({ requestId: "r1", table: "t" })).toEqual({ requestId: "r1", table: "t" });
  });

  it("builds a read capability with an open schema", async () => {
    const tool = await findTool(p, QUERY.name, deps);
    expect(tool).toMatchObject({ write: false, configure: false, destructive: false });
    expect(tool.schema.parse({ a: 1 })).toEqual({ a: 1 });
  });

  it("run dispatches the call without companyId and requestId", async () => {
    const tool = await findTool(p, DROP.name, deps);
    const body = { ok: true };
    const api = vi.fn(async () => body);
    const out = await tool.run(p, { requestId: "r1", table: "t", companyId: "evil" }, api);
    expect(api).toHaveBeenCalledWith(p, "POST", "/plugins/kyoube.apps/api/mcp/call", { companyId: "c1", tool: DROP.name, arguments: { table: "t" } });
    expect(out).toBe(body);
  });

  it("returns undefined for an unknown Kyoube name", async () => {
    expect(await findTool(p, "kyoubeai_tasks_nope", deps)).toBeUndefined();
  });

  it("refuses a Kyoube name when the catalogue is unavailable, but never a core name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockRejectedValue(new Error("down"));
    const err = await findTool(p, QUERY.name, deps).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toBe(UNAVAILABLE);
    expect(await findTool(p, "kyoubeai_create_task", deps)).toBeUndefined();
    warn.mockRestore();
  });

  it("refuses a Kyoube name when no dispatch is registered", async () => {
    resetForTests(() => now);
    const err = await findTool(p, QUERY.name, deps).catch((e) => e);
    expect(err.message).toBe(UNAVAILABLE);
  });
});
