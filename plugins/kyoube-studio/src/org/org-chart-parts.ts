/** Pure helpers for OrgChart.tsx. */
import { diffMoments, type Moment, type MomentSnapshot } from "./org-moments.js";
import type { Rect } from "./org-layout.js";
import type { OrgAgent, OrgPanel } from "./org-types.js";
import type { View } from "./org-view.js";

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

/** Whether a key event's target is somewhere people type: a form field or editable text. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const t = target as { tagName?: unknown; isContentEditable?: unknown };
  if (t.isContentEditable === true) return true;
  return typeof t.tagName === "string" && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName.toUpperCase());
}

export type ChartKeyAction = "clear-selection" | "leave-present" | "toggle" | "next" | "prev";

/**
 * What a keydown means to the chart. Nothing when someone else handled it, it was typed into a field,
 * it came with Alt, Ctrl or Cmd (Alt+← is the browser's Back), or it is a held key repeating.
 * In presentation Esc only leaves, Space pauses and the arrows step; otherwise Esc clears a selection.
 */
export function chartKeyAction(
  e: { key: string; defaultPrevented: boolean; target: unknown; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean },
  ctx: { present: boolean; hasSelection: boolean },
): ChartKeyAction | null {
  if (e.defaultPrevented || isTypingTarget(e.target)) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return null;
  if (ctx.present) {
    switch (e.key) {
      case "Escape": return "leave-present";
      case " ": return "toggle";
      case "ArrowRight": return "next";
      case "ArrowLeft": return "prev";
      default: return null;
    }
  }
  return e.key === "Escape" && ctx.hasSelection ? "clear-selection" : null;
}

/** One look at the tour's view: the stop shown, whether someone is panning, and the view that fits the stop. */
export interface TourFrame { index: number; manual: boolean; view: View }

/**
 * Whether the tour should move the view to `next.view`: on a new stop, when it resumes after panning,
 * or when the stop's fit changed while no one is panning.
 */
export function tourRefit(prev: TourFrame | null, next: TourFrame): boolean {
  if (prev === null || next.index !== prev.index) return true;
  if (next.manual) return false;
  if (prev.manual) return true;
  return next.view.x !== prev.view.x || next.view.y !== prev.view.y || next.view.scale !== prev.view.scale;
}

/** Whether the chart should fit itself to the page on its next size report: when a presentation just ended. */
export function refitOnLeave(wasPresent: boolean, present: boolean): boolean {
  return wasPresent && !present;
}
