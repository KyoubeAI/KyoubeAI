import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileCompanyPolicy, compileIndex, createPolicyReader, readPolicyState, writePolicyFiles } from "../src/index.js";

const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const policy = compileCompanyPolicy({ companyId: C, mode: "need_to_know", groups: [{ seesAll: false, members: ["ann"], projects: ["p1"] }], writtenAt: "x" })!;

describe("readPolicyState", () => {
  it("is open when there is no index at all", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    expect(await readPolicyState(C, { dir })).toEqual({ state: "open" });
  });
  it("reads a written company as need-to-know and an unlisted or open one as open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }, { companyId: D, mode: "open" }], "x"), companies: [policy] });
    expect(await readPolicyState(C, { dir })).toEqual({ state: "need_to_know", policy });
    expect(await readPolicyState(D, { dir })).toEqual({ state: "open" });
    expect(await readPolicyState("33333333-3333-4333-8333-333333333333", { dir })).toEqual({ state: "open" });
  });
  it("is closed when the index is unreadable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writeFile(path.join(dir, "index.json"), "{");
    expect(await readPolicyState(C, { dir })).toMatchObject({ state: "closed", reason: "index unreadable" });
  });
  it("an index that names a need-to-know company with no file is closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writeFile(path.join(dir, "index.json"), JSON.stringify(compileIndex([{ companyId: C, mode: "need_to_know" }], "x")));
    expect(await readPolicyState(C, { dir })).toMatchObject({ state: "closed", reason: "company policy unreadable" });
  });
  it("a truncated or empty company file is closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "x"), companies: [policy] });
    await writeFile(path.join(dir, `${C}.json`), JSON.stringify(policy).slice(0, 40));
    expect(await readPolicyState(C, { dir })).toMatchObject({ state: "closed" });
    await writeFile(path.join(dir, `${C}.json`), "");
    expect(await readPolicyState(C, { dir })).toMatchObject({ state: "closed" });
  });
  it("a listed company key that is not an id is closed, never a throw", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writeFile(path.join(dir, "index.json"), JSON.stringify(compileIndex([{ companyId: "../etc", mode: "need_to_know" }], "x")));
    expect(await readPolicyState("../etc", { dir })).toMatchObject({ state: "closed", reason: "company policy unreadable" });
    expect(await createPolicyReader({ dir }).read("../etc")).toMatchObject({ state: "closed", reason: "company policy unreadable" });
  });
});

describe("writePolicyFiles", () => {
  it("writes mode 600, leaves no temp file, and removes the file of a company that went open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "x"), companies: [policy] });
    expect(((await stat(path.join(dir, `${C}.json`))).mode & 0o777)).toBe(0o600);
    expect(((await stat(path.join(dir, "index.json"))).mode & 0o777)).toBe(0o600);
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "open" }], "y"), companies: [] });
    expect((await readdir(dir)).sort()).toEqual(["index.json"]);
    expect(JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")).writtenAt).toBe("y");
  });
});

describe("createPolicyReader", () => {
  it("re-reads only when a file's modification time changes, checked at most every two seconds", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    let now = 1_000_000;
    let stats = 0;
    const fs = {
      readFile: (file: string) => readFile(file, "utf8"),
      stat: async (file: string) => { stats += 1; return stat(file); },
    };
    const reader = createPolicyReader({ dir, now: () => now, fs });
    expect(await reader.read(C)).toEqual({ state: "open" });
    const after = stats;
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "x"), companies: [policy] });
    expect(await reader.read(C)).toEqual({ state: "open" }); // within 2 s: cached, no stat
    expect(stats).toBe(after);
    now += 2_001;
    expect(await reader.read(C)).toEqual({ state: "need_to_know", policy });
    now += 2_001;
    expect(await reader.read(C)).toEqual({ state: "need_to_know", policy }); // stat, same mtime, no re-read
    reader.invalidate();
    expect(await reader.read(C)).toEqual({ state: "need_to_know", policy });
  });
  it("re-reads a state closed by a failed read at the next check, with no file change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vis-"));
    await writePolicyFiles({ dir, index: compileIndex([{ companyId: C, mode: "need_to_know" }], "x"), companies: [policy] });
    let now = 1_000_000;
    let failures = 1;
    const fs = {
      readFile: async (file: string) => {
        if (file.endsWith(`${C}.json`) && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
        }
        return readFile(file, "utf8");
      },
      stat: (file: string) => stat(file),
    };
    const reader = createPolicyReader({ dir, now: () => now, fs });
    expect(await reader.read(C)).toMatchObject({ state: "closed", reason: "company policy unreadable" });
    now += 2_001;
    expect(await reader.read(C)).toEqual({ state: "need_to_know", policy });
  });
});
