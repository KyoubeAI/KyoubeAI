import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { API_ROUTES, PLUGIN_ID, PLUGIN_VERSION } from "../src/manifest.js";
import { createAgentRulesPlugin, FORBIDDEN_MESSAGE, groupsPortFromContext, parseRecord, portFromContext } from "../src/plugin.js";
import { EMPTY_RECORD, type GuardPort } from "../src/guard.js";
import { EMPTY_GROUPS_RECORD, parseGroupsRecord, type GroupsPort } from "../src/groups.js";
import pkg from "../package.json" with { type: "json" };
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rulesTokenMatches } from "../src/rules-token.js";

/** The kyoube CLI's rules token (ruling R18), in a temporary file the tests point the plugin at. */
const TOKEN = "ab".repeat(32);
const TOKEN_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-rules-token-"));
const TOKEN_PATH = path.join(TOKEN_DIR, "rules-token");
writeFileSync(TOKEN_PATH, `${TOKEN}\n`, { mode: 0o600 });
const MISSING_TOKEN_PATH = path.join(TOKEN_DIR, "absent");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const PATHS: Record<string, string> = { "guard.reconcile": "/reconcile", "guard.revert": "/revert", "groups.apply": "/groups/apply" };

function request(routeKey: string, actorType: "user" | "agent" = "user", companyId = COMPANY, body: Record<string, unknown> = {}) {
  return {
    routeKey,
    method: "POST",
    path: PATHS[routeKey] ?? "/other",
    params: {},
    query: {},
    body: { companyId, ...body },
    actor: { actorType, actorId: actorType === "user" ? "user-1" : "agent-1" },
    companyId,
    headers: {},
  };
}

function quietPort(overrides: Partial<GuardPort> = {}): GuardPort {
  return {
    listAgents: async () => [],
    getPolicy: async () => null,
    setPolicy: async () => {},
    listGrants: async () => [],
    setGrants: async () => {},
    previewAssign: async () => ({ allowed: true, reason: "x" }),
    readRecord: async () => ({ ...EMPTY_RECORD }),
    writeRecord: async () => {},
    ...overrides,
  };
}

function quietGroupsPort(overrides: Partial<GroupsPort> = {}): GroupsPort {
  return {
    listAgents: async () => [],
    listMembers: async () => [],
    getPolicy: async () => null,
    setPolicy: async () => {},
    listUserGrants: async () => [],
    setUserGrants: async () => {},
    readGroupsRecord: async () => structuredClone(EMPTY_GROUPS_RECORD),
    writeGroupsRecord: async () => {},
    ...overrides,
  };
}

/** A core members-list row for the harness. */
function memberRow(id: string, principalId: string, membershipRole: string | null, status = "active", companyId = COMPANY, principalType: "user" | "agent" = "user") {
  return { id, companyId, principalType, principalId, status, membershipRole, grants: [], createdAt: new Date(), updatedAt: new Date() } as never;
}

/** The caller, "user-1", is an owner of both test companies unless the test says otherwise. */
async function started(port: GuardPort, groups: GroupsPort = quietGroupsPort(), members = [memberRow("m-own", "user-1", "owner"), memberRow("m-own2", "user-1", "owner", "active", OTHER)], rulesTokenPath = TOKEN_PATH) {
  const harness = createTestHarness({ manifest });
  harness.seed({ accessMembers: members });
  const plugin = createAgentRulesPlugin({ port: () => port, groupsPort: () => groups, rulesTokenPath });
  await plugin.definition.setup(harness.ctx);
  return plugin;
}

