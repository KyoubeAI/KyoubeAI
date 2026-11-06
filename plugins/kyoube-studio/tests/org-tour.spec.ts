import { describe, expect, it } from "vitest";
import { buildOrgTree } from "../src/org/org-tree.js";
import { layoutOrg } from "../src/org/org-layout.js";
import { tourStep, tourStops, type TourState } from "../src/org/org-tour.js";
import { FIVE_ROOTS, FLAT, INDUSTRIAL } from "./org-fixtures.js";

const stopsFor = (agents: typeof FIVE_ROOTS, collapsed: ReadonlySet<string> = new Set()) => {
  const tree = buildOrgTree(agents);
  const layout = layoutOrg(tree, collapsed);
  return { tree, layout, stops: tourStops(tree, layout) };
};
const allPanelIds = (t: ReturnType<typeof buildOrgTree>) => [...t.heads.flatMap((h) => h.panels), ...t.teams].map((p) => p.id);

describe("tourStops", () => {
  it("stops are overview, heads, their panels, standalone teams, then the shelf", () => {
    const { tree, layout, stops } = stopsFor(FIVE_ROOTS);
    const kinds = stops.map((s) => s.kind);
    expect(kinds[0]).toBe("overview");
    expect(stops[0]!.ms).toBe(4000);
    expect(stops[0]!.rect).toEqual(layout.bounds);
    expect(stops[0]!.caption).toBe(`${FIVE_ROOTS.length} agents`);
    const expected = ["overview"];
    for (const h of tree.heads) expected.push("head", ...h.panels.map(() => "team"));
    expected.push(...tree.teams.map(() => "team"));
    if (tree.shelf.length > 0) expected.push("shelf");
    expect(kinds).toEqual(expected);
    expect(kinds.at(-1)).toBe("shelf");
    expect(stops.slice(1).every((s) => s.ms === 6000)).toBe(true);
  });

  it("head stops span the head and its panels and caption the summed tally", () => {
    const { tree, layout, stops } = stopsFor(FIVE_ROOTS);
    const h = tree.heads[0]!;
    const stop = stops.find((s) => s.kind === "head" && s.id === h.agent.id)!;
    const boxes = [layout.cards.get(h.agent.id)!, ...h.panels.map((p) => layout.panels.get(p.id)!)];
    expect(stop.rect.x).toBe(Math.min(...boxes.map((b) => b.x)));
    expect(stop.rect.y).toBe(Math.min(...boxes.map((b) => b.y)));
    expect(stop.rect.x + stop.rect.w).toBe(Math.max(...boxes.map((b) => b.x + b.w)));
    expect(stop.rect.y + stop.rect.h).toBe(Math.max(...boxes.map((b) => b.y + b.h)));
    const n = 1 + h.panels.reduce((s, p) => s + p.tally.agents, 0);
    expect(stop.caption).toBe(`${h.agent.name} · ${n} ${n === 1 ? "agent" : "agents"}`);
    expect(stop.panelId).toBeNull();
  });

  it("team stops use the panel rect, caption and panelId", () => {
    const { tree, layout, stops } = stopsFor(FIVE_ROOTS);
    const p = tree.heads[0]!.panels[0]!;
    const stop = stops.find((s) => s.kind === "team" && s.id === p.id)!;
    expect(stop.panelId).toBe(p.id);
    expect(stop.rect).toEqual({ x: layout.panels.get(p.id)!.x, y: layout.panels.get(p.id)!.y, w: layout.panels.get(p.id)!.w, h: layout.panels.get(p.id)!.h });
    expect(stop.caption.startsWith(`${p.name} · `)).toBe(true);
  });

  it("collapsed teams are still visited", () => {
    const tree = buildOrgTree(FIVE_ROOTS);
    const open = stopsFor(FIVE_ROOTS).stops;
    const { stops } = stopsFor(FIVE_ROOTS, new Set(allPanelIds(tree)));
    expect(stops.length).toBe(open.length);
    const teams = stops.filter((s) => s.kind === "team");
    expect(teams.length).toBe(allPanelIds(tree).length);
    expect(teams.every((s) => s.panelId !== null)).toBe(true);
  });

  it("no shelf stop when the shelf is empty", () => {
    const { tree, stops } = stopsFor(INDUSTRIAL);
    expect(tree.shelf.length).toBe(0);
    expect(stops.some((s) => s.kind === "shelf")).toBe(false);
  });

  it("a shelf stop captions the count", () => {
    const { tree, layout, stops } = stopsFor(FLAT);
    if (tree.shelf.length === 0) return;
    const s = stops.at(-1)!;
    expect(s.kind).toBe("shelf");
    expect(s.caption).toBe(`Not in a team yet · ${tree.shelf.length}`);
    expect(s.rect).toEqual(layout.shelf);
  });

  it("a one-agent overview says 1 agent", () => {
    const { stops } = stopsFor(FIVE_ROOTS.filter((a) => a.id === "zed"));
    expect(stops[0]!.caption).toBe("1 agent");
  });
});

describe("tourStep", () => {
  const { stops } = stopsFor(FIVE_ROOTS);
  const last = stops.length - 1;
  const start: TourState = { index: 0, paused: false, manualAt: null, stopStartedAt: 1000 };

  it("tick advances after the stop's time and wraps", () => {
    expect(tourStep(start, { type: "tick", now: 1000 + 3999 }, stops)).toEqual(start);
    const next = tourStep(start, { type: "tick", now: 1000 + 4000 }, stops);
    expect(next).toMatchObject({ index: 1, stopStartedAt: 5000 });
    const wrapped = tourStep({ ...start, index: last }, { type: "tick", now: 1000 + stops[last]!.ms }, stops);
    expect(wrapped.index).toBe(0);
  });

  it("toggle pauses and resumes", () => {
    const paused = tourStep({ ...start, index: 2 }, { type: "toggle", now: 2000 }, stops);
    expect(paused).toMatchObject({ paused: true, index: 2 });
    expect(tourStep(paused, { type: "tick", now: 999999 }, stops).index).toBe(2);
    expect(tourStep(paused, { type: "toggle", now: 3000 }, stops).paused).toBe(false);
    expect(tourStep({ ...paused, manualAt: 1500 }, { type: "toggle", now: 3000 }, stops).manualAt).toBeNull();
  });

  it("next and prev wrap", () => {
    expect(tourStep(start, { type: "prev", now: 7000 }, stops)).toMatchObject({ index: last, stopStartedAt: 7000 });
    expect(tourStep({ ...start, index: last }, { type: "next", now: 8000 }, stops)).toMatchObject({ index: 0, stopStartedAt: 8000 });
    expect(tourStep(start, { type: "next", now: 9000 }, stops)).toMatchObject({ index: 1, stopStartedAt: 9000 });
  });

  it("a manual move pauses until 15 s without input", () => {
    const moved = tourStep(start, { type: "manual", now: 2000 }, stops);
    expect(moved).toMatchObject({ paused: true, manualAt: 2000, index: 0 });
    const early = tourStep(moved, { type: "tick", now: 2000 + 14999 }, stops);
    expect(early.paused).toBe(true);
    expect(early.manualAt).toBe(2000);
    const resumed = tourStep(moved, { type: "tick", now: 2000 + 15000 }, stops);
    expect(resumed.paused).toBe(false);
    expect(resumed.manualAt).toBeNull();
  });

  it("copes with no stops", () => {
    expect(tourStep(start, { type: "tick", now: 99999 }, [])).toEqual(start);
    expect(tourStep(start, { type: "next", now: 99999 }, [])).toEqual(start);
  });
});
