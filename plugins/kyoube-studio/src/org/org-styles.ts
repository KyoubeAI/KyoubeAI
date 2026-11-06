/**
 * The org chart's styles, injected once into the document. They read Studio's
 * theme tokens (--kyoube-*) and the core's (--card, --border, ...), each with a
 * fallback, so the chart also renders on a plain web page.
 *
 * Panel tints come from [data-tint]; rings and line motion come from
 * [data-state], as in the spec's state table. Animations live inside
 * prefers-reduced-motion: no-preference, and reduce turns off the rest.
 */
const WORKING = "var(--kyoube-working, #0f766e)";
const WAITING = "var(--kyoube-waiting, #c2410c)";
const DANGER = "var(--kyoube-danger, #dc2626)";
const CARD = "var(--card, #fff)";
const BORDER = "var(--border, #e8e8eb)";
const FG = "var(--foreground, #18181b)";
const MUTED = "var(--muted-foreground, #71717a)";

const TILES: Record<string, string> = { teal: "#d3efe9", sky: "#d9e9f5", violet: "#e7ddfa", amber: "#f6e4cc", rose: "#f8dce2", zinc: "#e9e9ec" };
const tile = (t: string) => `var(--kyoube-tile-${t}, ${TILES[t]})`;
const tintRules = Object.keys(TILES)
  .map((t) => [
    `.ko-face[data-tint="${t}"] { background: ${tile(t)}; }`,
    `.ko-panel[data-tint="${t}"] { background: color-mix(in oklab, ${tile(t)} 55%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, ${tile(t)} 100%, ${BORDER}); }`,
  ].join("\n"))
  .join("\n");