/** A promise the test settles by hand, to hold a port call open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Lets every already-queued continuation run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("kyoube.agent-rules manifest", () => {
  it("declares the three board-only routes the CLI calls, resolved from the body's companyId", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(pkg.version);
    expect(PLUGIN_VERSION).toBe("0.3.1");
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(API_ROUTES.map((route) => [route.routeKey, route.method, route.path, route.auth])).toEqual([
      ["guard.reconcile", "POST", "/reconcile", "board"],
      ["guard.revert", "POST", "/revert", "board"],
      ["groups.apply", "POST", "/groups/apply", "board"],
    ]);
    expect(manifest.capabilities).toContain("access.members.read");
    expect(manifest.capabilities).not.toContain("access.members.write");
    expect(API_ROUTES.every((route) => route.companyResolution?.from === "body" && route.companyResolution.key === "companyId")).toBe(true);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js" });
  });
});

describe("kyoube.agent-rules routes", () => {
  it("answers 503 before setup", async () => {
    const plugin = createAgentRulesPlugin({ port: () => quietPort() });
    expect(await plugin.definition.onApiRequest!(request("guard.reconcile"))).toMatchObject({ status: 503 });
  });

  it("refuses an agent caller", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("guard.reconcile", "agent"))).toMatchObject({ status: 403 });
  });

  it("reconciles the body's company and returns the report", async () => {
    const plugin = await started(quietPort());
    const response = await plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ managers: [], updated: [], selfTest: { status: "not_applicable" } });
  });

  it("reverts the body's company", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("guard.revert"))).toEqual({ status: 200, body: { reverted: [], failures: [] } });
  });

  it("answers 500 with the reason when the host refuses", async () => {
    const plugin = await started(quietPort({ listAgents: async () => { throw new Error("boom"); } }));
    const response = await plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(response).toMatchObject({ status: 500, body: { error: "guard.reconcile failed: boom" } });
  });

  it("answers 404 for a route key it does not own", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("other"))).toMatchObject({ status: 404 });
  });
});

describe("kyoube.agent-rules route serialization", () => {
  it("runs a revert for a company only after that company's reconcile has finished", async () => {
    const hold = gate();
    const calls: string[] = [];
    let held = false;
    const plugin = await started(quietPort({
      listAgents: async () => {
        calls.push("listAgents");
        // Only the first call (the reconcile's) is held open.
        if (!held) { held = true; await hold.opened; }
        return [];
      },
      readRecord: async () => {
        calls.push("readRecord");
        return { ...EMPTY_RECORD };
      },
    }));

    const reconcile = plugin.definition.onApiRequest!(request("guard.reconcile"));
    const revert = plugin.definition.onApiRequest!(request("guard.revert"));
    await settle();
    // The reconcile is held inside its first port call; the revert has made none.
    expect(calls).toEqual(["listAgents"]);

    hold.open();
    expect(await reconcile).toMatchObject({ status: 200 });
    expect(await revert).toEqual({ status: 200, body: { reverted: [], failures: [] } });
    // Reconcile is listAgents then readRecord; revert is readRecord then listAgents.
    expect(calls).toEqual(["listAgents", "readRecord", "readRecord", "listAgents"]);
  });

  it("does not serialize two different companies against each other", async () => {
    const hold = gate();
    const seen: string[] = [];
    const plugin = await started(quietPort({
      listAgents: async (companyId) => {
        seen.push(companyId);
        if (companyId === COMPANY) await hold.opened;
        return [];
      },
    }));

    const slow = plugin.definition.onApiRequest!(request("guard.reconcile", "user", COMPANY));
    const other = plugin.definition.onApiRequest!(request("guard.reconcile", "user", OTHER));
    // The other company's reconcile finishes while the first is still held.
    expect(await other).toMatchObject({ status: 200 });
    expect(seen).toEqual([COMPANY, OTHER]);

    hold.open();
    expect(await slow).toMatchObject({ status: 200 });
  });

  it("keeps serving a company after one of its calls fails", async () => {
    let fail = true;
    const plugin = await started(quietPort({
      listAgents: async () => {
        if (fail) { fail = false; throw new Error("boom"); }
        return [];
      },
    }));

    const failing = plugin.definition.onApiRequest!(request("guard.reconcile"));
    const next = plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(await failing).toMatchObject({ status: 500, body: { error: "guard.reconcile failed: boom" } });
    expect(await next).toMatchObject({ status: 200 });
  });
});

describe("portFromContext", () => {
  it("reaches the host only through the capabilities the manifest declares", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [
        { id: "a1", companyId: COMPANY, name: "Dev", status: "idle", reportsTo: null } as never,
        { id: "a2", companyId: COMPANY, name: "Coach", status: "idle", reportsTo: null, metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } } } as never,
      ],
      principalGrants: [{ id: "g1", companyId: COMPANY, principalType: "agent", principalId: "a1", permissionKey: "tasks:assign", scope: null, grantedByUserId: null, createdAt: new Date(), updatedAt: new Date() } as never],
    });
    const port = portFromContext(harness.ctx);
    expect(await port.listAgents(COMPANY)).toEqual([
      { id: "a1", name: "Dev", status: "idle", reportsTo: null, builtIn: false },
      { id: "a2", name: "Coach", status: "idle", reportsTo: null, builtIn: true },
    ]);
    expect(await port.listGrants(COMPANY, "a1")).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
    await port.setGrants(COMPANY, "a1", []);
    expect(await port.listGrants(COMPANY, "a1")).toEqual([]);
    await port.setPolicy(COMPANY, "a1", { assignmentPolicy: { mode: "protected" } });
    await port.writeRecord(COMPANY, { protected: ["a1"], scoped: [], broadRemoved: ["a1"], changeGranted: { a1: ["agents:configure"] } });
    expect(await port.readRecord(COMPANY)).toEqual({ protected: ["a1"], scoped: [], broadRemoved: ["a1"], changeGranted: { a1: ["agents:configure"] } });
    expect(await port.previewAssign(COMPANY, "a1", "a1")).toMatchObject({ allowed: true });
  });
});

describe("parseRecord", () => {
  it("tolerates a missing or hand-edited record", () => {
    expect(parseRecord(null)).toEqual(EMPTY_RECORD);
    expect(parseRecord({ protected: ["a", 3], scoped: "x" })).toEqual({ protected: ["a"], scoped: [], broadRemoved: [], changeGranted: {} });
    expect(parseRecord({ changeGranted: { a: ["skills:create", 4], b: "x", c: [] } })).toEqual({ ...EMPTY_RECORD, changeGranted: { a: ["skills:create"], c: [] } });
  });
});

describe("kyoube.agent-rules groups routes", () => {
  const PROTECTED = { assignmentPolicy: { mode: "protected" } };

  it("answers 503 before setup", async () => {
    const plugin = createAgentRulesPlugin({ port: () => quietPort(), groupsPort: () => quietGroupsPort() });
    expect(await plugin.definition.onApiRequest!(request("groups.apply", "user", COMPANY, { agents: [] }))).toMatchObject({ status: 503 });
  });

  it("refuses an agent caller", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("groups.apply", "agent", COMPANY, { agents: [] }))).toMatchObject({ status: 403 });
  });

  it("refuses a body without a valid agent list", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("groups.apply"))).toMatchObject({ status: 400, body: { code: "invalid" } });
    expect(await plugin.definition.onApiRequest!(request("groups.apply", "user", COMPANY, { agents: [{ agentId: 1 }] }))).toMatchObject({ status: 400 });
  });

  it("applies the body's agent access and returns the report", async () => {
    const policies: string[] = [];
    const grants: Array<[string, unknown]> = [];
    const plugin = await started(quietPort(), quietGroupsPort({
      listAgents: async () => [{ id: "a1", name: "A1", status: "idle", reportsTo: null }, { id: "a2", name: "A2", status: "idle", reportsTo: null }],
      listMembers: async () => [{ userId: "u1", role: "operator", status: "active" }],
      listUserGrants: async () => [{ permissionKey: "tasks:assign", scope: null }],
      setPolicy: async (_c, id) => { policies.push(id); },
      setUserGrants: async (_c, id, list) => { grants.push([id, list]); },
    }));
    const response = await plugin.definition.onApiRequest!(request("groups.apply", "user", COMPANY, { agents: [{ agentId: "a1", allowedUserIds: [] }] }));
    expect(response).toEqual({ status: 200, body: { protected: ["a1"], unprotected: [], people: ["u1"], skipped: [], failures: [] } });
    expect(policies).toEqual(["a1"]);
    expect(grants).toEqual([["u1", [{ permissionKey: "tasks:assign", scope: { agentIds: ["a2"] } }]]]);
  });

  it("answers 500 with the reason when the host refuses", async () => {
    const plugin = await started(quietPort(), quietGroupsPort({ listAgents: async () => { throw new Error("boom"); } }));
    const response = await plugin.definition.onApiRequest!(request("groups.apply", "user", COMPANY, { agents: [{ agentId: "a1", allowedUserIds: [] }] }));
    expect(response).toMatchObject({ status: 500, body: { error: "groups.apply failed: boom" } });
  });

  it("keeps the guard from unprotecting an agent a group still needs, on reconcile and revert", async () => {
    const writes: string[] = [];
    const guard = quietPort({
      // "boss" was a manager the guard protected; it no longer manages anyone.
      listAgents: async () => [{ id: "boss", name: "BOSS", status: "idle", reportsTo: null }],
      readRecord: async () => ({ ...EMPTY_RECORD, protected: ["boss"] }),
      getPolicy: async () => structuredClone(PROTECTED),
      setPolicy: async (_c, id) => { writes.push(id); },
    });
    const plugin = await started(guard, quietGroupsPort({ readGroupsRecord: async () => ({ ...structuredClone(EMPTY_GROUPS_RECORD), required: ["boss"] }) }));
    expect(await plugin.definition.onApiRequest!(request("guard.reconcile"))).toMatchObject({ status: 200 });
    expect(await plugin.definition.onApiRequest!(request("guard.revert"))).toMatchObject({ status: 200, body: { reverted: ["boss"] } });
    expect(writes).toEqual([]);

    // Without a group needing it, the same reconcile unprotects it.
    const plain = await started(guard);
    await plain.definition.onApiRequest!(request("guard.reconcile"));
    expect(writes).toEqual(["boss"]);
  });
});

// Rulings R13 and R18: "board" admits every signed-in person; these routes need the kyoube CLI's rules
// token or a company owner or admin.
describe("kyoube.agent-rules routes: rules token, or owner or admin", () => {
  const FORBIDDEN = { status: 403, body: { error: FORBIDDEN_MESSAGE, code: "forbidden" } };
  const BODIES: Record<string, Record<string, unknown>> = { "guard.reconcile": {}, "guard.revert": {}, "groups.apply": { agents: [] } };

  /** Ports that record every host call, so a refused request can be shown to have done nothing. */
  function recording() {
    const calls: string[] = [];
    const note = (name: string) => async () => { calls.push(name); return [] as never; };
    const guard = quietPort({ listAgents: note("listAgents"), readRecord: async () => { calls.push("readRecord"); return { ...EMPTY_RECORD }; }, setPolicy: note("setPolicy"), setGrants: note("setGrants"), writeRecord: note("writeRecord") });
    const groups = quietGroupsPort({
      listAgents: note("groups.listAgents"), listMembers: note("groups.listMembers"), setPolicy: note("groups.setPolicy"), setUserGrants: note("groups.setUserGrants"),
      readGroupsRecord: async () => { calls.push("readGroupsRecord"); return { ...structuredClone(EMPTY_GROUPS_RECORD), protected: ["a1"], required: ["a1"] }; },
      writeGroupsRecord: note("writeGroupsRecord"),
    });
    return { calls, guard, groups };
  }

  for (const routeKey of Object.keys(BODIES)) {
    for (const role of ["operator", "viewer"]) {
      it(`refuses an ${role} on ${routeKey}, touching nothing`, async () => {
        const { calls, guard, groups } = recording();
        const plugin = await started(guard, groups, [memberRow("m1", "user-1", role)]);
        expect(await plugin.definition.onApiRequest!(request(routeKey, "user", COMPANY, BODIES[routeKey]))).toEqual(FORBIDDEN);
        expect(calls).toEqual([]);
      });
    }
    it(`refuses ${routeKey} to an owner of another company, a suspended admin and a non-member`, async () => {
      const { calls, guard, groups } = recording();
      for (const members of [[memberRow("m1", "user-1", "owner", "active", OTHER)], [memberRow("m1", "user-1", "admin", "suspended")], []]) {
        const plugin = await started(guard, groups, members);
        expect(await plugin.definition.onApiRequest!(request(routeKey, "user", COMPANY, BODIES[routeKey]))).toEqual(FORBIDDEN);
      }
      expect(calls).toEqual([]);
    });
    for (const role of ["owner", "Admin"]) {
      it(`serves ${routeKey} to an ${role.toLowerCase()} (role compared case-insensitively)`, async () => {
        const { calls, guard, groups } = recording();
        const plugin = await started(guard, groups, [memberRow("m1", "user-1", role)]);
        expect(await plugin.definition.onApiRequest!(request(routeKey, "user", COMPANY, BODIES[routeKey]))).toMatchObject({ status: 200 });
        expect(calls.length).toBeGreaterThan(0);
      });
    }
  }

  for (const routeKey of Object.keys(BODIES)) {
    it(`serves ${routeKey} to the kyoube CLI's rules token, for a board user who is not a member`, async () => {
      const { calls, guard, groups } = recording();
      const plugin = await started(guard, groups, []);
      expect(await plugin.definition.onApiRequest!(request(routeKey, "user", COMPANY, { ...BODIES[routeKey], rulesToken: TOKEN }))).toMatchObject({ status: 200 });
      expect(calls.length).toBeGreaterThan(0);
    });
    it(`refuses ${routeKey} with a wrong or short token, or when the token file is missing, touching nothing`, async () => {
      const { calls, guard, groups } = recording();
      const plugin = await started(guard, groups, [memberRow("m1", "user-1", "operator")]);
      for (const rulesToken of [`${TOKEN.slice(0, -1)}c`, TOKEN.slice(0, 10), "", 42, null]) {
        expect(await plugin.definition.onApiRequest!(request(routeKey, "user", COMPANY, { ...BODIES[routeKey], rulesToken }))).toEqual(FORBIDDEN);
      }
      const noFile = await started(guard, groups, [], MISSING_TOKEN_PATH);
      expect(await noFile.definition.onApiRequest!(request(routeKey, "user", COMPANY, { ...BODIES[routeKey], rulesToken: TOKEN }))).toEqual(FORBIDDEN);
      expect(calls).toEqual([]);
    });
    it(`still refuses an agent on ${routeKey}, even with the token`, async () => {
      const { calls, guard, groups } = recording();
      const plugin = await started(guard, groups);
      expect(await plugin.definition.onApiRequest!(request(routeKey, "agent", COMPANY, { ...BODIES[routeKey], rulesToken: TOKEN }))).toMatchObject({ status: 403 });
      expect(calls).toEqual([]);
    });
  }

  it("uses the actor's userId when the host gives one", async () => {
    const plugin = await started(quietPort(), quietGroupsPort(), [memberRow("m1", "user-9", "admin")]);
    const req = { ...request("guard.revert"), actor: { actorType: "user" as const, actorId: "board-key", userId: "user-9" } };
    expect(await plugin.definition.onApiRequest!(req)).toMatchObject({ status: 200 });
  });

  it("answers 500, doing nothing, when the members list cannot be read", async () => {
    const { calls, guard, groups } = recording();
    const harness = createTestHarness({ manifest });
    const plugin = createAgentRulesPlugin({ port: () => guard, groupsPort: () => groups, rulesTokenPath: TOKEN_PATH });
    await plugin.definition.setup({ ...harness.ctx, access: { ...harness.ctx.access, members: { ...harness.ctx.access.members, list: async () => { throw new Error("host down"); } } } });
    expect(await plugin.definition.onApiRequest!(request("groups.apply", "user", COMPANY, { agents: [] }))).toMatchObject({ status: 500, body: { error: "groups.apply failed: host down" } });
    expect(calls).toEqual([]);
  });
});

