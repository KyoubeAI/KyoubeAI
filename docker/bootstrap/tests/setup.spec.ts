import { describe, expect, it } from "vitest";
import { runSetup, type RunSetupDeps } from "../src/commands/setup.js";
import type { KyoubeConfig } from "../src/config.js";
import type { BoardKeyRecord } from "../src/key-store.js";
import type { CliAuthChallenge, CliAuthStatus, HealthInfo, CoreClient } from "../src/core-api.js";

function fakeConfig(): KyoubeConfig {
  return {
    version: 1,
    dataDatabaseUrl: "postgres://x",
    home: "/kyoubeai",
    hermesHome: "/kyoubeai/.hermes",
    pluginRoot: "/opt/kyoube/plugins",
    paperclipApiUrl: "http://127.0.0.1:3100",
    publicUrl: "http://localhost:3100",
    imageVersion: "test",
  };
}

function challenge(overrides: Partial<CliAuthChallenge> = {}): CliAuthChallenge {
  return {
    id: "c1",
    token: "pcp_cli_auth_deadbeef",
    boardApiToken: "pcp_board_token",
    approvalPath: "/cli-auth/c1?token=pcp_cli_auth_deadbeef",
    approvalUrl: null,
    pollPath: "/cli-auth/challenges/c1",
    // Ten minutes out, like upstream's CLI_AUTH_CHALLENGE_TTL_MS.
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    suggestedPollIntervalMs: 1000,
    ...overrides,
  };
}

interface Harness {
  deps: Partial<RunSetupDeps>;
  lines: string[];
  written: Array<{ filePath: string; record: BoardKeyRecord }>;
  ensureCalls: Array<Record<string, string | true>>;
}

function harness(options: {
  health?: HealthInfo;
  challenge?: CliAuthChallenge;
  statuses?: CliAuthStatus[];
  whoAmI?: CoreClient["whoAmI"];
  ensureCode?: number;
  companies?: Array<{ id: string; name: string }>;
  /** The skill library each poll sees for a company; `poll` counts from 1 per company. */
  companySkills?: (companyId: string, poll: number) => Array<{ slug: string; key: string; name: string }>;
}): Harness {
  const lines: string[] = [];
  const written: Array<{ filePath: string; record: BoardKeyRecord }> = [];
  const ensureCalls: Array<Record<string, string | true>> = [];
  const statuses = [...(options.statuses ?? [])];
  const skillPolls = new Map<string, number>();
  const client: CoreClient = {
    apiBase: "http://127.0.0.1:3100",
    getHealth: async () => options.health ?? { status: "ok", bootstrapStatus: "ready" },
    waitForHealth: async () => options.health ?? { status: "ok", bootstrapStatus: "ready" },
    listPlugins: async () => [],
    listCompanies: async () => options.companies ?? [],
    installPluginSkills: async () => ({ data: { status: "resolved" }, apps: { status: "resolved" } }),
    listCompanySkills: async (companyId) => {
      const poll = (skillPolls.get(companyId) ?? 0) + 1;
      skillPolls.set(companyId, poll);
      return options.companySkills?.(companyId, poll) ?? [];
    },
    listAgents: async () => [],
    listMembers: async () => [],
    installLocalPlugin: async () => { throw new Error("not used"); },
    upgradePlugin: async () => { throw new Error("not used"); },
    uninstallPlugin: async () => { throw new Error("not used"); },
    createCliAuthChallenge: async () => options.challenge ?? challenge(),
    getCliAuthChallengeStatus: async () => {
      const next = statuses.shift();
      if (!next) throw new Error("ran out of scripted challenge statuses");
      return next;
    },
    whoAmI: options.whoAmI ?? (async () => ({ userId: "user-1" })),
    setUserCompanyAccess: async () => {},
    demoteInstanceAdmin: async () => {},
  };
  return {
    lines,
    written,
    ensureCalls,
    deps: {
      readConfig: async () => fakeConfig(),
      createClient: () => client,
      sleep: async () => {},
      log: (line) => lines.push(line),
      writeKey: async (filePath, record) => { written.push({ filePath, record }); },
      runEnsurePlugins: async (flags) => { ensureCalls.push(flags); return options.ensureCode ?? 0; },
    },
  };
}

