import { describe, expect, it } from "vitest";
import type { AgentRef, GuardReport, GuardRevertReport, InstructionsBundle, RulesApi } from "../src/agent-rules/api.js";
import { GROUP_ROUTES, GUARD_PLUGIN_ROUTES, STUDIO_ROUTES } from "../src/agent-rules/api.js";
import { RULES_BLOCK, rulesBlock } from "../src/agent-rules/block.js";
import type { Governance } from "../src/agent-rules/governance.js";
import { applyPass, describeError, groupsPass, revertPass, syncReportError } from "../src/agent-rules/pass.js";
import { failureLines } from "../src/agent-rules/report.js";
import { EMPTY_STATE } from "../src/agent-rules/state.js";
import { CoreApiError } from "../src/core-api.js";

const NOW = new Date("2026-10-01T10:00:00Z");
const MANAGED: InstructionsBundle = { mode: "managed", entryFile: "AGENTS.md", hasEntryFile: true, editable: true, legacyPromptTemplateActive: false };
const FORBIDDEN = "forbidden: the kyoube CLI's rules token or a company owner or admin is required";
const QUIET_GUARD: GuardReport = { managers: [], updated: [], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } };

class FakeApi implements RulesApi {
  companies = [{ id: "c1", name: "Acme" }];
  agents: Record<string, AgentRef[]> = { c1: [{ id: "a1", name: "Writer", status: "idle" }, { id: "a2", name: "Gone", status: "terminated" }] };
  governance: Record<string, Governance> = { c1: {} };
  bundles: Record<string, InstructionsBundle> = {};
  files: Record<string, string> = { a1: "You are an agent.\n" };
  revisions: Record<string, number> = {};
  guard: GuardReport = QUIET_GUARD;
  calls: string[] = [];
  failing = new Set<string>();

  private check(key: string) {
    if (this.failing.has(key)) throw new Error(`refused ${key}`);
  }
  async listCompanies() { this.check("listCompanies"); return this.companies; }
  async listAgents(companyId: string) { this.check(`listAgents:${companyId}`); return this.agents[companyId] ?? []; }
  async getGovernance(companyId: string) { return structuredClone(this.governance[companyId] ?? {}); }
  async setGovernance(companyId: string, governance: Governance) { this.check(`setGovernance:${companyId}`); this.calls.push(`governance ${companyId}`); this.governance[companyId] = structuredClone(governance); }
  async getInstructionsBundle(agentId: string) { return this.bundles[agentId] ?? MANAGED; }
  async readInstructionsFile(agentId: string) { return { content: this.files[agentId] ?? "", revisionId: `rev-${agentId}-${this.revisions[agentId] ?? 0}` }; }
  async writeInstructionsFile(agentId: string, _path: string, content: string, baseRevisionId: string | null) {
    this.check(`write:${agentId}`);
    this.calls.push(`write ${agentId}`);
    if (baseRevisionId !== `rev-${agentId}-${this.revisions[agentId] ?? 0}`) throw new Error(`409 stale base ${baseRevisionId}`);
    this.files[agentId] = content;
    this.revisions[agentId] = (this.revisions[agentId] ?? 0) + 1;
  }
  async reconcileGuard(companyId: string) {
    if (this.failing.has("guard403")) throw new CoreApiError(403, { error: FORBIDDEN }, FORBIDDEN, `POST ${GUARD_PLUGIN_ROUTES.reconcile}`);
    if (this.failing.has("guard404")) throw new CoreApiError(404, { error: "Plugin not found" }, "Plugin not found", `POST ${GUARD_PLUGIN_ROUTES.reconcile}`);
    this.calls.push(`guard ${companyId}`);
    return this.guard;
  }
  async revertGuard(companyId: string): Promise<GuardRevertReport> {
    if (this.failing.has("guard403")) throw new CoreApiError(403, { error: FORBIDDEN }, FORBIDDEN, `POST ${GUARD_PLUGIN_ROUTES.revert}`);
    this.calls.push(`unguard ${companyId}`); return { reverted: [], failures: [] }; }
  async pluginReady() { return true; }
  access: Record<string, Array<{ agentId: string; allowedUserIds: string[] }>> = { c1: [] };
  groupsReport = { protected: [] as string[], unprotected: [] as string[], people: [] as string[], skipped: [] as Array<{ id: string; reason: string }>, failures: [] as Array<{ id: string; step: string; error: string }> };
  syncReports: Array<{ companyId: string; syncedAt: string; error: string | null }> = [];
  async getAgentAccess(companyId: string) {
    if (this.failing.has("access403")) throw new CoreApiError(403, { error: FORBIDDEN }, FORBIDDEN, `POST ${GROUP_ROUTES.access}`);
    this.check(`access:${companyId}`);
    return structuredClone(this.access[companyId] ?? []); }
  async applyGroups(companyId: string, agents: Array<{ agentId: string; allowedUserIds: string[] }>) { this.check(`applyGroups:${companyId}`); this.calls.push(`groups ${companyId} ${agents.length}`); return structuredClone(this.groupsReport); }
  async reportGroupSync(companyId: string, report: { syncedAt: string; error: string | null }) { this.syncReports.push({ companyId, ...report }); }
  levels: Record<string, Record<string, "none" | "any">> = { c1: {} };
  metadataWrites: Array<{ agentId: string; metadata: Record<string, unknown> }> = [];
  async getAskLevels(companyId: string) {
    if (this.failing.has("studio503")) throw new CoreApiError(503, { error: "Plugin worker not running" }, "Plugin worker not running", `POST ${STUDIO_ROUTES.askLevels}`);
    if (this.failing.has("studio403")) throw new CoreApiError(403, { error: FORBIDDEN }, FORBIDDEN, `POST ${STUDIO_ROUTES.askLevels}`);
    this.check(`levels:${companyId}`);
    return structuredClone(this.levels[companyId] ?? {});
  }
  async updateAgentMetadata(agentId: string, metadata: Record<string, unknown>) {
    this.check(`meta:${agentId}`);
    this.calls.push(`meta ${agentId}`);
    this.metadataWrites.push({ agentId, metadata: structuredClone(metadata) });
    for (const list of Object.values(this.agents)) for (const row of list) if (row.id === agentId) row.metadata = structuredClone(metadata);
  }
}

