import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileCompanyPolicy, compileIndex, createPolicyReader, MAX_ANCESTORS, writePolicyFiles, type PolicyReader, type TaskFacts } from "@kyoube/visibility";
import type { ActiveMember } from "../src/routing.js";
import { createVisibilityGate } from "../src/visibility.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const LISTED = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const WRITTEN_AT = "2026-10-23T00:00:00.000Z";

const OWNER: ActiveMember = { userId: "owner-1", role: "owner" };
const ADMIN: ActiveMember = { userId: "admin-1", role: "admin" };
const ON_LIST: ActiveMember = { userId: "on-list", role: "operator" };
const OFF_LIST: ActiveMember = { userId: "off-list", role: "operator" };
const SEES_ALL: ActiveMember = { userId: "sees-all", role: "operator" };
const VIEWER: ActiveMember = { userId: "viewer-1", role: "viewer" };
const EVERYONE = [OWNER, ADMIN, ON_LIST, OFF_LIST, SEES_ALL, VIEWER];

let dir: string;
let reader: PolicyReader;
let tasks: Map<string, TaskFacts>;
let reads: string[];

const task = (id: string, over: Partial<TaskFacts> = {}): TaskFacts => ({
  id, projectId: null, parentId: null, createdByUserId: null, assigneeUserId: null, responsibleUserId: null, conversationUserId: null, ...over,
});
const put = (row: TaskFacts) => tasks.set(row.id, row);

const gate = () => createVisibilityGate({
  reader,
  issues: { get: async (issueId, companyId) => { reads.push(`${companyId}/${issueId}`); return tasks.get(issueId) ?? null; } },
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kyoube-notify-visibility-"));
  reader = createPolicyReader({ dir, checkMs: 0 });
  tasks = new Map();
  reads = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeNeedToKnow() {
  const policy = compileCompanyPolicy({
    companyId: COMPANY,
    mode: "need_to_know",
    writtenAt: WRITTEN_AT,
    groups: [
      { seesAll: false, members: [ON_LIST.userId], projects: [LISTED] },
      { seesAll: true, members: [SEES_ALL.userId], projects: [] },
    ],
  });
  if (!policy) throw new Error("expected a need-to-know policy");
  await writePolicyFiles({ dir, index: compileIndex([{ companyId: COMPANY, mode: "need_to_know" }], WRITTEN_AT), companies: [policy] });
}

describe("restricted", () => {
  it("is everyone outside a sees-all group who is not an owner or an admin", async () => {
    await writeNeedToKnow();
    expect([...(await gate().restricted(COMPANY, EVERYONE))].sort()).toEqual([OFF_LIST.userId, ON_LIST.userId, VIEWER.userId].sort());
  });

  it("is nobody in an open company", async () => {
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: COMPANY, mode: "open" }], WRITTEN_AT), companies: [] });
    expect((await gate().restricted(COMPANY, EVERYONE)).size).toBe(0);
  });

  it("is nobody before the feature was ever turned on", async () => {
    expect((await gate().restricted(COMPANY, EVERYONE)).size).toBe(0);
  });

  it("holds back every non-manager, and never an owner or an admin, when the policy cannot be read", async () => {
    await writeNeedToKnow();
    await rm(path.join(dir, `${COMPANY}.json`));
    expect([...(await gate().restricted(COMPANY, EVERYONE))].sort()).toEqual([OFF_LIST.userId, ON_LIST.userId, SEES_ALL.userId, VIEWER.userId].sort());
  });
});

