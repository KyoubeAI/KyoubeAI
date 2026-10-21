import { describe, expect, it } from "vitest";
import { ASK_LEVEL_KEY, askLevelOf, hasAskLevel, isBuiltInAgent, withAskLevel } from "../src/agent-rules/ask-levels.js";

describe("ask levels in agent metadata", () => {
  it("reads none and any, and everything else as line, as the core patch does", () => {
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "none" })).toBe("none");
    expect(askLevelOf({ [ASK_LEVEL_KEY]: "any" })).toBe("any");
    for (const other of [{ [ASK_LEVEL_KEY]: "line" }, { [ASK_LEVEL_KEY]: "Any" }, {}, null, undefined, ["none"]]) expect(askLevelOf(other)).toBe("line");
  });

  it("keeps every other key, and removes the key for line", () => {
    const metadata = { paperclipBuiltInAgent: { key: "x" }, note: "kept" };
    expect(withAskLevel(metadata, "none")).toEqual({ paperclipBuiltInAgent: { key: "x" }, note: "kept", [ASK_LEVEL_KEY]: "none" });
    expect(withAskLevel({ ...metadata, [ASK_LEVEL_KEY]: "any" }, "line")).toEqual(metadata);
    expect(withAskLevel(null, "any")).toEqual({ [ASK_LEVEL_KEY]: "any" });
    expect(withAskLevel(undefined, "line")).toEqual({});
    expect(metadata).toEqual({ paperclipBuiltInAgent: { key: "x" }, note: "kept" });
  });

  it("says whether the key is there at all", () => {
    expect(hasAskLevel({ [ASK_LEVEL_KEY]: "line" })).toBe(true);
    expect(hasAskLevel({})).toBe(false);
    expect(hasAskLevel(null)).toBe(false);
  });

  it("knows the core's built-in agents by the core's own rule", () => {
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: ["reflection"] } })).toBe(true);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: 3, featureKeys: [] } })).toBe(false);
    expect(isBuiltInAgent(null)).toBe(false);
  });

  it("does not take a marker the core would not read, which an agent could add to itself", () => {
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "reflection-coach" } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: " ", featureKeys: [] } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: "reflection" } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: ["reflection", ""] } })).toBe(false);
    expect(isBuiltInAgent({ paperclipBuiltInAgent: { key: "x", featureKeys: [1] } })).toBe(false);
  });
});