describe("runSetup", () => {
  it("stops with the sign-up hint when no instance admin exists yet", async () => {
    const h = harness({ health: { status: "ok", bootstrapStatus: "bootstrap_pending" } });
    expect(await runSetup({}, {}, h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("http://localhost:3100");
    expect(h.lines.join("\n")).toContain("sign up");
    expect(h.written).toEqual([]);
  });

  it("stores the key and installs plugins once the challenge is approved", async () => {
    const h = harness({ statuses: ["pending", "approved"], ensureCode: 0 });
    expect(await runSetup({}, {}, h.deps)).toBe(0);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.filePath).toBe("/kyoubeai/kyoube/board-key.json");
    expect(h.written[0]?.record).toMatchObject({ token: "pcp_board_token", userId: "user-1" });
    expect(typeof h.written[0]?.record.createdAt).toBe("string");
    expect(h.ensureCalls).toEqual([{ "api-base": "http://127.0.0.1:3100" }]);
    expect(h.lines.join("\n")).toContain("stored board API key");
  });

  it("returns the ensure-plugins exit code", async () => {
    const h = harness({ statuses: ["approved"], ensureCode: 2 });
    expect(await runSetup({}, {}, h.deps)).toBe(2);
  });

  it("persists the key even when whoAmI fails after approval", async () => {
    const h = harness({
      statuses: ["approved"],
      whoAmI: async () => { throw new Error("Board authentication required"); },
    });
    expect(await runSetup({}, {}, h.deps)).toBe(0);
    // The board key already exists server-side at this point; dropping it here
    // would orphan it.
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.record).toMatchObject({ token: "pcp_board_token", userId: null });
    expect(h.lines.join("\n")).toContain("Board authentication required");
    expect(h.lines.join("\n")).toContain("without a user id");
  });

  it("returns 1 when the login is cancelled in the browser", async () => {
    const h = harness({ statuses: ["pending", "cancelled"] });
    expect(await runSetup({}, {}, h.deps)).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.lines.join("\n")).toContain("cancelled");
  });

  it("returns 1 when the challenge reports itself expired", async () => {
    const h = harness({ statuses: ["pending", "expired"] });
    expect(await runSetup({}, {}, h.deps)).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.lines.join("\n")).toContain("expired before it was approved");
  });

  it("returns 1 without polling when the challenge deadline has already passed", async () => {
    const h = harness({
      challenge: challenge({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      statuses: [],
    });
    expect(await runSetup({}, {}, h.deps)).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.lines.join("\n")).toContain("expired before it was approved");
  });

  it("reports the Kyoube skills once the worker has installed them in every company", async () => {
    const both = [{ slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data" }, { slug: "kyoube-apps", key: "plugin/kyoube-apps/kyoube-apps", name: "Kyoube Apps" }];
    const h = harness({
      statuses: ["approved"],
      companies: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }],
      // Beta's worker-side install lands one poll later than Acme's.
      companySkills: (companyId, poll) => (companyId === "c2" && poll < 2 ? [] : both),
    });
    expect(await runSetup({}, {}, h.deps)).toBe(0);
    expect(h.lines.join("\n")).toContain("Kyoube skills installed in 2/2 companies");
  });

  it("fails and names the company when the Kyoube skills never appear there", async () => {
    const h = harness({
      statuses: ["approved"],
      companies: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }],
      companySkills: (companyId) => (companyId === "c1" ? [{ slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data" }, { slug: "kyoube-apps", key: "plugin/kyoube-apps/kyoube-apps", name: "Kyoube Apps" }] : []),
    });
    expect(await runSetup({}, {}, h.deps)).toBe(1);
    const output = h.lines.join("\n");
    expect(output).toContain("Beta");
    expect(output).not.toContain("Acme (");
    expect(output).toContain("Install the Kyoube Data skill");
  });

  it("does not wait for skills when no company exists yet", async () => {
    const h = harness({ statuses: ["approved"], companies: [] });
    expect(await runSetup({}, {}, h.deps)).toBe(0);
    expect(h.lines.join("\n")).toContain("no company exists yet");
  });

  it("honours --api-base for both the client and the follow-up ensure-plugins run", async () => {
    const h = harness({ statuses: ["approved"] });
    expect(await runSetup({ "api-base": "http://app:3100" }, {}, h.deps)).toBe(0);
    expect(h.ensureCalls).toEqual([{ "api-base": "http://app:3100" }]);
  });
});
