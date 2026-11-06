import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type JSX, type ReactNode } from "react";
import { characterFor } from "../characters.js";
import { layoutOrg, type CardBox } from "./org-layout.js";
import { buildOrgTree, focusIds, panelOf, tallyText } from "./org-tree.js";
import { boxStyle, cardLabel, chartKeyAction, chipText, effectiveCollapsed, playableMoments, refitOnLeave, safeStorage, tourRefit, type TourFrame } from "./org-chart-parts.js";
import { momentSnapshot, type Moment, type MomentSnapshot } from "./org-moments.js";
import { clampTourIndex, tourStops } from "./org-tour.js";
import type { OrgAgent, OrgPanel } from "./org-types.js";
import { bottomInsetOf, defaultCollapsed, fillHeight, fitView, panIntoView, readCollapsed, tourView, writeCollapsed, zoomAt, type AncestorBox, type View } from "./org-view.js";
import { ensureOrgStyles } from "./org-styles.js";
import { usePresentation } from "./use-presentation.js";

export { effectiveCollapsed, playableMoments };

export interface OrgPanelContext { manager: OrgAgent | null; reports: OrgAgent[]; select: (id: string | null) => void }
export interface OrgChartProps {
  agents: OrgAgent[];
  doneTaskIds: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  renderPanel?: (agent: OrgAgent, ctx: OrgPanelContext) => ReactNode;
  present: boolean;
  onPresentChange: (present: boolean) => void;
  storageKey: string | null;
  /** Take the window's height below the chart's top (at least 520 px), measured on mount and on every resize. */
  fillWindow?: boolean;
  /** With fillWindow, measure again whenever this changes: for something above the chart that comes and goes. */
  fillKey?: string | number | boolean;
}

/** Before the ResizeObserver reports, so the server render has a stable view. */
const INITIAL_SIZE = { w: 1200, h: 800 };
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** How long a live moment stays on its card. */
const MOMENT_MS = 1200;

/** What is playing now, by agent id: the card's moment and whether the incoming line ripples. */
type Playing = Record<string, { kind: Moment["kind"]; line: boolean }>;

/** The height that fills the window below `el`, leaving its nearest scroller's (or <main>'s) bottom padding. */
function measureFillHeight(el: HTMLElement): number {
  const ancestors: AncestorBox[] = [];
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    ancestors.push({ tag: a.tagName, overflowY: cs.overflowY, paddingBottom: cs.paddingBottom });
  }
  return fillHeight({ windowHeight: window.innerHeight, top: el.getBoundingClientRect().top, bottomInset: bottomInsetOf(ancestors) });
}

