import { CoreApiError, createJsonRequest, type CoreClientOptions } from "./core-api.js";
import { readBoardKey, writeBoardKey } from "./key-store.js";

/**
 * The core gives a board key from `kyoube setup` (its CLI login) 30 days
 * (BOARD_API_KEY_TTL_MS, server/src/services/board-auth.ts). An expired key
 * stops every kyoube call: plugin updates, the agent working rules and user
 * groups. So the agent-rules loop renews the stored key while it still works:
 * once it has less than RENEW_WITHIN_MS left, the loop mints a replacement for
 * the same person through the core's own `POST /api/board-api-keys` (which gives
 * it the core's 30 days), checks that the core takes it and stores it. It
 * revokes the old one at its next check, an hour later, so nothing that read
 * the old key just before is refused mid-call. A key from KYOUBE_BOARD_API_KEY
 * or --api-key belongs to whoever set it, and is never renewed.
 */
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the loop asks the core when the stored key expires. */
export const RENEWAL_CHECK_MS = 60 * 60 * 1000;
/** The name the person sees for a renewed key under their API keys. */
export const RENEWED_KEY_NAME = "kyoube (renewed)";

export interface BoardKeyInfo {
  id: string;
  expiresAt: string | null;
}

export interface BoardKeyApi {
  /** `GET /api/cli-auth/me` with TOKEN: its key id (null unless TOKEN is a board key) and its person. */
  whoAmI(token: string): Promise<{ userId: string | null; keyId: string | null }>;
  /** `GET /api/board-api-keys` with TOKEN: its person's live keys. */
  listKeys(token: string): Promise<BoardKeyInfo[]>;
  /** `POST /api/board-api-keys` with TOKEN: a new key for the same person, with the core's default expiry. */
  createKey(token: string, name: string): Promise<BoardKeyInfo & { token: string }>;
  /** `DELETE /api/board-api-keys/:keyId` with TOKEN. */
  revokeKey(token: string, keyId: string): Promise<void>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** An expiry as the core sent it: null only when the core says null (never expires); anything else unreadable becomes "". */
function expiry(value: unknown): string | null {
  return value === null ? null : typeof value === "string" ? value : "";
}

export function createBoardKeyApi(opts: Pick<CoreClientOptions, "apiBase" | "fetchImpl">): BoardKeyApi {
  const request = createJsonRequest(opts);
  return {
    async whoAmI(token) {
      const me = await request<{ userId?: unknown; keyId?: unknown } | null>("/api/cli-auth/me", { token });
      return { userId: text(me?.userId), keyId: text(me?.keyId) };
    },
    async listKeys(token) {
      const rows = await request<unknown>("/api/board-api-keys", { token });
      return (Array.isArray(rows) ? rows : []).flatMap((row: { id?: unknown; expiresAt?: unknown }) => {
        const id = text(row?.id);
        return id ? [{ id, expiresAt: expiry(row.expiresAt) }] : [];
      });
    },
    async createKey(token, name) {
      const key = await request<{ id?: unknown; token?: unknown; expiresAt?: unknown } | null>("/api/board-api-keys", { method: "POST", body: { name }, token });
      const id = text(key?.id);
      const secret = text(key?.token);
      if (!id || !secret) throw new Error("the core answered POST /api/board-api-keys without a key");
      return { id, token: secret, expiresAt: expiry(key?.expiresAt) };
    },
    async revokeKey(token, keyId) {
      await request(`/api/board-api-keys/${encodeURIComponent(keyId)}`, { method: "DELETE", token });
    },
  };
}

/** When TOKEN's own key expires: its id and expiry (null: never), from the core. */
export async function currentKey(api: BoardKeyApi, token: string): Promise<BoardKeyInfo & { userId: string | null }> {
  const me = await api.whoAmI(token);
  if (!me.keyId) throw new Error("the core did not say which board key this is");
  const key = (await api.listKeys(token)).find((row) => row.id === me.keyId);
  if (!key) throw new Error(`the core does not list board key ${me.keyId} among its person's live keys`);
  if (key.expiresAt !== null && !Number.isFinite(Date.parse(key.expiresAt))) {
    throw new Error(`the core gave board key ${key.id} an expiry KyoubeAI cannot read`);
  }
  return { ...key, userId: me.userId };
}

export type BoardKeyRenewal =
  | { status: "not-due"; expiresAt: string | null }
  | { status: "renewed"; expiresAt: string | null; oldKeyId: string }
  | { status: "failed"; reason: string };

/**
 * Renews the key stored at KEY_PATH when it has less than RENEW_WITHIN_MS
 * left; null when no key is stored. The new key is stored only once the core
 * has taken it, and only if the file still holds the key it replaces (a
 * `kyoube setup` meanwhile wins), so a failure at any step leaves a working key
 * in the file. A new key that was not stored is revoked again. The old key is
 * left to revokeReplacedKey.
 */
export async function renewBoardKeyIfDue(input: { api: BoardKeyApi; keyPath: string; now: Date }): Promise<BoardKeyRenewal | null> {
  const { api, keyPath, now } = input;
  const stored = await readBoardKey(keyPath);
  if (!stored) return null;
  try {
    const current = await currentKey(api, stored.token);
    if (current.expiresAt === null || Date.parse(current.expiresAt) - now.getTime() > RENEW_WITHIN_MS) {
      return { status: "not-due", expiresAt: current.expiresAt };
    }
    const fresh = await api.createKey(stored.token, RENEWED_KEY_NAME);
    const dropFresh = () => api.revokeKey(fresh.token, fresh.id).catch(() => {});
    const check = await api.whoAmI(fresh.token).catch(() => null);
    if (check?.keyId !== fresh.id) {
      await dropFresh();
      return { status: "failed", reason: "the core did not take the new key" };
    }
    if ((await readBoardKey(keyPath))?.token !== stored.token) {
      await dropFresh();
      return { status: "failed", reason: "the stored key changed while it was being renewed (kyoube setup?), so the new one was dropped" };
    }
    try {
      await writeBoardKey(keyPath, { token: fresh.token, userId: check.userId ?? stored.userId, createdAt: now.toISOString() });
    } catch (error) {
      if ((await readBoardKey(keyPath).catch(() => null))?.token !== fresh.token) await dropFresh();
      throw error;
    }
    return { status: "renewed", expiresAt: fresh.expiresAt, oldKeyId: current.id };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Revokes KEY_ID, the key a renewal replaced, with the key now stored. True
 * when the core revoked it or no longer has it (already revoked or expired).
 */
export async function revokeReplacedKey(input: { api: BoardKeyApi; keyPath: string; keyId: string }): Promise<boolean> {
  const stored = await readBoardKey(input.keyPath);
  if (!stored) return false;
  try {
    await input.api.revokeKey(stored.token, input.keyId);
    return true;
  } catch (error) {
    return error instanceof CoreApiError && error.status === 404;
  }
}