const deps = (api: RulesApi) => ({ api, now: () => NOW });

describe("applyPass", () => {
  it("sets G1, reconciles G2 and writes the rules block, then records it all", async () => {
    const api = new FakeApi();
    const { report, state } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.calls).toEqual(["governance c1", "guard c1", "groups c1 0", "write a1"]);
    expect(api.governance.c1?.request_confirmation).toEqual({ defaultPolicy: "human_only", cap: "human_only" });
    expect(api.files.a1?.startsWith(RULES_BLOCK)).toBe(true);
    expect(report.companies[0]).toMatchObject({ companyId: "c1", governance: "set", rulesUpdated: ["Writer"], writes: 2, failures: [] });
    expect(state.governancePrevious.c1?.request_confirmation).toBeNull();
    expect(state.lastPass).toEqual(report);
    expect(report.at).toBe(NOW.toISOString());
  });

  it("makes no writes on a second pass and keeps the first recorded governance", async () => {
    const api = new FakeApi();
    api.governance.c1 = { request_confirmation: { cap: "anyone" } };
    const first = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    const second = await applyPass(deps(api), first.state);
    expect(api.calls).toEqual(["guard c1", "groups c1 0"]);
    expect(second.report.companies[0]?.writes).toBe(0);
    expect(second.state.governancePrevious.c1?.request_confirmation).toEqual({ cap: "anyone" });
  });

  it("skips agents it may not edit and says why, without writing", async () => {
    const api = new FakeApi();
    api.agents.c1 = [
      { id: "ext", name: "External", status: "idle" },
      { id: "leg", name: "Legacy", status: "idle" },
      { id: "none", name: "Empty", status: "idle" },
      { id: "bad", name: "Broken", status: "idle" },
    ];
    api.bundles = { ext: { ...MANAGED, mode: "external" }, leg: { ...MANAGED, legacyPromptTemplateActive: true }, none: { ...MANAGED, hasEntryFile: false } };
    api.files = { bad: "<!-- kyoube:working-rules v1. x -->\nno end\n" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.skipped).toEqual([
      { agent: "External", reason: "its instructions are not a managed bundle KyoubeAI can edit (mode external)" },
      { agent: "Legacy", reason: "it still uses the legacy prompt template" },
      { agent: "Empty", reason: "its instructions bundle has no AGENTS.md" },
      { agent: "Broken", reason: "AGENTS.md: the rules block markers are incomplete or repeated (1 start, 0 end)" },
    ]);
    expect(api.calls.filter((call) => call.startsWith("write"))).toEqual([]);
  });

  it("leaves an agent waiting for approval alone, without a skipped entry (the plugin's report lists it)", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle" }, { id: "p1", name: "Hire", status: "pending_approval" }];
    api.files.p1 = "You are new.\n";
    const bundlesRead: string[] = [];
    const getBundle = api.getInstructionsBundle.bind(api);
    api.getInstructionsBundle = async (agentId: string) => { bundlesRead.push(agentId); return getBundle(agentId); };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(bundlesRead).toEqual(["a1"]);
    expect(api.calls.filter((call) => call.startsWith("write"))).toEqual(["write a1"]);
    expect(api.files.p1).toBe("You are new.\n");
    expect(report.companies[0]?.skipped).toEqual([]);
  });

  it("carries the guard's skipped agents, failures and a failed self-test", async () => {
    const api = new FakeApi();
    api.guard = {
      ...QUIET_GUARD,
      skipped: [{ agentId: "m", name: "CTO", reason: "has an authorization policy KyoubeAI does not change" }],
      failures: [{ agentId: "x", name: "QA", step: "grants", error: "nope" }],
      selfTest: { status: "fail", detail: "QA can still assign to its manager CTO (allow_grant)" },
    };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.skipped).toContainEqual({ agent: "CTO", reason: "has an authorization policy KyoubeAI does not change" });
    expect(report.companies[0]?.failures).toEqual([
      { step: "guard", agent: "QA", error: "grants: nope" },
      { step: "guard", error: "self-test failed: QA can still assign to its manager CTO (allow_grant)" },
    ]);
  });

  it("keeps going when one step or one agent fails", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle" }, { id: "a3", name: "Coder", status: "idle" }];
    api.files.a3 = "Code.\n";
    api.failing.add("setGovernance:c1");
    api.failing.add("write:a1");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    const company = report.companies[0]!;
    expect(company.governance).toBe("failed");
    expect(company.failures.map((failure) => `${failure.step} ${failure.agent ?? ""}`.trim())).toEqual(["governance", "rules Writer"]);
    expect(company.rulesUpdated).toEqual(["Coder"]);
    expect(api.calls).toContain("guard c1");
  });

  it("writes on the revision it read, so a save made in between is refused and kept, and the next pass adds the block", async () => {
    const api = new FakeApi();
    // Someone saves Writer's AGENTS.md between the pass's read and its write.
    const read = api.readInstructionsFile.bind(api);
    api.readInstructionsFile = async (agentId: string) => {
      const file = await read(agentId);
      api.files[agentId] = "Edited by a person.\n";
      api.revisions[agentId] = (api.revisions[agentId] ?? 0) + 1;
      return file;
    };
    const { report, state } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures.map((failure) => `${failure.step} ${failure.agent}`)).toEqual(["rules Writer"]);
    expect(report.companies[0]?.failures[0]?.error).toContain("stale base");
    expect(api.files.a1).toBe("Edited by a person.\n");
    api.readInstructionsFile = read;
    await applyPass(deps(api), state);
    expect(api.files.a1).toContain("Edited by a person.\n");
    expect(api.files.a1).toContain(RULES_BLOCK);
  });

  it("says the guard plugin is missing, and still writes the rules block", async () => {
    const api = new FakeApi();
    api.failing.add("guard404");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures[0]?.error).toMatch(/^the kyoube\.agent-rules plugin is not installed or not ready \(POST \/api\/plugins\/kyoube\.agent-rules\/api\/reconcile → 404\)/);
    expect(report.companies[0]?.rulesUpdated).toEqual(["Writer"]);
  });

  it("records a failure to list companies and stops there", async () => {
    const api = new FakeApi();
    api.failing.add("listCompanies");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.failures).toEqual([{ step: "list", error: "refused listCompanies" }]);
    expect(report.companies).toEqual([]);
  });

  it("records governance even when unchanged, to preserve pre-existing people-only settings", async () => {
    const api = new FakeApi();
    // Start with all five kinds already set to people-only
    api.governance.c1 = {
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    };
    const { report, state } = await applyPass(deps(api), EMPTY_STATE);
    // No governance write should have happened
    expect(api.calls.filter((call) => call.startsWith("governance"))).toEqual([]);
    // But the previous values should be recorded as empty (no change)
    expect(state.governancePrevious.c1).toEqual({});
  });
});