/** Whether focus came from the keyboard; a click focuses its card too, and that must not pan. */
function focusFromKeyboard(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function Card({ agent, box, origin, dim, selected, moment, onSelect, onFocus }: { agent: OrgAgent; box: CardBox; origin?: { x: number; y: number }; dim: boolean; selected: boolean; moment?: Moment["kind"]; onSelect: (id: string) => void; onFocus: (box: CardBox, el: HTMLElement) => void }) {
  const face = useMemo(() => characterFor(agent.icon, agent.name), [agent.icon, agent.name]);
  return (
    <button
      type="button"
      className="ko-card"
      data-org-card={agent.id}
      data-state={agent.state}
      data-size={box.size === "head" ? "head" : undefined}
      data-dim={dim ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-moment={moment}
      aria-label={cardLabel(agent)}
      style={boxStyle(box, origin)}
      onClick={() => onSelect(agent.id)}
      onFocus={(e) => onFocus(box, e.currentTarget)}
    >
      <span className="ko-face" data-tint={face.tint}>
        <span className="ko-face-art" dangerouslySetInnerHTML={{ __html: face.svg }} />
        {agent.state === "paused" ? <i className="ko-pause" /> : null}
      </span>
      <span className="ko-text">
        <b className="ko-name">{agent.name}</b>
        {agent.title ? <span className="ko-title">{agent.title}</span> : null}
        <span className="ko-status"><i />{agent.detail}</span>
      </span>
    </button>
  );
}

export function OrgChart({ agents, doneTaskIds, selectedId, onSelect, renderPanel, present, onPresentChange, storageKey, fillWindow = false, fillKey }: OrgChartProps): JSX.Element {
  ensureOrgStyles();
  const tree = useMemo(() => buildOrgTree(agents), [agents]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(tree, agents.length));

  // The tour shows the whole org, so a selection waits (no side panel, no dimming) until it ends.
  const selected = !present && selectedId !== null ? tree.byId.get(selectedId) ?? null : null;
  const focus = useMemo(() => (selected ? focusIds(tree, selected.id) : null), [tree, selected]);
  const keepOpen = useMemo(() => new Set(focus ? [...focus].map((id) => panelOf(tree, id)) : []), [tree, focus]);
  const folded = useMemo(() => effectiveCollapsed(collapsed, keepOpen), [collapsed, keepOpen]);
  const foldedLayout = useMemo(() => layoutOrg(tree, folded), [tree, folded]);

  const rootRef = useRef<HTMLDivElement>(null);
  // The stops' order, times and panels do not depend on what is folded, so the folded layout's stops drive the tour.
  const foldedStops = useMemo(() => (present ? tourStops(tree, foldedLayout) : []), [present, tree, foldedLayout]);
  const show = usePresentation({ present, onPresentChange, rootRef, stops: foldedStops });
  // A folded team opens for its stop and folds again afterwards.
  const tourPanel = foldedStops[clampTourIndex(show.index, foldedStops.length)]?.panelId ?? null;
  const drawn = useMemo(() => (tourPanel !== null && folded.has(tourPanel) ? effectiveCollapsed(folded, [tourPanel]) : folded), [folded, tourPanel]);
  const layout = useMemo(() => (drawn === folded ? foldedLayout : layoutOrg(tree, drawn)), [tree, drawn, folded, foldedLayout]);
  const stops = useMemo(() => (layout === foldedLayout ? foldedStops : tourStops(tree, layout)), [tree, layout, foldedLayout, foldedStops]);
  const stopIndex = clampTourIndex(show.index, stops.length);
  const stop = stops[stopIndex] ?? null;

  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(INITIAL_SIZE);
  const [view, setView] = useState<View>(() => fitView(layout.bounds, INITIAL_SIZE));
  const boundsRef = useRef(layout.bounds);
  boundsRef.current = layout.bounds;

  // Compare each poll with the last and play the small moments, for MOMENT_MS each.
  const [playing, setPlaying] = useState<Playing>({});
  const lastSnapshot = useRef<MomentSnapshot | null>(null);
  const momentTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const next = momentSnapshot(agents, doneTaskIds);
    const moments = playableMoments(lastSnapshot.current, next, {
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    lastSnapshot.current = next;
    if (moments.length === 0) return;
    // One agent can have two moments; the card shows the later, the handover still marks its line.
    const batch: Playing = {};
    for (const m of moments) batch[m.agentId] = { kind: m.kind, line: m.kind === "handover" || (batch[m.agentId]?.line ?? false) };
    setPlaying((p) => ({ ...p, ...batch }));
    for (const id of Object.keys(batch)) {
      clearTimeout(momentTimers.current.get(id));
      momentTimers.current.set(id, setTimeout(() => {
        momentTimers.current.delete(id);
        setPlaying((p) => {
          const { [id]: _done, ...rest } = p;
          return rest;
        });
      }, MOMENT_MS));
    }
  }, [agents, doneTaskIds]);
  useEffect(() => {
    const timers = momentTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Swap in what this person folded last time, once storage is reachable.
  useEffect(() => {
    if (storageKey === null) return;
    const saved = readCollapsed(safeStorage(), storageKey);
    if (saved) setCollapsed(saved);
  }, [storageKey]);

  const changeCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    if (storageKey !== null) writeCollapsed(safeStorage(), storageKey, next);
  };
  const togglePanel = (id: string) => {
    const next = new Set(collapsed);
    if (drawn.has(id)) next.delete(id);
    else {
      next.add(id);
      // A panel held open by focus could not fold; folding it ends the focus.
      if (keepOpen.has(id)) onSelect(null);
    }
    changeCollapsed(next);
  };

  // The viewport's real size; the first report re-fits the chart once, and so does the first after a
  // presentation (the chart shrinks back from the screen and would keep the last stop's view). With
  // fillWindow the chart's height is measured first (before paint, so that first fit already has it) and
  // on every window resize.
  const [filledHeight, setFilledHeight] = useState<number | null>(null);
  const refitPending = useRef(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // While presenting, the chart covers the window or the screen, so there is nothing to measure.
    const fill = () => { if (!el.classList.contains("ko-fill") && document.fullscreenElement !== el) setFilledHeight(measureFillHeight(el)); };
    if (fillWindow) {
      fill();
      window.addEventListener("resize", fill);
    }
    const stopFill = () => { if (fillWindow) window.removeEventListener("resize", fill); };
    if (typeof ResizeObserver === "undefined") return stopFill;
    let fitted = false;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = { w: entry.contentRect.width, h: entry.contentRect.height };
      if (next.w === 0 || next.h === 0) return;
      setSize(next);
      if (!fitted || refitPending.current) {
        fitted = true;
        refitPending.current = false;
        setView(fitView(boundsRef.current, next));
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      stopFill();
    };
  }, [fillWindow]);
  // Once a presentation ends, fit the chart on the next size report, and measure again in case the
  // window changed while it ran. Measure again too when fillKey says the chart's top moved.
  const wasPresent = useRef(present);
  useLayoutEffect(() => {
    if (refitOnLeave(wasPresent.current, present)) refitPending.current = true;
    wasPresent.current = present;
    // Still in full screen until exitFullscreen settles; the window's resize measures then.
    const el = rootRef.current;
    if (fillWindow && !present && el && document.fullscreenElement !== el) setFilledHeight(measureFillHeight(el));
  }, [fillWindow, present, fillKey]);

  // The tour moves the view to each stop; the stage's transition glides it, and reduced motion cuts.
  const lastFrame = useRef<TourFrame | null>(null);
  useEffect(() => {
    if (!stop) {
      lastFrame.current = null;
      return;
    }
    const frame = { index: stopIndex, manual: show.manual, view: tourView(stop.rect, size) };
    const prev = lastFrame.current;
    const refit = tourRefit(prev, frame);
    lastFrame.current = refit || !prev ? frame : { ...frame, view: prev.view };
    if (refit) setView(frame.view);
  }, [stop, stopIndex, show.manual, size]);

  // Wheel zoom needs a non-passive listener so the page does not scroll.
  const { noteManual } = show;
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const point = { x: e.clientX - r.left, y: e.clientY - r.top };
      setView((v) => zoomAt(v, point, Math.exp(-e.deltaY / 500)));
      noteManual();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [noteManual]);

  // Esc anywhere on the page clears the selection, unless something else handled it or it was typed into a field.
  // In presentation the selection is set aside and use-presentation's Esc leaves instead.
  const hasSelection = selected !== null;
  useEffect(() => {
    if (!hasSelection || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return; // onRootKey has it.
      if (chartKeyAction(e, { present, hasSelection }) === "clear-selection") onSelect(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasSelection, present, onSelect]);
  const onRootKey = (e: ReactKeyboardEvent) => {
    if (chartKeyAction(e.nativeEvent, { present, hasSelection }) === "clear-selection") onSelect(null);
  };

  // Pan with one pointer, pinch with two. Capture starts only past the drag threshold, so a click still reaches its card.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ startX: 0, startY: 0, moved: false, swallowClick: false });
  const [dragging, setDragging] = useState(false);
  const local = (p: { x: number; y: number }) => {
    const r = viewportRef.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left, y: p.y - r.top } : p;
  };
  const capture = (id: number) => {
    try {
      viewportRef.current?.setPointerCapture(id);
    } catch {
      // The pointer may already be gone.
    }
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { startX: e.clientX, startY: e.clientY, moved: false, swallowClick: false };
    else {
      gesture.current.moved = true;
      for (const id of pointers.current.keys()) capture(id);
      setDragging(true);
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    const g = gesture.current;
    if (pointers.current.size >= 2) {
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
      pointers.current.set(e.pointerId, cur);
      if (!other) return;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(cur.x - other.x, cur.y - other.y);
      const midAfter = local({ x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 });
      // The midpoint moves by half this pointer's step; pan with it, then zoom about it.
      const dx = (cur.x - prev.x) / 2;
      const dy = (cur.y - prev.y) / 2;
      setView((v) => zoomAt({ ...v, x: v.x + dx, y: v.y + dy }, midAfter, before > 0 ? after / before : 1));
      noteManual();
      return;
    }
    if (!g.moved) {
      if (Math.hypot(cur.x - g.startX, cur.y - g.startY) < DRAG_THRESHOLD) return;
      g.moved = true;
      capture(e.pointerId);
      setDragging(true);
    }
    pointers.current.set(e.pointerId, cur);
    setView((v) => ({ ...v, x: v.x + cur.x - prev.x, y: v.y + cur.y - prev.y }));
    noteManual();
  };
  const onPointerEnd = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 0) {
      if (gesture.current.moved) gesture.current.swallowClick = true;
      setDragging(false);
    }
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (!gesture.current.swallowClick) return;
    gesture.current.swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  const onStageClick = (e: ReactMouseEvent) => {
    if (selectedId !== null && !(e.target as Element).closest("button, a")) onSelect(null);
  };

  const cardsByPanel = useMemo(() => {
    const out = new Map<string, CardBox[]>();
    for (const c of layout.cards.values()) if (c.panelId) out.set(c.panelId, [...(out.get(c.panelId) ?? []), c]);
    return out;
  }, [layout]);
  const isDim = (id: string) => focus !== null && !focus.has(id);
  // Tabbing to a card off the edge pans the chart (at the same zoom) until the card is in view.
  const onCardFocus = (box: CardBox, el: HTMLElement) => {
    if (!focusFromKeyboard(el)) return;
    const next = panIntoView(view, box, size);
    if (next === view) return;
    setView(next);
    noteManual();
  };
  const card = (box: CardBox, origin?: { x: number; y: number }) => {
    const agent = tree.byId.get(box.id);
    return agent ? <Card key={box.id} agent={agent} box={box} origin={origin} dim={isDim(box.id)} selected={box.id === selected?.id} moment={playing[box.id]?.kind} onSelect={onSelect} onFocus={onCardFocus} /> : null;
  };

  const panel = (p: OrgPanel) => {
    const box = layout.panels.get(p.id);
    if (!box) return null;
    const inside = cardsByPanel.get(p.id) ?? [];
    const dim = focus !== null && !inside.some((c) => focus.has(c.id));
    if (box.collapsed) {
      const text = chipText(p);
      return (
        <section key={p.id} className="ko-panel ko-chip" data-org-panel={p.id} data-org-chip={p.id} data-tint={p.tint} data-dim={dim ? "" : undefined} style={boxStyle(box)}>
          <div className="ko-panel-head">
            <button type="button" className="ko-chev" aria-expanded="false" aria-label={p.attention ? `${text} · ${p.tally.attention} stuck` : text} onClick={() => togglePanel(p.id)}>
              <Chevron /><span className="ko-chip-text">{text}</span>
            </button>
            {p.attention ? <i data-alert="" aria-hidden="true" /> : null}
          </div>
        </section>
      );
    }
    return (
      <section key={p.id} className="ko-panel" data-org-panel={p.id} data-tint={p.tint} data-dim={dim ? "" : undefined} style={boxStyle(box)}>
        <div className="ko-panel-head">
          <button type="button" className="ko-chev" aria-expanded="true" aria-label={`Collapse ${p.name}`} onClick={() => togglePanel(p.id)}><Chevron /></button>
          <span className="ko-panel-label">
            <span className="ko-panel-name">{p.name}</span>
            <span className="ko-tally">{tallyText(p.tally)}</span>
          </span>
        </div>
        {inside.map((c) => card(c, box))}
      </section>
    );
  };

  const head = (id: string) => {
    const box = layout.cards.get(id);
    return box ? card(box) : null;
  };
  const { bounds, shelf } = layout;
  const panelCtx: OrgPanelContext | null = selected
    ? {
        manager: tree.byId.get(tree.managerOf.get(selected.id) ?? "") ?? null,
        reports: (tree.reportsOf.get(selected.id) ?? []).flatMap((r) => tree.byId.get(r) ?? []),
        select: onSelect,
      }
    : null;

  return (
    <div className={present && show.fill ? "ko-org ko-fill" : "ko-org"} data-kyoube-org="" data-org-present={present ? "true" : undefined} ref={rootRef} onKeyDown={onRootKey} style={filledHeight !== null && !(present && show.fill) ? { height: filledHeight } : undefined}>
      <div
        className="ko-viewport"
        ref={viewportRef}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onClick={onStageClick}
      >
        <div className="ko-stage" data-glide={present && !show.manual && !dragging ? "" : undefined} style={{ width: bounds.w, height: bounds.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="ko-lines" style={boxStyle(bounds)} viewBox={`${bounds.x} ${bounds.y} ${Math.max(1, bounds.w)} ${Math.max(1, bounds.h)}`} aria-hidden="true">
            {layout.connectors.map((c) => (
              <path
                key={`${c.from}:${c.to}`}
                className="ko-line"
                data-org-line={`${c.from}:${c.to}`}
                data-state={tree.byId.get(c.to)?.state}
                data-moment={playing[c.to]?.line ? "handover" : undefined}
                pathLength={playing[c.to]?.line ? 100 : undefined}
                data-dim={focus !== null && !(focus.has(c.from) && focus.has(c.to)) ? "" : undefined}
                d={c.path}
              />
            ))}
          </svg>
          {tree.heads.flatMap((h) => [head(h.agent.id), ...h.panels.map(panel)])}
          {tree.teams.map(panel)}
          {shelf ? (
            <section className="ko-shelf" data-org-shelf="" style={boxStyle(shelf)}>
              <h3>Not in a team yet</h3>
              {tree.shelf.map((a) => {
                const box = layout.cards.get(a.id);
                return box ? card(box, shelf) : null;
              })}
            </section>
          ) : null}
        </div>
      </div>
      {present ? (
        stop ? <p className="ko-caption" data-org-caption="" aria-live="polite">{stop.caption}</p> : null
      ) : (
        <div className="ko-toolbar" role="toolbar" aria-label="Org chart">
          <button type="button" onClick={() => setView(fitView(bounds, size))}>Fit</button>
          <button type="button" onClick={() => changeCollapsed(new Set(layout.panels.keys()))}>Collapse all</button>
          <button type="button" onClick={() => changeCollapsed(new Set())}>Expand all</button>
          <button type="button" onClick={() => onPresentChange(true)}>Present</button>
        </div>
      )}
      {selected && panelCtx && renderPanel ? (
        <aside className="ko-side" data-org-side="" aria-label={selected.name}>
          <button type="button" className="ko-close" aria-label="Close" title="Close" onClick={() => onSelect(null)}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          {renderPanel(selected, panelCtx)}
        </aside>
      ) : null}
    </div>
  );
}
