import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePlugins, NO_KEY_EXIT_CODE, runEnsurePlugins } from "../src/commands/ensure-plugins.js";
import type { KyoubeConfig } from "../src/config.js";
import { CoreApiError, type InstalledPlugin, type CoreClient } from "../src/core-api.js";

interface BundleOnDisk {
  pluginKey: string;
  version: string;
  /** Capabilities the bundle declares; used to model upstream's escalation check. */
  capabilities?: string[];
}

interface RegistryOptions {
  rows: InstalledPlugin[];
  /** What each local bundle directory contains, as the plugin loader would read it. */
  disk: Record<string, BundleOnDisk>;
  /** Capabilities each installed row was registered with, keyed by pluginKey. */
  installedCapabilities?: Record<string, string[]>;
  /** Override the upgrade route's behaviour for a specific failure shape. */
  onUpgrade?: (row: InstalledPlugin) => InstalledPlugin;
}

/**
 * A fake `CoreClient` that mirrors the parts of upstream's plugin registry,
 * lifecycle manager and loader that `ensurePlugins` actually depends on
 * (server/src/services/plugin-registry.ts, plugin-lifecycle.ts, plugin-loader.ts
 * in core 2026.831.1):
 *
 * - `POST /api/plugins/install` throws `conflict("Plugin already installed: <key>")`
 *   (HTTP 400) for any existing row whose status is not `uninstalled`, and
 *   reactivates the existing row when it is.
 * - `POST /api/plugins/:id/upgrade` re-reads the stored `packagePath`, and the
 *   loader throws `Upgrade for "<id>" introduces new capabilities that require
 *   approval: …` (surfaced as HTTP 400) when the new manifest adds capabilities.
 * - `DELETE /api/plugins/:id` without `purge` soft-deletes: the row survives with
 *   status `uninstalled`.
 */
function registryClient(options: RegistryOptions) {
  const rows: InstalledPlugin[] = options.rows.map((row) => ({ ...row }));
  const capabilities: Record<string, string[]> = { ...(options.installedCapabilities ?? {}) };
  const calls: string[] = [];

  const conflict = (key: string) =>
    new CoreApiError(
      400,
      { error: `Plugin already installed: ${key}` },
      `Plugin already installed: ${key}`,
    );

  const client = {
    apiBase: "http://app:3100",
    async getHealth() { return { status: "ok" }; },
    async waitForHealth() { return { status: "ok" }; },
    async listPlugins() { return rows.map((row) => ({ ...row })); },
    async installLocalPlugin(localPath: string) {
      calls.push(`install ${localPath}`);
      const bundle = options.disk[localPath];
      if (!bundle) throw new Error(`no bundle on disk at ${localPath}`);
      const existing = rows.find((row) => row.pluginKey === bundle.pluginKey);
      if (existing) {
        if (existing.status !== "uninstalled") throw conflict(bundle.pluginKey);
        existing.version = bundle.version;
        existing.status = "installed";
        existing.packagePath = localPath;
        capabilities[bundle.pluginKey] = bundle.capabilities ?? [];
        return { ...existing };
      }
      const created: InstalledPlugin = {
        id: `id-${rows.length + 1}`,
        pluginKey: bundle.pluginKey,
        version: bundle.version,
        status: "installed",
        packagePath: localPath,
      };
      rows.push(created);
      capabilities[bundle.pluginKey] = bundle.capabilities ?? [];
      return { ...created };
    },
    async upgradePlugin(pluginId: string) {
      calls.push(`upgrade ${pluginId}`);
      const row = rows.find((candidate) => candidate.id === pluginId);
      if (!row) throw new CoreApiError(404, { error: "Plugin not found" }, "Plugin not found");
      if (options.onUpgrade) {
        Object.assign(row, options.onUpgrade(row));
        return { ...row };
      }
      const bundle = row.packagePath ? options.disk[row.packagePath] : undefined;
      if (!bundle) throw new CoreApiError(400, { error: "Plugin not found" }, "Plugin not found");
      const added = (bundle.capabilities ?? []).filter(
        (capability) => !(capabilities[row.pluginKey] ?? []).includes(capability),
      );
      if (added.length > 0) {
        const message =
          `Upgrade for "${row.id}" introduces new capabilities that require approval: ${added.join(", ")}. ` +
          `The previous version declared [${(capabilities[row.pluginKey] ?? []).join(", ")}]. ` +
          "Please review and approve the capability escalation before upgrading.";
        throw new CoreApiError(400, { error: message }, message);
      }
      row.version = bundle.version;
      row.status = "ready";
      return { ...row };
    },
    async uninstallPlugin(pluginId: string, opts: { purge?: boolean } = {}) {
      calls.push(`uninstall ${pluginId}${opts.purge ? " purge" : ""}`);
      const row = rows.find((candidate) => candidate.id === pluginId);
      if (!row) throw new CoreApiError(404, { error: "Plugin not found" }, "Plugin not found");
      row.status = "uninstalled";
    },
    async listCompanies() { return []; },
    async listCompanySkills() { return []; },
    async listAgents() { return []; },
    async listMembers() { return []; },
    async installPluginSkills() { return { data: { status: "resolved" }, apps: { status: "resolved" } }; },
    async createCliAuthChallenge() { throw new Error("not used"); },
    async getCliAuthChallengeStatus() { throw new Error("not used"); },
    async whoAmI() { throw new Error("not used"); },
    async setUserCompanyAccess() {},
    async demoteInstanceAdmin() {},
  } satisfies CoreClient;

  return { client, calls, rows };
}

