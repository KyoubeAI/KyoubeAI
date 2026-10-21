import { describe, expect, it } from "vitest";
import { createRulesApi, GROUP_ROUTES, GUARD_PLUGIN_ROUTES, STUDIO_ROUTES } from "../src/agent-rules/api.js";
import { CoreApiError } from "../src/core-api.js";

interface Seen { url: string; method: string; body: unknown }

function fakeFetch(responder: (req: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const result = responder(req);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  return { impl, seen };
}

const TOKEN = "f0".repeat(32);
const api = (impl: typeof fetch) => createRulesApi({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl }, TOKEN);

describe("createRulesApi", () => {
  it("reads and writes the company's resolver governance", async () => {
    const { impl, seen } = fakeFetch((req) => (req.method === "GET" ? { status: 200, body: { id: "c1", interactionResolverGovernance: { suggest_tasks: { cap: "anyone" } } } } : { status: 200, body: {} }));
    const client = api(impl);
    expect(await client.getGovernance("c1")).toEqual({ suggest_tasks: { cap: "anyone" } });
    await client.setGovernance("c1", { suggest_tasks: { cap: "human_only" } });
    expect(seen[1]).toEqual({ url: "http://app:3100/api/companies/c1", method: "PATCH", body: { interactionResolverGovernance: { suggest_tasks: { cap: "human_only" } } } });
  });

  it("treats a company without governance as an empty setting", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { id: "c1" } }));
    expect(await api(impl).getGovernance("c1")).toEqual({});
  });

  it("reads an agent's instructions bundle and its entry file", async () => {
    const { impl, seen } = fakeFetch((req) =>
      req.url.endsWith("/instructions-bundle")
        ? { status: 200, body: { mode: "managed", entryFile: "AGENTS.md", editable: true, legacyPromptTemplateActive: false, files: [{ path: "AGENTS.md" }, { path: "HEARTBEAT.md" }] } }
        : { status: 200, body: { path: "AGENTS.md", content: "You are an agent.\n", revision: { id: "rev-3", entryFile: "AGENTS.md" } } });
    const client = api(impl);
    expect(await client.getInstructionsBundle("a 1")).toEqual({ mode: "managed", entryFile: "AGENTS.md", hasEntryFile: true, editable: true, legacyPromptTemplateActive: false });
    expect(await client.readInstructionsFile("a 1", "AGENTS.md")).toEqual({ content: "You are an agent.\n", revisionId: "rev-3" });
    expect(seen.map((req) => req.url)).toEqual([
      "http://app:3100/api/agents/a%201/instructions-bundle",
      "http://app:3100/api/agents/a%201/instructions-bundle/file?path=AGENTS.md",
    ]);
  });

  it("reads an entry with no revision yet as a new entry (base null)", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { path: "AGENTS.md", content: "" } }));
    expect(await api(impl).readInstructionsFile("a1", "AGENTS.md")).toEqual({ content: "", revisionId: null });
  });

  it("never treats a file answer without content as an empty file", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { path: "AGENTS.md" } }));
    await expect(api(impl).readInstructionsFile("a1", "AGENTS.md")).rejects.toThrow(/no content/);
  });

  it("writes the entry file with PUT, on the revision it read (core 2026.1005 refuses a write without one)", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    await api(impl).writeInstructionsFile("a1", "AGENTS.md", "x", "rev-3");
    await api(impl).writeInstructionsFile("a1", "AGENTS.md", "y", null);
    expect(seen[0]).toEqual({ url: "http://app:3100/api/agents/a1/instructions-bundle/file", method: "PUT", body: { path: "AGENTS.md", content: "x", baseRevisionId: "rev-3" } });
    expect(seen[1]?.body).toEqual({ path: "AGENTS.md", content: "y", baseRevisionId: null });
  });

  it("calls the guard plugin's board-only routes and reads the report defensively", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: { managers: ["m"], updated: ["m", 7], selfTest: { status: "weird" } } }));
    const report = await api(impl).reconcileGuard("c1");
    expect(seen[0]).toEqual({ url: `http://app:3100${GUARD_PLUGIN_ROUTES.reconcile}`, method: "POST", body: { companyId: "c1", rulesToken: TOKEN } });
    expect(report).toEqual({ managers: ["m"], updated: ["m"], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } });
  });

  it("names the refused route when the plugin is missing", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { error: "Plugin not found" } }));
    const error = await api(impl).reconcileGuard("c1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error).toMatchObject({ status: 404, route: `POST ${GUARD_PLUGIN_ROUTES.reconcile}` });
  });

  it("reports the plugin not ready while the core answers its routes 503", async () => {
    const statuses = [503, 404];
    const { impl, seen } = fakeFetch(() => ({ status: statuses.shift() ?? 404, body: { error: "x" } }));
    const client = api(impl);
    expect(await client.pluginReady()).toBe(false);
    expect(await client.pluginReady()).toBe(true);
    // A GET to the POST-only route: the core refuses it before the worker sees it.
    expect(seen.map((req) => `${req.method} ${req.url}`)).toEqual([
      `GET http://app:3100${GUARD_PLUGIN_ROUTES.reconcile}`,
      `GET http://app:3100${GUARD_PLUGIN_ROUTES.reconcile}`,
    ]);
  });

  it("reports the plugin not ready while it is not installed yet", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { error: "Plugin not found" } }));
    expect(await api(impl).pluginReady()).toBe(false);
  });

  it("lists a company's agents with their metadata", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: [
      { id: "a1", name: "Writer", status: "idle", metadata: { kyoubeAskLevel: "none" }, adapterConfig: {} },
      { id: "a2", name: "Old", status: "terminated", metadata: null },
      { id: "a3", name: "Odd", status: "idle", metadata: ["x"] },
    ] }));
    expect(await api(impl).listAgents("c 1")).toEqual([
      { id: "a1", name: "Writer", status: "idle", metadata: { kyoubeAskLevel: "none" } },
      { id: "a2", name: "Old", status: "terminated", metadata: null },
      { id: "a3", name: "Odd", status: "idle", metadata: null },
    ]);
    expect(seen[0]).toMatchObject({ url: "http://app:3100/api/companies/c%201/agents", method: "GET" });
  });

  it("keeps a missing metadata field apart from an empty one, so the pass never writes over metadata it was not shown", async () => {
    const rows = [
      { id: "a1", name: "Writer", status: "idle" },
      { id: "a2", name: "Plain", status: "idle", metadata: null },
    ];
    const expected = [
      { id: "a1", name: "Writer", status: "idle", metadata: undefined },
      { id: "a2", name: "Plain", status: "idle", metadata: null },
    ];
    for (const body of [rows, { agents: rows }]) {
      const { impl } = fakeFetch(() => ({ status: 200, body }));
      const listed = await api(impl).listAgents("c1");
      expect(listed).toEqual(expected);
      expect(listed[0]?.metadata).toBeUndefined();
      expect(listed[1]?.metadata).toBeNull();
    }
  });

  it("reads Studio's ask levels with the rules token, strictly", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: { levels: { a1: "none", a2: "any" } } }));
    expect(await api(impl).getAskLevels("c1")).toEqual({ a1: "none", a2: "any" });
    expect(seen[0]).toEqual({ url: `http://app:3100${STUDIO_ROUTES.askLevels}`, method: "POST", body: { companyId: "c1", rulesToken: TOKEN } });
    for (const body of [{}, { levels: null }, { levels: ["a1"] }, { levels: { a1: "line" } }, { levels: { a1: "everyone" } }]) {
      const bad = fakeFetch(() => ({ status: 200, body }));
      await expect(api(bad.impl).getAskLevels("c1")).rejects.toThrow(/unreadable ask-level map/);
    }
  });

  it("writes an agent's whole metadata with PATCH", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    await api(impl).updateAgentMetadata("a 1", { kyoubeAskLevel: "any", note: "kept" });
    expect(seen[0]).toEqual({ url: "http://app:3100/api/agents/a%201", method: "PATCH", body: { metadata: { kyoubeAskLevel: "any", note: "kept" } } });
  });

  it("sends the rules token in the body of all six plugin route calls, and never in a URL", async () => {
    const { impl, seen } = fakeFetch((req) => ({ status: 200, body: req.url.includes("agent-access") ? { agents: [] } : req.url.includes("ask-levels") ? { levels: {} } : {} }));
    const client = api(impl);
    await client.reconcileGuard("c1");
    await client.revertGuard("c1");
    await client.getAgentAccess("c1");
    await client.applyGroups("c1", []);
    await client.reportGroupSync("c1", { syncedAt: "t", error: null });
    await client.getAskLevels("c1");
    expect(seen.map((req) => [req.method, req.url.replace("http://app:3100", ""), (req.body as { rulesToken?: string }).rulesToken])).toEqual([
      ["POST", GUARD_PLUGIN_ROUTES.reconcile, TOKEN],
      ["POST", GUARD_PLUGIN_ROUTES.revert, TOKEN],
      ["POST", GROUP_ROUTES.access, TOKEN],
      ["POST", GROUP_ROUTES.apply, TOKEN],
      ["POST", GROUP_ROUTES.report, TOKEN],
      ["POST", STUDIO_ROUTES.askLevels, TOKEN],
    ]);
    expect(seen.some((req) => req.url.includes(TOKEN))).toBe(false);
  });

  it("reads a 403 on the probe as ready: an auth refusal means the worker answers", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 403, body: { error: "forbidden" } }));
    expect(await api(impl).pluginReady()).toBe(true);
    expect(seen[0]?.body).toBeUndefined();
  });

  it("leaves any other 404 for the pass to report", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { error: "Plugin API route not found" } }));
    expect(await api(impl).pluginReady()).toBe(true);
  });

  it("rejects getGovernance when the response body is an array", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: [] }));
    await expect(api(impl).getGovernance("c1")).rejects.toThrow(/no company/);
  });

  it("rejects getGovernance when the response body is an object without an id", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: {} }));
    await expect(api(impl).getGovernance("c1")).rejects.toThrow(/no company/);
  });

  it("rejects getGovernance when interactionResolverGovernance is not a plain object", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { id: "c1", interactionResolverGovernance: "x" } }));
    await expect(api(impl).getGovernance("c1")).rejects.toThrow(/unreadable interactionResolverGovernance/);
  });

  it("returns empty object when interactionResolverGovernance is null", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { id: "c1", interactionResolverGovernance: null } }));
    expect(await api(impl).getGovernance("c1")).toEqual({});
  });

  it("reads agent access, applies groups and reports the sync through the board-only routes", async () => {
    const { impl, seen } = fakeFetch((req) =>
      req.url.includes("agent-access")
        ? { status: 200, body: { agents: [{ agentId: "a1", allowedUserIds: ["u1"] }] } }
        : req.url.endsWith("/apply")
          ? { status: 200, body: { protected: ["a1"], people: ["u1", 2], skipped: [{ id: "a9", reason: "r" }], failures: [{ id: "u2", step: "grants", error: "e" }] } }
          : { status: 200, body: { ok: true } });
    const client = api(impl);
    expect(await client.getAgentAccess("c1")).toEqual([{ agentId: "a1", allowedUserIds: ["u1"] }]);
    expect(await client.applyGroups("c1", [{ agentId: "a1", allowedUserIds: ["u1"] }])).toEqual({
      protected: ["a1"], unprotected: [], people: ["u1"], skipped: [{ id: "a9", reason: "r" }], failures: [{ id: "u2", step: "grants", error: "e" }],
    });
    await client.reportGroupSync("c1", { syncedAt: "t", error: null });
    // The token rides in the body of a POST, never in a URL (ruling R18).
    expect(seen[0]).toEqual({ url: `http://app:3100${GROUP_ROUTES.access}`, method: "POST", body: { companyId: "c1", rulesToken: TOKEN } });
    expect(seen[1]).toEqual({ url: `http://app:3100${GROUP_ROUTES.apply}`, method: "POST", body: { companyId: "c1", agents: [{ agentId: "a1", allowedUserIds: ["u1"] }], rulesToken: TOKEN } });
    expect(seen[2]).toEqual({ url: `http://app:3100${GROUP_ROUTES.report}`, method: "POST", body: { companyId: "c1", syncedAt: "t", error: null, rulesToken: TOKEN } });
  });

  it("accepts a genuinely empty agent-access list", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { agents: [] } }));
    expect(await api(impl).getAgentAccess("c1")).toEqual([]);
  });

  it.each([
    ["no agents key", {}],
    ["agents a string", { agents: "x" }],
    ["agents null", { agents: null }],
    ["a null body", null],
    ["a bare array", []],
    ["a non-string agentId", { agents: [{ agentId: 5, allowedUserIds: [] }] }],
    ["an empty agentId", { agents: [{ agentId: "", allowedUserIds: [] }] }],
    ["missing allowedUserIds", { agents: [{ agentId: "a1" }] }],
    ["a non-string user id", { agents: [{ agentId: "a1", allowedUserIds: ["u", 7] }] }],
  ])("refuses an unreadable agent-access list (%s) instead of reading it as no groups", async (_name, body) => {
    const { impl } = fakeFetch(() => ({ status: 200, body }));
    await expect(api(impl).getAgentAccess("c1")).rejects.toThrow(/unreadable agent-access list/);
  });
});
