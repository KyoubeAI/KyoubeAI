import { describe, expect, it } from "vitest";
import { buildOrgTree } from "../src/org/org-tree.js";
import { SIZES, layoutOrg, type Rect } from "../src/org/org-layout.js";
import { FIVE_ROOTS, FLAT, INDUSTRIAL, ONE_ROOT_DEEP, org } from "./org-fixtures.js";

const FIXTURES = { INDUSTRIAL, FLAT, ONE_ROOT_DEEP, FIVE_ROOTS };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, outer: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

function onEdge(p: [number, number], r: Rect): boolean {
  const [x, y] = p;
  const within = x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1;
  const near = Math.abs(x - r.x) <= 1 || Math.abs(x - (r.x + r.w)) <= 1 || Math.abs(y - r.y) <= 1 || Math.abs(y - (r.y + r.h)) <= 1;
  return within && near;
}

function points(path: string): [number, number][] {
  return [...path.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("the org layout", () => {
  for (const [name, agents] of Object.entries(FIXTURES)) {
    const tree = buildOrgTree(agents);
    const layout = layoutOrg(tree, new Set());

    it(`${name}: no two cards or panels overlap`, () => {
      const cards = [...layout.cards.values()];
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlaps(cards[i]!, cards[j]!)).toBe(false);
      const panels = [...layout.panels.values()];
      for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) expect(overlaps(panels[i]!, panels[j]!)).toBe(false);
    });

    it(`${name}: every connector starts and ends on a card`, () => {
      for (const c of layout.connectors) {
        const pts = points(c.path);
        expect(pts.length).toBeGreaterThanOrEqual(2);
        expect(onEdge(pts[0]!, layout.cards.get(c.from)!)).toBe(true);
        expect(onEdge(pts[pts.length - 1]!, layout.cards.get(c.to)!)).toBe(true);
      }
    });

    it(`${name}: one connector per laid-out agent with a laid-out manager`, () => {
      const expected = [...layout.cards.keys()].filter((id) => {
        const m = tree.managerOf.get(id);
        return m && layout.cards.has(m);
      });
      expect(layout.connectors.length).toBe(expected.length);
      expect(layout.connectors.map((c) => c.to).sort()).toEqual(expected.sort());
    });

    it(`${name}: the bounds hold everything`, () => {
      for (const c of layout.cards.values()) expect(inside(c, layout.bounds)).toBe(true);
      for (const p of layout.panels.values()) expect(inside(p, layout.bounds)).toBe(true);
      if (layout.shelf) expect(inside(layout.shelf, layout.bounds)).toBe(true);
      expect(layout.bounds.x).toBe(0);
      expect(layout.bounds.y).toBe(0);
    });
  }

  it("keeps connector lines out of every panel but the one they enter", () => {
    const rows: Parameters<typeof org>[0] = [["boss", "Boss", null]];
    for (let i = 0; i < 14; i++) {
      rows.push([`lead${i}`, `Lead ${i}`, "boss"], [`aide${i}`, `Aide ${i}`, `lead${i}`]);
    }
    rows.push(["desk", "Desk", "boss"]);
    const cases = [...Object.values(FIXTURES), org(rows)];
    let wrapped = false;
    for (const agents of cases) {
      const layout = layoutOrg(buildOrgTree(agents), new Set());
      const ys = new Set([...layout.panels.values()].map((p) => p.y));
      if (agents === cases[cases.length - 1]) wrapped = ys.size >= 3;
      for (const c of layout.connectors) {
        const own = layout.cards.get(c.to)!.panelId;
        const pts = points(c.path);
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay] = pts[i - 1]!;
          const [bx, by] = pts[i]!;
          const seg = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) };
          for (const p of layout.panels.values()) {
            if (p.id === own) continue;
            const hit = seg.x < p.x + p.w && p.x < seg.x + seg.w && seg.y < p.y + p.h && p.y < seg.y + seg.h;
            expect(hit, `${c.from}:${c.to} crosses ${p.id}`).toBe(false);
          }
        }
      }
    }
    expect(wrapped).toBe(true);
  });

  it("puts the shelf below collapsed standalone chips, with room for its heading", () => {
    const tree = buildOrgTree(FIVE_ROOTS);
    const allTeams = new Set(tree.teams.map((t) => t.id));
    expect(allTeams.size).toBeGreaterThan(0);
    const layout = layoutOrg(tree, allTeams);
    expect(layout.shelf).not.toBeNull();
    const shelfOnly = layoutOrg(buildOrgTree(org([["a", "A", null], ["b", "B", null]])), new Set());
    expect(shelfOnly.shelf!.y).toBe(0);
    for (const p of layout.panels.values()) expect(overlaps(p, layout.shelf!)).toBe(false);
    for (const a of tree.shelf) expect(layout.cards.get(a.id)!.y).toBeGreaterThanOrEqual(layout.shelf!.y + SIZES.header);
  });

  it("lays the shelf agents out as cards without connectors", () => {
    const tree = buildOrgTree(FLAT);
    const layout = layoutOrg(tree, new Set());
    expect(layout.shelf).not.toBeNull();
    for (const a of tree.shelf) {
      expect(layout.cards.get(a.id)!.panelId).toBeNull();
      expect(layout.connectors.some((c) => c.to === a.id)).toBe(false);
    }
  });

  it("indents deeper members and sizes panels to fit", () => {
    const tree = buildOrgTree(ONE_ROOT_DEEP);
    const layout = layoutOrg(tree, new Set());
    expect(layout.cards.get("t1")!.indent).toBe(0);
    expect(layout.cards.get("m1")!.indent).toBe(0);
    expect(layout.cards.get("s1")!.indent).toBe(SIZES.indent);
    expect(layout.cards.get("ss1")!.indent).toBe(SIZES.indent * 2);
    const panel = layout.panels.get("team:t1")!;
    expect(panel.w).toBe(SIZES.pad * 2 + SIZES.team.w + SIZES.indent * 2);
  });

  it("collapsing a team shrinks the layout", () => {
    const tree = buildOrgTree(INDUSTRIAL);
    const open = layoutOrg(tree, new Set());
    const shut = layoutOrg(tree, new Set(["team:pat"]));
    expect(shut.panels.get("team:pat")!.h).toBe(SIZES.header);
    expect(shut.panels.get("team:pat")!.collapsed).toBe(true);
    expect(shut.bounds.h).toBeLessThanOrEqual(open.bounds.h);
    for (const id of ["pat", "ana", "ana1", "proto"]) expect(shut.cards.has(id)).toBe(false);
    expect(open.cards.has("ana1")).toBe(true);
  });

  it("wraps rows of panels past maxRowWidth", () => {
    const rows: Parameters<typeof org>[0] = [];
    for (let i = 0; i < 12; i++) {
      rows.push([`lead${i}`, `Lead ${i}`, null]);
      rows.push([`aide${i}`, `Aide ${i}`, `lead${i}`]);
    }
    const layout = layoutOrg(buildOrgTree(org(rows)), new Set());
    const byRow = new Map<number, Rect[]>();
    for (const p of layout.panels.values()) byRow.set(p.y, [...(byRow.get(p.y) ?? []), p]);
    expect(byRow.size).toBeGreaterThanOrEqual(2);
    for (const list of byRow.values()) {
      const left = Math.min(...list.map((p) => p.x));
      const right = Math.max(...list.map((p) => p.x + p.w));
      expect(right - left).toBeLessThanOrEqual(SIZES.maxRowWidth);
    }
  });

  it("card sizes do not depend on name length", () => {
    const short = layoutOrg(buildOrgTree(org([["a", "Kai", null], ["b", "Bo", "a"]])), new Set());
    const long = layoutOrg(buildOrgTree(org([["a", "K".repeat(120), null], ["b", "Bo", "a"]])), new Set());
    expect(long.cards.get("a")!.w).toBe(short.cards.get("a")!.w);
    expect(long.cards.get("a")!.h).toBe(short.cards.get("a")!.h);
  });

  it("gives the same layout for the same input", () => {
    const tree = buildOrgTree(INDUSTRIAL);
    const set = new Set(["team:bo"]);
    expect(layoutOrg(tree, set)).toEqual(layoutOrg(tree, set));
  });
});
