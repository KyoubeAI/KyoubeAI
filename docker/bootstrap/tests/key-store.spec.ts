import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRulesToken, readBoardKey, resolveBoardApiKey, resolveBoardKeyPath, resolveRulesTokenPath, writeBoardKey } from "../src/key-store.js";
import { renderConfigFromEnv } from "../src/config.js";

describe("key-store", () => {
  it("derives the key path from the config home", () => {
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x", PAPERCLIP_HOME: "/data" });
    expect(resolveBoardKeyPath(config)).toBe("/data/kyoube/board-key.json");
  });

  it("round-trips a key record and returns null when absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    expect(await readBoardKey(filePath)).toBeNull();
    await writeBoardKey(filePath, { token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await readBoardKey(filePath)).toEqual({ token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
  });

  it("writes the key file owner-readable only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeBoardKey(filePath, { token: "pcp_x", userId: "u1", createdAt: "2026-09-05T00:00:00.000Z" });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an existing key file whole, owner-readable only, leaving no temporary file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeFile(filePath, "old", { mode: 0o644 });
    await writeBoardKey(filePath, { token: "pcp_new", userId: "u1", createdAt: "2026-10-21T00:00:00.000Z" });
    expect((await readBoardKey(filePath))?.token).toBe("pcp_new");
    expect(await readdir(dir)).toEqual(["board-key.json"]);
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("treats a malformed key file as missing and warns instead of throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeFile(filePath, '{"token": "pcp_trunc');
    const warnings: string[] = [];
    // `ensure-plugins --watch` re-reads this file every 60s; throwing here would
    // turn one corrupt file into a permanent crash loop.
    expect(await readBoardKey(filePath, (line) => warnings.push(line))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
    expect(await resolveBoardApiKey({}, filePath)).toBeNull();
  });

  it("prefers explicit, then env, then file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-key-"));
    const filePath = path.join(dir, "board-key.json");
    await writeBoardKey(filePath, { token: "from-file", userId: null, createdAt: "2026-09-05T00:00:00.000Z" });
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath, "explicit")).toBe("explicit");
    expect(await resolveBoardApiKey({ KYOUBE_BOARD_API_KEY: "from-env" }, filePath)).toBe("from-env");
    expect(await resolveBoardApiKey({}, filePath)).toBe("from-file");
    expect(await resolveBoardApiKey({}, path.join(dir, "missing.json"))).toBeNull();
  });
});

// Ruling R18: the kyoube CLI's rules token, beside the board key.
describe("rules token", () => {
  it("lives beside the board key", () => {
    const config = renderConfigFromEnv({ KYOUBE_DATABASE_URL: "postgres://x", PAPERCLIP_HOME: "/data" });
    expect(resolveRulesTokenPath(config)).toBe("/data/kyoube/rules-token");
  });

  it("creates 32 random bytes as hex with mode 600, leaves no temporary file, and reuses the file after", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const filePath = path.join(dir, "kyoube", "rules-token");
    const token = await ensureRulesToken(filePath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, "utf8")).toBe(`${token}\n`);
    expect(await readdir(path.dirname(filePath))).toEqual(["rules-token"]);
    expect(await ensureRulesToken(filePath)).toBe(token);
  });

  it("keeps an existing token as it is", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const filePath = path.join(dir, "rules-token");
    await writeFile(filePath, "existing-token\n", { mode: 0o600 });
    expect(await ensureRulesToken(filePath)).toBe("existing-token");
    expect(await readFile(filePath, "utf8")).toBe("existing-token\n");
  });

  it("replaces a blank file with a new token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const filePath = path.join(dir, "rules-token");
    await writeFile(filePath, "\n", { mode: 0o600 });
    expect(await ensureRulesToken(filePath)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two first runs at once the same token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const filePath = path.join(dir, "rules-token");
    const tokens = await Promise.all([ensureRulesToken(filePath), ensureRulesToken(filePath), ensureRulesToken(filePath)]);
    expect(new Set(tokens).size).toBe(1);
    expect(await readdir(dir)).toEqual(["rules-token"]);
  });
});
