import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findTool, KYOUBE_MCP_PATH, MCP_PLUGINS, listTools, REMOVED_TOOLS, registerDispatch, resetForTests, titleFor, UNAVAILABLE } from "../mcp-bridge.mjs";

class CapabilityError extends Error {}
const deps = { z, CapabilityError };
const p = { grant: { companyId: "c1" } };
const RID = "6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f";

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
    if (String(args[2]).startsWith("/plugins/kyoube.files/")) return { version: 1, tools: [] };
    return { version: 1, tools: [QUERY, DROP] };
  });
  resetForTests(() => now);
  registerDispatch(dispatch);
});

describe("constants", () => {
  it("exposes the path, removed tools and message", () => {
    expect(KYOUBE_MCP_PATH).toBe("/mcp/kyoubeai");
    expect(REMOVED_TOOLS).toEqual(["kyoubeai_search_api", "kyoubeai_call_api"]);
    expect(MCP_PLUGINS).toEqual([
      { id: "kyoube.apps", prefixes: ["kyoubeai_data_", "kyoubeai_apps_"] },
      { id: "kyoube.files", prefixes: ["kyoubeai_files_"] },
    ]);
    expect(UNAVAILABLE).toBe("KyoubeAI's table, app and file tools are unavailable right now. Try again in a minute.");
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
    expect(calls).toEqual([
      [p, "GET", "/plugins/kyoube.apps/api/mcp/tools?companyId=c1"],
      [p, "GET", "/plugins/kyoube.files/api/mcp/tools?companyId=c1"],
    ]);
  });

  it("caches for 60 seconds per company", async () => {
    await listTools(p);
    now += 60_000;
    await listTools(p);
    expect(dispatch).toHaveBeenCalledTimes(2);
    now += 1;
    await listTools(p);
    expect(dispatch).toHaveBeenCalledTimes(4);
    await listTools({ grant: { companyId: "c2" } });
    expect(dispatch).toHaveBeenCalledTimes(6);
  });

  it("returns [] and warns on each attempt when every fetch fails, caching nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockRejectedValue(new Error("down"));
    expect(await listTools(p)).toEqual([]);
    expect(await listTools(p)).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("returns [] with no dispatch registered", async () => {
    resetForTests(() => now);
    expect(await listTools(p)).toEqual([]);
  });
});

const FILE_B = { name: "kyoubeai_files_b", title: "Files b", description: "Read b", inputSchema: { type: "object" }, tier: "write", annotations: {} };
const byPath = (apps, files) => async (...args) => {
  calls.push(args);
  const result = String(args[2]).startsWith("/plugins/kyoube.files/") ? files : apps;
  if (result instanceof Error) throw result;
  return { version: 1, tools: result };
};

describe("two plugins", () => {
  it("merges both plugins in order", async () => {
    const a = { ...QUERY, name: "kyoubeai_data_a" };
    dispatch.mockImplementation(byPath([a], [FILE_B]));
    const tools = await listTools(p);
    expect(tools.map((t) => t.name)).toEqual(["kyoubeai_data_a", "kyoubeai_files_b"]);
    for (const t of tools) expect(t).not.toHaveProperty("tier");
  });

  it("one plugin failing leaves the other", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockImplementation(byPath([QUERY], new Error("down")));
    expect((await listTools(p)).map((t) => t.name)).toEqual([QUERY.name]);
    const err = await findTool(p, "kyoubeai_files_b", deps).catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toBe(UNAVAILABLE);
    expect((await findTool(p, QUERY.name, deps)).name).toBe(QUERY.name);
    warn.mockRestore();
  });

  it("a failure is not cached, a success is", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockImplementation(byPath([QUERY], new Error("down")));
    await listTools(p);
    dispatch.mockImplementation(byPath([QUERY], [FILE_B]));
    expect((await listTools(p)).map((t) => t.name)).toEqual([QUERY.name, "kyoubeai_files_b"]);
    const filesCalls = () => calls.filter((c) => String(c[2]).startsWith("/plugins/kyoube.files/")).length;
    const before = filesCalls();
    now += 60_000;
    await listTools(p);
    expect(filesCalls()).toBe(before);
    now += 1;
    await listTools(p);
    expect(filesCalls()).toBe(before + 1);
    warn.mockRestore();
  });

  it("drops an entry outside its plugin's prefixes with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dispatch.mockImplementation(byPath([QUERY, { ...FILE_B, name: "kyoubeai_files_x" }], []));
    expect((await listTools(p)).map((t) => t.name)).toEqual([QUERY.name]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await findTool(p, "kyoubeai_files_x", deps)).toBeUndefined();
    warn.mockRestore();
  });

  it("run reaches the owner", async () => {
    dispatch.mockImplementation(byPath([QUERY], [FILE_B]));
    const tool = await findTool(p, "kyoubeai_files_b", deps);
    const api = vi.fn(async () => ({ ok: true }));
    await tool.run(p, { requestId: RID, companyId: "evil", path: "a" }, api);
    expect(api).toHaveBeenCalledWith(p, "POST", "/plugins/kyoube.files/api/mcp/call", { companyId: "c1", tool: "kyoubeai_files_b", arguments: { path: "a" } });
  });
});

describe("findTool", () => {
  it("builds a configure capability with a required requestId", async () => {
    const tool = await findTool(p, DROP.name, deps);
    expect(tool).toMatchObject({ name: DROP.name, description: DROP.description, write: false, configure: true, destructive: true });
    expect(() => tool.schema.parse({})).toThrow();
    expect(tool.schema.parse({ requestId: RID, table: "t" })).toEqual({ requestId: RID, table: "t" });
  });

  it("refuses a requestId that is not a UUID, as the core's receipts store a uuid", async () => {
    const tool = await findTool(p, DROP.name, deps);
    for (const requestId of ["r1", "smoke-mcp-1", ""]) {
      expect(() => tool.schema.parse({ requestId, table: "t" })).toThrow(z.ZodError);
    }
  });

  it("treats a tier it does not know as configure, never as read", async () => {
    for (const tier of ["admin", undefined, "READ", ""]) {
      const ODD = { ...DROP, name: "kyoubeai_data_odd", tier, annotations: {} };
      dispatch.mockResolvedValue({ version: 1, tools: [QUERY, ODD] });
      resetForTests(() => now);
      registerDispatch(dispatch);
      const tool = await findTool(p, ODD.name, deps);
      expect(tool, String(tier)).toMatchObject({ write: false, configure: true });
      expect(() => tool.schema.parse({})).toThrow(z.ZodError);
      expect(tool.schema.parse({ requestId: RID })).toEqual({ requestId: RID });
    }
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
    const out = await tool.run(p, { requestId: RID, table: "t", companyId: "evil" }, api);
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
