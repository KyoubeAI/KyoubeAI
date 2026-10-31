import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverBundledAdapters,
  ensureAdapters,
  resolveAdapterPluginStorePath,
  seedAdapterPluginsStore,
  type InstalledAdapterInfo,
} from "../src/adapters.js";
import { runWriteConfig } from "../src/commands/write-config.js";

describe("bundled external adapters", () => {
  it("discovers bundled adapters and seeds the core's adapter-plugins.json in the home while preserving existing entries", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kyoube-adapters-"));
    const adapterRoot = path.join(tmp, "adapters");
    const agyDir = path.join(adapterRoot, "antigravity");
    await mkdir(agyDir, { recursive: true });
    await writeFile(
      path.join(agyDir, "package.json"),
      JSON.stringify({
        name: "@kyoube/adapter-antigravity",
        version: "0.1.0",
        paperclip: {
          adapterType: "antigravity_local",
          adapterUiParser: "1.0.0",
        },
      }),
    );

    const discovered = await discoverBundledAdapters(adapterRoot);
    expect(discovered).toEqual([
      {
        dir: agyDir,
        name: "antigravity",
        packageName: "@kyoube/adapter-antigravity",
        type: "antigravity_local",
        version: "0.1.0",
      },
    ]);

    const home = path.join(tmp, "home");
    const storePath = resolveAdapterPluginStorePath(home);
    expect(storePath).toBe(path.join(home, "adapter-plugins.json"));
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify([
        {
          packageName: "custom-external-adapter",
          type: "custom_local",
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const now = new Date("2026-10-31T00:00:00.000Z");
    const seeded = await seedAdapterPluginsStore({
      home,
      adapterRoot,
      now,
    });
    expect(seeded).toHaveLength(1);

    const stored = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored).toEqual([
      {
        packageName: "custom-external-adapter",
        type: "custom_local",
        installedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        packageName: "@kyoube/adapter-antigravity",
        localPath: agyDir,
        version: "0.1.0",
        type: "antigravity_local",
        installedAt: "2026-10-31T00:00:00.000Z",
      },
    ]);
  });

  it("runWriteConfig seeds adapter-plugins.json when KYOUBE_ADAPTER_ROOT has bundled adapters", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kyoube-wc-adapters-"));
    const adapterRoot = path.join(tmp, "adapters");
    const agyDir = path.join(adapterRoot, "antigravity");
    await mkdir(agyDir, { recursive: true });
    await writeFile(
      path.join(agyDir, "package.json"),
      JSON.stringify({
        name: "@kyoube/adapter-antigravity",
        version: "0.1.0",
        paperclip: { adapterType: "antigravity_local", adapterUiParser: "1.0.0" },
      }),
    );

    const home = path.join(tmp, "home");
    const configPath = path.join(tmp, "config.json");
    const code = await runWriteConfig({
      KYOUBE_DATABASE_URL: "postgres://x",
      PAPERCLIP_HOME: home,
      HERMES_HOME: path.join(home, ".hermes"),
      KYOUBE_CONFIG_PATH: configPath,
      KYOUBE_ADAPTER_ROOT: adapterRoot,
    });
    expect(code).toBe(0);
    const storePath = resolveAdapterPluginStorePath(home);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored).toMatchObject([
      {
        packageName: "@kyoube/adapter-antigravity",
        localPath: agyDir,
        version: "0.1.0",
        type: "antigravity_local",
      },
    ]);
  });

  it("replaces an older record of the same type and keeps the fields it does not set", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kyoube-adapters-replace-"));
    const adapterRoot = await bundleRoot(tmp, "0.2.0");
    const home = path.join(tmp, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      resolveAdapterPluginStorePath(home),
      JSON.stringify([
        {
          packageName: "@someone/antigravity-adapter",
          version: "0.0.9",
          type: "antigravity_local",
          installedAt: "2026-01-01T00:00:00.000Z",
          note: "kept",
        },
      ]),
    );

    await seedAdapterPluginsStore({ home, adapterRoot, now: new Date("2026-10-31T00:00:00.000Z") });

    expect(JSON.parse(await readFile(resolveAdapterPluginStorePath(home), "utf8"))).toEqual([
      {
        packageName: "@kyoube/adapter-antigravity",
        localPath: path.join(adapterRoot, "antigravity"),
        version: "0.2.0",
        type: "antigravity_local",
        installedAt: "2026-01-01T00:00:00.000Z",
        note: "kept",
      },
    ]);
  });

  it.each([
    ["truncated JSON", '[{"packageName": "custom-external-adapter", "ty'],
    ["a JSON object", '{"packageName": "custom-external-adapter"}'],
  ])("leaves a store holding %s untouched and throws", async (_label, content) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "kyoube-adapters-bad-"));
    const adapterRoot = await bundleRoot(tmp, "0.1.0");
    const home = path.join(tmp, "home");
    await mkdir(home, { recursive: true });
    await writeFile(resolveAdapterPluginStorePath(home), content);

    await expect(seedAdapterPluginsStore({ home, adapterRoot })).rejects.toThrow();
    expect(await readFile(resolveAdapterPluginStorePath(home), "utf8")).toBe(content);
  });

  it("ensureAdapters installs missing ones, re-registers outdated or npm-installed ones from the bundle, and skips current ones", async () => {
    const calls: string[] = [];
    const existing: InstalledAdapterInfo[] = [
      { type: "antigravity_local", packageName: "@kyoube/adapter-antigravity", version: "0.1.0", isLocalPath: true },
      { type: "outdated_local", packageName: "@kyoube/adapter-outdated", version: "0.1.0", isLocalPath: true },
      { type: "npm_local", packageName: "@someone/adapter-npm", version: "0.1.0", isLocalPath: false },
    ];
    const bundle = (name: string, type: string, version: string) => ({
      dir: `/opt/kyoube/adapters/${name}`,
      name,
      packageName: `@kyoube/adapter-${name}`,
      type,
      version,
    });
    const result = await ensureAdapters({
      client: {
        async listAdapters() {
          return existing;
        },
        async installLocalAdapter(localPath) {
          calls.push(`install ${localPath}`);
          return { type: "x", isLocalPath: true };
        },
      },
      log: () => {},
      scan: async () => [
        bundle("antigravity", "antigravity_local", "0.1.0"),
        bundle("outdated", "outdated_local", "0.2.0"),
        bundle("npm", "npm_local", "0.1.0"),
        bundle("new", "new_local", "0.1.0"),
      ],
    });

    expect(calls).toEqual([
      "install /opt/kyoube/adapters/outdated",
      "install /opt/kyoube/adapters/npm",
      "install /opt/kyoube/adapters/new",
    ]);
    expect(result).toEqual({
      installed: ["outdated_local", "npm_local", "new_local"],
      skipped: ["antigravity_local"],
    });
  });
});

async function bundleRoot(tmp: string, version: string): Promise<string> {
  const adapterRoot = path.join(tmp, "adapters");
  const agyDir = path.join(adapterRoot, "antigravity");
  await mkdir(agyDir, { recursive: true });
  await writeFile(
    path.join(agyDir, "package.json"),
    JSON.stringify({
      name: "@kyoube/adapter-antigravity",
      version,
      paperclip: { adapterType: "antigravity_local", adapterUiParser: "1.0.0" },
    }),
  );
  return adapterRoot;
}
