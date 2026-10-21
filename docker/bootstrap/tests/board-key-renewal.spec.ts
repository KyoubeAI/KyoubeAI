import { chmod, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBoardKeyApi, renewBoardKeyIfDue, RENEWED_KEY_NAME, revokeReplacedKey, type BoardKeyApi } from "../src/board-key-renewal.js";
import { CoreApiError } from "../src/core-api.js";
import { readBoardKey, writeBoardKey } from "../src/key-store.js";

const NOW = new Date("2026-10-21T10:00:00Z");
const DUE = "2026-10-26T10:00:00.000Z"; // five days left
const NOT_DUE = "2026-11-10T10:00:00.000Z"; // twenty days left
const RENEWED_UNTIL = "2026-11-20T10:00:00.000Z";

interface FakeKey { id: string; token: string; expiresAt: string | null; revoked: boolean }

/** The core's board keys as the four routes see them: a revoked or unknown token gets a 401. */
function fakeCore(expiresAt: string | null, overrides: Partial<BoardKeyApi> = {}) {
  const keys: FakeKey[] = [{ id: "k1", token: "old-token", expiresAt, revoked: false }];
  const calls: string[] = [];
  const live = (token: string) => {
    const key = keys.find((row) => row.token === token && !row.revoked);
    if (!key) throw new CoreApiError(401, null, "Agent token did not verify; obtain fresh credentials and retry");
    return key;
  };
  const api: BoardKeyApi = {
    async whoAmI(token) {
      calls.push(`me ${token}`);
      return { userId: "u1", keyId: live(token).id };
    },
    async listKeys(token) {
      calls.push("list");
      live(token);
      return keys.filter((row) => !row.revoked).map(({ id, expiresAt: until }) => ({ id, expiresAt: until }));
    },
    async createKey(token, name) {
      calls.push(`create ${name}`);
      live(token);
      const key = { id: `k${keys.length + 1}`, token: `new-token-${keys.length + 1}`, expiresAt: RENEWED_UNTIL, revoked: false };
      keys.push(key);
      return { id: key.id, token: key.token, expiresAt: key.expiresAt };
    },
    async revokeKey(token, keyId) {
      calls.push(`revoke ${keyId} with ${token}`);
      live(token);
      const key = keys.find((row) => row.id === keyId && !row.revoked);
      if (!key) throw new CoreApiError(404, null, "Board API key not found");
      key.revoked = true;
    },
    ...overrides,
  };
  return { api, keys, calls };
}

async function storedKey() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-renew-"));
  const keyPath = path.join(dir, "board-key.json");
  await writeBoardKey(keyPath, { token: "old-token", userId: "u1", createdAt: "2026-09-26T09:18:27.500Z" });
  return { dir, keyPath };
}

