import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The shared secret the `kyoube` CLI writes on the home volume (ruling R18): only the container's
 * own processes can read it, so a request carrying it came from `kyoube agent-rules`. The CLI
 * creates it (docker/bootstrap/src/key-store.ts); this plugin only reads it.
 */
export const RULES_TOKEN_PATH = "/kyoubeai/kyoube/rules-token";

/**
 * Whether `presented` is the token in `file`, compared in constant time. The file is read on every
 * call (no cache). A missing, unreadable or empty file, or a presented value that is not a
 * non-empty string, is a refusal. Never logs either value.
 */
export async function rulesTokenMatches(file: string, presented: unknown): Promise<boolean> {
  if (typeof presented !== "string" || presented.length === 0) return false;
  let expected: string;
  try {
    expected = (await readFile(file, "utf8")).trim();
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch; the token's length is fixed and not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}
