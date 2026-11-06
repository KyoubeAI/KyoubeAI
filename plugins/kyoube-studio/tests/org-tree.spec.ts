import { describe, expect, it } from "vitest";
import { buildOrgTree, focusIds, panelName, panelOf, tallyText } from "../src/org/org-tree.js";
import { FIVE_ROOTS, FLAT, INDUSTRIAL, ONE_ROOT_DEEP, org } from "./org-fixtures.js";

describe("the org tree", () => {
  it("builds heads, offices, teams and the shelf", () => {
    const tree = buildOrgTree(FIVE_ROOTS);
    expect(tree.heads.length).toBe(1);
    expect(tree.heads[0]!.panels.map((p) => p.kind)).toEqual(["office", "team"]);
    expect(tree.teams.length).toBe(2);
    expect(tree.shelf.length).toBe(2);
  });

  it("nests deeper levels inside the team", () => {
    const tree = buildOrgTree(INDUSTRIAL);
    expect(tree.heads.length).toBe(1);
    expect(tree.heads[0]!.panels.length).toBe(5);
    expect(tree.heads[0]!.panels.some((p) => p.kind === "office")).toBe(false);
    const team = tree.heads[0]!.panels.find((p) => p.id === "team:pat")!;
    expect(team.members.length).toBe(4);
    expect(team.members.find((m) => m.agent.name === "Lead Ana")!.children.length).toBe(2);
    expect(tallyText(team.tally)).toBe("11 agents");
    expect(INDUSTRIAL.filter((a) => a.reportsTo).length).toBe(31);
  });

  it("indents at depth 4", () => {
    const team = buildOrgTree(ONE_ROOT_DEEP).heads[0]!.panels[0]!;
    const deep = team.members.flatMap((m) => m.children.flatMap((c) => c.children));
    expect(deep.map((n) => n.agent.id)).toContain("ss1");
  });

  it("a flat company puts everyone on the shelf except the one small team", () => {
    const tree = buildOrgTree(FLAT);
    expect(tree.heads).toEqual([]);
    expect(tree.teams.length).toBe(1);
    expect(tree.teams[0]!.tally.agents).toBe(3);
    expect(tree.shelf.length).toBe(25);
  });

  it("a flat company with no managers at all puts everyone on the shelf", () => {
    const tree = buildOrgTree(FLAT.map((a) => ({ ...a, reportsTo: null })));
    expect(tree.heads).toEqual([]);
    expect(tree.teams).toEqual([]);
    expect(tree.shelf.length).toBe(28);
  });

  it("breaks a reportsTo loop at the first agent in the list", () => {
    const tree = buildOrgTree(org([["a", "A", "b"], ["b", "B", "a"], ["c", "C", "a"]]));
    expect(tree.managerOf.get("a")).toBeNull();
    expect(tree.managerOf.get("b")).toBe("a");
    expect(tree.teams.map((t) => t.id)).toEqual(["team:a"]);
    expect(tree.teams[0]!.members.map((m) => m.agent.name)).toEqual(["B", "C"]);
  });

  it("an unknown manager makes the agent top-level", () => {
    expect(buildOrgTree(org([["x", "X", "gone"]])).shelf[0]!.id).toBe("x");
    const tree = buildOrgTree(org([["x", "X", "gone"], ["y", "Y", "x"]]));
    expect(tree.teams[0]!.id).toBe("team:x");
  });

  it("names panels by the lead's name, possessive only for one-word names", () => {
    expect(panelName("Kai", "team")).toBe("Kai's team");
    expect(panelName("Ava", "office")).toBe("Ava's office");
    expect(panelName("Product Lead, Field", "team")).toBe("Team · Product Lead, Field");
    expect(panelName("Ops Lee", "office")).toBe("Office · Ops Lee");
  });

  it("tally text leaves out idle and zero counts", () => {
    expect(tallyText({ agents: 4, working: 2, waiting: 0, attention: 1, paused: 0 })).toBe("4 agents · 2 working · 1 stuck");
    expect(tallyText({ agents: 1, working: 0, waiting: 0, attention: 0, paused: 0 })).toBe("1 agent");
  });

  it("focusIds is the chain up and the direct reports", () => {
    const tree = buildOrgTree(ONE_ROOT_DEEP);
    expect([...focusIds(tree, "m1")].sort()).toEqual(["m1", "root", "s1", "s2", "t1"]);
    expect([...focusIds(tree, "ghost")]).toEqual([]);
  });

  it("finds the panel that holds an agent", () => {
    const tree = buildOrgTree(ONE_ROOT_DEEP);
    expect(panelOf(tree, "t1")).toBe("team:t1");
    expect(panelOf(tree, "ss1")).toBe("team:t1");
    expect(panelOf(tree, "root")).toBeNull();
    expect(panelOf(buildOrgTree(FIVE_ROOTS), "ofc1")).toBe("office:ava");
    expect(panelOf(buildOrgTree(FIVE_ROOTS), "zed")).toBeNull();
  });

  it("orders members by state then name", () => {
    const tree = buildOrgTree(org([["l", "Lead", null], ["a", "Aaa", "l", "idle"], ["z", "Zzz", "l", "working"]]));
    expect(tree.teams[0]!.members.map((m) => m.agent.id)).toEqual(["z", "a"]);
  });

  it("flags a panel with a stuck member", () => {
    const tree = buildOrgTree(org([["l", "Lead", null], ["a", "A", "l", "attention"]]));
    expect(tree.teams[0]!.attention).toBe(true);
    expect(tallyText(tree.teams[0]!.tally)).toBe("2 agents · 1 stuck");
  });
});