describe("rulesTokenMatches", () => {
  it("matches only the file's exact token, and refuses when the file is missing or empty", async () => {
    expect(await rulesTokenMatches(TOKEN_PATH, TOKEN)).toBe(true);
    expect(await rulesTokenMatches(TOKEN_PATH, `${TOKEN}0`)).toBe(false);
    expect(await rulesTokenMatches(TOKEN_PATH, undefined)).toBe(false);
    expect(await rulesTokenMatches(MISSING_TOKEN_PATH, TOKEN)).toBe(false);
    const empty = path.join(TOKEN_DIR, "empty");
    writeFileSync(empty, "\n");
    expect(await rulesTokenMatches(empty, "")).toBe(false);
    expect(await rulesTokenMatches(empty, "\n")).toBe(false);
  });
});

describe("groupsPortFromContext", () => {
  it("reads every person with their role and status, and reads and writes their grants and the groups record", async () => {
    const harness = createTestHarness({ manifest });
    const member = (id: string, principalType: "user" | "agent", principalId: string, status: string, membershipRole: string | null) =>
      ({ id, companyId: COMPANY, principalType, principalId, status, membershipRole, grants: [], createdAt: new Date(), updatedAt: new Date() }) as never;
    harness.seed({
      accessMembers: [
        member("m1", "user", "u1", "active", "Operator"),
        member("m2", "user", "u2", "suspended", "operator"),
        member("m3", "agent", "a1", "active", null),
        member("m4", "user", "u3", "active", null),
        member("m5", "user", "u4", "archived", "viewer"),
      ],
      principalGrants: [{ id: "g1", companyId: COMPANY, principalType: "user", principalId: "u1", permissionKey: "tasks:assign", scope: null, grantedByUserId: null, createdAt: new Date(), updatedAt: new Date() } as never],
    });
    const port = groupsPortFromContext(harness.ctx);
    expect(await port.listMembers(COMPANY)).toEqual([
      { userId: "u1", role: "operator", status: "active" },
      { userId: "u2", role: "operator", status: "suspended" },
      { userId: "u3", role: null, status: "active" },
      { userId: "u4", role: "viewer", status: "archived" },
    ]);
    expect(await port.listUserGrants(COMPANY, "u1")).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
    await port.setUserGrants(COMPANY, "u1", [{ permissionKey: "tasks:assign", scope: { agentIds: ["a1"] } }]);
    expect(await port.listUserGrants(COMPANY, "u1")).toEqual([{ permissionKey: "tasks:assign", scope: { agentIds: ["a1"] } }]);
    expect(await port.readGroupsRecord(COMPANY)).toEqual(EMPTY_GROUPS_RECORD);
    const record = { protected: ["a1"], required: ["a1"], people: { u1: { original: { permissionKey: "tasks:assign", scope: null }, applied: { permissionKey: "tasks:assign", scope: { agentIds: ["a1"] } } } } };
    await port.writeGroupsRecord(COMPANY, record);
    expect(await port.readGroupsRecord(COMPANY)).toEqual(record);
    // Kept apart from the guard's own record.
    expect(await portFromContext(harness.ctx).readRecord(COMPANY)).toEqual(EMPTY_RECORD);
  });
});

describe("parseGroupsRecord", () => {
  it("tolerates a missing or hand-edited record", () => {
    expect(parseGroupsRecord(undefined)).toEqual(EMPTY_GROUPS_RECORD);
    expect(parseGroupsRecord({ protected: ["a", 2], required: "x", people: { u1: { original: null, applied: { permissionKey: "tasks:assign", scope: { agentIds: ["a"] } } }, u2: { applied: "x" }, u3: null } }))
      .toEqual({ protected: ["a"], required: [], people: { u1: { original: null, applied: { permissionKey: "tasks:assign", scope: { agentIds: ["a"] } } } } });
    const row = { permissionKey: "tasks:assign", scope: { agentIds: ["a"] } };
    // A pending write (null: remove the row) and a first entry for a person who held no row survive; a bad pending does not.
    expect(parseGroupsRecord({ people: { u1: { original: null, applied: null, pending: row }, u2: { original: row, applied: row, pending: null }, u3: { original: null, applied: null, pending: "x" } } }).people)
      .toEqual({ u1: { original: null, applied: null, pending: row }, u2: { original: row, applied: row, pending: null } });
  });
});
