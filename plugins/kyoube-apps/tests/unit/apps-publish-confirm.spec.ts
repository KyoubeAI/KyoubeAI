// tests/unit/apps-publish-confirm.spec.ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { handleAppsApiRequest } from "../../src/apps/api-routes.js";
import type { AppService } from "../../src/apps/service.js";
import { APP_TOOL_DEFINITIONS, registerAppTools } from "../../src/apps/tools.js";
import manifest from "../../src/manifest.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function request(routeKey: string, body: Record<string, unknown>): PluginApiRequestInput {
  return { routeKey, method: "POST", path: "/", params: { slug: "crm" }, query: {}, body: { companyId: COMPANY, ...body }, actor: { actorType: "user", actorId: "u1", userId: "u1" }, companyId: COMPANY, headers: {} };
}

describe("publishing with the decisions confirmation", () => {
  it("passes decisionsConfirmed from the REST body", async () => {
    const { service, calls } = createStubService();
    await handleAppsApiRequest(service as unknown as AppService, request("apps.publish", { decisionsConfirmed: true }));
    expect(calls.at(-1)).toEqual({ method: "publish", args: [COMPANY, { kind: "user", id: "u1", runId: null }, "crm", undefined, { decisionsConfirmed: true }] });
    await handleAppsApiRequest(service as unknown as AppService, request("apps.rollback", { version: 2, decisionsConfirmed: true }));
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", 2, { decisionsConfirmed: true }]);
    const bad = await handleAppsApiRequest(service as unknown as AppService, request("apps.publish", { decisionsConfirmed: "yes" }));
    expect(bad!.status).toBe(400);
  });

  it("passes it from the tools and says a person must publish new or changed sets", async () => {
    const publish = APP_TOOL_DEFINITIONS.find((tool) => tool.name === "apps_publish")!;
    expect(publish.description).toContain("person");
    const { service, calls } = createStubService();
    const harness = createTestHarness({ manifest });
    registerAppTools(harness.ctx, service as unknown as AppService);
    await harness.executeTool("apps_publish", { slug: "crm", decisionsConfirmed: true }, { agentId: "a1", runId: "r1", companyId: COMPANY, projectId: "p1" } as never);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: true }]);
  });

  it("passes tasksConfirmed from the REST body and the tools only when it is true", async () => {
    const { service, calls } = createStubService();
    await handleAppsApiRequest(service as unknown as AppService, request("apps.publish", { tasksConfirmed: true }));
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: false, tasksConfirmed: true }]);
    await handleAppsApiRequest(service as unknown as AppService, request("apps.rollback", { version: 2, tasksConfirmed: true, connectionsConfirmed: true }));
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", 2, { decisionsConfirmed: false, connectionsConfirmed: true, tasksConfirmed: true }]);
    await handleAppsApiRequest(service as unknown as AppService, request("apps.publish", { tasksConfirmed: false }));
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: false }]);
    const bad = await handleAppsApiRequest(service as unknown as AppService, request("apps.publish", { tasksConfirmed: "yes" }));
    expect(bad!.status).toBe(400);

    const publish = APP_TOOL_DEFINITIONS.find((tool) => tool.name === "apps_publish")!;
    expect(publish.description).toContain("task templates");
    const harness = createTestHarness({ manifest });
    registerAppTools(harness.ctx, service as unknown as AppService);
    const run = { agentId: "a1", runId: "r1", companyId: COMPANY, projectId: "p1" } as never;
    await harness.executeTool("apps_publish", { slug: "crm", tasksConfirmed: true }, run);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", undefined, { decisionsConfirmed: false, tasksConfirmed: true }]);
    await harness.executeTool("apps_rollback", { slug: "crm", version: 3, tasksConfirmed: true }, run);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["crm", 3, { decisionsConfirmed: false, tasksConfirmed: true }]);
  });
});