describe("revertPass", () => {
  it("puts governance back, asks the plugin to revert, removes the blocks and forgets the record", async () => {
    const api = new FakeApi();
    api.governance.c1 = { request_confirmation: { cap: "anyone" } };
    const applied = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    const { report, state } = await revertPass(deps(api), applied.state);
    expect(api.governance.c1).toEqual({ request_confirmation: { cap: "anyone" } });
    expect(api.calls).toEqual(["governance c1", "unguard c1", "write a1"]);
    expect(api.files.a1).toBe("You are an agent.\n\n## Handoffs\n\nNone. To add a standing handoff, write a line such as\n\"QA Agent tests every code change before it is marked done.\"\n");
    expect(state.governancePrevious).toEqual({});
    expect(report.mode).toBe("revert");
    expect(report.companies[0]?.governance).toBe("restored");
  });

  it("without a recorded value, removes only KyoubeAI's exact entries", async () => {
    const api = new FakeApi();
    await applyPass(deps(api), EMPTY_STATE);
    await revertPass(deps(api), EMPTY_STATE);
    expect(api.governance.c1).toEqual({});
  });

  it("with empty recorded governance (pre-existing people-only), makes no governance write", async () => {
    const api = new FakeApi();
    // Start with all five kinds already set to people-only
    api.governance.c1 = {
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    };
    // Run apply first to record empty previous
    const applied = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    // Now run revert with that state
    const { report, state } = await revertPass(deps(api), applied.state);
    // No governance write should happen since we're just restoring what was there
    expect(api.calls.filter((call) => call.startsWith("governance"))).toEqual([]);
    // Governance should be unchanged (still all people-only)
    expect(api.governance.c1).toEqual({
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    });
    expect(state.governancePrevious).toEqual({});
  });
});

