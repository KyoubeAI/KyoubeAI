import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { compileCompanyPolicy, compileIndex, createPolicyReader, writePolicyFiles } from "@kyoube/visibility";
import manifest from "../src/manifest.js";
import { createNotifyPlugin } from "../src/plugin.js";
import { decryptBody, fakeTransport, makeDevice, type TestDevice } from "./helpers.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const member = (principalId: string, membershipRole: string, status = "active") => ({ id: `m-${principalId}`, companyId: COMPANY, principalType: "user" as const, principalId, status, membershipRole, grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });

let dir: string;
// Never created until a test restricts the company: no policy files means an open company.
let policyDir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kyoube-notify-"));
  policyDir = path.join(dir, "visibility");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface SetupOptions { interactions?: Array<Record<string, unknown>>; issue?: Record<string, unknown>; moreIssues?: Array<Record<string, unknown>>; statuses?: Array<number | Error>; members?: ReturnType<typeof member>[]; realTransport?: boolean; pushTimeoutMs?: number; beforeSetup?: (harness: ReturnType<typeof createTestHarness>) => void }

async function setup(options: SetupOptions = {}) {
  const harness = createTestHarness({ manifest });
  harness.seed({
    companies: [{ id: COMPANY, name: "Acme", issuePrefix: "ACM" } as never],
    agents: [{ id: AGENT, companyId: COMPANY, name: "Ada" } as never],
    issues: [{ id: ISSUE, companyId: COMPANY, identifier: "ACM-1", title: "Launch post", status: "in_progress", createdByUserId: "owner", assigneeUserId: "operator", ...options.issue } as never, ...(options.moreIssues ?? []) as never[]],
    issueInteractions: (options.interactions ?? []) as never,
    approvals: [{ id: "ap1", companyId: COMPANY, type: "hire_agent", status: "pending", requestedByAgentId: AGENT, payload: { name: "Mo" } } as never],
    accessMembers: (options.members ?? [member("owner", "owner"), member("admin", "admin"), member("operator", "operator"), member("viewer", "viewer"), member("left", "admin", "archived")]) as never,
  });
  options.beforeSetup?.(harness);
  const { sent, transport } = fakeTransport(options.statuses ?? []);
  const plugin = createNotifyPlugin({ policyReader: createPolicyReader({ dir: policyDir, checkMs: 0 }), pushTimeoutMs: options.pushTimeoutMs, ...(options.realTransport ? {} : { transport }), sleep: async () => {}, configPath: path.join(dir, "config.json"), testEndpointPath: path.join(dir, "push-test-endpoint") });
  await plugin.definition.setup(harness.ctx);
  const devices = new Map<string, TestDevice>();
  const subscribe = async (userId: string) => {
    const device = makeDevice();
    await harness.performAction("notify.subscribe", { subscription: device.subscription, label: "Phone" }, { actor: { type: "user", userId }, companyId: COMPANY });
    devices.set(device.subscription.endpoint, device);
    return device;
  };
  /** Each push as { to: endpoint owner's device, payload }. */
  const pushes = () => sent.map((request) => ({ endpoint: request.url, payload: JSON.parse(decryptBody(request.body, devices.get(request.url)!)) as { title: string; url: string } }));
  // A fresh eventId per emit: the worker drops an event id it has already handled.
  const emit = (eventType: string, base: Partial<PluginEvent>, payload: unknown = {}) => harness.emit(eventType as never, payload, { companyId: COMPANY, eventId: randomUUID(), ...base });
  return { harness, sent, subscribe, pushes, emit };
}

/**
 * Turns the company need-to-know, with real policy files. `seesAll` is a group that sees every
 * work object; `projects` says who is in a group that includes each project.
 */
async function restrict(seesAll: string[] = [], projects: Record<string, string[]> = {}) {
  const writtenAt = "2026-10-23T00:00:00.000Z";
  const policy = compileCompanyPolicy({
    companyId: COMPANY,
    mode: "need_to_know",
    writtenAt,
    groups: [
      ...Object.entries(projects).map(([projectId, members]) => ({ seesAll: false, members, projects: [projectId] })),
      { seesAll: true, members: seesAll, projects: [] },
    ],
  });
  if (!policy) throw new Error("expected a need-to-know policy");
  await writePolicyFiles({ dir: policyDir, index: compileIndex([{ companyId: COMPANY, mode: "need_to_know" }], writtenAt), companies: [policy] });
}

