import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileCompanyPolicy, compileIndex, VISIBILITY_DIR, writePolicyFiles, type CompileGroup, type VisibilityMode } from "@kyoube/visibility";
import {
  SHADOW_ENV_KEYS, VISIBILITY_MARKER, VISIBILITY_MODULE_PATH, VISIBILITY_PATCHED, VISIBILITY_STALE_MS, visibilityChecks, visibilityDoctorChecks,
} from "../src/visibility/doctor.js";
import { readVisibilityModes, VISIBILITY_MODES_SQL } from "../src/visibility/modes-db.js";
import type { Check } from "../src/commands/doctor.js";

const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const okModule = async () => ({ decideBoard() {}, liveEventFilter() {}, filterSearchResults() {} });
const markers = (count: number) => Array.from({ length: count }, () => `/* ${VISIBILITY_MARKER} (docs/groups.md) */`).join("\n");
/** Every patched file with exactly its marker count, but for the counts given. */
const patched = (override: Record<string, number | null> = {}) => async (file: string) => {
  if (Object.hasOwn(override, file)) {
    const count = override[file];
    return count === null || count === undefined ? null : markers(count);
  }
  const entry = VISIBILITY_PATCHED.find((item) => item.path === file);
  return entry ? markers(entry.count) : null;
};

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "vis-doctor-"));

/** The index lists every company given; a need-to-know one gets its file, compiled from its groups. */
async function writePolicy(dir: string, companies: Array<{ companyId: string; mode: VisibilityMode; groups?: CompileGroup[] }>, writtenAt = minutesAgo(1)): Promise<void> {
  const files = companies.flatMap(({ companyId, mode, groups = [] }) => {
    const policy = compileCompanyPolicy({ companyId, mode, groups, writtenAt });
    return policy ? [policy] : [];
  });
  await writePolicyFiles({ dir, index: compileIndex(companies.map(({ companyId, mode }) => ({ companyId, mode })), writtenAt), companies: files });
}

function input(dir: string, overrides: Partial<Parameters<typeof visibilityChecks>[0]> = {}): Parameters<typeof visibilityChecks>[0] {
  return {
    env: {},
    dir,
    dbModes: new Map(),
    deploymentMode: "authenticated",
    members: async () => null,
    now: NOW,
    importModule: okModule,
    readText: patched(),
    ...overrides,
  };
}

const line = (checks: Check[], name: string) => checks.find((check) => check.name === name);

describe("visibility constants", () => {
  it("are the ones the image and the core use", () => {
    expect(VISIBILITY_MODULE_PATH).toBe("/opt/kyoube/visibility/decide.mjs");
    expect(VISIBILITY_MARKER).toBe("kyoube-visibility");
    expect(VISIBILITY_PATCHED).toEqual([
      { path: "/app/server/dist/services/authorization.js", count: 1 },
      { path: "/app/server/dist/realtime/live-events-ws.js", count: 1 },
      { path: "/app/server/dist/routes/issues.js", count: 2 },
    ]);
    expect(VISIBILITY_STALE_MS).toBe(15 * 60_000);
    expect(SHADOW_ENV_KEYS).toEqual(["PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW"]);
  });
});

