import { describe, expect, it } from "vitest";
import { buildOrgTree } from "../src/org/org-tree.js";
import { CAPTION_ROOM, bottomInsetOf, collapsedKey, defaultCollapsed, fillHeight, fitView, readCollapsed, tourView, writeCollapsed, zoomAt } from "../src/org/org-view.js";
import { FIVE_ROOTS } from "./org-fixtures.js";

describe("fitView", () => {
  it("centres and clamps", () => {
    const v = fitView({ x: 0, y: 0, w: 1000, h: 500 }, { w: 1064, h: 800 });
    expect(v.scale).toBeCloseTo(1, 5);
    expect(v.x).toBeCloseTo(32, 5);
    expect(v.y).toBeCloseTo(150, 5);
    expect(fitView({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 1000 }).scale).toBe(2);
    expect(fitView({ x: 0, y: 0, w: 100000, h: 100000 }, { w: 500, h: 500 }).scale).toBe(0.25);
  });
  it("centres content with a non-zero origin", () => {
    const b = { x: -100, y: 40, w: 400, h: 200 };
    const v = fitView(b, { w: 1000, h: 600 }, 0);
    expect(v.scale).toBe(2);
    expect((b.x + b.w / 2) * v.scale + v.x).toBeCloseTo(500, 5);
    expect((b.y + b.h / 2) * v.scale + v.y).toBeCloseTo(300, 5);
  });
});

describe("tourView", () => {
  it("keeps a stop clear of the caption band at the bottom", () => {
    // A tall team stop, like Kyoube Industrial Systems' Director of Product with eleven agents.
    const stop = { x: 400, y: 156, w: 276, h: 840 };
    for (const viewport of [{ w: 1440, h: 900 }, { w: 390, h: 844 }, { w: 1920, h: 1080 }]) {
      const v = tourView(stop, viewport);
      expect(stop.y * v.scale + v.y).toBeGreaterThanOrEqual(0);
      expect((stop.y + stop.h) * v.scale + v.y).toBeLessThanOrEqual(viewport.h - CAPTION_ROOM + 0.001);
      expect((stop.x + stop.w / 2) * v.scale + v.x).toBeCloseTo(viewport.w / 2, 5);
    }
  });
});

describe("filling the window", () => {
  const box = (tag: string, overflowY: string, paddingBottom: string) => ({ tag, overflowY, paddingBottom });

  it("takes the bottom padding of the nearest scrolling ancestor", () => {
    // The core on a desktop: <main> scrolls, with 24 px of padding under the page.
    expect(bottomInsetOf([box("div", "visible", "0px"), box("div", "visible", "0px"), box("main", "auto", "24px"), box("div", "visible", "0px")])).toBe(24);
    expect(bottomInsetOf([box("div", "scroll", "12.5px"), box("main", "auto", "24px")])).toBe(12.5);
  });

  it("stops at <main> when the document scrolls, so a phone's tab-bar padding counts", () => {
    // The core on a phone: <main> does not scroll, and its 80 px padding keeps the page clear of the tab bar.
    expect(bottomInsetOf([box("div", "visible", "0px"), box("main", "visible", "80px"), box("body", "visible", "0px")])).toBe(80);
  });

  it("is zero on a plain page with no scroller or <main>", () => {
    expect(bottomInsetOf([box("div", "visible", "0px"), box("body", "visible", "8px")])).toBe(0);
    expect(bottomInsetOf([])).toBe(0);
    expect(bottomInsetOf([box("main", "auto", "")])).toBe(0);
  });

  it("fills the window below the chart's top, never under 520 px", () => {
    expect(fillHeight({ windowHeight: 900, top: 146, bottomInset: 24 })).toBe(730);
    expect(fillHeight({ windowHeight: 844, top: 138, bottomInset: 80 })).toBe(626);
    expect(fillHeight({ windowHeight: 600.6, top: 30.2, bottomInset: 10 })).toBe(560);
    expect(fillHeight({ windowHeight: 500, top: 146, bottomInset: 24 })).toBe(520);
  });
});

describe("zoomAt", () => {
  it("keeps the point fixed", () => {
    const view = { x: 40, y: -20, scale: 1 };
    const p = { x: 300, y: 200 };
    const content = { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
    for (const f of [1.5, 0.5, 100, 0.001]) {
      const v = zoomAt(view, p, f);
      expect(v.scale).toBeGreaterThanOrEqual(0.25);
      expect(v.scale).toBeLessThanOrEqual(2);
      expect(content.x * v.scale + v.x).toBeCloseTo(p.x, 2);
      expect(content.y * v.scale + v.y).toBeCloseTo(p.y, 2);
    }
  });
});

describe("collapse defaults and storage", () => {
  const tree = buildOrgTree(FIVE_ROOTS);
  const all = [...tree.heads.flatMap((h) => h.panels), ...tree.teams].map((p) => p.id);

  it("defaultCollapsed is empty up to 60 agents and every panel above", () => {
    expect(all.length).toBeGreaterThan(0);
    expect(defaultCollapsed(tree, 60).size).toBe(0);
    expect([...defaultCollapsed(tree, 61)].sort()).toEqual([...all].sort());
  });

  it("readCollapsed survives a throwing, missing or junk store", () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readCollapsed({ getItem: () => { throw new Error("denied"); } }, "k")).toBeNull();
    expect(readCollapsed(null, "k")).toBeNull();
    expect(readCollapsed(undefined, "k")).toBeNull();
    expect(readCollapsed(store(null), "k")).toBeNull();
    expect(readCollapsed(store("not json"), "k")).toBeNull();
    expect(readCollapsed(store("{}"), "k")).toBeNull();
    expect(readCollapsed(store('[1,"team:a"]'), "k")).toEqual(new Set(["team:a"]));
  });

  it("writeCollapsed stores an array and swallows a throwing store", () => {
    const seen: [string, string][] = [];
    writeCollapsed({ setItem: (k, v) => void seen.push([k, v]) }, "k", new Set(["a", "b"]));
    expect(seen).toEqual([["k", '["a","b"]']]);
    expect(() => writeCollapsed({ setItem: () => { throw new Error("full"); } }, "k", new Set(["a"]))).not.toThrow();
    expect(() => writeCollapsed(null, "k", new Set())).not.toThrow();
  });

  it("collapsedKey format", () => {
    expect(collapsedKey("u1", "c1")).toBe("kyoube.org.collapsed:u1:c1");
  });
});