const openQuestion = (over: Record<string, unknown> = {}) => ({ id: "q1", companyId: COMPANY, issueId: ISSUE, kind: "request_confirmation", status: "pending", title: "Ship it?", createdByAgentId: AGENT, ...over });

describe("approvals", () => {
  it("tell every active member except viewers, with a link to the approval", async () => {
    const { subscribe, pushes, emit } = await setup();
    const owner = await subscribe("owner"); const operator = await subscribe("operator"); await subscribe("viewer");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(pushes().map((p) => p.endpoint).sort()).toEqual([owner.subscription.endpoint, operator.subscription.endpoint].sort());
    expect(pushes()[0]!.payload).toMatchObject({ title: "Approval needed: Hire an agent", url: "/ACM/approvals/ap1" });
  });

  it("never tell the person who asked", async () => {
    const { subscribe, sent, emit } = await setup();
    await subscribe("admin");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "user", actorId: "admin" });
    expect(sent).toHaveLength(0);
  });
});

describe("agent questions", () => {
  it("reach the task's creator when the agent's run ends, once", async () => {
    const { subscribe, pushes, emit } = await setup({ interactions: [openQuestion()] });
    await subscribe("owner");
    await emit("agent.run.finished", { entityType: "heartbeat_run", entityId: "r1", actorType: "agent", actorId: AGENT }, { runId: "r1", agentId: AGENT, issueId: ISSUE });
    await emit("agent.run.finished", { entityType: "heartbeat_run", entityId: "r2", actorType: "agent", actorId: AGENT }, { runId: "r2", agentId: AGENT, issueId: ISSUE });
    expect(pushes().map((p) => p.payload)).toEqual([{ title: "Ada is asking: Ship it?", body: "ACM-1 · Launch post", url: "/ACM/issues/ACM-1", tag: `issue:${ISSUE}` }]);
  });

  it("go to the person addressed, and nowhere when an agent is addressed", async () => {
    const { subscribe, pushes, emit } = await setup({ interactions: [openQuestion({ addresseeUserId: "admin" }), openQuestion({ id: "q2", addresseeAgentId: AGENT })] });
    const admin = await subscribe("admin"); await subscribe("owner");
    await emit("issue.comment.created", { entityType: "issue", entityId: ISSUE, actorType: "agent", actorId: AGENT });
    expect(pushes().map((p) => p.endpoint)).toEqual([admin.subscription.endpoint]);
  });
});

describe("task status", () => {
  it("tells the creator and assignee when a task is done, not the person who closed it", async () => {
    const { subscribe, pushes, emit } = await setup({ issue: { status: "done" } });
    const owner = await subscribe("owner"); await subscribe("operator");
    await emit("issue.updated", { entityType: "issue", entityId: ISSUE, actorType: "user", actorId: "operator" }, { status: "done", _previous: { status: "in_progress" } });
    expect(pushes().map((p) => p.endpoint)).toEqual([owner.subscription.endpoint]);
    expect(pushes()[0]!.payload.title).toBe("Done: Launch post");
  });

  it("does not repeat for the same status, and needs a known previous status", async () => {
    const { subscribe, sent, emit } = await setup({ issue: { status: "blocked" } });
    await subscribe("owner");
    await emit("issue.updated", { entityType: "issue", entityId: ISSUE, actorType: "agent", actorId: AGENT }, {});
    expect(sent).toHaveLength(0);
    await emit("issue.updated", { entityType: "issue", entityId: ISSUE, actorType: "agent", actorId: AGENT }, { _previous: { status: "in_progress" } });
    expect(sent).toHaveLength(0);
  });
});

