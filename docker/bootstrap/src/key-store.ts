import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KyoubeConfig } from "./config.js";

export interface BoardKeyRecord {
  token: string;
  userId: string | null;
  createdAt: string;
}

export function resolveBoardKeyPath(config: KyoubeConfig): string {
  return path.posix.join(config.home, "kyoube", "board-key.json");
}

/**
 * Read the stored board API key, or `null` when there isn't a usable one.
 *
 * A truncated or hand-edited `board-key.json` is treated as *missing* (with a
 * warning) rather than fatal: `ensure-plugins --watch` re-reads this file every
 * 60 s for the life of the container, so throwing here would turn one corrupt
 * file into an endless crash loop instead of the "run kyoube setup" path that
 * actually fixes it.
 */
export async function readBoardKey(
  filePath: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<BoardKeyRecord | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: Partial<BoardKeyRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<BoardKeyRecord>;
  } catch (error) {
    warn(
      `kyoube: ignoring malformed ${filePath} (${error instanceof Error ? error.message : String(error)}); ` +
        "treating it as no stored key — re-run kyoube setup",
    );
    return null;
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
  return {
    token: parsed.token,
    userId: typeof parsed.userId === "string" ? parsed.userId : null,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
  };
}

/**
 * Stores the board key (mode 600). It is written to a private temporary file, synced to disk and
 * renamed into place, so the loops that re-read it every minute never see half a file when the
 * agent-rules loop renews it, and a crash never leaves an empty one.
 */
export async function writeBoardKey(filePath: string, record: BoardKeyRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The kyoube CLI's rules token (ruling R18): 32 random bytes as hex, mode 600, beside the board key.
 * `kyoube agent-rules` sends it in the body of every call to the agent-rules and group routes, and
 * the plugins read the same file to tell the CLI's calls from any other signed-in person's.
 */
export function resolveRulesTokenPath(config: Pick<KyoubeConfig, "home">): string {
  return path.posix.join(config.home, "kyoube", "rules-token");
}

/** The stored rules token; null when the file is missing, and "" when it exists but is blank. */
async function readRulesToken(filePath: string): Promise<string | null> {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Returns the rules token, creating the file first when it is missing (or blank). The new token is
 * written to a private temporary file and then linked into place, which fails if another process
 * created the file meanwhile, so two first runs agree on one token. Never logs the token.
 */
export async function ensureRulesToken(filePath: string): Promise<string> {
  const existing = await readRulesToken(filePath);
  if (existing) return existing;
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (existing === "") await rename(temporary, filePath);
    else await link(temporary, filePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  } finally {
    await rm(temporary, { force: true });
  }
  const token = await readRulesToken(filePath);
  if (!token) throw new Error(`could not create the rules token at ${filePath}`);
  return token;
}

export async function resolveBoardApiKey(
  env: NodeJS.ProcessEnv,
  filePath: string,
  explicit?: string,
): Promise<string | null> {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = env.KYOUBE_BOARD_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = await readBoardKey(filePath);
  return stored?.token ?? null;
}