describe("renewBoardKeyIfDue", () => {
  it("does nothing without a stored key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-renew-"));
    const { api, calls } = fakeCore(DUE);
    expect(await renewBoardKeyIfDue({ api, keyPath: path.join(dir, "board-key.json"), now: NOW })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("leaves a key with more than a week left, or none that expires, alone", async () => {
    for (const expiresAt of [NOT_DUE, null]) {
      const { keyPath } = await storedKey();
      const { api, calls } = fakeCore(expiresAt);
      expect(await renewBoardKeyIfDue({ api, keyPath, now: NOW })).toEqual({ status: "not-due", expiresAt });
      expect(calls).toEqual(["me old-token", "list"]);
      expect((await readBoardKey(keyPath))?.token).toBe("old-token");
    }
  });

  it("renews a key with less than a week left: a new key for the same person, checked and stored; the old one stays live for now", async () => {
    const { keyPath } = await storedKey();
    const { api, keys, calls } = fakeCore(DUE);
    expect(await renewBoardKeyIfDue({ api, keyPath, now: NOW })).toEqual({ status: "renewed", expiresAt: RENEWED_UNTIL, oldKeyId: "k1" });
    expect(calls).toEqual(["me old-token", "list", `create ${RENEWED_KEY_NAME}`, "me new-token-2"]);
    expect(await readBoardKey(keyPath)).toEqual({ token: "new-token-2", userId: "u1", createdAt: NOW.toISOString() });
    expect(keys.map((key) => [key.id, key.revoked])).toEqual([["k1", false], ["k2", false]]);
  });

  it("drops the new key and keeps the one kyoube setup stored while the renewal ran", async () => {
    const { keyPath } = await storedKey();
    const core = fakeCore(DUE);
    const realCreate = core.api.createKey;
    core.api.createKey = async (token, name) => {
      const created = await realCreate(token, name);
      await writeBoardKey(keyPath, { token: "from-setup", userId: "u1", createdAt: NOW.toISOString() });
      return created;
    };
    expect(await renewBoardKeyIfDue({ api: core.api, keyPath, now: NOW })).toEqual({
      status: "failed",
      reason: "the stored key changed while it was being renewed (kyoube setup?), so the new one was dropped",
    });
    expect((await readBoardKey(keyPath))?.token).toBe("from-setup");
    expect(core.keys.map((key) => [key.id, key.revoked])).toEqual([["k1", false], ["k2", true]]);
  });

  it("drops the new key when checking it fails", async () => {
    const { keyPath } = await storedKey();
    const core = fakeCore(DUE);
    const realWhoAmI = core.api.whoAmI;
    core.api.whoAmI = async (token) => { if (token !== "old-token") throw new Error("socket hang up"); return realWhoAmI(token); };
    expect(await renewBoardKeyIfDue({ api: core.api, keyPath, now: NOW })).toEqual({ status: "failed", reason: "the core did not take the new key" });
    expect((await readBoardKey(keyPath))?.token).toBe("old-token");
    expect(core.keys.map((key) => [key.id, key.revoked])).toEqual([["k1", false], ["k2", true]]);
  });

  it("fails rather than guess when the core's expiry cannot be read", async () => {
    for (const expiresAt of ["", "soon"]) {
      const { keyPath } = await storedKey();
      const { api, calls } = fakeCore(expiresAt);
      expect(await renewBoardKeyIfDue({ api, keyPath, now: NOW })).toEqual({ status: "failed", reason: "the core gave board key k1 an expiry KyoubeAI cannot read" });
      expect(calls).toEqual(["me old-token", "list"]);
    }
  });

  it("keeps the old key, and revokes the new one, when the core does not take the new one", async () => {
    const { keyPath } = await storedKey();
    const core = fakeCore(DUE);
    const realWhoAmI = core.api.whoAmI;
    core.api.whoAmI = async (token) => (token === "old-token" ? realWhoAmI(token) : { userId: "u1", keyId: "someone-else" });
    expect(await renewBoardKeyIfDue({ api: core.api, keyPath, now: NOW })).toEqual({ status: "failed", reason: "the core did not take the new key" });
    expect((await readBoardKey(keyPath))?.token).toBe("old-token");
    expect(core.keys.map((key) => [key.id, key.revoked])).toEqual([["k1", false], ["k2", true]]);
  });

  it("keeps the old key, and revokes the new one, when the new one cannot be stored", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { dir, keyPath } = await storedKey();
    const { api, keys } = fakeCore(DUE);
    await chmod(dir, 0o500);
    try {
      expect(await renewBoardKeyIfDue({ api, keyPath, now: NOW })).toMatchObject({ status: "failed" });
    } finally {
      await chmod(dir, 0o700);
    }
    expect((await readBoardKey(keyPath))?.token).toBe("old-token");
    expect(keys.map((key) => [key.id, key.revoked])).toEqual([["k1", false], ["k2", true]]);
    expect(await readdir(dir)).toEqual(["board-key.json"]);
  });

  it("fails without minting anything when the stored key no longer works, or the core does not list it", async () => {
    const expired = await storedKey();
    const gone = fakeCore(DUE);
    gone.keys[0]!.revoked = true;
    expect(await renewBoardKeyIfDue({ api: gone.api, keyPath: expired.keyPath, now: NOW })).toEqual({ status: "failed", reason: "Agent token did not verify; obtain fresh credentials and retry" });
    expect(gone.calls).toEqual(["me old-token"]);

    const unlisted = await storedKey();
    const hidden = fakeCore(DUE, { listKeys: async () => [] });
    expect(await renewBoardKeyIfDue({ api: hidden.api, keyPath: unlisted.keyPath, now: NOW })).toEqual({ status: "failed", reason: "the core does not list board key k1 among its person's live keys" });
    expect(hidden.calls).toEqual(["me old-token"]);
    expect((await readBoardKey(unlisted.keyPath))?.token).toBe("old-token");
  });
});