describe("opt-ins", () => {
  it("sends one failure per agent per 30 minutes to owners and admins who asked for them", async () => {
    const { harness, subscribe, pushes, emit } = await setup();
    await subscribe("owner"); await subscribe("admin");
    await harness.performAction("notify.prefs", { failures: true }, { actor: { type: "user", userId: "owner" }, companyId: COMPANY });
    const failed = (runId: string) => emit("agent.run.failed", { entityType: "heartbeat_run", entityId: runId, actorType: "agent", actorId: AGENT }, { runId, agentId: AGENT, issueId: null });
    await failed("r1"); await failed("r2");
    expect(pushes().map((p) => p.payload)).toEqual([expect.objectContaining({ title: "Ada's run failed", url: `/ACM/agents/${AGENT}/runs/r1` })]);
  });

  it("sends comments only to the task's people who asked for them", async () => {
    const { harness, subscribe, pushes, emit } = await setup();
    const operator = await subscribe("operator"); await subscribe("owner");
    await harness.performAction("notify.prefs", { comments: true }, { actor: { type: "user", userId: "operator" }, companyId: COMPANY });
    await emit("issue.comment.created", { entityType: "issue", entityId: ISSUE, actorType: "agent", actorId: AGENT });
    expect(pushes().map((p) => [p.endpoint, p.payload.title])).toEqual([[operator.subscription.endpoint, "Ada commented on ACM-1"]]);
  });
});

