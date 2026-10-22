import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { GroupService, type GroupServiceDeps } from "../../src/groups/service.js";
import { GroupStore } from "../../src/groups/store.js";
import { VisibilityWriter } from "../../src/groups/visibility-writer.js";
import { createTestDatabase } from "./setup.js";

const C = "66666666-6666-4666-8666-666666666666";
const ROLES: Record<string, string> = { owner: "owner", op: "operator", op2: "operator", vw: "viewer" };
const user = (id: string) => ({ kind: "user" as const, id, runId: null });
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let unlocked = true;
let deps: GroupServiceDeps;
let groups: GroupService;
const changed: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/group-visibility.spec.ts", "src/db/migrate.ts")));
  deps = {
    pool: db.pool,
    resolveUserRole: async (_c, id) => ROLES[id] ?? null,
    licence: { unlocked: async () => unlocked },
    listProjectIds: async () => new Set(["p1", "p2"]),
    listMembers: async () => [{ userId: "owner", role: "owner" }, { userId: "op", role: "operator" }, { userId: "op2", role: "operator" }, { userId: "vw", role: "viewer" }],
  };
  groups = new GroupService({ ...deps, afterVisibilityChange: async (companyId) => { changed.push(companyId); } });
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });

describe("group visibility", () => {
  it("applies 0009: mode defaults to open, groups carry sees_all and projects", async () => {
    // Open, no groups: everyone but owners and admins would be restricted on switching, in listMembers order.
    expect((await groups.list(C, user("owner"))).visibility).toEqual({
      mode: "open", seesAll: [], restricted: [{ userId: "op", role: "operator" }, { userId: "op2", role: "operator" }, { userId: "vw", role: "viewer" }],
    });
    const g = await groups.save(C, user("owner"), { name: "Team", members: ["op"], agents: [], apps: [], projects: ["p1"], seesAll: false });
    expect(g).toMatchObject({ projects: ["p1"], seesAll: false });
    expect(changed).toEqual([C]); // afterVisibilityChange ran once
  });

  it("refuses projects that are not the company's", async () => {
    await expect(groups.save(C, user("owner"), { name: "Bad", members: [], agents: [], apps: [], projects: ["p9"] })).rejects.toThrow("projects must be this company's projects");
  });

  it("switching to need-to-know needs the licence, lists who becomes restricted, and audits ids only", async () => {
    unlocked = false;
    await expect(groups.setVisibilityMode(C, user("owner"), "need_to_know")).rejects.toThrow("needs a KyoubeAI licence");
    unlocked = true;
    await expect(groups.setVisibilityMode(C, user("op"), "need_to_know")).rejects.toThrow("forbidden");
    await expect(groups.setVisibilityMode(C, user("owner"), "sometimes")).rejects.toThrow("mode must be open or need_to_know");
    await groups.save(C, user("owner"), { name: "Leads", members: ["op2"], agents: [], apps: [], projects: [], seesAll: true });
    const summary = await groups.setVisibilityMode(C, user("owner"), "need_to_know");
    expect(summary).toEqual({ mode: "need_to_know", seesAll: ["op2"], restricted: [{ userId: "op", role: "operator" }, { userId: "vw", role: "viewer" }] });
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'visibility_mode'", [C]);
    expect(audit.rows[0].details).toEqual({ mode: "need_to_know", restricted: ["op", "vw"] });
  });

  it("switching back to open never needs the licence", async () => {
    unlocked = false;
    expect((await groups.setVisibilityMode(C, user("owner"), "open")).mode).toBe("open");
    unlocked = true;
  });

  it("visibilityInput and allModes feed the writer", async () => {
    await groups.setVisibilityMode(C, user("owner"), "need_to_know");
    const store = new GroupStore(db.pool);
    expect(await store.visibilityInput(C)).toEqual({ mode: "need_to_know", groups: [{ seesAll: false, members: ["op"], projects: ["p1"] }, { seesAll: true, members: ["op2"], projects: [] }] });
    expect(await store.allModes()).toEqual([{ companyId: C, mode: "need_to_know" }]);
  });

  it("a group change rewrites the policy files at once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    const writer = new VisibilityWriter({ store: new GroupStore(db.pool), dir, log: () => {} });
    const service = new GroupService({ ...deps, afterVisibilityChange: () => writer.write().then(() => undefined) });
    await service.save(C, user("owner"), { name: "Ops", members: ["vw"], agents: [], apps: [], projects: ["p2"], seesAll: false });
    const policy = JSON.parse(await readFile(path.join(dir, `${C}.json`), "utf8"));
    expect(policy.projects.p2).toEqual(["vw"]);
    await service.setVisibilityMode(C, user("owner"), "open");
    expect((await readdir(dir)).sort()).toEqual(["index.json"]);
  });
});