describe("visibilityChecks", () => {
  it("is ok and says open everywhere when nothing is switched on", async () => {
    const dir = await tempDir();
    // No index at all: the feature was never turned on.
    expect(await visibilityChecks(input(dir, { dbModes: new Map([[C, "open"]]) }))).toEqual([{ name: "visibility", ok: true, detail: "open everywhere" }]);
    // An index that lists only open companies.
    await writePolicy(dir, [{ companyId: C, mode: "open" }, { companyId: D, mode: "open" }]);
    expect(await visibilityChecks(input(dir, { dbModes: new Map([[C, "open"], [D, "open"]]) }))).toEqual([{ name: "visibility", ok: true, detail: "open everywhere" }]);
  });

  it("fails when the module does not load, naming the path", async () => {
    const dir = await tempDir();
    const broken = await visibilityChecks(input(dir, { importModule: async () => { throw new Error("Cannot find module"); } }));
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ name: "visibility", ok: false });
    expect(broken[0]!.detail).toContain(`${VISIBILITY_MODULE_PATH} does not load (Cannot find module)`);
    expect(broken[0]!.detail).toContain("rebuild the image");

    const partial = await visibilityChecks(input(dir, { importModule: async () => ({ decideBoard() {} }) }));
    expect(partial[0]).toMatchObject({ name: "visibility", ok: false });
    expect(partial[0]!.detail).toContain(`${VISIBILITY_MODULE_PATH} has no liveEventFilter, filterSearchResults`);
  });

  it("fails when a patched file lacks its marker count", async () => {
    const dir = await tempDir();
    const [check] = await visibilityChecks(input(dir, { readText: patched({ "/app/server/dist/routes/issues.js": 1 }) }));
    expect(check).toMatchObject({ name: "visibility", ok: false });
    expect(check!.detail).toContain("/app/server/dist/routes/issues.js has 1 kyoube-visibility marker, expected 2");
    expect(check!.detail).not.toContain("authorization.js");

    // A missing file, and a patch applied twice, fail too.
    const [twice] = await visibilityChecks(input(dir, { readText: patched({ "/app/server/dist/services/authorization.js": null, "/app/server/dist/realtime/live-events-ws.js": 2 }) }));
    expect(twice).toMatchObject({ ok: false });
    expect(twice!.detail).toContain("/app/server/dist/services/authorization.js has 0 kyoube-visibility markers, expected 1");
    expect(twice!.detail).toContain("/app/server/dist/realtime/live-events-ws.js has 2 kyoube-visibility markers, expected 1");
  });

  it("fails when the index is unreadable", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "index.json"), "{");
    const [check] = await visibilityChecks(input(dir));
    expect(check).toMatchObject({ name: "visibility", ok: false });
    expect(check!.detail).toContain(`${dir}/index.json is unreadable`);
  });

  it("fails on a shadow-mode variable only when a company is need-to-know", async () => {
    const open = await tempDir();
    for (const env of [{ PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE: "shadow" }, { PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW: "1" }]) {
      expect(await visibilityChecks(input(open, { env }))).toEqual([{ name: "visibility", ok: true, detail: "open everywhere" }]);
    }

    const dir = await tempDir();
    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }]);
    const dbModes = new Map<string, VisibilityMode>([[C, "need_to_know"]]);
    const mode = line(await visibilityChecks(input(dir, { dbModes, env: { PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE: " Shadow " } })), "visibility");
    expect(mode).toMatchObject({ ok: false });
    expect(mode!.detail).toContain("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE=shadow");
    expect(mode!.detail).not.toContain("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW");
    const shadow = line(await visibilityChecks(input(dir, { dbModes, env: { PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW: "true" } })), "visibility");
    expect(shadow).toMatchObject({ ok: false });
    expect(shadow!.detail).toContain("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW");
    // Not shadow mode: another MODE value, an empty SHADOW.
    expect(line(await visibilityChecks(input(dir, { dbModes, env: { PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE: "enforce", PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW: " " } })), "visibility"))
      .toEqual({ name: "visibility", ok: true, detail: "need-to-know in 1 company" });
  });

  it("fails when a need-to-know company runs without sign-in", async () => {
    const open = await tempDir();
    expect(await visibilityChecks(input(open, { deploymentMode: "local" }))).toEqual([{ name: "visibility", ok: true, detail: "open everywhere" }]);

    const dir = await tempDir();
    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }]);
    const dbModes = new Map<string, VisibilityMode>([[C, "need_to_know"]]);
    const local = line(await visibilityChecks(input(dir, { dbModes, deploymentMode: "local" })), "visibility");
    expect(local).toMatchObject({ ok: false });
    expect(local!.detail).toContain("deployment mode is local");
    expect(local!.detail).toContain("PAPERCLIP_DEPLOYMENT_MODE=authenticated");
    // A core that did not answer gives no mode, which is not authenticated either.
    expect(line(await visibilityChecks(input(dir, { dbModes, deploymentMode: null })), "visibility")).toMatchObject({ ok: false });
  });

  it("fails when the database and the index disagree about a company", async () => {
    const dir = await tempDir();
    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }, { companyId: D, mode: "open" }]);
    const checks = await visibilityChecks(input(dir, { dbModes: new Map([[C, "open"], [D, "need_to_know"]]) }));
    expect(checks.map((check) => check.name)).toEqual(["visibility", `visibility ${C}`, `visibility ${D}`]);
    expect(line(checks, "visibility")).toEqual({ name: "visibility", ok: true, detail: "need-to-know in 2 companies" });
    // The index restricts a company the database calls open.
    expect(line(checks, `visibility ${C}`)).toMatchObject({ ok: false });
    expect(line(checks, `visibility ${C}`)!.detail).toContain(`${dir}/index.json says need-to-know but the kyoube database says open`);
    // The database restricts a company the index calls open: the core shows everything.
    expect(line(checks, `visibility ${D}`)).toMatchObject({ ok: false });
    expect(line(checks, `visibility ${D}`)!.detail).toContain(`the kyoube database says need-to-know but ${dir}/index.json says open`);

    // No index at all while the database says need-to-know.
    const empty = await tempDir();
    const missing = line(await visibilityChecks(input(empty, { dbModes: new Map([[C, "need_to_know"]]) })), `visibility ${C}`);
    expect(missing).toMatchObject({ ok: false });
    expect(missing!.detail).toContain(`the kyoube database says need-to-know but ${empty}/index.json does not exist`);
  });

  it("fails when a need-to-know company's file is missing", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "index.json"), JSON.stringify(compileIndex([{ companyId: C, mode: "need_to_know" }], minutesAgo(1))));
    const dbModes = new Map<string, VisibilityMode>([[C, "need_to_know"]]);
    const missing = line(await visibilityChecks(input(dir, { dbModes })), `visibility ${C}`);
    expect(missing).toMatchObject({ ok: false });
    expect(missing!.detail).toContain(`${dir}/${C}.json is missing`);

    // A file that is there but is not this company's policy fails the same way.
    await writeFile(path.join(dir, `${C}.json`), "{\"version\":1");
    const unparsable = line(await visibilityChecks(input(dir, { dbModes })), `visibility ${C}`);
    expect(unparsable).toMatchObject({ ok: false });
    expect(unparsable!.detail).toContain(`${dir}/${C}.json is not a valid policy for this company`);
  });

  it("warns when a company file is older than fifteen minutes", async () => {
    const dir = await tempDir();
    const dbModes = new Map<string, VisibilityMode>([[C, "need_to_know"]]);
    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }], minutesAgo(16));
    const stale = line(await visibilityChecks(input(dir, { dbModes })), `visibility ${C}`);
    expect(stale).toMatchObject({ ok: true, warn: true });
    expect(stale!.detail).toContain(`written ${minutesAgo(16)}, more than 15 minutes ago`);

    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }], minutesAgo(14));
    const fresh = line(await visibilityChecks(input(dir, { dbModes })), `visibility ${C}`);
    expect(fresh).toEqual({ name: `visibility ${C}`, ok: true, detail: "0 sees all, 0 projects, restricted count unavailable" });
  });

  it("reports sees-all, project and restricted counts", async () => {
    const dir = await tempDir();
    await writePolicy(dir, [{
      companyId: C,
      mode: "need_to_know",
      groups: [{ seesAll: true, members: ["ann"], projects: [] }, { seesAll: false, members: ["bob"], projects: ["p1", "p2"] }],
    }]);
    const asked: string[] = [];
    const members = async (companyId: string) => {
      asked.push(companyId);
      // ann sees all; the owner and the admin always do; bob, cat and the viewer dan are held back.
      return [
        { userId: "ann", role: "member" },
        { userId: "olly", role: "owner" },
        { userId: "ada", role: "admin" },
        { userId: "bob", role: "member" },
        { userId: "cat", role: null },
        { userId: "dan", role: "viewer" },
      ];
    };
    const checks = await visibilityChecks(input(dir, { dbModes: new Map([[C, "need_to_know"]]), members }));
    expect(checks).toEqual([
      { name: "visibility", ok: true, detail: "need-to-know in 1 company" },
      { name: `visibility ${C}`, ok: true, detail: "1 sees all, 2 projects, 3 restricted" },
    ]);
    expect(asked).toEqual([C]);

    expect(line(await visibilityChecks(input(dir, { dbModes: new Map([[C, "need_to_know"]]) })), `visibility ${C}`))
      .toEqual({ name: `visibility ${C}`, ok: true, detail: "1 sees all, 2 projects, restricted count unavailable" });
  });

  it("warns, not fails, when the kyoube database cannot be read", async () => {
    const dir = await tempDir();
    await writePolicy(dir, [{ companyId: C, mode: "need_to_know" }, { companyId: D, mode: "open" }]);
    const checks = await visibilityChecks(input(dir, { dbModes: null }));
    expect(checks).toEqual([
      { name: "visibility", ok: true, warn: true, detail: "need-to-know in 1 company — database unreadable; index trusted" },
      { name: `visibility ${C}`, ok: true, detail: "0 sees all, 0 projects, restricted count unavailable" },
    ]);
  });

  it("warns when the home is not where the core reads the policy", async () => {
    const dir = await tempDir();
    expect(await visibilityChecks(input(dir, { home: "/kyoubeai" }))).toEqual([{ name: "visibility", ok: true, detail: "open everywhere" }]);
    expect(await visibilityChecks(input(dir, { home: "/data" }))).toEqual([
      { name: "visibility", ok: true, warn: true, detail: "open everywhere — home is /data; the core reads /kyoubeai/kyoube/visibility" },
    ]);
  });
});

