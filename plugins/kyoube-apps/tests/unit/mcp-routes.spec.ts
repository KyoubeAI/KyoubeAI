import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { AppService } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import type { DataService } from "../../src/data/service.js";
import { MCP_API_ROUTES, handleMcpApiRequest } from "../../src/mcp/api-routes.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = { actorType: "user" as const, actorId: "u1", userId: "u1" };
const AGENT = { actorType: "agent" as const, actorId: "a1", agentId: "a1", runId: "run-1" };

function request(routeKey: string, body: unknown, actor: PluginApiRequestInput["actor"] = USER): PluginApiRequestInput {
  const method = routeKey === "mcp.tools" ? "GET" : "POST";
  const path = routeKey === "mcp.tools" ? "/mcp/tools" : "/mcp/call";
  return { routeKey, method, path, params: {}, query: method === "GET" ? { companyId: COMPANY } : {}, body, actor, companyId: COMPANY, headers: {} } as PluginApiRequestInput;
}

function services(fail?: Error) {
  const data = createStubService(fail);
  const apps = createStubService(fail);
  return { services: { data: data.service, apps: apps.service as unknown as AppService }, data, apps };
}

describe("MCP route declarations", () => {
  it("declares both routes for signed-in people only", () => {
    expect(MCP_API_ROUTES.map((route) => [route.routeKey, route.method, route.path, route.auth])).toEqual([
      ["mcp.tools", "GET", "/mcp/tools", "board"],
      ["mcp.call", "POST", "/mcp/call", "board"],
    ]);
  });
});

describe("handleMcpApiRequest", () => {
  it("refuses an agent on both routes before doing anything", async () => {
    const { services: s, data } = services();
    for (const routeKey of ["mcp.tools", "mcp.call"]) {
      const response = await handleMcpApiRequest(s, request(routeKey, { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals" } }, AGENT));
      expect(response).toEqual({ status: 403, body: { error: "forbidden: assistant connections act as a person", code: "forbidden" } });
    }
    expect(data.calls).toHaveLength(0);
  });

  it("lists the catalogue with the plugin version", async () => {
    const response = await handleMcpApiRequest(services().services, request("mcp.tools", undefined));
    expect(response!.status).toBe(200);
    const body = response!.body as { version: string; tools: Array<{ name: string; tier: string }> };
    expect(body.version).toBe("0.15.0");
    expect(body.tools).toHaveLength(25);
    expect(body.tools.find((tool) => tool.name === "kyoubeai_data_query")).toMatchObject({ tier: "read", title: "Query rows" });
  });

  it("runs a tool as the signed-in person in the request's company", async () => {
    const { services: s, data } = services();
    const response = await handleMcpApiRequest(s, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals", limit: 5, requestId: "r", companyId: "evil" } }));
    expect(data.calls).toEqual([{ method: "query", args: [COMPANY, { kind: "user", id: "u1", runId: null }, "deals", { where: undefined, orderBy: undefined, limit: 5, offset: undefined, fields: undefined }] }]);
    expect(response!.status).toBe(200);
    expect(response!.body).toMatchObject({ outcome: "completed", data: { method: "query" } });
  });

  it("uses the actor id when the host gives no user id", async () => {
    const { services: s, apps } = services();
    await handleMcpApiRequest(s, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_apps_list", arguments: {} }, { actorType: "user", actorId: "board-key" } as PluginApiRequestInput["actor"]));
    expect(apps.calls).toEqual([{ method: "list", args: [COMPANY, { kind: "user", id: "board-key", runId: null }] }]);
  });

  it("answers a Kyoube refusal as a 200 rejected outcome", async () => {
    const response = await handleMcpApiRequest(services(new DataError("forbidden", "schema access required")).services, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals" } }));
    // DataError prefixes its code, so the message is the same text an agent sees.
    expect(response).toEqual({ status: 200, body: { outcome: "rejected", status: 403, code: "forbidden", message: "forbidden: schema access required" } });
  });

  it("answers invalid arguments as a rejected outcome", async () => {
    const { services: s, data } = services();
    const response = await handleMcpApiRequest(s, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_insert", arguments: { table: "deals", requestId: "r" } }));
    expect(response!.status).toBe(200);
    expect(response!.body).toMatchObject({ outcome: "rejected", status: 400, code: "invalid" });
    expect((response!.body as { message: string }).message).toMatch(/^invalid: rows/);
    expect(data.calls).toHaveLength(0);
  });

  it("answers a server-side DataError as a 500", async () => {
    const response = await handleMcpApiRequest(services(new DataError("provider_unavailable", "model down")).services, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals" } }));
    expect(response).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
  });

  it("answers any other error as a 500 without its message", async () => {
    const logged: unknown[] = [];
    const response = await handleMcpApiRequest(services(new Error("boom")).services, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals" } }), (message, meta) => logged.push([message, meta]));
    expect(response).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
    expect(JSON.stringify(response)).not.toContain("boom");
    expect(JSON.stringify(logged)).toContain("boom");
  });

  it("refuses a tool not in the catalogue with 404", async () => {
    const response = await handleMcpApiRequest(services().services, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_nope", arguments: {} }));
    expect(response!.status).toBe(404);
    expect(response!.body).toMatchObject({ code: "not_found" });
  });

  it("refuses a malformed body with 400", async () => {
    for (const body of [null, { companyId: COMPANY }, { companyId: COMPANY, tool: 7, arguments: {} }, { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: [] }]) {
      const response = await handleMcpApiRequest(services().services, request("mcp.call", body));
      expect(response!.status).toBe(400);
      expect(response!.body).toMatchObject({ code: "invalid" });
    }
  });

  it("truncates a large result to the agent text", async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ id: index, value: "x".repeat(50) }));
    const data = { query: async () => ({ rows }) } as unknown as DataService;
    const response = await handleMcpApiRequest({ data, apps: {} as AppService }, request("mcp.call", { companyId: COMPANY, tool: "kyoubeai_data_query", arguments: { table: "deals" } }));
    expect(response!.status).toBe(200);
    const body = response!.body as { outcome: string; truncated: boolean; content: string; data?: unknown };
    expect(body).toMatchObject({ outcome: "completed", truncated: true });
    expect(body.content).toContain("truncated");
    expect(body).not.toHaveProperty("data");
  });

  it("leaves other routes to the other dispatchers", async () => {
    expect(await handleMcpApiRequest(services().services, request("tables.list", undefined))).toBeNull();
  });
});