const TERMINAL_DIR = "/opt/kyoube/plugins/terminal";
const APPS_DIR = "/opt/kyoube/plugins/apps";

describe("ensurePlugins", () => {
  it("installs missing bundles, upgrades outdated ones through the upgrade route, skips current ones", async () => {
    const { client, calls, rows } = registryClient({
      rows: [
        { id: "id-1", pluginKey: "kyoube.apps", version: "0.1.0", status: "ready", packagePath: APPS_DIR },
        { id: "id-2", pluginKey: "kyoube.other", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/other" },
      ],
      installedCapabilities: { "kyoube.apps": ["plugin.state.read"], "kyoube.other": ["plugin.state.read"] },
      disk: {
        [APPS_DIR]: { pluginKey: "kyoube.apps", version: "0.2.0", capabilities: ["plugin.state.read"] },
        "/opt/kyoube/plugins/other": { pluginKey: "kyoube.other", version: "0.1.0", capabilities: ["plugin.state.read"] },
        [TERMINAL_DIR]: { pluginKey: "kyoube.terminal", version: "0.2.0", capabilities: ["plugin.state.read"] },
      },
    });
    const lines: string[] = [];
    const result = await ensurePlugins({
      client,
      log: (line) => lines.push(line),
      scan: async () => [
        { dir: APPS_DIR, name: "apps", pluginKey: "kyoube.apps", version: "0.2.0" },
        { dir: "/opt/kyoube/plugins/other", name: "other", pluginKey: "kyoube.other", version: "0.1.0" },
        { dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" },
      ],
    });
    // The outdated plugin goes through /upgrade, never a re-install (which the
    // registry would reject with "Plugin already installed").
    expect(calls).toEqual(["upgrade id-1", `install ${TERMINAL_DIR}`]);
    expect(result).toEqual({ installed: ["kyoube.terminal"], upgraded: ["kyoube.apps"], skipped: ["kyoube.other"] });
    expect(rows.find((row) => row.pluginKey === "kyoube.apps")).toMatchObject({ version: "0.2.0", status: "ready" });
    expect(lines.some((line) => line.includes("kyoube.terminal"))).toBe(true);
  });

  it("falls back to soft uninstall + reinstall when the upgrade needs capability approval", async () => {
    const { client, calls, rows } = registryClient({
      rows: [{ id: "id-1", pluginKey: "kyoube.terminal", version: "0.1.1", status: "ready", packagePath: TERMINAL_DIR }],
      installedCapabilities: { "kyoube.terminal": ["plugin.state.read"] },
      disk: {
        [TERMINAL_DIR]: {
          pluginKey: "kyoube.terminal",
          version: "0.1.2",
          capabilities: ["plugin.state.read", "activity.log.write"],
        },
      },
    });
    const lines: string[] = [];
    const result = await ensurePlugins({
      client,
      log: (line) => lines.push(line),
      scan: async () => [{ dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.2" }],
    });
    expect(calls).toEqual(["upgrade id-1", "uninstall id-1", `install ${TERMINAL_DIR}`]);
    expect(result.upgraded).toEqual(["kyoube.terminal"]);
    // Soft delete: the same row is reactivated, so plugin-scoped data survives.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "id-1", version: "0.1.2", status: "installed" });
    expect(lines.some((line) => line.includes("needs board approval for new capabilities"))).toBe(true);
  });

  it("propagates an upgrade failure that is not a capability escalation", async () => {
    const message =
      "Cannot upgrade plugin in status 'error'. Plugin must be in 'ready' or 'upgrade_pending' status to be upgraded.";
    const { client, calls } = registryClient({
      rows: [{ id: "id-1", pluginKey: "kyoube.terminal", version: "0.1.1", status: "error", packagePath: TERMINAL_DIR }],
      disk: { [TERMINAL_DIR]: { pluginKey: "kyoube.terminal", version: "0.1.2" } },
      onUpgrade: () => { throw new CoreApiError(400, { error: message }, message); },
    });
    await expect(ensurePlugins({
      client,
      log: () => {},
      scan: async () => [{ dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.2" }],
    })).rejects.toThrow("Cannot upgrade plugin in status 'error'");
    // No blind reinstall attempt on an unexpected failure.
    expect(calls).toEqual(["upgrade id-1"]);
  });

  it("mirrors upstream: re-installing an existing, non-uninstalled plugin is a 400 conflict", async () => {
    const { client } = registryClient({
      rows: [{ id: "id-1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: TERMINAL_DIR }],
      disk: { [TERMINAL_DIR]: { pluginKey: "kyoube.terminal", version: "0.1.1" } },
    });
    await expect(client.installLocalPlugin(TERMINAL_DIR)).rejects.toMatchObject({
      status: 400,
      body: { error: "Plugin already installed: kyoube.terminal" },
    });
  });

  it("re-installs a previously uninstalled plugin instead of upgrading it", async () => {
    const { client, calls, rows } = registryClient({
      rows: [{ id: "id-1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "uninstalled", packagePath: TERMINAL_DIR }],
      disk: { [TERMINAL_DIR]: { pluginKey: "kyoube.terminal", version: "0.1.1" } },
    });
    const result = await ensurePlugins({
      client,
      log: () => {},
      scan: async () => [{ dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.1" }],
    });
    expect(calls).toEqual([`install ${TERMINAL_DIR}`]);
    expect(result.installed).toEqual(["kyoube.terminal"]);
    expect(rows[0]).toMatchObject({ id: "id-1", version: "0.1.1", status: "installed" });
  });

  it("fails when a plugin is installed but reports an error status", async () => {
    const { client } = registryClient({ rows: [], disk: {} });
    client.installLocalPlugin = async (localPath) => ({ id: "x", pluginKey: "kyoube.terminal", version: "0.2.0", status: "error", packagePath: localPath });
    await expect(ensurePlugins({
      client,
      log: () => {},
      scan: async () => [{ dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" }],
    })).rejects.toThrow("kyoube.terminal installed with status error");
  });

  it("takes the reinstall fallback when upstream parks the upgrade in upgrade_pending", async () => {
    const { client, calls } = registryClient({
      rows: [{ id: "id-1", pluginKey: "kyoube.terminal", version: "0.1.1", status: "ready", packagePath: TERMINAL_DIR }],
      disk: { [TERMINAL_DIR]: { pluginKey: "kyoube.terminal", version: "0.1.2" } },
      onUpgrade: (row) => ({ ...row, status: "upgrade_pending" }),
    });
    const result = await ensurePlugins({
      client,
      log: () => {},
      scan: async () => [{ dir: TERMINAL_DIR, name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.2" }],
    });
    expect(calls).toEqual(["upgrade id-1", "uninstall id-1", `install ${TERMINAL_DIR}`]);
    expect(result.upgraded).toEqual(["kyoube.terminal"]);
  });
});

function fakeConfig(): KyoubeConfig {
  return {
    version: 1,
    dataDatabaseUrl: "postgres://x",
    home: path.join(os.tmpdir(), "kyoube-ensure-plugins-test-home-missing"),
    hermesHome: path.join(os.tmpdir(), "kyoube-ensure-plugins-test-home-missing", ".hermes"),
    pluginRoot: path.join(os.tmpdir(), "kyoube-ensure-plugins-test-plugins-missing"),
    paperclipApiUrl: "http://fake-paperclip:1",
    publicUrl: "http://fake-paperclip:1",
    imageVersion: "test",
  };
}

function fakeRunClient(
  waitForHealth: CoreClient["waitForHealth"],
  extras: Partial<Pick<CoreClient, "listCompanies" | "installPluginSkills">> = {},
): CoreClient {
  return {
    apiBase: "http://fake-paperclip:1",
    getHealth: async () => ({ status: "ok" }),
    waitForHealth,
    listPlugins: async () => [],
    listCompanies: extras.listCompanies ?? (async () => []),
    listCompanySkills: async () => [],
    listAgents: async () => [],
    listMembers: async () => [],
    installPluginSkills: extras.installPluginSkills ?? (async () => { throw new Error("not used"); }),
    installLocalPlugin: async (localPath: string) => ({ id: "x", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: localPath }),
    upgradePlugin: async () => { throw new Error("not used"); },
    uninstallPlugin: async () => { throw new Error("not used"); },
    createCliAuthChallenge: async () => { throw new Error("not used"); },
    getCliAuthChallengeStatus: async () => { throw new Error("not used"); },
    whoAmI: async () => { throw new Error("not used"); },
    setUserCompanyAccess: async () => {},
    demoteInstanceAdmin: async () => {},
  } satisfies CoreClient;
}

describe("runEnsurePlugins", () => {
  it("in --watch mode, retries through a health-check outage instead of exiting, then installs once healthy", async () => {
    let healthCalls = 0;
    const client = fakeRunClient(async () => {
      healthCalls += 1;
      if (healthCalls === 1) throw new Error("connect ECONNREFUSED");
      return { status: "ok" };
    });
    const sleeps: number[] = [];
    const lines: string[] = [];
    const code = await runEnsurePlugins(
      { watch: true, "api-key": "test-key" },
      {},
      {
        readConfig: async () => fakeConfig(),
        createClient: () => client,
        sleep: async (ms) => { sleeps.push(ms); },
        log: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(healthCalls).toBe(2);
    expect(sleeps).toEqual([60_000]);
    expect(lines.some((line) => line.includes("plugins ok"))).toBe(true);
  });

  it("installs the Kyoube skills into every company once the plugins are ok, and reports the count", async () => {
    const installed: string[] = [];
    const client = fakeRunClient(async () => ({ status: "ok" }), {
      listCompanies: async () => [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }],
      installPluginSkills: async (companyId) => { installed.push(companyId); return { data: { status: "created" }, apps: { status: "created" } }; },
    });
    const sleeps: number[] = [];
    const lines: string[] = [];
    const code = await runEnsurePlugins({ "api-key": "test-key" }, {}, { readConfig: async () => fakeConfig(), createClient: () => client, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(installed).toEqual(["c1", "c2"]);
    expect(sleeps).toEqual([]);
    expect(lines.some((line) => line.includes("Kyoube skills ensured in 2/2 companies"))).toBe(true);
  });

  it("retries a company whose worker is still activating, and only reports the ones that never took the skills", async () => {
    const attempts: Record<string, number> = {};
    const client = fakeRunClient(async () => ({ status: "ok" }), {
      listCompanies: async () => [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }, { id: "c3", name: "Gamma" }],
      installPluginSkills: async (companyId) => {
        attempts[companyId] = (attempts[companyId] ?? 0) + 1;
        // Beta's first call lands before the worker is ready; Gamma's never works.
        if (companyId === "c2" && attempts[companyId] === 1) throw new CoreApiError(503, { error: "plugin not ready" }, "plugin not ready");
        if (companyId === "c3") throw new CoreApiError(502, { code: "WORKER_UNAVAILABLE" }, "Plugin is not ready");
        return { data: { status: "resolved" }, apps: { status: "resolved" } };
      },
    });
    const sleeps: number[] = [];
    const lines: string[] = [];
    const code = await runEnsurePlugins({ "api-key": "test-key" }, {}, { readConfig: async () => fakeConfig(), createClient: () => client, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(attempts.c1).toBe(1);
    expect(attempts.c2).toBe(2);
    expect(attempts.c3).toBeGreaterThan(2);
    expect(sleeps.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toContain("Kyoube skills ensured in 2/3 companies");
    expect(output).toContain("Gamma");
    expect(output).not.toContain("Beta (");
  });

  it("without --watch, returns 1 (not 2) when the health check fails, and does not retry", async () => {
    const client = fakeRunClient(async () => { throw new Error("connect ECONNREFUSED"); });
    const sleeps: number[] = [];
    const code = await runEnsurePlugins(
      {},
      {},
      {
        readConfig: async () => fakeConfig(),
        createClient: () => client,
        sleep: async (ms) => { sleeps.push(ms); },
        log: () => {},
      },
    );
    expect(code).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("without --watch, returns NO_KEY_EXIT_CODE when healthy but no board API key is available", async () => {
    const client = fakeRunClient(async () => ({ status: "ok" }));
    const sleeps: number[] = [];
    const code = await runEnsurePlugins(
      {},
      {},
      {
        readConfig: async () => fakeConfig(),
        createClient: () => client,
        sleep: async (ms) => { sleeps.push(ms); },
        log: () => {},
      },
    );
    expect(code).toBe(NO_KEY_EXIT_CODE);
    expect(sleeps).toEqual([]);
  });
});
