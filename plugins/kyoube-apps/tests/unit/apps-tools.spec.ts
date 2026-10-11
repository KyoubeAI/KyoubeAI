import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { AppService } from "../../src/apps/service.js";
import { APP_TOOL_DEFINITIONS, appToolDeclarations, registerAppTools } from "../../src/apps/tools.js";
import { connectionToolDeclarations } from "../../src/connections/tools.js";
import { decisionToolDeclarations } from "../../src/decisions/tools.js";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";
import { toolDeclarations } from "../../src/tools.js";
import { createStubService } from "../stub-service.js";

const RUN = { agentId: "agent-1", runId: "run-1", companyId: "11111111-1111-4111-8111-111111111111", projectId: "p1" };
const AGENT = { kind: "agent", id: "agent-1", runId: "run-1" };
const SOURCE = "<html><body><script>kyoube.ready()</script></body></html>";
const MANIFEST = { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] };

function setup(fail?: Error) {
  const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
  const stub = createStubService(fail);
  registerAppTools(harness.ctx, stub.service as unknown as AppService);
  return { harness, ...stub };
}

describe("app tools", () => {
  it("declares seven tools and lists them in the manifest", () => {
    const declarations = appToolDeclarations();
    expect(declarations.map((tool) => tool.name)).toEqual(["apps_list", "apps_get", "apps_create", "apps_update", "apps_publish", "apps_rollback", "apps_archive"]);
    for (const tool of declarations) {
      expect(tool.parametersSchema).toMatchObject({ type: "object" });
      expect(tool.parametersSchema).not.toHaveProperty("$schema");
      expect(tool.description.length).toBeGreaterThan(20);
    }
    // The manifest's tool list is exactly the data tools, then the app tools, then the
    // decision tools — not merely a superset containing these seven.
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([...toolDeclarations(), ...appToolDeclarations(), ...decisionToolDeclarations(), ...connectionToolDeclarations()].map((tool) => tool.name));
  });

  it("routes calls to the AppService with the agent actor", async () => {
    const { harness, calls } = setup();
    const created = await harness.executeTool("apps_create", { manifest: MANIFEST, source: SOURCE, notes: "v1" }, RUN);
    expect(created.error).toBeUndefined();
    expect(calls[0]).toEqual({ method: "create", args: [RUN.companyId, AGENT, MANIFEST, SOURCE, "v1"] });
    await harness.executeTool("apps_publish", { slug: "crm" }, RUN);
    expect(calls[1]).toEqual({ method: "publish", args: [RUN.companyId, AGENT, "crm", undefined, { decisionsConfirmed: false }] });
    const invalid = await harness.executeTool("apps_rollback", { slug: "crm" }, RUN);
    expect(invalid.error).toContain("version");
    const badSlug = await harness.executeTool("apps_archive", { slug: "Not A Slug" }, RUN);
    expect(badSlug.error).toContain("slug must match");
    // The tools declare (and parse) the service's own manifest schema, so a
    // typo is reported rather than quietly dropped on the way through.
    const typo = await harness.executeTool("apps_create", { manifest: { ...MANIFEST, tabels: [] }, source: SOURCE }, RUN);
    expect(typo.error).toContain("tabels");
    expect(calls).toHaveLength(2);
  });

  it("passes tasksConfirmed to publish and rollback and refuses a non-boolean", async () => {
    const { harness, calls } = setup();
    await harness.executeTool("apps_publish", { slug: "crm", tasksConfirmed: true }, RUN);
    expect(calls.at(-1)).toEqual({ method: "publish", args: [RUN.companyId, AGENT, "crm", undefined, { decisionsConfirmed: false, tasksConfirmed: true }] });
    await harness.executeTool("apps_rollback", { slug: "crm", version: 1, tasksConfirmed: true }, RUN);
    expect(calls.at(-1)).toEqual({ method: "rollback", args: [RUN.companyId, AGENT, "crm", 1, { decisionsConfirmed: false, tasksConfirmed: true }] });
    const bad = await harness.executeTool("apps_publish", { slug: "crm", tasksConfirmed: "yes" }, RUN);
    expect(bad.error).toContain("tasksConfirmed");
    expect(calls).toHaveLength(2);
  });

  it("rejects notes longer than 2000 characters", async () => {
    const { harness, calls } = setup();
    const tooLong = "x".repeat(2001);
    const created = await harness.executeTool("apps_create", { manifest: MANIFEST, source: SOURCE, notes: tooLong }, RUN);
    expect(created.error).toContain("notes");
    expect(created.error).toContain("2000");
    const updated = await harness.executeTool("apps_update", { slug: "crm", manifest: MANIFEST, source: SOURCE, notes: tooLong }, RUN);
    expect(updated.error).toContain("notes");
    expect(updated.error).toContain("2000");
    expect(calls).toHaveLength(0);
  });

  it("every declared tool has a registered handler", async () => {
    const { harness } = setup();
    for (const tool of APP_TOOL_DEFINITIONS) {
      await expect(harness.executeTool(tool.name, {}, RUN)).resolves.toBeDefined();
    }
  });

  // The agent asks for a version explicitly or gets the latest one; the source
  // is a whole HTML document, so it is summarised unless the agent says it
  // needs to read it.
  it("defaults apps_get to the latest version and omits the source unless asked", async () => {
    const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
    const calls: unknown[][] = [];
    const service = {
      get: async (...args: unknown[]) => {
        calls.push(args);
        return { app: { slug: "crm" }, version: { version: 3, source: SOURCE, notes: null } };
      },
    } as unknown as AppService;
    registerAppTools(harness.ctx, service);

    const summarised = await harness.executeTool<{ data: { version: Record<string, unknown> } }>("apps_get", { slug: "crm" }, RUN);
    expect(calls[0]).toEqual([RUN.companyId, AGENT, "crm", "latest"]);
    expect(summarised.data.version).toEqual({ version: 3, notes: null, sourceBytes: SOURCE.length });
    const full = await harness.executeTool<{ data: { version: Record<string, unknown> } }>("apps_get", { slug: "crm", version: 2, includeSource: true }, RUN);
    expect(calls[1]).toEqual([RUN.companyId, AGENT, "crm", 2]);
    expect(full.data.version.source).toBe(SOURCE);
    // The UI's string versions stay valid params (AppService.get takes the union).
    await harness.executeTool("apps_get", { slug: "crm", version: "current" }, RUN);
    expect(calls[2]).toEqual([RUN.companyId, AGENT, "crm", "current"]);
  });

  // Ruling P3-R20: the agent sent the source, so echoing it back only burns
  // context — every lifecycle answer reports its size instead.
  it("strips the source from create and update results too", async () => {
    const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
    const service = {
      create: async () => ({ app: { slug: "crm", latestVersion: 1 }, version: { version: 1, source: SOURCE, notes: "v1" } }),
      update: async () => ({ version: 2, source: SOURCE, notes: null }),
    } as unknown as AppService;
    registerAppTools(harness.ctx, service);

    const created = await harness.executeTool<{ data: { app: { slug: string }; version: Record<string, unknown> } }>("apps_create", { manifest: MANIFEST, source: SOURCE, notes: "v1" }, RUN);
    expect(created.data.app).toEqual({ slug: "crm", latestVersion: 1 });
    expect(created.data.version).toEqual({ version: 1, notes: "v1", sourceBytes: Buffer.byteLength(SOURCE, "utf8") });
    const updated = await harness.executeTool<{ data: Record<string, unknown> }>("apps_update", { slug: "crm", manifest: MANIFEST, source: SOURCE }, RUN);
    expect(updated.data).toEqual({ version: 2, notes: null, sourceBytes: Buffer.byteLength(SOURCE, "utf8") });
    // Neither result carries the document anywhere in it.
    expect(JSON.stringify([created.data, updated.data])).not.toContain("kyoube.ready");
  });

  // Ruling P3-R7 carries Phase 2's P2-R23 into the shared runtime: the actor is
  // built from `runCtx` alone, so a run context missing the agent or the
  // company is refused before the service is called.
  it("refuses to call the service when the run context is missing the agent or company", async () => {
    const { harness, calls } = setup();
    const missingAgent = await harness.executeTool("apps_list", {}, { ...RUN, agentId: "" });
    expect(missingAgent.error).toBe("invalid: tool run context is missing the agent or company");
    const missingCompany = await harness.executeTool("apps_list", {}, { ...RUN, companyId: "" });
    expect(missingCompany.error).toBe("invalid: tool run context is missing the agent or company");
    expect(calls).toHaveLength(0);
  });

  // Ruling P3-R7 carries P2-R24 too: a DataError's own message is caller-safe,
  // anything else is reported generically and logged for operators.
  it("passes DataError messages through and hides other failures", async () => {
    const { harness: denied } = setup(new DataError("forbidden", "publish an app requires schema access (you have write)"));
    expect((await denied.executeTool("apps_publish", { slug: "crm" }, RUN)).error).toBe("forbidden: publish an app requires schema access (you have write)");

    const { harness } = setup(new Error("boom"));
    expect((await harness.executeTool("apps_create", { manifest: MANIFEST, source: SOURCE }, RUN)).error).toBe("error: internal error");
    const warning = harness.logs.find((entry) => entry.level === "warn");
    expect(String(warning?.meta?.message)).toContain("boom");
    // Tool params never reach the operator log — least of all an app's source.
    expect(JSON.stringify(harness.logs)).not.toContain("kyoube.ready");
  });
});
