import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { compileCompanyPolicy, compileIndex, createPolicyReader, writePolicyFiles } from "@kyoube/visibility";
import type { Project } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import manifest from "../src/manifest.js";
import { createFilesPlugin, resolveWorkspaces } from "../src/plugin.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const HIDDEN_PROJECT = "77777777-7777-4777-8777-777777777777";
const ADMIN = { type: "user" as const, userId: "admin-1" };
const MEMBER = { type: "user" as const, userId: "member-1" };
const VIEWER = { type: "user" as const, userId: "viewer-1" };
const STRANGER = { type: "user" as const, userId: "stranger-1" };

const MEMBERS = [
  { id: "m1", companyId: COMPANY, principalType: "user" as const, principalId: "admin-1", status: "active" as const, membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "m2", companyId: COMPANY, principalType: "user" as const, principalId: "member-1", status: "active" as const, membershipRole: "member", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "m3", companyId: COMPANY, principalType: "user" as const, principalId: "viewer-1", status: "active" as const, membershipRole: "viewer", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "m4", companyId: OTHER_COMPANY, principalType: "user" as const, principalId: "stranger-1", status: "active" as const, membershipRole: "owner", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];

function project(id: string, companyId: string, name: string): Project {
  return { id, companyId, name, urlKey: name, goalId: null, goalIds: [], goals: [], description: null, status: "active", leadAgentId: null, targetDate: null, color: null, icon: null, env: null, pauseReason: null, pausedAt: null, executionWorkspacePolicy: null, codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null, localFolder: null, managedFolder: "", effectiveLocalFolder: "", origin: "managed_checkout" }, workspaces: [], primaryWorkspace: null, archivedAt: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") } as unknown as Project;
}

let base: string;
let root: string;
let secondRoot: string;
let hiddenRoot: string;
let policyDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "kyoube-files-plugin-"));
  root = path.join(base, "projects", COMPANY, PROJECT, "_default");
  secondRoot = path.join(base, "second");
  hiddenRoot = path.join(base, "projects", COMPANY, HIDDEN_PROJECT, "_default");
  // Never created until a test restricts the company: no policy files means an open company.
  policyDir = path.join(base, "visibility");
  await mkdir(root, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await mkdir(hiddenRoot, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function setup(config: Record<string, unknown> = {}, opts: { secondWorkspace?: boolean } = {}) {
  const harness = createTestHarness({ manifest, config });
  const workspaces = [
    { id: `${PROJECT}:managed`, projectId: PROJECT, name: "Smoke", path: root, repoUrl: null, repoRef: null, defaultRef: null, isPrimary: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  ];
  if (opts.secondWorkspace) workspaces.push({ id: "ws-2", projectId: PROJECT, name: "Second", path: secondRoot, repoUrl: null, repoRef: null, defaultRef: null, isPrimary: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  harness.seed({
    accessMembers: MEMBERS,
    projects: [project(PROJECT, COMPANY, "Smoke"), project(HIDDEN_PROJECT, COMPANY, "Vault"), project(OTHER_PROJECT, OTHER_COMPANY, "Elsewhere")],
    projectWorkspaces: [
      ...workspaces,
      { id: `${HIDDEN_PROJECT}:managed`, projectId: HIDDEN_PROJECT, name: "Vault", path: hiddenRoot, repoUrl: null, repoRef: null, defaultRef: null, isPrimary: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ],
  });
  const plugin = createFilesPlugin({ policyReader: createPolicyReader({ dir: policyDir, checkMs: 0 }) });
  await plugin.definition.setup(harness.ctx);
  const act = <T,>(key: string, params: Record<string, unknown>, actor = ADMIN, companyId = COMPANY) =>
    harness.performAction<T>(key, { projectId: PROJECT, ...params }, { actor, companyId });
  return { harness, plugin, act };
}

/**
 * Turns the company need-to-know, with real policy files. `projects` says who is in a group
 * that includes each project; `seesAll` is a group that sees every project.
 */
async function restrict(projects: Record<string, string[]>, seesAll: string[] = []) {
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

describe("files.workspaces", () => {
  it("reports the caller's access and the project's folders", async () => {
    const { act } = await setup();
    const info = await act<{ role: string; canRead: boolean; canWrite: boolean; limits: Record<string, number>; workspaces: Array<{ id: string; path: string; source: string; isPrimary: boolean }> }>("files.workspaces", {});
    expect(info).toMatchObject({ role: "admin", canRead: true, canWrite: true, limits: { maxEditableBytes: 1024 * 1024, maxUploadBytes: 5 * 1024 * 1024, maxDownloadBytes: 25 * 1024 * 1024 } });
    expect(info.workspaces).toEqual([{ id: `${PROJECT}:managed`, name: "Smoke", path: root, isPrimary: true, source: "managed" }]);
  });

  it("gives a viewer read-only access by default, and a role outside readRoles nothing — not even the path", async () => {
    const { act } = await setup();
    expect(await act("files.workspaces", {}, VIEWER)).toMatchObject({ role: "viewer", canRead: true, canWrite: false });
    const { act: restricted } = await setup({ readRoles: ["owner", "admin"] });
    const info = await restricted<{ canRead: boolean; workspaces: unknown[] }>("files.workspaces", {}, MEMBER);
    expect(info).toMatchObject({ canRead: false, workspaces: [] });
  });

  it("lists further configured workspaces after the primary", async () => {
    const { act } = await setup({}, { secondWorkspace: true });
    const info = await act<{ workspaces: Array<{ id: string; isPrimary: boolean; source: string }> }>("files.workspaces", {});
    expect(info.workspaces.map((item) => [item.id, item.isPrimary, item.source])).toEqual([[`${PROJECT}:managed`, true, "managed"], ["ws-2", false, "configured"]]);
  });

  it("refuses agents, anonymous callers and a project outside the company", async () => {
    const { act, harness } = await setup();
    await expect(act("files.workspaces", {}, { type: "agent" as const, agentId: "a1" } as never)).rejects.toThrow("forbidden");
    await expect(harness.performAction("files.workspaces", { projectId: PROJECT }, { companyId: COMPANY })).rejects.toThrow("forbidden");
    await expect(act("files.workspaces", { projectId: OTHER_PROJECT })).rejects.toThrow("not_found");
  });
});

describe("files.locate", () => {
  const ISSUE = "55555555-5555-4555-8555-555555555555";
  const ORPHAN = "66666666-6666-4666-8666-666666666666";
  const issue = (id: string, projectId: string | null) => ({ id, companyId: COMPANY, projectId, identifier: "SMK-1", title: "t", status: "todo", priority: "medium" }) as never;
  it("maps a task to its project for a reader, and answers nulls rather than throwing otherwise", async () => {
    const { act, harness } = await setup();
    harness.seed({ issues: [issue(ISSUE, PROJECT), issue(ORPHAN, null)] });
    expect(await act("files.locate", { issueRef: ISSUE })).toEqual({ projectId: PROJECT, projectName: "Smoke", canRead: true });
    expect(await act("files.locate", { issueRef: ORPHAN })).toEqual({ projectId: null, projectName: null, canRead: true });
    expect(await act("files.locate", { issueRef: "nope" })).toEqual({ projectId: null, projectName: null, canRead: true });
    expect(await act("files.locate", {})).toEqual({ projectId: null, projectName: null, canRead: true });
    expect(await act("files.locate", { issueRef: ISSUE }, VIEWER)).toMatchObject({ projectId: PROJECT, canRead: true });
    expect(await act("files.locate", { issueRef: ISSUE }, { type: "agent" as const, agentId: "a1" } as never)).toEqual({ projectId: null, projectName: null, canRead: false });
  });
  it("hides the project from a role outside readRoles", async () => {
    const { act, harness } = await setup({ readRoles: ["owner", "admin"] });
    harness.seed({ issues: [issue(ISSUE, PROJECT)] });
    expect(await act("files.locate", { issueRef: ISSUE }, MEMBER)).toEqual({ projectId: null, projectName: null, canRead: false });
  });
});

describe("files actions", () => {
  it("lists, creates, writes, reads, renames and deletes inside the project folder, auditing each change", async () => {
    const { act, harness } = await setup();
    expect(await act("files.list", { path: "" })).toEqual({ path: "", exists: true, entries: [] });
    await act("files.create", { dir: "", name: "docs", kind: "dir" });
    await act("files.create", { dir: "docs", name: "plan.md", kind: "file" });
    const saved = await act<{ mtimeMs: number; size: number }>("files.write", { path: "docs/plan.md", content: "# Plan\n", mustExist: true });
    expect(saved.size).toBe(7);
    expect(await readFile(path.join(root, "docs", "plan.md"), "utf8")).toBe("# Plan\n");
    expect(await act("files.read", { path: "docs/plan.md" })).toMatchObject({ encoding: "utf8", content: "# Plan\n", mtimeMs: saved.mtimeMs });
    expect(await act("files.stat", { path: "docs/plan.md" })).toMatchObject({ kind: "file", size: 7 });
    await act("files.rename", { path: "docs/plan.md", newPath: "docs/roadmap.md" });
    const listing = await act<{ entries: Array<{ name: string }> }>("files.list", { path: "docs" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["roadmap.md"]);
    await expect(act("files.delete", { path: "docs" })).rejects.toThrow("confirm");
    expect(await act("files.delete", { path: "docs", recursive: true })).toEqual({ ok: true, path: "docs", kind: "dir" });
    const operations = harness.activity.map((entry) => entry.metadata?.operation);
    expect(operations).toEqual(["created folder", "created file", "saved", "renamed", "deleted folder"]);
    for (const entry of harness.activity) {
      expect(entry.entityType).toBe("project");
      expect(entry.entityId).toBe(PROJECT);
      expect(entry.metadata).toMatchObject({ userId: "admin-1", workspaceId: `${PROJECT}:managed` });
      expect(JSON.stringify(entry)).not.toContain("# Plan"); // never content
    }
  });

  it("uploads base64 content within the limit and refuses a second copy unless overwrite is set", async () => {
    const { act } = await setup({ maxUploadMb: 1 });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await act("files.upload", { dir: "", name: "logo.png", contentBase64: bytes.toString("base64") });
    expect([...(await readFile(path.join(root, "logo.png")))]).toEqual([...bytes]);
    await expect(act("files.upload", { dir: "", name: "logo.png", contentBase64: bytes.toString("base64") })).rejects.toThrow("exists");
    await act("files.upload", { dir: "", name: "logo.png", contentBase64: Buffer.from([0, 1]).toString("base64"), overwrite: true });
    expect([...(await readFile(path.join(root, "logo.png")))]).toEqual([0, 1]);
    const tooBig = Buffer.alloc(1024 * 1024 + 1).toString("base64");
    await expect(act("files.upload", { dir: "", name: "big.bin", contentBase64: tooBig })).rejects.toThrow("limit");
    expect(await act("files.read", { path: "logo.png" })).toMatchObject({ binary: true, content: null });
    expect(await act("files.read", { path: "logo.png", encoding: "base64" })).toMatchObject({ encoding: "base64", content: Buffer.from([0, 1]).toString("base64") });
  });

  it("caps the editor read by maxEditableKb and a download by maxDownloadMb", async () => {
    const { act } = await setup({ maxEditableKb: 1, maxDownloadMb: 1 });
    await writeFile(path.join(root, "log.txt"), "x".repeat(2048));
    expect(await act("files.read", { path: "log.txt" })).toMatchObject({ tooLarge: true, content: null, size: 2048 });
    expect(await act("files.read", { path: "log.txt", encoding: "base64" })).toMatchObject({ encoding: "base64", tooLarge: false });
  });

  it("reports a save conflict when the file changed since it was read", async () => {
    const { act } = await setup();
    await writeFile(path.join(root, "shared.txt"), "v1");
    const seen = await act<{ mtimeMs: number }>("files.read", { path: "shared.txt" });
    const { utimes } = await import("node:fs/promises");
    await writeFile(path.join(root, "shared.txt"), "agent");
    await utimes(path.join(root, "shared.txt"), new Date(seen.mtimeMs + 5_000), new Date(seen.mtimeMs + 5_000));
    await expect(act("files.write", { path: "shared.txt", content: "mine", baseMtimeMs: seen.mtimeMs })).rejects.toThrow("conflict");
    await act("files.write", { path: "shared.txt", content: "mine", baseMtimeMs: null });
    expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe("mine");
  });

  it("selects a workspace by id and refuses an unknown one", async () => {
    const { act } = await setup({}, { secondWorkspace: true });
    await writeFile(path.join(secondRoot, "only-here.txt"), "!");
    const listing = await act<{ entries: Array<{ name: string }> }>("files.list", { path: "", workspaceId: "ws-2" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["only-here.txt"]);
    expect((await act<{ entries: unknown[] }>("files.list", { path: "" })).entries).toEqual([]);
    await expect(act("files.list", { path: "", workspaceId: "ws-9" })).rejects.toThrow("not_found");
  });
});

describe("files authorization", () => {
  it("lets a viewer read but not write, and audits nothing for a refused write", async () => {
    const { act, harness } = await setup();
    await writeFile(path.join(root, "a.txt"), "a");
    expect(await act("files.read", { path: "a.txt" }, VIEWER)).toMatchObject({ content: "a" });
    await expect(act("files.write", { path: "a.txt", content: "b" }, VIEWER)).rejects.toThrow("forbidden");
    await expect(act("files.create", { dir: "", name: "x", kind: "file" }, VIEWER)).rejects.toThrow("forbidden");
    await expect(act("files.delete", { path: "a.txt" }, VIEWER)).rejects.toThrow("forbidden");
    await expect(act("files.rename", { path: "a.txt", newPath: "b.txt" }, VIEWER)).rejects.toThrow("forbidden");
    await expect(act("files.upload", { dir: "", name: "u", contentBase64: "AA==" }, VIEWER)).rejects.toThrow("forbidden");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a");
    expect(harness.activity).toEqual([]);
  });

  it("honours configured readRoles and writeRoles", async () => {
    const { act } = await setup({ readRoles: ["owner", "admin", "member"], writeRoles: ["owner", "admin"] });
    await expect(act("files.list", { path: "" }, VIEWER)).rejects.toThrow("forbidden");
    expect(await act("files.list", { path: "" }, MEMBER)).toMatchObject({ exists: true });
    await expect(act("files.create", { dir: "", name: "x", kind: "dir" }, MEMBER)).rejects.toThrow("forbidden");
    await act("files.create", { dir: "", name: "x", kind: "dir" }, ADMIN);
  });

  it("refuses a member of another company, and a project that belongs to another company", async () => {
    const { act } = await setup();
    await expect(act("files.list", { path: "" }, STRANGER)).rejects.toThrow("forbidden");
    await expect(act("files.list", { path: "", projectId: OTHER_PROJECT })).rejects.toThrow("not_found");
    await expect(act("files.list", { path: "" }, STRANGER, OTHER_COMPANY)).rejects.toThrow("not_found");
  });

  it("refuses agents and unattributed callers on every action", async () => {
    const { act, harness } = await setup();
    for (const key of ["files.list", "files.stat", "files.read", "files.write", "files.create", "files.upload", "files.rename", "files.delete"]) {
      await expect(act(key, { path: "a", content: "x", dir: "", name: "n", contentBase64: "AA==", newPath: "b" }, { type: "agent" as const, agentId: "a1" } as never), key).rejects.toThrow("forbidden");
      await expect(harness.performAction(key, { projectId: PROJECT, path: "a" }, { companyId: COMPANY }), key).rejects.toThrow("forbidden");
    }
  });

  it("rejects a params.companyId that contradicts the host's company scope", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({ accessMembers: MEMBERS, projects: [project(PROJECT, COMPANY, "Smoke")], projectWorkspaces: [{ id: `${PROJECT}:managed`, projectId: PROJECT, name: "Smoke", path: root, repoUrl: null, repoRef: null, defaultRef: null, isPrimary: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
    const handlers = new Map<string, (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>>();
    const ctx = { ...harness.ctx, actions: { register: (key: string, handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>) => void handlers.set(key, handler) } };
    await createFilesPlugin({}).definition.setup(ctx);
    const context: PluginPerformActionContext = { actor: { type: "user", userId: "admin-1", agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY };
    await expect(handlers.get("files.list")!({ projectId: PROJECT, companyId: OTHER_COMPANY, path: "" }, context)).rejects.toThrow("invalid");
    await expect(handlers.get("files.list")!({ projectId: PROJECT, companyId: COMPANY, path: "" }, context)).resolves.toMatchObject({ exists: true });
  });
});

describe("project visibility", () => {
  const ISSUE_VISIBLE = "88888888-8888-4888-8888-888888888888";
  const ISSUE_HIDDEN = "99999999-9999-4999-8999-999999999999";
  const issue = (id: string, projectId: string) => ({ id, companyId: COMPANY, projectId, identifier: "SMK-1", title: "t", status: "todo", priority: "medium" }) as never;

  it("refuses files.list for a restricted person on a hidden project with forbidden, and serves a listed one", async () => {
    const { act } = await setup();
    await restrict({ [PROJECT]: ["member-1"], [HIDDEN_PROJECT]: ["viewer-1"] });
    await writeFile(path.join(root, "open.txt"), "o");
    await writeFile(path.join(hiddenRoot, "secret.txt"), "s");
    const listed = await act<{ entries: Array<{ name: string }> }>("files.list", { path: "" }, MEMBER);
    expect(listed.entries.map((entry) => entry.name)).toEqual(["open.txt"]);
    await expect(act("files.list", { path: "", projectId: HIDDEN_PROJECT }, MEMBER)).rejects.toThrow("forbidden: this project is outside what you can see");
    await expect(act("files.read", { path: "secret.txt", projectId: HIDDEN_PROJECT }, MEMBER)).rejects.toThrow("forbidden: this project is outside what you can see");
    await expect(act("files.stat", { path: "secret.txt", projectId: HIDDEN_PROJECT }, MEMBER)).rejects.toThrow("forbidden");
    // The other restricted person has the opposite project.
    await expect(act("files.list", { path: "" }, VIEWER)).rejects.toThrow("forbidden: this project is outside what you can see");
    expect(await act("files.list", { path: "", projectId: HIDDEN_PROJECT }, VIEWER)).toMatchObject({ exists: true });
  });

  it("refuses every mutation on a hidden project and leaves the folder untouched", async () => {
    const { act, harness } = await setup();
    await restrict({ [PROJECT]: ["member-1"] });
    await writeFile(path.join(hiddenRoot, "secret.txt"), "s");
    const hidden = { projectId: HIDDEN_PROJECT };
    await expect(act("files.write", { ...hidden, path: "secret.txt", content: "x" }, MEMBER)).rejects.toThrow("outside what you can see");
    await expect(act("files.create", { ...hidden, dir: "", name: "n", kind: "file" }, MEMBER)).rejects.toThrow("outside what you can see");
    await expect(act("files.upload", { ...hidden, dir: "", name: "u", contentBase64: "AA==" }, MEMBER)).rejects.toThrow("outside what you can see");
    await expect(act("files.rename", { ...hidden, path: "secret.txt", newPath: "b.txt" }, MEMBER)).rejects.toThrow("outside what you can see");
    await expect(act("files.delete", { ...hidden, path: "secret.txt" }, MEMBER)).rejects.toThrow("outside what you can see");
    expect(await readFile(path.join(hiddenRoot, "secret.txt"), "utf8")).toBe("s");
    expect(harness.activity).toEqual([]);
  });

  it("never restricts an owner or admin, and serves a person in a sees-all group", async () => {
    const { act } = await setup();
    await restrict({ [PROJECT]: ["member-1"] }, ["viewer-1"]);
    expect(await act("files.list", { path: "", projectId: HIDDEN_PROJECT }, ADMIN)).toMatchObject({ exists: true });
    expect(await act("files.list", { path: "", projectId: HIDDEN_PROJECT }, VIEWER)).toMatchObject({ exists: true });
  });

  it("refuses a restricted person, but not an admin, when the company policy cannot be read", async () => {
    const { act } = await setup();
    await restrict({ [PROJECT]: ["member-1"] });
    await rm(path.join(policyDir, `${COMPANY}.json`));
    await expect(act("files.list", { path: "" }, MEMBER)).rejects.toThrow("outside what you can see");
    expect(await act("files.list", { path: "" }, ADMIN)).toMatchObject({ exists: true });
  });

  it("picks up a policy change at the next call", async () => {
    const { act } = await setup();
    expect(await act("files.list", { path: "", projectId: HIDDEN_PROJECT }, MEMBER)).toMatchObject({ exists: true });
    await restrict({ [PROJECT]: ["member-1"] });
    await expect(act("files.list", { path: "", projectId: HIDDEN_PROJECT }, MEMBER)).rejects.toThrow("outside what you can see");
    await restrict({ [PROJECT]: ["member-1"], [HIDDEN_PROJECT]: ["member-1"] });
    expect(await act("files.list", { path: "", projectId: HIDDEN_PROJECT }, MEMBER)).toMatchObject({ exists: true });
  });

  it("files.workspaces answers canRead false for a hidden project, and no path", async () => {
    const { act } = await setup();
    await restrict({ [PROJECT]: ["member-1"] });
    expect(await act("files.workspaces", {}, MEMBER)).toMatchObject({ role: "member", canRead: true, workspaces: [{ path: root }] });
    const hidden = await act<{ canRead: boolean; workspaces: unknown[] }>("files.workspaces", { projectId: HIDDEN_PROJECT }, MEMBER);
    expect(hidden).toMatchObject({ role: "member", canRead: false, workspaces: [] });
    expect(JSON.stringify(hidden)).not.toContain(hiddenRoot);
    expect(await act("files.workspaces", { projectId: HIDDEN_PROJECT }, ADMIN)).toMatchObject({ canRead: true, workspaces: [{ path: hiddenRoot }] });
  });

  it("files.locate answers no project for a task in a hidden project", async () => {
    const { act, harness } = await setup();
    harness.seed({ issues: [issue(ISSUE_VISIBLE, PROJECT), issue(ISSUE_HIDDEN, HIDDEN_PROJECT)] });
    await restrict({ [PROJECT]: ["member-1"] });
    expect(await act("files.locate", { issueRef: ISSUE_VISIBLE }, MEMBER)).toEqual({ projectId: PROJECT, projectName: "Smoke", canRead: true });
    expect(await act("files.locate", { issueRef: ISSUE_HIDDEN }, MEMBER)).toEqual({ projectId: null, projectName: null, canRead: true });
    expect(await act("files.locate", { issueRef: ISSUE_HIDDEN }, ADMIN)).toEqual({ projectId: HIDDEN_PROJECT, projectName: "Vault", canRead: true });
  });
});

describe("resolveWorkspaces", () => {
  it("answers not_found for a project the host does not return, and skips path-less rows", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({
      projects: [project(PROJECT, COMPANY, "Smoke")],
      projectWorkspaces: [
        { id: "ws-1", projectId: PROJECT, name: "Primary", path: root, repoUrl: null, repoRef: null, defaultRef: null, isPrimary: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
        { id: "ws-2", projectId: PROJECT, name: "Remote", path: "", repoUrl: "https://example.com/x.git", repoRef: null, defaultRef: null, isPrimary: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      ],
    });
    await expect(resolveWorkspaces(harness.ctx.projects, OTHER_PROJECT, COMPANY)).rejects.toThrow("not_found");
    expect(await resolveWorkspaces(harness.ctx.projects, PROJECT, COMPANY)).toEqual([{ id: "ws-1", name: "Primary", path: root, isPrimary: true, source: "configured" }]);
  });
});

describe("lifecycle", () => {
  it("reports health only once setup has run, and the manifest declares the two project slots", async () => {
    const plugin = createFilesPlugin({});
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "degraded" });
    const harness = createTestHarness({ manifest, config: {} });
    await plugin.definition.setup(harness.ctx);
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok" });
    await plugin.definition.onShutdown?.();
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "degraded" });
    expect(manifest.ui?.slots?.map((slot) => [slot.type, slot.exportName, slot.entityTypes])).toEqual([
      ["detailTab", "ProjectFilesTab", ["project"]],
      ["projectSidebarItem", "ProjectSidebarItem", ["project"]],
      ["globalToolbarButton", "GlobalFilesButton", undefined],
    ]);
    expect(manifest.capabilities).toContain("ui.action.register");
    expect(manifest.capabilities).toContain("issues.read");
  });
});
