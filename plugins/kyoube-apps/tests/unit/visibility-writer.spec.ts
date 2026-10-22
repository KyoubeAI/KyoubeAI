import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CompileGroup, VisibilityMode } from "@kyoube/visibility";
import { describe, expect, it } from "vitest";
import { VisibilityWriter } from "../../src/groups/visibility-writer.js";

const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-22T10:00:00.000Z");
const GROUPS: CompileGroup[] = [{ seesAll: true, members: ["lead"], projects: [] }, { seesAll: false, members: ["op"], projects: ["p1"] }];

/** C is need-to-know, D is open; `input` runs inside every visibilityInput call. */
function fakeStore(opts: { modes?: Array<{ companyId: string; mode: VisibilityMode }>; input?: (companyId: string) => Promise<void> } = {}) {
  const calls = { allModes: 0, visibilityInput: [] as string[] };
  const modes = opts.modes ?? [{ companyId: C, mode: "need_to_know" }, { companyId: D, mode: "open" }];
  const store = {
    async allModes() {
      calls.allModes += 1;
      return modes;
    },
    async visibilityInput(companyId: string) {
      calls.visibilityInput.push(companyId);
      await opts.input?.(companyId);
      return { mode: "need_to_know" as const, groups: GROUPS };
    },
  };
  return { store, calls };
}

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "kyoube-visibility-writer-"));
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("VisibilityWriter", () => {
  it("writes the index and one file per need-to-know company, and removes files of open companies", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, `${D}.json`), "{}");
    await new VisibilityWriter({ store: fakeStore().store, dir, now: () => NOW, log: () => {} }).write();
    expect(await readJson(path.join(dir, "index.json"))).toEqual({ version: 1, writtenAt: NOW.toISOString(), companies: { [C]: { mode: "need_to_know" }, [D]: { mode: "open" } } });
    expect(await readJson(path.join(dir, `${C}.json`))).toEqual({ version: 1, companyId: C, mode: "need_to_know", writtenAt: NOW.toISOString(), seesAll: ["lead"], projects: { p1: ["op"] } });
    expect((await readdir(dir)).sort()).toEqual([`${C}.json`, "index.json"]);
  });

  it("coalesces concurrent writes into at most one extra run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, calls } = fakeStore({ input: () => gate });
    const writer = new VisibilityWriter({ store, dir: await tempDir(), log: () => {} });
    const writes = [writer.write(), writer.write(), writer.write()];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.allModes).toBe(1); // the later calls wait for the running write
    release();
    await Promise.all(writes);
    expect(calls.allModes).toBe(2);
  });

  it("reports counts", async () => {
    const writer = new VisibilityWriter({ store: fakeStore().store, dir: await tempDir(), log: () => {} });
    expect(await writer.write()).toEqual({ companies: 2, needToKnow: 1 });
  });

  it("leaves out a company whose groups cannot be read, so the core treats it as closed, and still writes the others", async () => {
    const dir = await tempDir();
    const logged: Array<[string, Record<string, unknown> | undefined]> = [];
    const { store } = fakeStore({
      modes: [{ companyId: C, mode: "need_to_know" }, { companyId: E, mode: "need_to_know" }],
      input: async (companyId) => { if (companyId === E) throw new Error("statement timeout"); },
    });
    const writer = new VisibilityWriter({ store, dir, log: (message, meta) => void logged.push([message, meta]) });
    expect(await writer.write()).toEqual({ companies: 2, needToKnow: 1 });
    expect((await readdir(dir)).sort()).toEqual([`${C}.json`, "index.json"]);
    expect((await readJson(path.join(dir, "index.json"))).companies[E]).toEqual({ mode: "need_to_know" });
    expect(logged).toEqual([["visibility policy compile failed; the core treats the company as closed", { companyId: E, error: "Error: statement timeout" }]]);
  });
});