describe("group step", () => {
  it("reads agent access, applies it after the guard, and reports the sync", async () => {
    const api = new FakeApi();
    api.access.c1 = [{ agentId: "a1", allowedUserIds: ["u1"] }];
    api.groupsReport.people = ["u1"];
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(api.calls).toContain("groups c1 1");
    expect(report.companies[0]!.groups?.people).toEqual(["u1"]);
    expect(api.syncReports).toEqual([{ companyId: "c1", syncedAt: NOW.toISOString(), error: null }]);
  });

  it("skips the group step entirely when agent access cannot be read", async () => {
    const api = new FakeApi();
    api.failing.add("access:c1");
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(api.calls.some((call) => call.startsWith("groups "))).toBe(false);
    expect(report.companies[0]!.failures).toContainEqual(expect.objectContaining({ step: "groups" }));
    expect(api.syncReports[0]!.error).toMatch(/refused access:c1/);
  });

  it("never applies an unreadable agent-access list as no groups", async () => {
    const api = new FakeApi();
    api.getAgentAccess = async () => { throw new Error("kyoube.apps returned an unreadable agent-access list: no agents array"); };
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(api.calls.some((call) => call.startsWith("groups "))).toBe(false);
    expect(report.companies[0]!.failures).toContainEqual({ step: "groups", error: expect.stringMatching(/unreadable agent-access list/) });
    expect(api.syncReports[0]!.error).toMatch(/unreadable agent-access list/);
  });

  it("names the company and the rules token file when a plugin refuses the CLI", async () => {
    const api = new FakeApi();
    api.failing.add("guard403");
    api.failing.add("access403");
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    const failures = report.companies[0]!.failures;
    expect(failures).toContainEqual({ step: "guard", error: expect.stringMatching(/^the plugin refused the kyoube CLI in "Acme" \(POST \/api\/plugins\/kyoube\.agent-rules\/api\/reconcile → 403\): .*; check that the rules token file \(kyoube\/rules-token on the home volume\) exists and the node user can read it$/) });
    expect(failures).toContainEqual({ step: "groups", error: expect.stringMatching(/^the plugin refused the kyoube CLI in "Acme" \(POST \/api\/plugins\/kyoube\.apps\/api\/groups\/agent-access → 403\)/) });
    // Nothing applied, and no sync report the same refusal would only bounce.
    expect(api.calls.some((call) => call.startsWith("groups "))).toBe(false);
    expect(api.syncReports).toEqual([]);
    expect(failureLines(report)[0]).toMatch(/^kyoube: agent rules: Acme: guard failed: the plugin refused the kyoube CLI in "Acme"/);
  });

  it("tells the operator to add the board key's user when the core refuses the company", () => {
    const refusal = new CoreApiError(403, { error: "User does not have access to this company" }, "User does not have access to this company", "POST /api/plugins/kyoube.agent-rules/api/reconcile");
    const message = describeError(refusal, "Acme");
    expect(message).toContain('add the board key\'s user to "Acme" as a member (any role)');
    expect(message).not.toContain("rules token file");
    expect(describeError(new CoreApiError(403, { error: FORBIDDEN }, FORBIDDEN, "POST /api/plugins/kyoube.agent-rules/api/reconcile"), "Acme")).toContain("rules token file");
  });

  it("names the company on a refused revert too", async () => {
    const api = new FakeApi();
    api.failing.add("guard403");
    const { report } = await revertPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(report.companies[0]!.failures).toContainEqual({ step: "guard", error: expect.stringMatching(/refused the kyoube CLI in "Acme".*\/revert → 403/) });
  });

  it("reports group failures from the plugin as pass failures", async () => {
    const api = new FakeApi();
    api.groupsReport.failures = [{ id: "u2", step: "grants", error: "nope" }];
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(report.companies[0]!.failures).toContainEqual({ step: "groups", agent: "u2", error: "grants: nope" });
    expect(api.syncReports[0]!.error).toBe("1 failure(s); see kyoube doctor");
  });
});

