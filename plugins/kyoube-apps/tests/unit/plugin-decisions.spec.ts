// tests/unit/plugin-decisions.spec.ts
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { DECISIONS_SKILL_KEY, PLUGIN_VERSION } from "../../src/manifest.js";
import { createAppsPlugin } from "../../src/plugin.js";
import type { DecisionServiceDeps } from "../../src/decisions/service.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
const KEY = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };

async function setup() {
  const harness = createTestHarness({ manifest, config: { decisionsProvider: "typesafe", decisionsModel: "jev-1.13.0", decisionsApiKey: KEY } });
  harness.seed({ accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
  const decisions = createStubService();
  let decisionDeps: DecisionServiceDeps | null = null;
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    createPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} }) as never,
    migrate: async () => [],
    createService: () => createStubService().service,
    createAppService: () => createStubService().service as never,
    createDecisionService: (deps) => { decisionDeps = deps; return decisions.service as never; },
  });
  await plugin.definition.setup(harness.ctx);
  return { harness, plugin, decisions, deps: () => decisionDeps! };
}

describe("plugin wiring for typed decisions", () => {
  it("serves multiple companies' configs from one worker", async () => {
    const { plugin } = await setup();
    expect(plugin.definition.multiCompanyConfig).toBe(true);
  });

  it("validates a saved config", async () => {
    const { plugin } = await setup();
    expect(await plugin.definition.onValidateConfig!({ decisionsProvider: "typesafe", decisionsModel: "jev-latest", decisionsApiKey: KEY })).toMatchObject({ ok: false });
    expect(await plugin.definition.onValidateConfig!({})).toEqual({ ok: true });
  });

  it("registers the two settings actions", async () => {
    const { harness, decisions } = await setup();
    await harness.performAction("decisions.settings", {}, { actor: { type: "user", userId: "admin-1" }, companyId: COMPANY });
    await harness.performAction("decisions.set_settings", { agents: true }, { actor: { type: "user", userId: "admin-1" }, companyId: COMPANY });
    expect(decisions.calls.map((call) => call.method)).toEqual(["getSettings", "setSettings"]);
    expect(decisions.calls[1]!.args[2]).toEqual({ agents: true });
  });

  it("answers decision routes", async () => {
    const { plugin, decisions } = await setup();
    const response = await plugin.definition.onApiRequest!({ routeKey: "decisions.status", method: "GET", path: "/decisions/status", params: {}, query: {}, body: undefined, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1" }, companyId: COMPANY, headers: {} });
    expect(response.status).toBe(200);
    expect(decisions.calls[0]!.method).toBe("status");
  });

  it("drops the cached key when the company's config changes", async () => {
    let lookups = 0;
    const { harness, plugin, deps } = await setup();
    const original = harness.ctx.secrets.resolve.bind(harness.ctx.secrets);
    harness.ctx.secrets.resolve = (async (...args: Parameters<typeof original>) => { lookups += 1; return original(...args); }) as never;
    const providers = deps().providers;
    await providers.resolve(COMPANY);
    await providers.resolve(COMPANY);
    expect(lookups).toBe(1);
    await plugin.definition.onConfigChanged!({}, { companyId: COMPANY });
    await providers.resolve(COMPANY);
    expect(lookups).toBe(2);
  });

  it("calls the provider through ctx.http.fetch", async () => {
    const { harness, deps } = await setup();
    const seen: string[] = [];
    harness.ctx.http.fetch = (async (url: string) => { seen.push(url); return new Response("{}", { status: 200 }); }) as never;
    await deps().fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: {}, body: "{}" });
    expect(seen).toEqual(["https://api.typesafe.ai/v1/systemone"]);
  });

  it("never uses the global fetch", async () => {
    const { harness, deps } = await setup();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const stubbed = vi.fn(async () => new Response("{}", { status: 200 }));
    harness.ctx.http.fetch = stubbed as never;
    try {
      await deps().fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: {}, body: "{}" });
      expect(stubbed).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});

describe("the kyoube-decisions skill", () => {
  it("ships as a third managed skill and installs with the other two", async () => {
    expect(PLUGIN_VERSION).toBe("0.12.0");
    expect(manifest.skills?.map((skill) => skill.skillKey)).toEqual(["kyoube-data", "kyoube-apps", DECISIONS_SKILL_KEY]);
    const { harness, plugin } = await setup();
    await plugin.definition.onApiRequest!({ routeKey: "skills.install", method: "POST", path: "/skills/install", params: {}, query: {}, body: { companyId: COMPANY }, actor: { actorType: "user", actorId: "admin-1", userId: "admin-1" }, companyId: COMPANY, headers: {} });
    expect((await harness.ctx.skills.managed.get(DECISIONS_SKILL_KEY, COMPANY)).status).toBe("resolved");
  });
  it("teaches the rules that keep decisions safe", () => {
    const markdown = manifest.skills!.find((skill) => skill.skillKey === DECISIONS_SKILL_KEY)!.markdown;
    for (const phrase of ["/decisions/decide", "decisions_status", "unsure", "review", "never instead of", "compute"]) expect(markdown).toContain(phrase);
  });
});

describe("AI columns in the skills and manifest", () => {
  it("declares the fill job and teaches AI columns", () => {
    expect(manifest.jobs?.find((job) => job.jobKey === "fill-ai-columns")).toMatchObject({ schedule: "*/5 * * * *" });
    const data = manifest.skills!.find((skill) => skill.skillKey === "kyoube-data")!.markdown;
    for (const phrase of ["AI column", "sourceFields", "/review", "data_list_review", "manual"]) expect(data).toContain(phrase);
  });
});

describe("the guardrail in the skills", () => {
  const skill = (key: string) => manifest.skills!.find((entry) => entry.skillKey === key)!.markdown;
  it("teaches agents to pass their task, to wait when held, and never to work around a hold", () => {
    for (const phrase of ["issueId", "$PAPERCLIP_TASK_ID", "held", "confirmationId", "rejected_by_person", "Never try the same thing another way"]) {
      expect(skill(DECISIONS_SKILL_KEY)).toContain(phrase);
    }
    expect(skill("kyoube-data")).toContain("$PAPERCLIP_TASK_ID");
    expect(skill("kyoube-apps")).toContain("$PAPERCLIP_TASK_ID");
  });
});