describe("canReadTask", () => {
  it("lets a restricted person read a task they made, even without a project", async () => {
    await writeNeedToKnow();
    put(task("t1", { createdByUserId: OFF_LIST.userId }));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "t1")).toBe(true);
    expect(await gate().canReadTask(COMPANY, ON_LIST, "t1")).toBe(false);
  });

  it("lets a restricted person read a task assigned to, owed by or discussed with them", async () => {
    await writeNeedToKnow();
    put(task("assigned", { assigneeUserId: OFF_LIST.userId }));
    put(task("responsible", { responsibleUserId: OFF_LIST.userId }));
    put(task("conversation", { conversationUserId: OFF_LIST.userId }));
    for (const id of ["assigned", "responsible", "conversation"]) expect(await gate().canReadTask(COMPANY, OFF_LIST, id)).toBe(true);
  });

  it("lets a restricted person read a subtask whose parent is theirs", async () => {
    await writeNeedToKnow();
    put(task("parent", { createdByUserId: OFF_LIST.userId }));
    put(task("child", { parentId: "parent", createdByUserId: "someone-else" }));
    put(task("grandchild", { parentId: "child" }));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "child")).toBe(true);
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "grandchild")).toBe(true);
    expect(await gate().canReadTask(COMPANY, ON_LIST, "grandchild")).toBe(false);
  });

  it("hides a task in a project the person's groups do not list, when someone else made it", async () => {
    await writeNeedToKnow();
    put(task("secret", { projectId: HIDDEN, createdByUserId: OWNER.userId }));
    put(task("shared", { projectId: LISTED, createdByUserId: OWNER.userId }));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "secret")).toBe(false);
    expect(await gate().canReadTask(COMPANY, ON_LIST, "secret")).toBe(false);
    expect(await gate().canReadTask(COMPANY, ON_LIST, "shared")).toBe(true);
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "shared")).toBe(false);
  });

  it("shows every task to an owner, an admin and a person in a sees-all group, without reading it", async () => {
    await writeNeedToKnow();
    put(task("secret", { projectId: HIDDEN, createdByUserId: "someone-else" }));
    for (const person of [OWNER, ADMIN, SEES_ALL]) expect(await gate().canReadTask(COMPANY, person, "secret")).toBe(true);
    expect(reads).toEqual([]);
  });

  it("shows every task in an open company", async () => {
    put(task("secret", { projectId: HIDDEN }));
    expect(await gate().canReadTask(COMPANY, VIEWER, "secret")).toBe(true);
  });

  it("hides a task that cannot be read back from a restricted person", async () => {
    await writeNeedToKnow();
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "gone")).toBe(false);
  });

  it("refuses a restricted person, but not an admin, when the policy file is unreadable", async () => {
    await writeNeedToKnow();
    put(task("t1", { createdByUserId: OFF_LIST.userId }));
    await rm(path.join(dir, `${COMPANY}.json`));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "t1")).toBe(false);
    expect(await gate().canReadTask(COMPANY, ADMIN, "t1")).toBe(true);
    expect(await gate().canReadTask(COMPANY, OWNER, "t1")).toBe(true);
  });

  it("follows a chain of ancestors up to the limit, and no further", async () => {
    await writeNeedToKnow();
    // t0 is the task, t1 its parent and so on; the person's task is `depth` parents up.
    const build = (depth: number) => {
      tasks.clear();
      for (let i = 0; i <= depth; i += 1) put(task(`t${i}`, { parentId: i < depth ? `t${i + 1}` : null, createdByUserId: i === depth ? OFF_LIST.userId : null }));
    };
    build(MAX_ANCESTORS);
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "t0")).toBe(true);
    build(MAX_ANCESTORS + 1);
    reads = [];
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "t0")).toBe(false);
    // The walk stops at the limit instead of reading the whole chain.
    expect(reads.length).toBeLessThanOrEqual(MAX_ANCESTORS + 1);
  });

  it("stops at a missing parent and at a cycle", async () => {
    await writeNeedToKnow();
    put(task("orphan", { parentId: "gone" }));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "orphan")).toBe(false);
    put(task("a", { parentId: "b" }));
    put(task("b", { parentId: "a" }));
    expect(await gate().canReadTask(COMPANY, OFF_LIST, "a")).toBe(false);
  });
});