describe("need-to-know visibility", () => {
  const HIDDEN_PROJECT = "55555555-5555-4555-8555-555555555555";
  const PARENT = "66666666-6666-4666-8666-666666666666";
  const people = [member("owner", "owner"), member("admin", "admin"), member("operator", "operator"), member("scout", "operator"), member("viewer", "viewer")];
  const byAgent = { entityType: "issue", entityId: ISSUE, actorType: "agent" as const, actorId: AGENT };
  const sorted = (endpoints: string[]) => [...endpoints].sort();
  const problems = (logs: Array<{ level: string }>) => logs.filter((entry) => entry.level === "warn" || entry.level === "error");
  const unreadable = () => rm(path.join(policyDir, `${COMPANY}.json`));

  it("sends an approval notification to the owner, an admin and a sees-all operator, not to a restricted operator or viewer", async () => {
    const { subscribe, pushes, emit } = await setup({ members: people });
    await restrict(["scout"]);
    const reached = [await subscribe("owner"), await subscribe("admin"), await subscribe("scout")];
    await subscribe("operator"); await subscribe("viewer");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(sorted(pushes().map((p) => p.endpoint))).toEqual(sorted(reached.map((device) => device.subscription.endpoint)));
  });

  it("still sends an approval notification to owners and admins when the policy cannot be read", async () => {
    const { harness, subscribe, pushes, emit } = await setup({ members: people });
    await restrict(["scout"]);
    await unreadable();
    const reached = [await subscribe("owner"), await subscribe("admin")];
    await subscribe("operator"); await subscribe("scout");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(sorted(pushes().map((p) => p.endpoint))).toEqual(sorted(reached.map((device) => device.subscription.endpoint)));
    expect(problems(harness.logs)).toEqual([]);
  });

  it("does not send a question to a person who cannot see the task, and does send the other one", async () => {
    const { harness, subscribe, pushes, emit } = await setup({
      members: people,
      issue: { projectId: HIDDEN_PROJECT },
      interactions: [openQuestion({ addresseeUserId: "viewer" }), openQuestion({ id: "q2", addresseeUserId: "operator" })],
    });
    await restrict();
    await subscribe("viewer");
    const operator = await subscribe("operator");
    await emit("issue.comment.created", byAgent);
    expect(pushes().map((p) => p.endpoint)).toEqual([operator.subscription.endpoint]);
    expect(problems(harness.logs)).toEqual([]);
  });

  it("sends a question nowhere, quietly, when nobody addressed can see the task", async () => {
    const { harness, subscribe, sent, emit } = await setup({ members: people, issue: { projectId: HIDDEN_PROJECT }, interactions: [openQuestion({ addresseeUserId: "viewer" })] });
    await restrict();
    await subscribe("viewer");
    await emit("issue.comment.created", byAgent);
    expect(sent).toHaveLength(0);
    expect(problems(harness.logs)).toEqual([]);
  });

  it("sends a question to a restricted person who sees the task through their group's project", async () => {
    const { subscribe, pushes, emit } = await setup({ members: people, issue: { projectId: HIDDEN_PROJECT }, interactions: [openQuestion({ addresseeUserId: "viewer" })] });
    await restrict([], { [HIDDEN_PROJECT]: ["viewer"] });
    const viewer = await subscribe("viewer");
    await emit("issue.comment.created", byAgent);
    expect(pushes().map((p) => p.endpoint)).toEqual([viewer.subscription.endpoint]);
  });

  it("sends a question to a restricted person who sees the task through its parent", async () => {
    const parent = { id: PARENT, companyId: COMPANY, identifier: "ACM-0", title: "Campaign", status: "in_progress", createdByUserId: "viewer" };
    const { subscribe, pushes, emit } = await setup({ members: people, moreIssues: [parent], issue: { parentId: PARENT }, interactions: [openQuestion({ addresseeUserId: "viewer" })] });
    await restrict();
    const viewer = await subscribe("viewer");
    await emit("issue.comment.created", byAgent);
    expect(pushes().map((p) => p.endpoint)).toEqual([viewer.subscription.endpoint]);
  });

  it("keeps telling a restricted creator and assignee about their own task", async () => {
    const { subscribe, pushes, emit } = await setup({ members: people, issue: { status: "done", projectId: HIDDEN_PROJECT, createdByUserId: "scout" } });
    await restrict();
    const reached = [await subscribe("scout"), await subscribe("operator")];
    await emit("issue.updated", byAgent, { status: "done", _previous: { status: "in_progress" } });
    expect(sorted(pushes().map((p) => p.endpoint))).toEqual(sorted(reached.map((device) => device.subscription.endpoint)));
  });

  it("tells only people who can read the task that it is done when the policy cannot be read", async () => {
    const { harness, subscribe, pushes, emit } = await setup({ members: people, issue: { status: "done" } });
    await restrict();
    await unreadable();
    const owner = await subscribe("owner");
    await subscribe("operator");
    await emit("issue.updated", byAgent, { status: "done", _previous: { status: "in_progress" } });
    expect(pushes().map((p) => p.endpoint)).toEqual([owner.subscription.endpoint]);
    expect(problems(harness.logs)).toEqual([]);
  });

  it("sends a comment notification only to people who can read the task when the policy cannot be read", async () => {
    const { harness, subscribe, pushes, emit } = await setup({ members: people });
    await restrict();
    await unreadable();
    const owner = await subscribe("owner");
    await subscribe("operator");
    for (const userId of ["owner", "operator"]) await harness.performAction("notify.prefs", { comments: true }, { actor: { type: "user", userId }, companyId: COMPANY });
    await emit("issue.comment.created", byAgent);
    expect(pushes().map((p) => p.endpoint)).toEqual([owner.subscription.endpoint]);
    expect(problems(harness.logs)).toEqual([]);
  });

  it("picks up a policy change at the next event", async () => {
    const { subscribe, pushes, emit } = await setup({ members: people });
    const operator = await subscribe("operator");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(pushes().map((p) => p.endpoint)).toEqual([operator.subscription.endpoint]);
    await restrict();
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(pushes()).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("handles each event once, even if the core delivers it twice", async () => {
    const { harness, subscribe, sent } = await setup();
    await subscribe("owner");
    const base = { companyId: COMPANY, eventId: "e-1", entityType: "approval", entityId: "ap1", actorType: "agent" as const, actorId: AGENT };
    await harness.emit("approval.created", {}, base);
    await harness.emit("approval.created", {}, base);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing to a member who left", async () => {
    const { subscribe, sent, emit } = await setup();
    await subscribe("left");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    expect(sent).toHaveLength(0);
  });

  it("ignores events whose task or approval is gone", async () => {
    const { subscribe, sent, emit, harness } = await setup();
    await subscribe("owner");
    await emit("approval.created", { entityType: "approval", entityId: "missing", actorType: "agent", actorId: AGENT });
    await emit("issue.updated", { entityType: "issue", entityId: "missing" }, { _previous: { status: "todo" } });
    await emit("agent.run.finished", { entityType: "heartbeat_run", entityId: "r9" }, { runId: "r9", agentId: AGENT, issueId: "missing" });
    await harness.emit("approval.created", {}, { companyId: "99999999-9999-4999-8999-999999999999", eventId: randomUUID(), entityType: "approval", entityId: "ap1" });
    expect(sent).toHaveLength(0);
  });

  it("removes a device the push service dropped and keeps a refused one with the reason", async () => {
    const { harness, subscribe, emit } = await setup({ statuses: [410, 403] });
    await subscribe("owner"); await subscribe("operator");
    await emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT });
    const devices = async (userId: string) => (await harness.performAction<{ devices: Array<{ lastError: string | null }> }>("notify.config", {}, { actor: { type: "user", userId }, companyId: COMPANY })).devices;
    const remaining = [...(await devices("owner")), ...(await devices("operator"))];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.lastError).toBe("push service refused the request (403)");
  });

  it("keeps a refused device and records why, without throwing out of the event handler", async () => {
    const { harness, subscribe, emit } = await setup({ statuses: [new Error("boom"), new Error("boom")] });
    await subscribe("owner");
    await expect(emit("approval.created", { entityType: "approval", entityId: "ap1", actorType: "agent", actorId: AGENT })).resolves.toBeUndefined();
    const { devices } = await harness.performAction<{ devices: Array<{ lastError: string | null }> }>("notify.config", {}, { actor: { type: "user", userId: "owner" }, companyId: COMPANY });
    expect(devices[0]!.lastError).toBe("push service unreachable: boom");
  });
});

