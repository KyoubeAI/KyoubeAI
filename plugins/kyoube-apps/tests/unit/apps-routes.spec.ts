import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { APP_API_ROUTES, handleAppsApiRequest } from "../../src/apps/api-routes.js";
import type { AppService } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = { kind: "user", id: "u1", runId: null };
const SOURCE = "<html><body><script>kyoube.ready()</script></body></html>";
const MANIFEST = { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] };

function request(routeKey: string, overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  const route = APP_API_ROUTES.find((entry) => entry.routeKey === routeKey) ?? { method: "GET", path: "/" };
  return {
    routeKey, method: route.method, path: route.path, params: {}, query: {}, body: undefined,
    actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId: COMPANY, headers: {}, ...overrides,
  };
}

function apps(fail?: Error) {
  const { service, calls } = createStubService(fail);
  return { apps: service as unknown as AppService, calls };
}

describe("apps API routes", () => {
  it("declares every apps route in the manifest with a company resolution", () => {
    expect(APP_API_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /apps", "POST /apps", "GET /apps/:slug", "POST /apps/:slug", "POST /apps/:slug/publish", "POST /apps/:slug/rollback", "POST /apps/:slug/archive",
    ]);
    for (const route of APP_API_ROUTES) {
      expect(route.capability).toBe("api.routes.register");
      expect(route.companyResolution).toEqual(route.method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" });
      expect(manifest.apiRoutes?.some((declared) => declared.routeKey === route.routeKey)).toBe(true);
    }
  });

  it("dispatches apps routes and ignores others", async () => {
    const { apps: service, calls } = apps();
    expect(await handleAppsApiRequest(service, request("tables.list"))).toBeNull();
    const listed = await handleAppsApiRequest(service, request("apps.list"));
    expect(listed?.status).toBe(200);
    expect(calls[0]).toEqual({ method: "list", args: [COMPANY, USER] });
    await handleAppsApiRequest(service, request("apps.get", { params: { slug: "crm" }, query: { version: "2" } }));
    expect(calls[1]).toEqual({ method: "get", args: [COMPANY, USER, "crm", 2] });
    const bad = await handleAppsApiRequest(service, request("apps.create", { body: { companyId: COMPANY, manifest: {} } }));
    expect(bad?.status).toBe(400);
    await handleAppsApiRequest(service, request("apps.rollback", { params: { slug: "crm" }, body: { companyId: COMPANY, version: 1 } }));
    expect(calls.at(-1)).toEqual({ method: "rollback", args: [COMPANY, USER, "crm", 1, { decisionsConfirmed: false }] });
  });

  it("passes tasksConfirmed from the publish and rollback bodies", async () => {
    const { apps: service, calls } = apps();
    await handleAppsApiRequest(service, request("apps.publish", { params: { slug: "crm" }, body: { companyId: COMPANY, tasksConfirmed: true } }));
    expect(calls.at(-1)).toEqual({ method: "publish", args: [COMPANY, USER, "crm", undefined, { decisionsConfirmed: false, tasksConfirmed: true }] });
    await handleAppsApiRequest(service, request("apps.rollback", { params: { slug: "crm" }, body: { companyId: COMPANY, version: 1, tasksConfirmed: true } }));
    expect(calls.at(-1)).toEqual({ method: "rollback", args: [COMPANY, USER, "crm", 1, { decisionsConfirmed: false, tasksConfirmed: true }] });
    const bad = await handleAppsApiRequest(service, request("apps.rollback", { params: { slug: "crm" }, body: { companyId: COMPANY, version: 1, tasksConfirmed: 1 } }));
    expect(bad?.status).toBe(400);
  });

  it("covers the whole lifecycle with the host's actor and company", async () => {
    const { apps: service, calls } = apps();
    const agent = request("apps.archive", { params: { slug: "crm" }, body: { companyId: COMPANY }, actor: { actorType: "agent", actorId: "a1", agentId: "a1", runId: "r1" } });
    expect((await handleAppsApiRequest(service, agent))?.status).toBe(200);
    // No guard ids in the body, so archive's options carry no guard (docs/decisions.md, the guardrail).
    expect(calls.at(-1)).toEqual({ method: "archive", args: [COMPANY, { kind: "agent", id: "a1", runId: "r1" }, "crm", {}] });

    await handleAppsApiRequest(service, request("apps.create", { body: { companyId: COMPANY, manifest: MANIFEST, source: SOURCE, notes: "v1" } }));
    expect(calls.at(-1)).toEqual({ method: "create", args: [COMPANY, USER, MANIFEST, SOURCE, "v1"] });
    await handleAppsApiRequest(service, request("apps.update", { params: { slug: "crm" }, body: { companyId: COMPANY, manifest: MANIFEST, source: SOURCE } }));
    expect(calls.at(-1)).toEqual({ method: "update", args: [COMPANY, USER, "crm", MANIFEST, SOURCE, null] });
    await handleAppsApiRequest(service, request("apps.publish", { params: { slug: "crm" }, body: { companyId: COMPANY } }));
    expect(calls.at(-1)).toEqual({ method: "publish", args: [COMPANY, USER, "crm", undefined, { decisionsConfirmed: false }] });
    // "latest" is the default version, and the UI's string versions stay valid.
    await handleAppsApiRequest(service, request("apps.get", { params: { slug: "crm" } }));
    expect(calls.at(-1)).toEqual({ method: "get", args: [COMPANY, USER, "crm", "latest"] });
    await handleAppsApiRequest(service, request("apps.get", { params: { slug: "crm" }, query: { version: "current" } }));
    expect(calls.at(-1)).toEqual({ method: "get", args: [COMPANY, USER, "crm", "current"] });
    const nonsense = await handleAppsApiRequest(service, request("apps.get", { params: { slug: "crm" }, query: { version: "newest" } }));
    expect(nonsense?.status).toBe(400);
    const missingSlug = await handleAppsApiRequest(service, request("apps.publish", { body: { companyId: COMPANY } }));
    expect(missingSlug?.status).toBe(400);
    const unknown = await handleAppsApiRequest(service, request("apps.nonsense"));
    expect(unknown?.status).toBe(404);
  });

  // Ruling P3-R7: the apps routes answer with the same bodies as the data
  // routes — an actor with no id never reaches the service, and a non-DataError
  // failure is generic to the caller and complete for the operator.
  it("refuses an unauthenticated caller and hides internal failures", async () => {
    const { apps: service, calls } = apps(new Error("boom"));
    const hollow = await handleAppsApiRequest(service, request("apps.list", { actor: { actorType: "user", actorId: "", userId: null } }));
    expect(hollow).toEqual({ status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } });
    expect(calls).toHaveLength(0);

    const logged: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const failed = await handleAppsApiRequest(service, request("apps.create", { body: { companyId: COMPANY, manifest: MANIFEST, source: SOURCE } }), (message, meta) => logged.push({ message, meta }));
    expect(failed).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
    expect(String(logged[0]?.meta?.error)).toContain("boom");
    // The request body (an app's whole source) never reaches the operator log.
    expect(JSON.stringify(logged)).not.toContain("kyoube.ready");
  });

  it("maps DataError codes to status codes", async () => {
    const { apps: service } = apps(new DataError("forbidden", "publish an app requires schema access (you have write)"));
    expect(await handleAppsApiRequest(service, request("apps.publish", { params: { slug: "crm" }, body: { companyId: COMPANY } }))).toEqual({
      status: 403,
      body: { error: "forbidden: publish an app requires schema access (you have write)", code: "forbidden" },
    });
    const { apps: missing } = apps(new DataError("not_found", 'app "crm" not found'));
    expect((await handleAppsApiRequest(missing, request("apps.get", { params: { slug: "crm" } })))?.status).toBe(404);
  });

  it("rejects notes longer than 2000 characters on create and update", async () => {
    const { apps: service, calls } = apps();
    const tooLong = "x".repeat(2001);
    const created = await handleAppsApiRequest(service, request("apps.create", { body: { companyId: COMPANY, manifest: MANIFEST, source: SOURCE, notes: tooLong } }));
    expect(created?.status).toBe(400);
    expect(String((created?.body as { error?: string })?.error)).toContain("2000");
    const updated = await handleAppsApiRequest(service, request("apps.update", { params: { slug: "crm" }, body: { companyId: COMPANY, manifest: MANIFEST, source: SOURCE, notes: tooLong } }));
    expect(updated?.status).toBe(400);
    expect(String((updated?.body as { error?: string })?.error)).toContain("2000");
    expect(calls).toHaveLength(0);
  });
});
