// Reading and writing the policy files. Node built-ins only on purpose: this file is bundled
// into the core's dependency-free decision module.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { PolicyState } from "./decide.js";
import { parseCompanyPolicy, parseIndex, policyPaths, type CompanyPolicy, type VisibilityIndex } from "./policy.js";

/** The two file operations the reader needs; a test can count or fake them. */
export interface PolicyFs {
  readFile(file: string): Promise<string>;
  stat(file: string): Promise<{ mtimeMs: number }>;
}

const nodePolicyFs: PolicyFs = { readFile: (file) => readFile(file, "utf8"), stat: (file) => stat(file) };

const OPEN: PolicyState = { state: "open" };

function closed(reason: string): PolicyState {
  return { state: "closed", reason };
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

/**
 * Uncached. No index at all means the feature was never turned on: open. Any other trouble
 * with the index, or with the file of a company the index says is need-to-know, is closed.
 */
export async function readPolicyState(companyId: string, opts: { dir?: string; fs?: PolicyFs } = {}): Promise<PolicyState> {
  const fs = opts.fs ?? nodePolicyFs;
  const paths = policyPaths(opts.dir);
  let indexText: string;
  try {
    indexText = await fs.readFile(paths.index);
  } catch (error) {
    return isMissing(error) ? OPEN : closed("index unreadable");
  }
  const index = parseIndex(indexText);
  if (index === null) return closed("index unreadable");
  if (!Object.hasOwn(index.companies, companyId)) return OPEN;
  // parseIndex does not check that keys are ids; a listed key that is not one has no readable file.
  let companyFile: string;
  try {
    companyFile = paths.company(companyId);
  } catch {
    return closed("company policy unreadable");
  }
  if (index.companies[companyId]?.mode !== "need_to_know") return OPEN;
  let companyText: string;
  try {
    companyText = await fs.readFile(companyFile);
  } catch {
    return closed("company policy unreadable");
  }
  const policy = parseCompanyPolicy(companyText, companyId);
  return policy === null ? closed("company policy unreadable") : { state: "need_to_know", policy };
}

export interface PolicyReader {
  read(companyId: string): Promise<PolicyState>;
  invalidate(): void;
}

/** A file's modification time, or that it is missing, or that stat failed (always re-read). */
type Stamp = number | "missing" | "error";

interface Checked {
  checkedAt: number;
  stamps: [Stamp, Stamp];
  state: PolicyState;
}

/**
 * Per company, the last state and the modification times it was read at. Within `checkMs` of the
 * last check a read is answered from memory; after that the index and the company file are
 * stat'ed and read again only when one changed, appeared or disappeared, or the last state was
 * closed.
 */
export function createPolicyReader(opts: { dir?: string; checkMs?: number; now?: () => number; fs?: PolicyFs } = {}): PolicyReader {
  const { dir } = opts;
  const checkMs = opts.checkMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const fs = opts.fs ?? nodePolicyFs;
  const paths = policyPaths(dir);
  const checked = new Map<string, Checked>();
  const running = new Map<string, Promise<PolicyState>>();
  let generation = 0;

  async function stampOf(file: string | null): Promise<Stamp> {
    if (file === null) return "missing";
    try {
      return (await fs.stat(file)).mtimeMs;
    } catch (error) {
      return isMissing(error) ? "missing" : "error";
    }
  }

  function companyFile(companyId: string): string | null {
    try {
      return paths.company(companyId);
    } catch {
      return null;
    }
  }

  async function check(companyId: string, previous: Checked | undefined): Promise<PolicyState> {
    const started = generation;
    const checkedAt = now();
    const stamps: [Stamp, Stamp] = [await stampOf(paths.index), await stampOf(companyFile(companyId))];
    // A closed state is never kept on unchanged stamps: it may come from a passing read error
    // (EMFILE, EIO) on a file that is fine, so it is read again at every check.
    const unchanged = previous !== undefined && previous.state.state !== "closed" && stamps.every((stamp, i) => stamp !== "error" && stamp === previous.stamps[i]);
    const state = unchanged ? previous.state : await readPolicyState(companyId, { dir, fs });
    if (started === generation) checked.set(companyId, { checkedAt, stamps, state });
    return state;
  }

  return {
    read(companyId) {
      const previous = checked.get(companyId);
      if (previous !== undefined && now() - previous.checkedAt < checkMs) return Promise.resolve(previous.state);
      const inFlight = running.get(companyId);
      if (inFlight !== undefined) return inFlight;
      const started = generation;
      const result = check(companyId, previous).finally(() => {
        if (started === generation) running.delete(companyId);
      });
      running.set(companyId, result);
      return result;
    },
    invalidate() {
      generation += 1;
      checked.clear();
      running.clear();
    },
  };
}

/** The writes the writer needs; defaults to node:fs/promises. */
export interface PolicyWriteFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, opts: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  rm(file: string, opts: { force: true }): Promise<void>;
}

const nodeWriteFs: PolicyWriteFs = {
  mkdir: (dir, opts) => mkdir(dir, opts),
  writeFile: (file, data, opts) => writeFile(file, data, opts),
  rename: (from, to) => rename(from, to),
  readdir: (dir) => readdir(dir),
  rm: (file, opts) => rm(file, opts),
};

let tempSequence = 0;

/** Readers see the old file or the new one, never half of one. */
async function writeAtomically(fs: PolicyWriteFs, file: string, data: unknown): Promise<void> {
  tempSequence += 1;
  const temp = `${file}.${process.pid}.${Date.now()}.${tempSequence}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Company files first, then the index, so the index never names a need-to-know company whose
 * new file is not yet in place. Then every other `*.json` goes: a company that went open or away.
 */
export async function writePolicyFiles(input: { dir?: string; index: VisibilityIndex; companies: CompanyPolicy[]; fs?: PolicyWriteFs }): Promise<void> {
  const fs = input.fs ?? nodeWriteFs;
  const paths = policyPaths(input.dir);
  await fs.mkdir(paths.dir, { recursive: true });
  const keep = new Set(["index.json"]);
  for (const policy of input.companies) {
    const file = paths.company(policy.companyId);
    keep.add(`${policy.companyId}.json`);
    await writeAtomically(fs, file, policy);
  }
  await writeAtomically(fs, paths.index, input.index);
  for (const name of await fs.readdir(paths.dir)) {
    if (name.endsWith(".json") && !keep.has(name)) await fs.rm(`${paths.dir}/${name}`, { force: true });
  }
}
