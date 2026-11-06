import type { Rect } from "./org-layout.js";
import type { OrgTree } from "./org-types.js";

/** Maps content point p to screen point p * scale + (x, y). */
export interface View { x: number; y: number; scale: number }

const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const AUTO_COLLAPSE_ABOVE = 60;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function fitView(bounds: Rect, viewport: { w: number; h: number }, margin = 32): View {
  const w = Math.max(1, bounds.w + margin * 2);
  const h = Math.max(1, bounds.h + margin * 2);
  const scale = clampScale(Math.min(viewport.w / w, viewport.h / h));
  return {
    scale,
    x: (viewport.w - bounds.w * scale) / 2 - bounds.x * scale,
    y: (viewport.h - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

/** The chart's smallest height, as in org-styles' `.ko-org { min-height }`. */
export const MIN_CHART_HEIGHT = 520;

/** One ancestor of the chart, nearest first: its tag and the computed styles the fill needs. */
export interface AncestorBox { tag: string; overflowY: string; paddingBottom: string }

/**
 * The space to leave under the chart: the bottom padding of the nearest ancestor that scrolls, or of
 * the nearest <main> when the document scrolls instead (as on the core's phone layout, whose <main>
 * padding keeps the page clear of the tab bar). Zero when there is neither.
 */
export function bottomInsetOf(ancestors: readonly AncestorBox[]): number {
  const box = ancestors.find((a) => a.overflowY === "auto" || a.overflowY === "scroll" || a.tag.toLowerCase() === "main");
  const px = box ? Number.parseFloat(box.paddingBottom) : 0;
  return Number.isFinite(px) ? px : 0;
}

/** The chart's height when it fills the window below its own top, whole pixels, never under MIN_CHART_HEIGHT. */
export function fillHeight({ windowHeight, top, bottomInset }: { windowHeight: number; top: number; bottomInset: number }): number {
  return Math.max(MIN_CHART_HEIGHT, Math.floor(windowHeight - top - bottomInset));
}

/** Room the presentation caption takes at the bottom: 32 px below it, and up to two lines of it. */
export const CAPTION_ROOM = 112;

/** A tour stop's view: the stop fitted above the caption, so the caption never covers it. */
export function tourView(rect: Rect, viewport: { w: number; h: number }): View {
  return fitView(rect, { w: viewport.w, h: Math.max(1, viewport.h - CAPTION_ROOM) });
}

export function zoomAt(view: View, point: { x: number; y: number }, factor: number): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k };
}

/** Big companies open folded: every panel id above 60 agents, none otherwise. */
export function defaultCollapsed(tree: OrgTree, agentCount: number): Set<string> {
  if (agentCount <= AUTO_COLLAPSE_ABOVE) return new Set();
  return new Set([...tree.heads.flatMap((h) => h.panels), ...tree.teams].map((p) => p.id));
}

export const collapsedKey = (userId: string, companyId: string): string => `kyoube.org.collapsed:${userId}:${companyId}`;

export function readCollapsed(storage: Pick<Storage, "getItem"> | null | undefined, key: string): Set<string> | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return null;
  }
}

export function writeCollapsed(storage: Pick<Storage, "setItem"> | null | undefined, key: string, ids: ReadonlySet<string>): void {
  try {
    storage?.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage can be full or blocked; folding still works for this visit.
  }
}
