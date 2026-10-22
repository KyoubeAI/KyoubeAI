import { describe, expect, it } from "vitest";
import { compileCompanyPolicy, compileIndex, parseCompanyPolicy, parseIndex, parseMode, policyPaths, VISIBILITY_DIR } from "../src/index.js";

const C = "11111111-1111-4111-8111-111111111111";

describe("policyPaths", () => {
  it("names the index and one file per company under the visibility dir", () => {
    const paths = policyPaths();
    expect(paths.dir).toBe(VISIBILITY_DIR);
    expect(paths.index).toBe(`${VISIBILITY_DIR}/index.json`);
    expect(paths.company(C)).toBe(`${VISIBILITY_DIR}/${C}.json`);
  });
  it("refuses a company id that is not an id", () => {
    expect(() => policyPaths().company("../etc/passwd")).toThrow("companyId is not an id");
  });
});

describe("parseMode", () => {
  it("accepts the two modes and nothing else", () => {
    expect(parseMode("open")).toBe("open");
    expect(parseMode("need_to_know")).toBe("need_to_know");
    expect(parseMode("Open")).toBeNull();
    expect(parseMode("")).toBeNull();
    expect(parseMode(undefined)).toBeNull();
  });
});

describe("compile and parse", () => {
  const groups = [
    { seesAll: true, members: ["boss"], projects: [] },
    { seesAll: false, members: ["ann", "bob", "ann"], projects: ["p1", "p2"] },
    { seesAll: false, members: ["cid"], projects: ["p2"] },
  ];
  it("compiles sees-all people and the people of each project, de-duplicated and sorted", () => {
    const policy = compileCompanyPolicy({ companyId: C, mode: "need_to_know", groups, writtenAt: "2026-10-22T00:00:00.000Z" });
    expect(policy).toEqual({ version: 1, companyId: C, mode: "need_to_know", writtenAt: "2026-10-22T00:00:00.000Z", seesAll: ["boss"], projects: { p1: ["ann", "bob"], p2: ["ann", "bob", "cid"] } });
  });
  it("compiles nothing for an open company", () => {
    expect(compileCompanyPolicy({ companyId: C, mode: "open", groups, writtenAt: "x" })).toBeNull();
  });
  it("round-trips through parse", () => {
    const policy = compileCompanyPolicy({ companyId: C, mode: "need_to_know", groups, writtenAt: "x" })!;
    expect(parseCompanyPolicy(JSON.stringify(policy), C)).toEqual(policy);
  });
  it("rejects a company file that is not exactly the shape", () => {
    expect(parseCompanyPolicy("", C)).toBeNull();
    expect(parseCompanyPolicy("{", C)).toBeNull();
    expect(parseCompanyPolicy(JSON.stringify({ version: 2, companyId: C, mode: "need_to_know", writtenAt: "x", seesAll: [], projects: {} }), C)).toBeNull();
    expect(parseCompanyPolicy(JSON.stringify({ version: 1, companyId: "other", mode: "need_to_know", writtenAt: "x", seesAll: [], projects: {} }), C)).toBeNull();
    expect(parseCompanyPolicy(JSON.stringify({ version: 1, companyId: C, mode: "open", writtenAt: "x", seesAll: [], projects: {} }), C)).toBeNull();
    expect(parseCompanyPolicy(JSON.stringify({ version: 1, companyId: C, mode: "need_to_know", writtenAt: "x", seesAll: [1], projects: {} }), C)).toBeNull();
    expect(parseCompanyPolicy(JSON.stringify({ version: 1, companyId: C, mode: "need_to_know", writtenAt: "x", seesAll: [], projects: { p1: "ann" } }), C)).toBeNull();
  });
  it("compiles and parses the index", () => {
    const index = compileIndex([{ companyId: C, mode: "need_to_know" }, { companyId: "22222222-2222-4222-8222-222222222222", mode: "open" }], "x");
    expect(index.companies[C]).toEqual({ mode: "need_to_know" });
    expect(parseIndex(JSON.stringify(index))).toEqual(index);
    expect(parseIndex("nope")).toBeNull();
    expect(parseIndex(JSON.stringify({ version: 1, writtenAt: "x", companies: { [C]: { mode: "sometimes" } } }))).toBeNull();
  });
});
