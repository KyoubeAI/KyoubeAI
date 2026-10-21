import { describe, expect, it } from "vitest";
import { isBuiltInAgent, levelOf, parseAskLevel, parseAskLevels, pruneAskLevels, withAskLevel } from "../src/ask-levels.js";

describe("ask levels", () => {
  it("parses only the three levels", () => {
    expect(parseAskLevel("none")).toBe("none");
    expect(parseAskLevel("line")).toBe("line");
    expect(parseAskLevel("any")).toBe("any");
    for (const bad of ["ANY", "", "everyone", null, undefined, 3]) expect(parseAskLevel(bad)).toBeNull();
  });

  it("reads a stored map tolerantly: only none and any survive", () => {
    expect(parseAskLevels({ a: "none", b: "any", c: "line", d: "x", e: 1 })).toEqual({ a: "none", b: "any" });
    expect(parseAskLevels(null)).toEqual({});
    expect(parseAskLevels(["none"])).toEqual({});
  });

  it("stores none and any, and removes the entry for line", () => {
    expect(withAskLevel({}, "a", "none")).toEqual({ a: "none" });
    expect(withAskLevel({ a: "none" }, "a", "any")).toEqual({ a: "any" });
    expect(withAskLevel({ a: "none", b: "any" }, "a", "line")).toEqual({ b: "any" });
  });

  it("reads an agent's level, line when it has no entry", () => {
    expect(levelOf({ a: "any" }, "a")).toBe("any");
    expect(levelOf({ a: "any" }, "b")).toBe("line");
  });

  it("keeps only entries for live agents", () => {
    expect(pruneAskLevels({ a: "none", gone: "any" }, new Set(["a", "b"]))).toEqual({ a: "none" });
  });

  it("knows the core's built-in agents by the core's own rule", () => {
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: ["reflection"] } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: {} })).toBe(false);
    expect(isBuiltInAgent(null)).toBe(false);
    expect(isBuiltInAgent({ kyoubeAskLevel: "none" })).toBe(false);
  });

  it("does not take a marker the core would not read, which an agent could add to itself", () => {
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach" } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: " ", featureKeys: [] } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: "reflection" } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: ["reflection", ""] } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: [1] } })).toBe(false);
  });
});
