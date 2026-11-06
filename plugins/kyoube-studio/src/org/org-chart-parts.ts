/** Pure helpers for OrgChart.tsx. */
import { diffMoments, type Moment, type MomentSnapshot } from "./org-moments.js";
import type { Rect } from "./org-layout.js";
import type { OrgAgent, OrgPanel } from "./org-types.js";

/** The panels actually drawn folded: `collapsed` without the `keepOpen` ids. Returns a new set. */
export function effectiveCollapsed(collapsed: ReadonlySet<string>, keepOpen: Iterable<string | null>): Set<string> {
  const out = new Set(collapsed);
  for (const id of keepOpen) if (id !== null) out.delete(id);
  return out;
}

/** "<name>, <title>, <detail>", without an empty title; a working agent with a task reads "working on <id>". */
export function cardLabel(agent: OrgAgent): string {
  const detail = agent.state === "working" && agent.task ? `working on ${agent.task.identifier}` : agent.detail;
  return [agent.name, agent.title, detail].filter(Boolean).join(", ");
}

/** A folded panel's chip: "<name> · <agents>", plus " · N working" when anyone is. */
export function chipText(panel: OrgPanel): string {
  return `${panel.name} · ${panel.tally.agents}${panel.tally.working > 0 ? ` · ${panel.tally.working} working` : ""}`;
}

export const boxStyle = (b: Rect, origin: { x: number; y: number } = { x: 0, y: 0 }) => ({ left: b.x - origin.x, top: b.y - origin.y, width: b.w, height: b.h });

export const safeStorage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The moments worth playing now: none while the page is hidden or the person asked for less motion. */
export function playableMoments(previous: MomentSnapshot | null, next: MomentSnapshot, env: { hidden: boolean; reducedMotion: boolean }): Moment[] {
  return env.hidden || env.reducedMotion ? [] : diffMoments(previous, next);
}
