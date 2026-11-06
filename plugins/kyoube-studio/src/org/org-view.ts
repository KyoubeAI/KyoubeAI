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
