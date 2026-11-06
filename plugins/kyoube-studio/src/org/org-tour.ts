import { tallyText } from "./org-tree.js";
import type { Rect, OrgLayout } from "./org-layout.js";
import type { OrgPanel, OrgTally, OrgTree } from "./org-types.js";

export interface TourStop {
  kind: "overview" | "head" | "team" | "shelf";
  id: string;
  rect: Rect;
  caption: string;
  ms: number;
  /** The panel to open if it is folded while this stop shows. */
  panelId: string | null;
}

const OVERVIEW_MS = 4000;
const STOP_MS = 6000;
const RESUME_AFTER_MS = 15000;

const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

const rectOf = ({ x, y, w, h }: Rect): Rect => ({ x, y, w, h });

export function tourStops(tree: OrgTree, layout: OrgLayout): TourStop[] {
  const stops: TourStop[] = [];
  const total = tree.byId.size;
  stops.push({ kind: "overview", id: "overview", rect: rectOf(layout.bounds), caption: `${total} ${total === 1 ? "agent" : "agents"}`, ms: OVERVIEW_MS, panelId: null });

  const teamStop = (p: OrgPanel) => {
    const box = layout.panels.get(p.id);
    if (!box) return;
    stops.push({ kind: "team", id: p.id, rect: rectOf(box), caption: `${p.name} · ${tallyText(p.tally)}`, ms: STOP_MS, panelId: p.id });
  };

  for (const h of tree.heads) {
    const card = layout.cards.get(h.agent.id);
    if (card) {
      const sum: OrgTally = { agents: 1, working: 0, waiting: 0, attention: 0, paused: 0 };
      if (h.agent.state !== "idle") sum[h.agent.state] += 1;
      for (const p of h.panels) {
        sum.agents += p.tally.agents;
        sum.working += p.tally.working;
        sum.waiting += p.tally.waiting;
        sum.attention += p.tally.attention;
        sum.paused += p.tally.paused;
      }
      const rects = [card, ...h.panels.flatMap((p) => layout.panels.get(p.id) ?? [])];
      stops.push({ kind: "head", id: h.agent.id, rect: union(rects), caption: `${h.agent.name} · ${tallyText(sum)}`, ms: STOP_MS, panelId: null });
    }
    h.panels.forEach(teamStop);
  }
  tree.teams.forEach(teamStop);

  if (layout.shelf && tree.shelf.length > 0) {
    stops.push({ kind: "shelf", id: "shelf", rect: rectOf(layout.shelf), caption: `Not in a team yet · ${tree.shelf.length}`, ms: STOP_MS, panelId: null });
  }
  return stops;
}

export interface TourState { index: number; paused: boolean; manualAt: number | null; stopStartedAt: number }
export type TourEvent =
  | { type: "tick"; now: number }
  | { type: "toggle"; now: number }
  | { type: "next" | "prev"; now: number }
  | { type: "manual"; now: number };

/** `index` kept inside `0..n - 1`, for when stops shrink (an agent leaves mid-tour). 0 when there are none. */
export const clampTourIndex = (index: number, n: number): number => Math.max(0, Math.min(index, n - 1));

export function tourStep(state: TourState, event: TourEvent, stops: TourStop[]): TourState {
  const n = stops.length;
  const at = n > 0 && state.index >= n ? { ...state, index: clampTourIndex(state.index, n) } : state;
  const move = (by: number): TourState =>
    n === 0 ? at : { ...at, index: (((at.index + by) % n) + n) % n, stopStartedAt: event.now };
  switch (event.type) {
    case "toggle":
      // Resuming starts a whole dwell, so a long pause does not jump on at once.
      return at.paused ? { ...at, paused: false, manualAt: null, stopStartedAt: event.now } : { ...at, paused: true, manualAt: null };
    case "manual":
      return { ...at, paused: true, manualAt: event.now };
    case "next":
      return move(1);
    case "prev":
      return move(-1);
    case "tick": {
      let s = at;
      if (s.manualAt !== null && event.now - s.manualAt >= RESUME_AFTER_MS) s = { ...s, manualAt: null, paused: false, stopStartedAt: event.now };
      const stop = stops[s.index];
      if (!s.paused && stop && event.now - s.stopStartedAt >= stop.ms) {
        return { ...s, index: (s.index + 1) % n, stopStartedAt: event.now };
      }
      return s;
    }
  }
}
