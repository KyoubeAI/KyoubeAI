import type { OrgNode, OrgPanel, OrgTree } from "./org-types.js";

export interface Rect { x: number; y: number; w: number; h: number }
export interface CardBox extends Rect { id: string; size: "head" | "team"; indent: number; panelId: string | null }
export interface PanelBox extends Rect { id: string; collapsed: boolean }
/** An SVG path of straight segments ("M x y L x y ..."). */
export interface Connector { from: string; to: string; path: string }
export interface OrgLayout {
  cards: Map<string, CardBox>;
  panels: Map<string, PanelBox>;
  connectors: Connector[];
  shelf: Rect | null;
  bounds: Rect;
}

export const SIZES = {
  head: { w: 248, h: 92 },
  team: { w: 224, h: 64 },
  indent: 20,
  pad: 16,
  header: 40,
  rowGap: 8,
  panelGap: 24,
  tierGap: 64,
  maxRowWidth: 1680,
} as const;

/** How far a rail sits left of the card edge it leaves from. */
const RAIL = SIZES.pad / 2;

interface Row { id: string; indent: number; managerId: string | null }

function rowsOf(panel: OrgPanel): Row[] {
  const rows: Row[] = [];
  if (panel.kind === "team") rows.push({ id: panel.owner.id, indent: 0, managerId: null });
  const walk = (nodes: OrgNode[], depth: number, managerId: string | null) => {
    for (const n of nodes) {
      rows.push({ id: n.agent.id, indent: SIZES.indent * (depth - 1), managerId: panel.kind === "team" ? managerId : null });
      walk(n.children, depth + 1, n.agent.id);
    }
  };
  walk(panel.members, 1, panel.owner.id);
  return rows;
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");

export function layoutOrg(tree: OrgTree, collapsed: ReadonlySet<string>): OrgLayout {
  const cards = new Map<string, CardBox>();
  const panels = new Map<string, PanelBox>();
  const connectors: Connector[] = [];
  const { head, team, pad, header, rowGap, panelGap, tierGap, maxRowWidth } = SIZES;

  const measure = (p: OrgPanel) => {
    if (collapsed.has(p.id)) return { w: pad * 2 + team.w, h: header, rows: [] as Row[], isCollapsed: true };
    const rows = rowsOf(p);
    const maxIndent = rows.reduce((m, r) => Math.max(m, r.indent), 0);
    const h = header + rows.length * team.h + (rows.length - 1) * rowGap + pad;
    return { w: pad * 2 + team.w + maxIndent, h, rows, isCollapsed: false };
  };

  /** Place one panel with its top-left at (x, y); returns its box. */
  const place = (p: OrgPanel, x: number, y: number): PanelBox => {
    const m = measure(p);
    const box: PanelBox = { id: p.id, x, y, w: m.w, h: m.h, collapsed: m.isCollapsed };
    panels.set(p.id, box);
    m.rows.forEach((r, i) => {
      cards.set(r.id, { id: r.id, x: x + pad + r.indent, y: y + header + i * (team.h + rowGap), w: team.w, h: team.h, size: "team", indent: r.indent, panelId: p.id });
    });
    for (const r of m.rows) {
      if (!r.managerId) continue;
      const from = cards.get(r.managerId)!;
      const to = cards.get(r.id)!;
      const toY = to.y + to.h / 2;
      if (to.indent > from.indent) {
        // An indented report hangs from its manager's own card, on a rail in the indent, so it never runs along the lead's rail.
        const railX = from.x + SIZES.indent / 2;
        connectors.push({ from: from.id, to: to.id, path: pathOf([[railX, from.y + from.h], [railX, toY], [to.x, toY]]) });
      } else {
        const railX = from.x - RAIL;
        connectors.push({ from: from.id, to: to.id, path: pathOf([[from.x, from.y + from.h / 2], [railX, from.y + from.h / 2], [railX, toY], [to.x, toY]]) });
      }
    }
    return box;
  };

  /** Flow panels left to right, wrapping past maxRowWidth. Returns the rows with the box of each panel. */
  const flow = (list: OrgPanel[], x0: number, y0: number): { rows: PanelBox[][]; bottom: number } => {
    const rows: PanelBox[][] = [];
    let x = x0;
    let y = y0;
    let rowH = 0;
    let current: PanelBox[] = [];
    for (const p of list) {
      const m = measure(p);
      if (current.length > 0 && x - x0 + m.w > maxRowWidth) {
        rows.push(current);
        current = [];
        y += rowH + tierGap;
        x = x0;
        rowH = 0;
      }
      current.push(place(p, x, y));
      x += m.w + panelGap;
      rowH = Math.max(rowH, m.h);
    }
    if (current.length > 0) rows.push(current);
    return { rows, bottom: y + rowH };
  };

  let cursorX = 0;
  let bottom = 0;
  for (const h of tree.heads) {
    // Measure first so the head can be centred over the first row.
    const widths = h.panels.map((p) => measure(p).w);
    const rowWidth = (from: number) => {
      let w = 0;
      let n = 0;
      for (let i = from; i < widths.length; i++) {
        const next = w + (n > 0 ? panelGap : 0) + widths[i]!;
        if (n > 0 && next > maxRowWidth) break;
        w = next;
        n++;
      }
      return w;
    };
    const firstRow = rowWidth(0);
    const rel = firstRow / 2 - head.w / 2;
    const shift = Math.max(0, -rel);
    const headX = cursorX + rel + shift;
    const headBox: CardBox = { id: h.agent.id, x: headX, y: 0, w: head.w, h: head.h, size: "head", indent: 0, panelId: null };
    cards.set(h.agent.id, headBox);
    const { rows, bottom: groupBottom } = flow(h.panels, cursorX + shift, head.h + tierGap);
    const hx = headBox.x + head.w / 2;
    const hb = headBox.y + head.h;
    const groupRight = Math.max(headBox.x + head.w, ...rows.flat().map((b) => b.x + b.w));
    // Lines to wrapped rows run down the clear channel just right of the group, then along the gap above their row.
    const channelX = groupRight + panelGap / 2;
    const firstGapY = head.h + tierGap / 2;
    const rowOf = (id: string) => rows.findIndex((r) => r.some((b) => b.id === id));
    const drop = (id: string, box: PanelBox, tx: number): [number, number][] => {
      const midY = box.y - tierGap / 2;
      const lead: [number, number][] = rowOf(id) <= 0 ? [[hx, hb], [hx, midY]] : [[hx, hb], [hx, firstGapY], [channelX, firstGapY], [channelX, midY]];
      return [...lead, [tx, midY]];
    };
    for (const p of h.panels) {
      const box = panels.get(p.id)!;
      if (p.kind === "team") {
        const owner = cards.get(p.owner.id);
        if (!owner) continue;
        const ox = owner.x + owner.w / 2;
        connectors.push({ from: h.agent.id, to: owner.id, path: pathOf([...drop(p.id, box, ox), [ox, owner.y]]) });
      } else {
        for (const n of p.members) {
          const c = cards.get(n.agent.id);
          if (!c) continue;
          const railX = box.x + RAIL;
          const cy = c.y + c.h / 2;
          connectors.push({ from: h.agent.id, to: c.id, path: pathOf([...drop(p.id, box, railX), [railX, cy], [c.x, cy]]) });
        }
      }
    }
    cursorX = groupRight + panelGap;
    bottom = Math.max(bottom, groupBottom);
  }

  if (tree.teams.length > 0) {
    const y0 = tree.heads.length > 0 ? bottom + tierGap : 0;
    bottom = flow(tree.teams, 0, y0).bottom;
  }

  let shelf: Rect | null = null;
  if (tree.shelf.length > 0) {
    const y0 = cards.size > 0 || panels.size > 0 ? bottom + tierGap : 0;
    const cols = Math.max(1, Math.floor((maxRowWidth + rowGap) / (team.w + rowGap)));
    tree.shelf.forEach((a, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      cards.set(a.id, { id: a.id, x: col * (team.w + rowGap), y: y0 + header + row * (team.h + rowGap), w: team.w, h: team.h, size: "team", indent: 0, panelId: null });
    });
    const usedCols = Math.min(cols, tree.shelf.length);
    const rowsN = Math.ceil(tree.shelf.length / cols);
    shelf = { x: 0, y: y0, w: usedCols * team.w + (usedCols - 1) * rowGap, h: header + rowsN * team.h + (rowsN - 1) * rowGap };
  }

  const boxes: Rect[] = [...cards.values(), ...panels.values(), ...(shelf ? [shelf] : [])];
  const x1 = Math.min(0, ...boxes.map((b) => b.x));
  const y1 = Math.min(0, ...boxes.map((b) => b.y));
  const bounds: Rect = boxes.length === 0
    ? { x: 0, y: 0, w: 0, h: 0 }
    : { x: x1, y: y1, w: Math.max(...boxes.map((b) => b.x + b.w)) - x1, h: Math.max(...boxes.map((b) => b.y + b.h)) - y1 };
  return { cards, panels, connectors, shelf, bounds };
}