describe("visibilityDoctorChecks", () => {
  const config = { home: "/kyoubeai", dataDatabaseUrl: "postgres://kyoube/kyoube", paperclipApiUrl: "http://app:3100" };
  const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

  /** A policy directory at VISIBILITY_DIR, in memory: the doctor reads where the core reads. */
  function files(contents: Record<string, string>) {
    const read: string[] = [];
    const readFile = async (file: string) => {
      read.push(file);
      if (!Object.hasOwn(contents, file)) throw enoent();
      return contents[file]!;
    };
    return { read, readFile };
  }

  function policyFiles(writtenAt: string): Record<string, string> {
    const policy = compileCompanyPolicy({ companyId: C, mode: "need_to_know", groups: [{ seesAll: false, members: ["bob"], projects: ["p1"] }], writtenAt })!;
    return {
      [`${VISIBILITY_DIR}/index.json`]: JSON.stringify(compileIndex([{ companyId: C, mode: "need_to_know" }], writtenAt)),
      [`${VISIBILITY_DIR}/${C}.json`]: JSON.stringify(policy),
    };
  }

  it("reads the modes from the kyoube database and the policy from the directory the core reads", async () => {
    const urls: string[] = [];
    const fs = files({});
    const checks = await visibilityDoctorChecks({}, { ...config, home: "/data" }, "authenticated", null, {
      readModes: async (url) => { urls.push(url); return new Map([[C, "need_to_know"]]); },
      importModule: okModule,
      readText: patched(),
      readFile: fs.readFile,
    });
    expect(urls).toEqual(["postgres://kyoube/kyoube"]);
    expect(fs.read).toContain(`${VISIBILITY_DIR}/index.json`);
    expect(fs.read.every((file) => file.startsWith(`${VISIBILITY_DIR}/`))).toBe(true);
    expect(line(checks, "visibility")).toEqual({ name: "visibility", ok: true, warn: true, detail: "need-to-know in 1 company — home is /data; the core reads /kyoubeai/kyoube/visibility" });
    expect(line(checks, `visibility ${C}`)).toMatchObject({ ok: false, detail: expect.stringContaining(`${VISIBILITY_DIR}/index.json does not exist`) });
  });

  it("warns, and trusts the index, when the kyoube database cannot be read", async () => {
    const fs = files(policyFiles(new Date().toISOString()));
    const checks = await visibilityDoctorChecks({}, config, "authenticated", null, {
      readModes: async () => { throw new Error("connect ECONNREFUSED"); },
      importModule: okModule,
      readText: patched(),
      readFile: fs.readFile,
    });
    expect(checks).toEqual([
      { name: "visibility", ok: true, warn: true, detail: "need-to-know in 1 company — database unreadable; index trusted" },
      { name: `visibility ${C}`, ok: true, detail: "0 sees all, 1 project, restricted count unavailable" },
    ]);
  });

  it("asks the core for a company's members with the board key, and only with one", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers ?? {}).get("authorization") });
      return new Response(JSON.stringify({ members: [
        { principalType: "user", principalId: "bob", status: "active", membershipRole: "member" },
        { principalType: "user", principalId: "olly", status: "active", membershipRole: "owner" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const deps = { readModes: async () => new Map<string, VisibilityMode>([[C, "need_to_know"]]), importModule: okModule, readText: patched(), fetchImpl };

    const keyed = await visibilityDoctorChecks({}, config, "authenticated", "board-key", { ...deps, readFile: files(policyFiles(new Date().toISOString())).readFile });
    expect(line(keyed, `visibility ${C}`)).toEqual({ name: `visibility ${C}`, ok: true, detail: "0 sees all, 1 project, 1 restricted" });
    expect(requests).toEqual([{ url: `http://app:3100/api/companies/${C}/members`, authorization: "Bearer board-key" }]);

    const keyless = await visibilityDoctorChecks({}, config, "authenticated", null, { ...deps, readFile: files(policyFiles(new Date().toISOString())).readFile });
    expect(line(keyless, `visibility ${C}`)?.detail).toBe("0 sees all, 1 project, restricted count unavailable");
    expect(requests).toHaveLength(1);

    const refused: typeof fetch = async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    const failed = await visibilityDoctorChecks({}, config, "authenticated", "board-key", { ...deps, fetchImpl: refused, readFile: files(policyFiles(new Date().toISOString())).readFile });
    expect(line(failed, `visibility ${C}`)?.detail).toBe("0 sees all, 1 project, restricted count unavailable");
  });

  it("passes the environment and the deployment mode through", async () => {
    const deps = { readModes: async () => new Map<string, VisibilityMode>([[C, "need_to_know"]]), importModule: okModule, readText: patched() };
    const shadow = await visibilityDoctorChecks({ PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW: "1" }, config, "authenticated", null, { ...deps, readFile: files(policyFiles(new Date().toISOString())).readFile });
    expect(line(shadow, "visibility")).toMatchObject({ ok: false, detail: expect.stringContaining("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW") });
    const local = await visibilityDoctorChecks({}, config, "local_trusted", null, { ...deps, readFile: files(policyFiles(new Date().toISOString())).readFile });
    expect(line(local, "visibility")).toMatchObject({ ok: false, detail: expect.stringContaining("deployment mode is local_trusted") });
  });
});

describe("readVisibilityModes", () => {
  it("reads every company's mode from kyoube_meta, open without a settings row", () => {
    expect(VISIBILITY_MODES_SQL).toBe("SELECT c.company_id, coalesce(s.visibility_mode, 'open') AS mode FROM kyoube_meta.companies c LEFT JOIN kyoube_meta.company_settings s USING (company_id)");
  });

  function fakePool(result: Array<{ company_id: string; mode: string }> | Error) {
    const calls = { urls: [] as string[], sql: [] as string[], ended: 0 };
    const open = (url: string) => {
      calls.urls.push(url);
      return {
        async query(sql: string) {
          calls.sql.push(sql);
          if (result instanceof Error) throw result;
          return { rows: result };
        },
        async end() { calls.ended += 1; },
      };
    };
    return { calls, open };
  }

  it("maps each company to its mode through one pool, closed after", async () => {
    const { calls, open } = fakePool([{ company_id: C, mode: "need_to_know" }, { company_id: D, mode: "open" }]);
    expect(await readVisibilityModes("postgres://kyoube/kyoube", open)).toEqual(new Map([[C, "need_to_know"], [D, "open"]]));
    expect(calls).toEqual({ urls: ["postgres://kyoube/kyoube"], sql: [VISIBILITY_MODES_SQL], ended: 1 });
  });

  it("throws on a failed query or an unknown mode, and still closes the pool", async () => {
    const failed = fakePool(new Error("relation does not exist"));
    await expect(readVisibilityModes("postgres://kyoube/kyoube", failed.open)).rejects.toThrow("relation does not exist");
    expect(failed.calls.ended).toBe(1);
    const odd = fakePool([{ company_id: C, mode: "secret" }]);
    await expect(readVisibilityModes("postgres://kyoube/kyoube", odd.open)).rejects.toThrow(/unknown visibility mode/);
    expect(odd.calls.ended).toBe(1);
  });
});