describe("actions", () => {
  const as = (userId: string) => ({ actor: { type: "user" as const, userId }, companyId: COMPANY });

  it("give each person their own key, devices and preferences", async () => {
    const { harness, subscribe } = await setup();
    await subscribe("owner");
    const first = await harness.performAction<{ publicKey: string; devices: Array<Record<string, unknown>>; prefs: unknown }>("notify.config", {}, as("owner"));
    const again = await harness.performAction<{ publicKey: string }>("notify.config", {}, as("admin"));
    expect(first.publicKey).toBe(again.publicKey);
    expect(first.devices).toHaveLength(1);
    expect(first.devices[0]).not.toHaveProperty("p256dh");
    expect(first.devices[0]).not.toHaveProperty("auth");
    expect(first.prefs).toEqual({ failures: false, comments: false });
  });

  it("tell the page whether the person can receive failure notices: owners and admins only", async () => {
    const { harness } = await setup();
    const config = (userId: string) => harness.performAction<{ canReceiveFailures: boolean }>("notify.config", {}, as(userId));
    expect((await config("owner")).canReceiveFailures).toBe(true);
    expect((await config("admin")).canReceiveFailures).toBe(true);
    expect((await config("operator")).canReceiveFailures).toBe(false);
    expect((await config("left")).canReceiveFailures).toBe(false);
    expect((await config("stranger")).canReceiveFailures).toBe(false);
    expect((await harness.performAction<{ canReceiveFailures: boolean }>("notify.config", {}, { actor: { type: "user", userId: "owner" } })).canReceiveFailures).toBe(false);
  });

  it("refuse agents, unknown push services and someone else's device", async () => {
    const { harness, subscribe } = await setup();
    const device = makeDevice();
    await expect(harness.performAction("notify.subscribe", { subscription: device.subscription }, { actor: { type: "agent", agentId: AGENT } as never, companyId: COMPANY })).rejects.toThrow("forbidden");
    await expect(harness.performAction("notify.subscribe", { subscription: { ...device.subscription, endpoint: "https://evil.example.com/x" } }, as("owner"))).rejects.toThrow("not a known push service");
    await subscribe("owner");
    const { devices } = await harness.performAction<{ devices: Array<{ id: string }> }>("notify.config", {}, as("owner"));
    expect(await harness.performAction("notify.unsubscribe", { deviceId: devices[0]!.id }, as("admin"))).toEqual({ ok: false });
    expect(await harness.performAction("notify.unsubscribe", { deviceId: devices[0]!.id }, as("owner"))).toEqual({ ok: true });
  });

  it("accept the smoke test's endpoint only while its file names it", async () => {
    const { harness } = await setup();
    const device = makeDevice("http://127.0.0.1:39123/push");
    await expect(harness.performAction("notify.subscribe", { subscription: device.subscription }, as("owner"))).rejects.toThrow("not a known push service");
    await writeFile(path.join(dir, "push-test-endpoint"), "http://127.0.0.1:39123/push\n");
    await expect(harness.performAction("notify.subscribe", { subscription: device.subscription }, as("owner"))).resolves.toMatchObject({ endpoint: "http://127.0.0.1:39123/push" });
  });

  it("send a test to one of your own devices", async () => {
    const { harness, subscribe, pushes } = await setup();
    await subscribe("owner");
    const { devices } = await harness.performAction<{ devices: Array<{ id: string }> }>("notify.config", {}, as("owner"));
    expect(await harness.performAction("notify.test", { deviceId: devices[0]!.id }, as("owner"))).toEqual({ result: "delivered", status: 201 });
    expect(pushes()[0]!.payload.title).toBe("KyoubeAI test");
    await expect(harness.performAction("notify.test", { deviceId: devices[0]!.id }, as("admin"))).rejects.toThrow("not_found");
  });
});