describe("group step: sync report and a missing kyoube.apps (R17)", () => {
  it("cuts a long error to fit the sync-report route's 2000-character cap", async () => {
    const api = new FakeApi();
    const long = "x".repeat(5000);
    api.getAgentAccess = async () => { throw new Error(long); };
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    const sent = api.syncReports[0]!.error!;
    expect(sent).toHaveLength(1991);
    expect(sent).toBe(`${"x".repeat(1990)}…`);
    // The pass report keeps the whole message for kyoube doctor.
    expect(report.companies[0]!.failures).toContainEqual({ step: "groups", error: long });
    expect(syncReportError("short")).toBe("short");
    expect(syncReportError("y".repeat(2000))).toBe("y".repeat(2000));
    expect(syncReportError(null)).toBeNull();
  });

  for (const [what, error] of [
    ["not installed (404 Plugin not found)", new CoreApiError(404, { error: "Plugin not found" }, "Plugin not found", `POST ${GROUP_ROUTES.access}`)],
    ["not ready (503)", new CoreApiError(503, { error: "plugin not ready" }, "plugin not ready", `POST ${GROUP_ROUTES.access}`)],
  ] as const) {
    it(`skips the group step quietly when kyoube.apps is ${what}`, async () => {
      const api = new FakeApi();
      api.getAgentAccess = async () => { throw error; };
      const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
      expect(api.calls.some((call) => call.startsWith("groups "))).toBe(false);
      expect(api.syncReports).toEqual([]);
      expect(report.companies[0]!.failures).toEqual([]);
      expect(report.companies[0]!.groups).toBeNull();
    });
  }

  it("still reports any other read failure, such as a 404 for a moved route", async () => {
    const api = new FakeApi();
    api.getAgentAccess = async () => { throw new CoreApiError(404, { error: "Not found" }, "Not found", `POST ${GROUP_ROUTES.access}`); };
    const { report } = await applyPass({ api, now: () => NOW }, EMPTY_STATE);
    expect(report.companies[0]!.failures).toContainEqual({ step: "groups", error: expect.stringContaining("the core no longer accepts") });
    expect(api.syncReports).toHaveLength(1);
  });
});

