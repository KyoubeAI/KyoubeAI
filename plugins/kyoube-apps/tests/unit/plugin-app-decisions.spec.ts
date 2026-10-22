// tests/unit/plugin-app-decisions.spec.ts
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { AppServiceDeps } from "../../src/apps/service.js";
import manifest from "../../src/manifest.js";
import { createAppsPlugin } from "../../src/plugin.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user" as const, userId: "admin-1" };
const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
// Setup writes the visibility policy; tests point it here, never at /kyoubeai.
const VISIBILITY_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-visibility-"));

async function setup() {
  const harness = createTestHarness({ manifest });
  harness.seed({ accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
  const appsStub = createStubService();
  const decisionStub = createStubService();
  let appDeps: AppServiceDeps | null = null;
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    visibilityDir: VISIBILITY_DIR,
    createPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} }) as never,
    migrate: async () => [],
    createService: () => createStubService().service,
    createDecisionService: () => decisionStub.service as never,
    createAppService: (deps) => { appDeps = deps; return appsStub.service as never; },
  });
  await plugin.definition.setup(harness.ctx);
  return { harness, calls: appsStub.calls, decisionService: decisionStub.service, appDeps: () => appDeps! };
}

const as = { actor: ADMIN, companyId: COMPANY };

describe("plugin wiring for app decisions", () => {
  it("hands the decision service to the app service", async () => {
    const { appDeps, decisionService } = await setup();
    expect(appDeps().decisions).toBe(decisionService);
  });

  it("routes apps.decide with a parsed input", async () => {
    const { harness, calls } = await setup();
    await harness.performAction("apps.decide", { slug: "triage", set: "triage", input: { rowId: "r1" } }, as);
    expect(calls.at(-1)).toEqual({ method: "runtimeDecide", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "triage", "triage", { rowId: "r1" }] });
    await expect(harness.performAction("apps.decide", { slug: "triage", set: "triage", input: { rowId: "r1", values: {} } }, as)).rejects.toThrow("exactly one of");
    await expect(harness.performAction("apps.decide", { slug: "triage", set: "triage", input: "free text" }, as)).rejects.toThrow("rowId");
  });

  it("routes outcomes and previews, and passes the publish confirmation", async () => {
    const { harness, calls } = await setup();
    await harness.performAction("apps.decision_outcome", { slug: "triage", decisionId: "d1", question: "urgent", value: false }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["triage", "d1", "urgent", false]);
    await harness.performAction("apps.publish_preview", { slug: "triage" }, as);
    expect(calls.at(-1)).toMatchObject({ method: "publishPreview", args: [COMPANY, expect.anything(), "triage", "latest"] });
    await harness.performAction("apps.publish", { slug: "triage", decisionsConfirmed: true }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["triage", undefined, { decisionsConfirmed: true }]);
    await harness.performAction("apps.rollback", { slug: "triage", version: 1 }, as);
    expect(calls.at(-1)!.args.slice(2)).toEqual(["triage", 1, { decisionsConfirmed: false }]);
  });
});
