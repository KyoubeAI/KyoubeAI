/**
 * Studio's own styles, injected once into the host document. They read the
 * core's theme tokens (--foreground, --border, ...) and KyoubeAI's
 * (--kyoube-*, set by docker/theme/theme.css), each with a fallback so the
 * components stay legible if the theme is absent.
 *
 * The collapsed sidebar rail is detected with a container query on the
 * `kyoube-sidebar` container the theme declares on the sidebar.
 */
const CSS = String.raw`
.ks-label { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 14px 12px 4px 20px; min-height: 24px; }
.ks-label-text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: color-mix(in oklab, var(--muted-foreground, #71717a) 70%, transparent); white-space: nowrap; }
.ks-label-actions { display: flex; align-items: center; gap: 2px; }
.ks-icon-btn { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--muted-foreground, #71717a); transition: background-color .15s, color .15s; }
.ks-icon-btn:hover { background: var(--accent, #f0f0f2); color: var(--foreground, #18181b); }
.ks-icon-btn:focus-visible, .ks-row:focus-visible, .ks-btn:focus-visible, .ks-card:focus-visible, .ks-need:focus-visible { outline: 2px solid var(--ring, #0f766e); outline-offset: 1px; }
.ks-divider { display: none; height: 1px; margin: 12px 14px 6px; background: color-mix(in oklab, var(--border, #e8e8eb) 60%, transparent); }

.ks-team { display: flex; flex-direction: column; gap: 1px; }
.ks-row { display: flex; align-items: center; gap: 10px; margin: 0 8px; padding: 5px 8px; border-radius: 10px; min-width: 0; color: var(--foreground, #18181b); text-decoration: none; transition: background-color .15s; }
.ks-row:hover { background: color-mix(in oklab, var(--accent, #f0f0f2) 60%, transparent); }
.ks-row[aria-current="page"] { background: var(--accent, #f0f0f2); }
.ks-who { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.ks-who b { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-who span { font-size: 11.5px; font-weight: 450; color: var(--muted-foreground, #71717a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-who span[data-state="working"] { color: var(--kyoube-working, #0f766e); }
.ks-who span[data-state="waiting"] { color: var(--kyoube-waiting, #c2410c); }
.ks-who span[data-state="attention"] { color: var(--kyoube-danger, #dc2626); }
.ks-more { margin: 2px 8px 0; padding: 5px 8px; border-radius: 8px; font-size: 12px; font-weight: 500; color: var(--muted-foreground, #71717a); text-decoration: none; display: flex; align-items: center; gap: 8px; }
.ks-more:hover { background: color-mix(in oklab, var(--accent, #f0f0f2) 60%, transparent); color: var(--foreground, #18181b); }
.ks-empty { margin: 2px 16px 4px 20px; font-size: 12px; color: var(--muted-foreground, #71717a); }
.ks-empty a { color: var(--kyoube-accent, #0f766e); font-weight: 500; }
.ks-skeleton { margin: 4px 16px 4px 20px; height: 28px; border-radius: 8px; background: color-mix(in oklab, var(--muted, #f4f4f5) 80%, transparent); }

.ks-avatar { position: relative; flex: none; display: inline-block; border-radius: 30%; }
.ks-avatar-art { display: block; width: 100%; height: 100%; border-radius: 30%; overflow: hidden; }
.ks-avatar-art svg { display: block; width: 100%; height: 100%; }
.ks-avatar[data-tint="teal"] .ks-avatar-art { background: var(--kyoube-tile-teal, #d3efe9); }
.ks-avatar[data-tint="sky"] .ks-avatar-art { background: var(--kyoube-tile-sky, #d9e9f5); }
.ks-avatar[data-tint="violet"] .ks-avatar-art { background: var(--kyoube-tile-violet, #e7ddfa); }
.ks-avatar[data-tint="amber"] .ks-avatar-art { background: var(--kyoube-tile-amber, #f6e4cc); }
.ks-avatar[data-tint="rose"] .ks-avatar-art { background: var(--kyoube-tile-rose, #f8dce2); }
.ks-avatar[data-tint="zinc"] .ks-avatar-art { background: var(--kyoube-tile-zinc, #e9e9ec); }
.ks-dot { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--sidebar, #fafafa); background: var(--kyoube-idle, #a1a1aa); }
.ks-dot[data-state="working"] { background: var(--kyoube-working, #0f766e); }
.ks-dot[data-state="waiting"] { background: var(--kyoube-waiting, #c2410c); }
.ks-dot[data-state="attention"] { background: var(--kyoube-danger, #dc2626); }
.ks-card .ks-dot, .ks-home .ks-dot { border-color: var(--card, #fff); }

@container kyoube-sidebar (max-width: 120px) {
  .ks-label { display: none; }
  .ks-divider { display: block; }
  .ks-row { justify-content: center; padding: 5px 0; margin: 0 10px; }
  .ks-who, .ks-more span, .ks-empty { display: none; }
  .ks-more { justify-content: center; }
}

/* ── Home ─────────────────────────────────────────────────────────────── */
.ks-home { display: flex; flex-direction: column; gap: 22px; container: ks-home / inline-size; color: var(--foreground, #18181b); }
.ks-hello { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ks-hello h2 { margin: 0; font-family: var(--kyoube-font-display, Georgia, serif); font-weight: 400; font-size: clamp(30px, 4.2vw, 42px); line-height: 1.02; letter-spacing: -.01em; text-wrap: balance; }
.ks-hello h2 em { font-style: italic; color: var(--kyoube-accent, #0f766e); }
.ks-hello p { margin: 8px 0 0; font-size: 13.5px; color: var(--muted-foreground, #71717a); }
.ks-hello p b { color: var(--foreground, #18181b); font-weight: 600; }

.ks-strip { position: relative; display: grid; grid-template-columns: 1fr 18px 1fr 18px 1.25fr; align-items: stretch; gap: 8px; padding: 14px; border: 1px solid var(--kyoube-strip-border, #d6eee9); background: var(--kyoube-strip, #f1faf8); border-radius: 14px; }
.ks-strip-close { position: absolute; right: 8px; top: 6px; }
.ks-step { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 14px; border: 1px solid var(--border, #e8e8eb); background: var(--card, #fff); border-radius: 11px; box-shadow: var(--kyoube-shadow, none); color: inherit; text-decoration: none; }
a.ks-step:hover { border-color: color-mix(in oklab, var(--kyoube-accent, #0f766e) 40%, var(--border, #e8e8eb)); }
.ks-step-text { flex: 1; min-width: 0; }
.ks-step-text b { display: block; font-size: 13px; font-weight: 600; }
.ks-step-text span { display: block; font-size: 11.5px; color: var(--muted-foreground, #71717a); }
.ks-step[data-done="true"] .ks-step-text b { color: var(--muted-foreground, #71717a); text-decoration: line-through; }
.ks-check { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--kyoube-accent, #0f766e); color: var(--kyoube-accent-ink, #fff); font-size: 11px; font-weight: 600; }
.ks-check[data-done="false"] { background: transparent; border: 1.5px dashed var(--muted-foreground, #71717a); color: var(--muted-foreground, #71717a); }
.ks-arrow { display: grid; place-items: center; color: var(--kyoube-accent, #0f766e); }
.ks-stack { display: flex; margin-left: auto; }
.ks-stack .ks-avatar { margin-left: -8px; box-shadow: 0 0 0 2px var(--card, #fff); }
.ks-stack .ks-avatar:first-child { margin-left: 0; }

.ks-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; }
.ks-panel { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border, #e8e8eb); border-radius: 14px; background: var(--card, #fff); box-shadow: var(--kyoube-shadow, none); }
.ks-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border, #e8e8eb); }
.ks-panel-head b { font-size: 13px; font-weight: 600; }
.ks-panel-head a, .ks-panel-head span { font-size: 12px; color: var(--muted-foreground, #71717a); text-decoration: none; }
.ks-panel-head a:hover { color: var(--foreground, #18181b); }
.ks-need { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 1px solid var(--border, #e8e8eb); color: inherit; text-decoration: none; min-width: 0; }
.ks-need:last-child { border-bottom: 0; }
.ks-need:hover { background: color-mix(in oklab, var(--accent, #f0f0f2) 45%, transparent); }
.ks-kind { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; }
.ks-kind[data-kind="approval"] { background: color-mix(in oklab, var(--kyoube-waiting, #c2410c) 14%, transparent); color: var(--kyoube-waiting, #c2410c); }
.ks-kind[data-kind="review"] { background: var(--kyoube-accent-soft, #e3f5f1); color: var(--kyoube-accent, #0f766e); }
.ks-kind[data-kind="blocked"], .ks-kind[data-kind="agent"] { background: color-mix(in oklab, var(--kyoube-danger, #dc2626) 12%, transparent); color: var(--kyoube-danger, #dc2626); }
.ks-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ks-text b { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-text span { font-size: 11.5px; color: var(--muted-foreground, #71717a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.ks-btn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 7px; font-size: 12px; font-weight: 600; border: 1px solid var(--border, #e8e8eb); background: var(--card, #fff); color: var(--foreground, #18181b); white-space: nowrap; }
.ks-btn[data-tone="accent"] { background: var(--kyoube-accent, #0f766e); border-color: var(--kyoube-accent, #0f766e); color: var(--kyoube-accent-ink, #fff); }
.ks-state { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 500; color: var(--muted-foreground, #71717a); white-space: nowrap; }
.ks-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--kyoube-idle, #a1a1aa); }
.ks-state[data-state="working"] { color: var(--kyoube-working, #0f766e); }
.ks-state[data-state="working"] i { background: var(--kyoube-working, #0f766e); box-shadow: 0 0 0 3px color-mix(in oklab, var(--kyoube-working, #0f766e) 22%, transparent); }
.ks-state[data-state="waiting"] { color: var(--kyoube-waiting, #c2410c); }
.ks-state[data-state="waiting"] i { background: var(--kyoube-waiting, #c2410c); }
.ks-state[data-state="attention"] { color: var(--kyoube-danger, #dc2626); }
.ks-state[data-state="attention"] i { background: var(--kyoube-danger, #dc2626); }
.ks-none { display: flex; align-items: center; gap: 10px; padding: 18px 16px; font-size: 13px; color: var(--muted-foreground, #71717a); }
.ks-none .ks-check { width: 24px; height: 24px; }

.ks-updates { padding: 14px 16px 16px; }
.ks-track { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); position: relative; }
.ks-track::before { content: ""; position: absolute; left: 14px; right: 14px; top: 13px; border-top: 1.5px dashed var(--border, #e8e8eb); }
.ks-event { position: relative; display: flex; flex-direction: column; gap: 6px; padding-right: 12px; color: inherit; text-decoration: none; min-width: 0; }
.ks-event-text { min-width: 0; }
.ks-event-text b { font-size: 12px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ks-event-text span { display: block; font-size: 11px; color: var(--muted-foreground, #71717a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-event:hover .ks-event-text b { text-decoration: underline; text-underline-offset: 2px; }
.ks-node { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; border: 3px solid var(--card, #fff); }
.ks-node[data-tone="teal"] { background: var(--kyoube-tile-teal, #d3efe9); color: var(--kyoube-accent, #0f766e); }
.ks-node[data-tone="sky"] { background: var(--kyoube-tile-sky, #d9e9f5); color: #0369a1; }
.ks-node[data-tone="violet"] { background: var(--kyoube-tile-violet, #e7ddfa); color: #6d28d9; }
.ks-node[data-tone="amber"] { background: var(--kyoube-tile-amber, #f6e4cc); color: #b45309; }
.ks-node[data-tone="rose"] { background: var(--kyoube-tile-rose, #f8dce2); color: #be123c; }
.dark .ks-node[data-tone="sky"] { color: #7dd3fc; }
.dark .ks-node[data-tone="violet"] { color: #c4b5fd; }
.dark .ks-node[data-tone="amber"] { color: #fcd34d; }
.dark .ks-node[data-tone="rose"] { color: #fda4af; }

@container ks-home (max-width: 760px) {
  .ks-grid { grid-template-columns: minmax(0, 1fr); }
  .ks-strip { grid-template-columns: minmax(0, 1fr); }
  .ks-arrow { display: none; }
  .ks-track { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .ks-track::before { display: none; }
  .ks-event { flex-direction: row; align-items: center; gap: 10px; }
  .ks-event .ks-node { flex: none; }
}

/* ── Workspace page ──────────────────────────────────────────────────── */
.ks-ws { display: flex; flex-direction: column; gap: 22px; max-width: 1180px; container: ks-ws / inline-size; color: var(--foreground, #18181b); }
.ks-ws-head h1 { margin: 0; font-family: var(--kyoube-font-display, Georgia, serif); font-weight: 400; font-size: 40px; line-height: 1; letter-spacing: -.01em; }
.ks-ws-head p { margin: 8px 0 0; font-size: 13.5px; color: var(--muted-foreground, #71717a); }
.ks-ws-group { display: flex; flex-direction: column; gap: 10px; }
.ks-ws-group h2 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-foreground, #71717a); }
.ks-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.ks-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 14px; border: 1px solid var(--border, #e8e8eb); border-radius: 12px; background: var(--card, #fff); box-shadow: var(--kyoube-shadow, none); color: inherit; text-decoration: none; transition: border-color .15s, transform .15s; }
.ks-card:hover { border-color: color-mix(in oklab, var(--kyoube-accent, #0f766e) 45%, var(--border, #e8e8eb)); }
.ks-card-title { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 600; }
.ks-card p { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--muted-foreground, #71717a); }
.ks-card-meta { margin-top: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted-foreground, #71717a); }
.ks-tile { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; }
.ks-tile[data-tone="teal"] { background: var(--kyoube-tile-teal, #d3efe9); color: var(--kyoube-accent, #0f766e); }
.ks-tile[data-tone="sky"] { background: var(--kyoube-tile-sky, #d9e9f5); color: #0369a1; }
.ks-tile[data-tone="violet"] { background: var(--kyoube-tile-violet, #e7ddfa); color: #6d28d9; }
.ks-tile[data-tone="amber"] { background: var(--kyoube-tile-amber, #f6e4cc); color: #b45309; }
.ks-tile[data-tone="rose"] { background: var(--kyoube-tile-rose, #f8dce2); color: #be123c; }
.ks-tile[data-tone="zinc"] { background: var(--kyoube-tile-zinc, #e9e9ec); color: var(--foreground, #18181b); }
.dark .ks-tile[data-tone="sky"] { color: #7dd3fc; }
.dark .ks-tile[data-tone="violet"] { color: #c4b5fd; }
.dark .ks-tile[data-tone="amber"] { color: #fcd34d; }
.dark .ks-tile[data-tone="rose"] { color: #fda4af; }
@container ks-ws (max-width: 900px) { .ks-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container ks-ws (max-width: 480px) { .ks-cards { grid-template-columns: minmax(0, 1fr); } }

/* ── Agent profile (Concept C) ─────────────────────────────────────── */
:root[data-kyoube-redirecting] main { visibility: hidden; }
.ks-profile { display: flex; flex-direction: column; gap: 20px; max-width: 1180px; container: ks-prof / inline-size; color: var(--foreground, #18181b); }
.ks-prof { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.ks-prof .ks-avatar .ks-dot { width: 16px; height: 16px; border-width: 3px; border-color: var(--background, #fff); }
.ks-prof-name { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: 6px; }
.ks-prof-name h1 { margin: 0; font-family: var(--kyoube-font-display, Georgia, serif); font-weight: 400; font-size: 36px; line-height: 1.02; letter-spacing: -.01em; }
.ks-prof-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 13px; color: var(--muted-foreground, #71717a); }
.ks-prof-meta span { display: inline-flex; align-items: center; gap: 5px; }
.ks-prof-meta a { color: var(--foreground, #18181b); text-decoration: none; font-weight: 500; }
.ks-prof-meta a:hover { text-decoration: underline; text-underline-offset: 2px; }
.ks-prof-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ks-btn-lg { height: 34px; padding: 0 13px; border-radius: 9px; font-size: 13px; cursor: pointer; text-decoration: none; }
.ks-btn[data-tone="primary"] { background: var(--primary, #18181b); border-color: var(--primary, #18181b); color: var(--primary-foreground, #fafafa); }
.ks-btn:disabled { opacity: .55; cursor: default; }
button.ks-btn { font-family: inherit; }
.ks-switch { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 6px; border: 0; background: none; font: inherit; font-size: 13px; font-weight: 500; color: var(--muted-foreground, #71717a); cursor: pointer; border-radius: 9px; }
.ks-switch:hover { background: color-mix(in oklab, var(--accent, #f0f0f2) 60%, transparent); }
.ks-switch:disabled { cursor: default; opacity: .6; }
.ks-switch i { position: relative; width: 32px; height: 18px; border-radius: 9px; background: var(--kyoube-idle, #a1a1aa); transition: background-color .15s; }
.ks-switch i::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
.ks-switch[aria-checked="true"] { color: var(--foreground, #18181b); }
.ks-switch[aria-checked="true"] i { background: var(--kyoube-accent, #0f766e); }
.ks-switch[aria-checked="true"] i::after { transform: translateX(14px); }
.ks-switch:focus-visible { outline: 2px solid var(--ring, #0f766e); outline-offset: 1px; }
.ks-assign { display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid var(--border, #e8e8eb); border-radius: 14px; background: var(--card, #fff); box-shadow: var(--kyoube-shadow, none); }
.ks-assign label { font-size: 13px; font-weight: 600; }
.ks-assign input, .ks-assign textarea { font: inherit; font-size: 13.5px; color: var(--foreground, #18181b); background: var(--background, #fff); border: 1px solid var(--input, #e4e4e7); border-radius: 9px; padding: 8px 10px; resize: vertical; }
.ks-assign input:focus, .ks-assign textarea:focus { outline: 2px solid var(--ring, #0f766e); outline-offset: 0; border-color: transparent; }
.ks-assign-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ks-assign-error { margin: 0; font-size: 12.5px; color: var(--kyoube-danger, #dc2626); }
.ks-banner { padding: 10px 14px; border-radius: 10px; font-size: 13px; border: 1px solid color-mix(in oklab, var(--kyoube-waiting, #c2410c) 35%, var(--border, #e8e8eb)); background: color-mix(in oklab, var(--kyoube-waiting, #c2410c) 8%, transparent); }
.ks-banner a { color: inherit; font-weight: 600; }
.ks-tabs { display: flex; gap: 22px; border-bottom: 1px solid var(--border, #e8e8eb); overflow-x: auto; scrollbar-width: none; }
.ks-tabs a { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 2px 1px 10px; font-size: 13.5px; font-weight: 500; color: var(--muted-foreground, #71717a); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.ks-tabs a:hover { color: var(--foreground, #18181b); }
.ks-tabs a[aria-current="page"] { color: var(--foreground, #18181b); border-bottom-color: var(--foreground, #18181b); }
.ks-tab-count { font-size: 11px; font-weight: 600; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; display: inline-grid; place-items: center; background: var(--muted, #f4f4f5); color: var(--muted-foreground, #71717a); }
.ks-pgrid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.ks-pcol { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.ks-now { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.ks-now-top { display: flex; align-items: center; gap: 10px; }
.ks-now-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--foreground, #18181b); text-decoration: none; line-height: 1.35; }
a.ks-now-title:hover { text-decoration: underline; text-underline-offset: 2px; }
.ks-now-note { margin: 0; font-size: 13px; color: var(--muted-foreground, #71717a); }
.ks-now-actions { display: flex; gap: 8px; }
.ks-bar { height: 6px; border-radius: 3px; background: var(--muted, #f4f4f5); overflow: hidden; position: relative; }
.ks-bar i { position: absolute; top: 0; bottom: 0; width: 38%; border-radius: 3px; background: var(--kyoube-accent, #0f766e); left: 0; }
.ks-log { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 7px; font-size: 12.5px; color: var(--muted-foreground, #71717a); }
.ks-log li { display: flex; align-items: flex-start; gap: 8px; }
.ks-log li svg { flex: none; margin-top: 1px; color: var(--kyoube-accent, #0f766e); }
.ks-log li[data-latest] { color: var(--foreground, #18181b); }
.ks-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ks-stats div { padding: 14px 16px; display: flex; flex-direction: column; gap: 3px; border-right: 1px solid var(--border, #e8e8eb); min-width: 0; }
.ks-stats div:last-child { border-right: 0; }
.ks-stats b { font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ks-stats span { font-size: 11.5px; color: var(--muted-foreground, #71717a); }
.ks-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 16px; }
.ks-chips span { font-size: 12px; font-weight: 500; padding: 3px 9px; border-radius: 7px; background: var(--muted, #f4f4f5); color: var(--foreground, #18181b); }
.ks-perm { display: flex; align-items: center; gap: 12px; padding: 11px 10px 11px 16px; }
.ks-perm .ks-text span { white-space: normal; }
.ks-perm + .ks-perm { border-top: 1px solid var(--border, #e4e4e7); }
.ks-seg { display: inline-flex; flex-shrink: 0; gap: 2px; padding: 2px; border: 1px solid var(--border, #e4e4e7); border-radius: 9px; }
.ks-seg button { height: 28px; padding: 0 10px; border: 0; border-radius: 7px; background: none; font: inherit; font-size: 13px; font-weight: 500; color: var(--muted-foreground, #71717a); cursor: pointer; white-space: nowrap; }
.ks-seg button:hover:not(:disabled) { background: color-mix(in oklab, var(--accent, #f0f0f2) 60%, transparent); }
.ks-seg button[aria-checked="true"] { background: var(--kyoube-accent, #0f766e); color: #fff; }
.ks-seg button:disabled { cursor: default; opacity: .6; }
@media (max-width: 560px) { .ks-perm-wide { flex-wrap: wrap; } .ks-perm-wide .ks-seg { margin-left: auto; } }
.ks-about { margin: 0; padding: 14px 16px; font-size: 13px; line-height: 1.5; color: var(--muted-foreground, #71717a); white-space: pre-line; }
.ks-classic { margin: 0; font-size: 12.5px; }
.ks-classic a { color: var(--muted-foreground, #71717a); }
.ks-tasklists { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
.ks-sti { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 1.8px solid var(--status-task-icon-backlog, #a1a1aa); }
.ks-sti[data-s="prog"] { border-color: var(--status-task-icon-in_progress, #2563eb); background: conic-gradient(var(--status-task-icon-in_progress, #2563eb) 0 50%, transparent 50%); }
.ks-sti[data-s="rev"] { border-color: var(--status-task-icon-in_review, #7c3aed); background: conic-gradient(var(--status-task-icon-in_review, #7c3aed) 0 75%, transparent 75%); }
.ks-sti[data-s="todo"] { border-color: var(--status-task-icon-todo, #cc7a00); }
.ks-sti[data-s="blk"] { border-color: var(--status-task-icon-blocked, #dc2626); background: var(--status-task-icon-blocked, #dc2626); }
.ks-sti[data-s="done"] { border-color: var(--status-task-icon-done, #16a34a); background: var(--status-task-icon-done, #16a34a); }
.ks-skeleton-avatar { width: 72px; height: 72px; margin: 0; border-radius: 30%; }
.ks-member { align-items: flex-start; }
.ks-member p { min-height: 18px; }
.ks-hire { border-style: dashed; }
.ks-hire-ph { width: 48px; height: 48px; border-radius: 30%; border: 1.5px dashed var(--muted-foreground, #71717a); display: grid; place-items: center; color: var(--muted-foreground, #71717a); }
@container ks-prof (max-width: 820px) {
  .ks-pgrid, .ks-tasklists { grid-template-columns: minmax(0, 1fr); }
}
@container ks-prof (max-width: 520px) {
  .ks-stats { grid-template-columns: minmax(0, 1fr); }
  .ks-stats div { border-right: 0; border-bottom: 1px solid var(--border, #e8e8eb); }
}

@media (prefers-reduced-motion: no-preference) {
  .ks-bar i { animation: ks-slide 1.8s ease-in-out infinite; }
  @keyframes ks-slide { 0% { left: -38%; } 100% { left: 100%; } }
  .ks-state[data-state="working"] i { animation: ks-pulse 2.2s ease-in-out infinite; }
  @keyframes ks-pulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in oklab, var(--kyoube-working, #0f766e) 22%, transparent); } 50% { box-shadow: 0 0 0 6px color-mix(in oklab, var(--kyoube-working, #0f766e) 0%, transparent); } }
}
`;

const STYLE_ID = "kyoube-studio-styles";

/** Adds the stylesheet to the host document once; safe to call from every component. */
export function ensureStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

export const STUDIO_CSS = CSS;