describe("revokeReplacedKey", () => {
  it("revokes the replaced key with the key now stored, and counts one the core no longer has as gone", async () => {
    const { keyPath } = await storedKey();
    const { api, keys, calls } = fakeCore(DUE);
    expect(await revokeReplacedKey({ api, keyPath, keyId: "k1" })).toBe(true);
    expect(calls).toEqual(["revoke k1 with old-token"]);
    keys.push({ id: "k2", token: "other", expiresAt: DUE, revoked: false });
    await writeBoardKey(keyPath, { token: "other", userId: "u1", createdAt: NOW.toISOString() });
    expect(await revokeReplacedKey({ api, keyPath, keyId: "k1" })).toBe(true);
  });

  it("says so when the core refuses", async () => {
    const { keyPath } = await storedKey();
    const { api } = fakeCore(DUE, { revokeKey: async () => { throw new CoreApiError(500, null, "boom"); } });
    expect(await revokeReplacedKey({ api, keyPath, keyId: "k1" })).toBe(false);
  });
});

describe("createBoardKeyApi", () => {
  it("speaks the core's four board key routes with the token it is given", async () => {
    const requests: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    const answers: Record<string, unknown> = {
      "GET /api/cli-auth/me": { userId: "u1", keyId: "k1", source: "board_key" },
      "GET /api/board-api-keys": [{ id: "k1", name: "kyoube", expiresAt: DUE }, { id: "k0", expiresAt: null }, { id: "k9", expiresAt: 5 }, { id: "k8" }, { name: "no id" }],
      "POST /api/board-api-keys": { id: "k2", token: "pcp_board_new", expiresAt: RENEWED_UNTIL },
      "DELETE /api/board-api-keys/k1": { ok: true, keyId: "k1" },
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const route = `${init.method} ${url.replace("http://app:3100", "")}`;
      requests.push({ url: route, method: String(init.method), auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(answers[route]), { status: 200 });
    }) as typeof fetch;
    const api = createBoardKeyApi({ apiBase: "http://app:3100/", fetchImpl });
    expect(await api.whoAmI("t1")).toEqual({ userId: "u1", keyId: "k1" });
    expect(await api.listKeys("t1")).toEqual([{ id: "k1", expiresAt: DUE }, { id: "k0", expiresAt: null }, { id: "k9", expiresAt: "" }, { id: "k8", expiresAt: "" }]);
    expect(await api.createKey("t1", RENEWED_KEY_NAME)).toEqual({ id: "k2", token: "pcp_board_new", expiresAt: RENEWED_UNTIL });
    await api.revokeKey("t2", "k1");
    expect(requests).toEqual([
      { url: "GET /api/cli-auth/me", method: "GET", auth: "Bearer t1", body: null },
      { url: "GET /api/board-api-keys", method: "GET", auth: "Bearer t1", body: null },
      { url: "POST /api/board-api-keys", method: "POST", auth: "Bearer t1", body: { name: RENEWED_KEY_NAME } },
      { url: "DELETE /api/board-api-keys/k1", method: "DELETE", auth: "Bearer t2", body: null },
    ]);
  });

  it("refuses an answer to POST /api/board-api-keys without a key", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "k2" }), { status: 201 })) as typeof fetch;
    await expect(createBoardKeyApi({ apiBase: "http://app:3100", fetchImpl }).createKey("t1", "x")).rejects.toThrow(/without a key/);
  });
});