const CSS = String.raw`
/* clip, not hidden: a hidden box still scrolls for focus and find-in-page, which the view's maths would not see. */
.ko-org { position: relative; width: 100%; height: 100%; min-height: 520px; overflow: hidden; overflow: clip; color: ${FG}; font-size: 13px; }
.ko-viewport { position: absolute; inset: 0; overflow: hidden; overflow: clip; touch-action: none; user-select: none; cursor: grab; }
.ko-viewport[data-dragging] { cursor: grabbing; }
.ko-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.ko-lines { position: absolute; overflow: visible; pointer-events: none; }

.ko-toolbar { position: absolute; z-index: 3; top: 12px; left: 12px; display: flex; gap: 4px; padding: 4px; border-radius: 10px; background: ${CARD}; border: 1px solid ${BORDER}; box-shadow: 0 1px 2px rgb(0 0 0 / .06); }
.ko-toolbar button { padding: 5px 10px; border-radius: 7px; font: inherit; font-size: 12.5px; font-weight: 500; color: ${FG}; background: transparent; border: 0; cursor: pointer; }
.ko-toolbar button:hover { background: color-mix(in oklab, ${MUTED} 12%, transparent); }

.ko-card { position: absolute; display: flex; align-items: center; gap: 10px; padding: 8px 10px; box-sizing: border-box; border-radius: 12px; border: 1px solid ${BORDER}; background: ${CARD}; color: ${FG}; text-align: left; font: inherit; cursor: pointer; box-shadow: 0 1px 2px rgb(0 0 0 / .05); transition: opacity .2s, box-shadow .2s, border-color .2s; }
.ko-card:hover { border-color: color-mix(in oklab, ${FG} 25%, ${BORDER}); }
.ko-card:focus-visible, .ko-chev:focus-visible, .ko-toolbar button:focus-visible, .ko-close:focus-visible { outline: 2px solid var(--ring, #0f766e); outline-offset: 2px; }
.ko-card[data-selected] { border-color: ${WORKING}; box-shadow: 0 0 0 2px color-mix(in oklab, ${WORKING} 35%, transparent); }
.ko-card[data-size="head"] { padding: 12px 14px; gap: 12px; border-radius: 16px; }
.ko-face { position: relative; flex: none; width: 40px; height: 40px; border-radius: 30%; }
.ko-card[data-size="head"] .ko-face { width: 60px; height: 60px; }
.ko-face-art { display: block; width: 100%; height: 100%; border-radius: 30%; overflow: hidden; }
.ko-face-art svg { display: block; width: 100%; height: 100%; }
.ko-pause { position: absolute; right: -3px; bottom: -3px; width: 14px; height: 14px; border-radius: 50%; background: ${CARD}; border: 1px solid ${BORDER}; }
.ko-pause::before { content: ""; position: absolute; left: 4px; top: 3.5px; width: 5px; height: 6px; border-left: 1.5px solid ${MUTED}; border-right: 1.5px solid ${MUTED}; box-sizing: border-box; }
.ko-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.ko-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-card[data-size="head"] .ko-name { font-family: var(--kyoube-font-display, Georgia, serif); font-weight: 400; font-size: 21px; line-height: 1.1; }
.ko-title { font-size: 11.5px; color: ${MUTED}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-status { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: ${MUTED}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-status i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--kyoube-idle, #a1a1aa); }

.ko-card[data-state="working"] .ko-face { box-shadow: 0 0 0 2px color-mix(in oklab, ${WORKING} 45%, transparent); }
.ko-card[data-state="working"] .ko-status i { background: ${WORKING}; }
.ko-card[data-state="waiting"] .ko-face { box-shadow: 0 0 0 2px ${WAITING}; }
.ko-card[data-state="waiting"] .ko-status i { background: ${WAITING}; }
.ko-card[data-state="attention"] { border-color: ${DANGER}; background: color-mix(in oklab, ${DANGER} 7%, ${CARD}); }
.ko-card[data-state="attention"] .ko-face { box-shadow: 0 0 0 2px ${DANGER}; }
.ko-card[data-state="attention"] .ko-status { color: ${DANGER}; }
.ko-card[data-state="attention"] .ko-status i { background: ${DANGER}; }
.ko-card[data-state="paused"] { opacity: .6; }

.ko-line { fill: none; stroke: color-mix(in oklab, ${MUTED} 45%, transparent); stroke-width: 1.5; transition: opacity .2s; }
.ko-line[data-state="working"] { stroke: ${WORKING}; stroke-dasharray: 6 6; }
.ko-line[data-state="attention"] { stroke: ${DANGER}; stroke-dasharray: 4 4; }
.ko-line[data-state="paused"] { opacity: .4; }

.ko-panel { position: absolute; box-sizing: border-box; border-radius: 16px; box-shadow: inset 0 0 0 1px ${BORDER}; transition: opacity .2s; }
${tintRules}
.ko-panel-head { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px 0 6px; box-sizing: border-box; min-width: 0; }
.ko-chev { flex: none; display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 6px; border: 0; border-radius: 7px; background: transparent; color: ${FG}; font: inherit; cursor: pointer; }
.ko-chev:hover { background: color-mix(in oklab, ${FG} 8%, transparent); }
.ko-chev svg { flex: none; transition: transform .15s; }
.ko-chev[aria-expanded="false"] svg { transform: rotate(-90deg); }
/* The name sits over the tally, so a role-named lead ("Team · Product Lead, Field") and a busy tally both fit a team-width panel. */
.ko-panel-label { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.ko-panel-name { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-tally { font-size: 11.5px; color: ${MUTED}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-chip .ko-chev { flex: 1; font-size: 12.5px; font-weight: 600; }
.ko-chip-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ko-chip i[data-alert] { flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${DANGER}; }

.ko-shelf { position: absolute; box-sizing: border-box; }
.ko-shelf h3 { margin: 0; height: 40px; display: flex; align-items: center; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: ${MUTED}; }

[data-kyoube-org] [data-dim] { opacity: .3; }
/* Cards sit inside their panel, so a dimmed card in a dimmed panel takes the panel's dimming instead of compounding it. */
[data-kyoube-org] [data-dim] [data-dim] { opacity: 1; }

.ko-side { position: absolute; z-index: 4; top: 0; right: 0; bottom: 0; width: 360px; box-sizing: border-box; padding: 16px; overflow-y: auto; background: ${CARD}; border-left: 1px solid ${BORDER}; box-shadow: -8px 0 24px rgb(0 0 0 / .06); }
.ko-close { position: absolute; top: 10px; right: 10px; display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: ${MUTED}; cursor: pointer; }
.ko-close:hover { background: color-mix(in oklab, ${MUTED} 12%, transparent); color: ${FG}; }
/* Presentation: full screen, or the whole window (ko-fill) above the host's own layers when full screen is refused. */
.ko-org[data-org-present] { background: var(--background, #fff); }
.ko-org.ko-fill { position: fixed; inset: 0; z-index: 2147483000; width: auto; height: auto; min-height: 0; }
.ko-caption { position: absolute; z-index: 3; left: 50%; bottom: 32px; transform: translateX(-50%); max-width: calc(100% - 32px); box-sizing: border-box; margin: 0; padding: 10px 20px; border-radius: 999px; background: ${CARD}; border: 1px solid ${BORDER}; box-shadow: 0 4px 16px rgb(0 0 0 / .08); font-family: var(--kyoube-font-display, Georgia, serif); font-size: 20px; line-height: 1.2; text-align: center; text-wrap: balance; width: max-content; }

@media (max-width: 639px) {
  /* A long live tally wraps to a second line on a phone instead of losing its end. */
  .ko-caption { font-size: 17px; border-radius: 18px; padding: 8px 16px; }
  .ko-side { top: auto; left: 0; width: auto; max-height: 65%; border-left: 0; border-top: 1px solid ${BORDER}; border-radius: 16px 16px 0 0; box-shadow: 0 -8px 24px rgb(0 0 0 / .08); }
}

@media (prefers-reduced-motion: no-preference) {
  .ko-card[data-state="working"] .ko-face { animation: ko-breathe 3.2s ease-in-out infinite; }
  .ko-card[data-state="attention"] .ko-face { animation: ko-alarm 1s ease-in-out infinite; }
  .ko-line[data-state="working"] { animation: ko-flow 1.6s linear infinite; }
  .ko-line[data-state="attention"] { animation: ko-flow .6s linear infinite; }
  .ko-side { animation: ko-slide-in .2s ease-out; }
  .ko-stage[data-glide] { transition: transform .9s ease-in-out; }
  @media (max-width: 639px) { .ko-side { animation-name: ko-slide-up; } }
  .ko-card[data-moment="finished"]::after { content: ""; position: absolute; left: 50%; top: 50%; width: 100%; aspect-ratio: 1; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, color-mix(in oklab, ${WORKING} 55%, transparent) 0%, transparent 70%); transform: translate(-50%, -50%) scale(.2); opacity: 0; animation: ko-burst 1.2s ease-out; }
  .ko-card[data-moment="handover"] { animation: ko-pulse .6s ease-out .4s; }
  .ko-line[data-moment="handover"] { stroke: ${WORKING}; stroke-width: 3; stroke-dasharray: 10 400; animation: ko-ripple 1s ease-in; }
  .ko-card[data-moment="problem"] { animation: ko-shake .5s ease-in-out 1; }
  @keyframes ko-burst { 0% { transform: translate(-50%, -50%) scale(.2); opacity: .9; } 100% { transform: translate(-50%, -50%) scale(1.8); opacity: 0; } }
  @keyframes ko-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in oklab, ${WORKING} 45%, transparent); } 100% { box-shadow: 0 0 0 10px color-mix(in oklab, ${WORKING} 0%, transparent); } }
  @keyframes ko-ripple { from { stroke-dashoffset: 410; } to { stroke-dashoffset: 0; } }
  @keyframes ko-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-5px); } 40% { transform: translateX(5px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(3px); } }
  @keyframes ko-breathe { 0%, 100% { box-shadow: 0 0 0 2px color-mix(in oklab, ${WORKING} 45%, transparent); } 50% { box-shadow: 0 0 0 6px color-mix(in oklab, ${WORKING} 0%, transparent); } }
  @keyframes ko-alarm { 0%, 100% { box-shadow: 0 0 0 2px ${DANGER}; } 50% { box-shadow: 0 0 0 6px color-mix(in oklab, ${DANGER} 0%, transparent); } }
  @keyframes ko-flow { to { stroke-dashoffset: -24; } }
  @keyframes ko-slide-in { from { transform: translateX(24px); opacity: 0; } }
  @keyframes ko-slide-up { from { transform: translateY(24px); opacity: 0; } }
}
@media (prefers-reduced-motion: reduce) {
  .ko-org *, .ko-org *::before, .ko-org *::after { animation: none !important; transition: none !important; }
}
`;

const STYLE_ID = "kyoube-org-styles";

export const ORG_CSS = CSS;

/** Adds the stylesheet to the document once; safe to call from every render. Does nothing without a document. */
export function ensureOrgStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
