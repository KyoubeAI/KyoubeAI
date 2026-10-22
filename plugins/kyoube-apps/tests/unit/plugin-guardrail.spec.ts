// tests/unit/plugin-guardrail.spec.ts
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { AppServiceDeps } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import type { GuardAgentAction } from "../../src/decisions/guardrail.js";
import manifest from "../../src/manifest.js";
import { createAppsPlugin } from "../../src/plugin.js";
import { createStubService } from "../stub-service.js";

const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
// Setup writes the visibility policy; tests point it here, never at /kyoubeai.
const VISIBILITY_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-visibility-"));
const COMPANY = "11111111-1111-4111-8111-111111111111";

describe("plugin wiring for the guardrail", () => {
  it("declares the issue capabilities it needs and none that answer cards or approvals", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["issues.read", "issue.interactions.create", "issue.interactions.read", "agents.read"]));
    expect(manifest.capabilities).not.toContain("issue.interactions.respond");
    expect(manifest.capabilities).not.toContain("approvals.respond");
  });

  it("hands the same guard to DataService and AppService", async () => {
    const harness = createTestHarness({ manifest });
    const data = createStubService();
    let appDeps: AppServiceDeps | null = null;
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir: VISIBILITY_DIR,
      createPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} }) as never,
      migrate: async () => [],
      createService: () => data.service,
      createAppService: (deps) => { appDeps = deps; return createStubService().service as never; },
      createDecisionService: () => createStubService().service as never,
    });
    await plugin.definition.setup(harness.ctx);
    const attached = data.calls.filter((call) => call.method === "attach").map((call) => call.args[0] as Record<string, unknown>);
    const guard = attached.find((hooks) => typeof hooks.guardAgentAction === "function")?.guardAgentAction;
    expect(typeof guard).toBe("function");
    expect(appDeps!.guardAgentAction).toBe(guard);
  });

  it("raises the card on the agent's task through ctx.issues, within the declared capabilities", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [{ id: "issue-1", companyId: COMPANY, title: "Tidy the CRM", description: null, assigneeAgentId: "agent-1" } as never],
      agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder", status: "idle" } as never],
    });
    const data = createStubService();
    // Just enough of the holds table: the stored hold reads back by its card id; no live hold exists.
    const pool = {
      query: async (sql: string, params: unknown[] = []) => (sql.includes("card_id = $2")
        ? { rows: [{ id: "h-1", company_id: params[0], agent_id: "agent-1", issue_id: "issue-1", card_id: params[1], action_fingerprint: "f", operation: "drop_table", consumed_at: null, expires_at: new Date(), created_at: new Date() }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
      end: async () => {},
    };
    const decisions = {
      settingsFor: async () => ({ agents: false, columns: false, apps: false, guardrail: true, dailyCap: 100 }),
      decide: async () => { throw new DataError("provider_unavailable", "down"); },
    };
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir: VISIBILITY_DIR,
      createPool: () => pool as never,
      migrate: async () => [],
      createService: () => data.service,
      createAppService: () => createStubService().service as never,
      createDecisionService: () => decisions as never,
    });
    await plugin.definition.setup(harness.ctx);
    const check = data.calls.map((call) => call.args[0] as { guardAgentAction?: GuardAgentAction }).find((hooks) => hooks?.guardAgentAction)!.guardAgentAction!;
    const held = await check({ companyId: COMPANY, actor: { kind: "agent", id: "agent-1", runId: "run-1" }, operation: "drop_table", table: "t", params: { table: "t" }, guard: { issueId: "issue-1" } }).catch((error: unknown) => error);
    expect(held).toMatchObject({ code: "held" });
    const cards = await harness.ctx.issues.listInteractions("issue-1", COMPANY);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "request_confirmation", title: "Kyoube guardrail: allow this action?", payload: { prompt: "Agent Builder wants to drop table `t`." } });
    expect((held as DataError).details).toEqual({ confirmationId: cards[0]!.id });
  });

  // An agent can call the UI actions too (actorFromAction accepts agents), so the covered ones take
  // the guard ids as well; a person's call, which carries none, reaches the services unchanged.
  it("passes guard ids from the covered UI actions", async () => {
    const harness = createTestHarness({ manifest });
    const stub = createStubService();
    const plugin = createAppsPlugin({
      loadKyoubeConfig: async () => KYOUBE_CONFIG,
      migrationsDir: "/nowhere",
      visibilityDir: VISIBILITY_DIR,
      createPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} }) as never,
      migrate: async () => [],
      createService: () => stub.service,
      createAppService: () => stub.service as never,
      createDecisionService: () => createStubService().service as never,
    });
    await plugin.definition.setup(harness.ctx);
    stub.calls.length = 0;
    const agent = { actor: { type: "agent" as const, agentId: "agent-1", runId: "run-1" }, companyId: COMPANY };
    const guard = { issueId: "i-1", confirmationId: "card-1" };
    const actions: Array<[string, Record<string, unknown>]> = [
      ["data.remove_field", { table: "t", field: "f" }],
      ["data.drop_table", { table: "t" }],
      ["data.rename_table", { table: "t", newName: "u" }],
      ["data.update", { table: "t", where: { field: "x", op: "eq", value: 1 }, patch: { y: 2 } }],
      ["data.delete", { table: "t", where: { field: "x", op: "eq", value: 1 } }],
    ];
    for (const [key, params] of actions) await harness.performAction(key, { ...params, ...guard }, agent);
    await harness.performAction("apps.publish", { slug: "crm", version: 2, ...guard }, agent);
    await harness.performAction("apps.rollback", { slug: "crm", version: 1, ...guard }, agent);
    await harness.performAction("apps.archive", { slug: "crm", ...guard }, agent);
    expect(stub.calls.map((call) => [call.method, call.args.at(-1)])).toEqual([
      ["removeField", guard], ["dropTable", guard], ["renameTable", guard], ["update", guard], ["delete", guard],
      ["publish", { decisionsConfirmed: false, guard }], ["rollback", { decisionsConfirmed: false, guard }], ["archive", { guard }],
    ]);
    expect(stub.calls.map((call) => call.args[1])).toEqual(stub.calls.map(() => ({ kind: "agent", id: "agent-1", runId: "run-1" })));

    stub.calls.length = 0;
    const person = { actor: { type: "user" as const, userId: "admin-1" }, companyId: COMPANY };
    await harness.performAction("data.drop_table", { table: "t" }, person);
    await harness.performAction("apps.publish", { slug: "crm", decisionsConfirmed: true }, person);
    expect(stub.calls[0]!.args[3]).toBeUndefined();
    expect(Object.keys(stub.calls[1]!.args.at(-1) as object)).toEqual(["decisionsConfirmed"]);
    await expect(harness.performAction("data.drop_table", { table: "t", issueId: 7 }, agent)).rejects.toThrow("issueId and confirmationId must be strings");
  });
});