describe("robustness of questions", () => {
  it("still sends an opted-in failure when the question check throws", async () => {
    const { harness, subscribe, pushes, emit } = await setup({ beforeSetup: (h) => { (h.ctx.issues as { listInteractions: unknown }).listInteractions = async () => { throw new Error("down"); }; } });
    await subscribe("owner");
    await harness.performAction("notify.prefs", { failures: true }, { actor: { type: "user", userId: "owner" }, companyId: COMPANY });
    await emit("agent.run.failed", { entityType: "heartbeat_run", entityId: "r1", actorType: "agent", actorId: AGENT }, { runId: "r1", agentId: AGENT, issueId: ISSUE });
    expect(pushes().map((p) => p.payload.title)).toEqual(["Ada's run failed"]);
  });
});

describe("the real transport", () => {
  const servers: Server[] = [];
  const listen = async (handler: (req: IncomingMessage, chunks: Buffer[]) => { status: number; location?: string }) => {
    const received: Buffer[] = [];
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(Buffer.concat(chunks));
        const out = handler(req, chunks);
        res.writeHead(out.status, out.location ? { location: out.location } : {});
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/push`, received, hits: () => hits };
  };
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });
  const as = (userId: string) => ({ actor: { type: "user" as const, userId }, companyId: COMPANY });

  it("delivers the encrypted body byte for byte", async () => {
    const target = await listen(() => ({ status: 201 }));
    await writeFile(path.join(dir, "push-test-endpoint"), target.url);
    const { harness } = await setup({ realTransport: true });
    const device = makeDevice(target.url);
    const added = await harness.performAction<{ id: string }>("notify.subscribe", { subscription: device.subscription }, as("owner"));
    expect(await harness.performAction("notify.test", { deviceId: added.id }, as("owner"))).toEqual({ result: "delivered", status: 201 });
    expect(JSON.parse(decryptBody(target.received[0]!, device))).toMatchObject({ title: "KyoubeAI test" });
  });

  it("does not follow a redirect", async () => {
    const second = await listen(() => ({ status: 201 }));
    const first = await listen(() => ({ status: 302, location: second.url }));
    await writeFile(path.join(dir, "push-test-endpoint"), first.url);
    const { harness } = await setup({ realTransport: true });
    const added = await harness.performAction<{ id: string }>("notify.subscribe", { subscription: makeDevice(first.url).subscription }, as("owner"));
    expect(await harness.performAction("notify.test", { deviceId: added.id }, as("owner"))).toMatchObject({ result: "failed", status: 302 });
    expect(second.hits()).toBe(0);
  });

  it("gives up on a push service that never answers", async () => {
    const hung = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    servers.push(hung);
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/push`;
    await writeFile(path.join(dir, "push-test-endpoint"), url);
    const { harness } = await setup({ realTransport: true, pushTimeoutMs: 200 });
    const added = await harness.performAction<{ id: string }>("notify.subscribe", { subscription: makeDevice(url).subscription }, as("owner"));
    const outcome = await harness.performAction<{ result: string }>("notify.test", { deviceId: added.id }, as("owner"));
    expect(outcome.result).toBe("failed");
  });
});