describe("groupsPass (KYOUBE_AGENT_RULES=off, ruling R15)", () => {
  it("runs only the group step in every company and records it apart from the last rules pass", async () => {
    const api = new FakeApi();
    api.access.c1 = [{ agentId: "a1", allowedUserIds: [] }];
    const before = { ...EMPTY_STATE, lastPass: { at: "2026-10-01T09:00:00.000Z", mode: "apply" as const, companies: [], failures: [] } };
    const { report, state } = await groupsPass({ api, now: () => NOW }, before);
    expect(api.calls).toEqual(["groups c1 1"]);
    expect(api.files.a1).toBe("You are an agent.\n");
    expect(report).toMatchObject({ mode: "groups", companies: [{ name: "Acme", governance: "already", guard: null, rulesUpdated: [] }] });
    expect(api.syncReports).toEqual([{ companyId: "c1", syncedAt: NOW.toISOString(), error: null }]);
    expect(state.lastPass).toEqual(before.lastPass);
    expect(state.lastGroupsPass).toBe(report);
  });
});

describe("ask levels", () => {
  it("copies a level into the agent's metadata, then writes the block for that level", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: { note: "kept" } }];
    api.levels.c1 = { a1: "none" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.calls).toEqual(["governance c1", "guard c1", "groups c1 0", "meta a1", "write a1"]);
    expect(api.metadataWrites).toEqual([{ agentId: "a1", metadata: { note: "kept", kyoubeAskLevel: "none" } }]);
    expect(api.files.a1?.startsWith(rulesBlock("none"))).toBe(true);
    expect(report.companies[0]).toMatchObject({ askLevelsUpdated: ["Writer"], failures: [] });
  });

  it("puts back a level an agent changed itself, and keeps the agent's other metadata keys", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: { kyoubeAskLevel: "any", paperclipNote: 1 } }];
    await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([{ agentId: "a1", metadata: { paperclipNote: 1 } }]);
    expect(api.files.a1?.startsWith(RULES_BLOCK)).toBe(true);
  });

  it("makes no writes once metadata and blocks agree", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: {} }];
    api.levels.c1 = { a1: "any" };
    const first = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([{ agentId: "a1", metadata: { kyoubeAskLevel: "any" } }]);
    api.calls = [];
    const second = await applyPass(deps(api), first.state);
    expect(api.calls).toEqual(["guard c1", "groups c1 0"]);
    expect(second.report.companies[0]?.writes).toBe(0);
  });

  it("leaves terminated and waiting agents alone, and keeps a built-in agent at its line whatever Studio says", async () => {
    const api = new FakeApi();
    api.agents.c1 = [
      { id: "b1", name: "Coach", status: "idle", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } } },
      { id: "t1", name: "Gone", status: "terminated", metadata: null },
      { id: "w1", name: "New", status: "pending_approval", metadata: null },
      { id: "bt", name: "Old coach", status: "terminated", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] }, kyoubeAskLevel: "any" } },
      { id: "bw", name: "New coach", status: "pending_approval", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] }, kyoubeAskLevel: "any" } },
    ];
    api.levels.c1 = { b1: "none", t1: "none", w1: "none", bt: "none", bw: "none" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([]);
    expect(api.files.b1?.startsWith(RULES_BLOCK)).toBe(true);
    expect(report.companies[0]).toMatchObject({ askLevelsUpdated: [], failures: [] });
  });

  it("puts a built-in agent that raised its own level back at its line, keeping the core's marker", async () => {
    const api = new FakeApi();
    const marker = { key: "reflection-coach", featureKeys: ["reflection"] };
    api.agents.c1 = [{ id: "b1", name: "Coach", status: "idle", metadata: { paperclipBuiltInAgent: marker, kyoubeAskLevel: "any" } }];
    api.levels.c1 = { b1: "any" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([{ agentId: "b1", metadata: { paperclipBuiltInAgent: marker } }]);
    expect(api.files.b1?.startsWith(RULES_BLOCK)).toBe(true);
    expect(report.companies[0]).toMatchObject({ askLevelsUpdated: ["Coach"], failures: [] });
  });

  it("copies Studio's level to an agent that gave itself a marker the core would not read", async () => {
    const api = new FakeApi();
    const forged = { key: "reflection-coach" };
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: { paperclipBuiltInAgent: forged } }];
    api.levels.c1 = { a1: "none" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([{ agentId: "a1", metadata: { paperclipBuiltInAgent: forged, kyoubeAskLevel: "none" } }]);
    expect(api.files.a1?.startsWith(rulesBlock("none"))).toBe(true);
    expect(report.companies[0]).toMatchObject({ askLevelsUpdated: ["Writer"], failures: [] });
  });

  it("holds a built-in agent's block at its line even when putting its level back fails", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "b1", name: "Coach", status: "idle", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] }, kyoubeAskLevel: "any" } }];
    api.failing.add("meta:b1");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures).toEqual([{ step: "asklevels", agent: "Coach", error: "refused meta:b1" }]);
    expect(api.files.b1?.startsWith(RULES_BLOCK)).toBe(true);
  });

  it("never writes the metadata of an agent the core listed without a metadata field", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: undefined }];
    api.levels.c1 = { a1: "none" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([]);
    expect(api.files.a1?.startsWith(RULES_BLOCK)).toBe(true);
    expect(report.companies[0]).toMatchObject({ askLevelsUpdated: [], failures: [], skipped: [] });
  });

  it("ignores a level for an agent that is not in the company", async () => {
    const api = new FakeApi();
    api.levels.c1 = { elsewhere: "any" };
    await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([]);
  });

  it("skips the copy and reports it when the levels cannot be read, and the block follows the metadata", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: { kyoubeAskLevel: "any" } }];
    api.failing.add("levels:c1");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([]);
    expect(report.companies[0]?.failures).toEqual([{ step: "asklevels", error: "refused levels:c1" }]);
    expect(api.files.a1?.startsWith(rulesBlock("any"))).toBe(true);
  });

  it("names the rules token file when Studio refuses the CLI", async () => {
    const api = new FakeApi();
    api.failing.add("studio403");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures[0]?.error).toMatch(/kyoube\/rules-token/);
  });

  it("skips quietly while Studio's worker is not running", async () => {
    const api = new FakeApi();
    api.failing.add("studio503");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures).toEqual([]);
    expect(api.metadataWrites).toEqual([]);
  });

  it("records a failed metadata write, and the block keeps the level the agent still has", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle", metadata: null }];
    api.levels.c1 = { a1: "none" };
    api.failing.add("meta:a1");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures).toEqual([{ step: "asklevels", agent: "Writer", error: "refused meta:a1" }]);
    expect(api.files.a1?.startsWith(RULES_BLOCK)).toBe(true);
  });

  it("off removes the key from every agent that has it, built-in agents included, keeping the rest of its metadata", async () => {
    const api = new FakeApi();
    const marker = { key: "reflection-coach", featureKeys: [] };
    api.agents.c1 = [
      { id: "a1", name: "Writer", status: "idle", metadata: { kyoubeAskLevel: "none", note: "kept" } },
      { id: "a3", name: "Plain", status: "idle", metadata: { note: "untouched" } },
      { id: "b1", name: "Coach", status: "idle", metadata: { paperclipBuiltInAgent: marker, kyoubeAskLevel: "any" } },
      { id: "u1", name: "Unlisted", status: "idle", metadata: undefined },
    ];
    api.files = { a1: `${rulesBlock("none")}\n\nYou are an agent.\n`, a3: "You are an agent.\n", b1: "You are a coach.\n", u1: "You are an agent.\n" };
    const { report } = await revertPass(deps(api), EMPTY_STATE);
    expect(api.metadataWrites).toEqual([{ agentId: "a1", metadata: { note: "kept" } }, { agentId: "b1", metadata: { paperclipBuiltInAgent: marker } }]);
    expect(api.files.a1).toBe("You are an agent.\n");
    expect(report.companies[0]?.failures).toEqual([]);
  });
});
