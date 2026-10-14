import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { appMountKey, createAppGuard, handleAppMessage, postTaskEvent, stopNotice, type AppGuard, type StopReason, type TaskOp } from "./bridge.js";
import { button } from "../forms.js";
import { appLabel, createDownloadController, formatSize, saveFile, type DownloadController, type PendingSave } from "./download.js";
import { keepFrameFitted } from "./frame-height.js";
import { buildSrcdoc, newAppNonce } from "./srcdoc.js";
import { createTaskWatcher, type TaskWatcher } from "./task-watch.js";

export interface AppRunnerProps {
  source: string;
  context: unknown;
  onData: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onToast: (title: string, tone: string) => void;
  onOpenApp: (slug: string) => void;
  onDecide?: (set: string, input: Record<string, unknown>) => Promise<unknown>;
  onConnection?: (name: string, request: Record<string, unknown>) => Promise<unknown>;
  onDecisionOutcome?: (decisionId: string, question: string, value: string | boolean) => Promise<unknown>;
  onTask?: (op: TaskOp, params: Record<string, unknown>) => Promise<unknown>;
  onTaskOpen?: (id: string) => Promise<void>;
}

/**
 * Renders the app in an opaque-origin iframe and hands its postMessage traffic
 * to `handleAppMessage` — this component owns only the frame, the listener,
 * and the srcdoc; every decision about a message is made (and unit-tested) in
 * `bridge.ts`.
 *
 * Ruling P4-R19, as narrowed by P4-R29: the frame is keyed on the app's
 * identity and version (`slug@version`), so a different document — a newly
 * published version arriving behind a mounted runner, or a different app —
 * remounts rather than swapping `srcDoc` under a live mount. Without this, the
 * new document's own `load` would be counted as the *second* load of the old
 * one — the runner would kill an app that never navigated — and it would run
 * under the previous mount's nonce, load counter, and call budget. A remount
 * gives it a fresh set of all three, which is what "a different document"
 * means. The key is the identity rather than the source text because the source
 * can be 2 MiB and says nothing about *which* app it is: two versions that
 * happen to ship identical bytes are still two versions.
 *
 * Manual check — the unit suite renders this component (ruling P4-R38, which
 * narrows P3-R6: `tests/unit/ui.spec.tsx` pins the frame's sandbox and policy
 * through `renderToStaticMarkup`) but never *mounts* it, so no effect below
 * ever runs there and none of the behaviour this paragraph describes is
 * covered by a test:
 * open a published app, press "Source & versions", edit the source, "Save
 * draft", then "Publish latest". The panel's `onChanged` reloads the runtime,
 * so a new version arrives in place. The app must re-render and keep working —
 * not be replaced by the "navigated away" notice, which is what the shape
 * before P4-R19 did — and its first data call after the swap must succeed,
 * which it can only do under the new mount's nonce. Editing the source *without*
 * publishing changes no published version, so the runner correctly keeps the
 * mount it has.
 */
export function AppRunner(props: AppRunnerProps) {
  return <AppFrame key={appMountKey(props.context)} {...props} />;
}

/**
 * The sandbox is exactly `allow-scripts allow-forms allow-modals allow-downloads` (ruling P3-R2,
 * widened by the app downloads design, 2026-10-14): without `allow-same-origin` the frame gets an
 * opaque origin, so app code cannot touch this document, its cookies, or its storage — the only way
 * out is a message the bridge accepts. `allow-downloads` lets `<a download>` inside the frame save a
 * file without the bridge's checks: an accepted residual (SECURITY.md, Apps), since the bytes only
 * reach the viewer's own disk. `allow-popups` is deliberately absent; apps navigate through
 * `ui.openApp` instead. `tests/unit/ui.spec.tsx` asserts the attribute is exactly those four tokens
 * and that the srcdoc carries `APP_CSP` (ruling P4-R38): before that, adding `allow-same-origin` here
 * passed every test in the repository.
 */
function AppFrame(props: AppRunnerProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  // Ruling P1-R15: the listener is registered once, so it reads the current
  // props (including the action callbacks, which the host bridge does not
  // guarantee to keep referentially stable) through this ref rather than
  // listing them as effect dependencies and re-subscribing on every render.
  const latest = useRef(props);
  latest.current = props;
  // Cleared on unmount so a data call still in flight cannot post its reply
  // into a frame this component no longer owns.
  const live = useRef(true);
  // One `load` per mount is the srcdoc document itself; a second one means the
  // app navigated its own frame (ruling P3-R18).
  const loads = useRef(0);
  const [stopped, setStopped] = useState<StopReason | null>(null);
  // The save waiting for the viewer, if any; the controller below owns it.
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const stop = useCallback((reason: StopReason) => {
    // `live` is cleared synchronously, before React re-renders, so a message
    // racing this is already refused. The task polls end here too, not only in
    // the effect cleanup the re-render brings: a stopped runner polls nothing.
    live.current = false;
    mount.current?.watcher.stopAll();
    mount.current?.downloads.dispose();
    setStopped(reason);
  }, []);
  // The nonce and the guard are minted once per mount and never recomputed:
  // `useMemo` is a hint React may discard, so they are held in a ref (lazily
  // initialised) instead. Both are keyed to this mount, and this component is
  // keyed on the app's identity — so a new document always gets a new pair.
  // The task watcher belongs to the mount as well: its polls are for this
  // frame's watches, and each one it ends frees that watch's slot in the guard.
  const mount = useRef<{ nonce: string; guard: AppGuard; watcher: TaskWatcher; downloads: DownloadController } | null>(null);
  if (!mount.current) {
    const nonce = newAppNonce();
    const guard = createAppGuard(nonce, { onStop: stop });
    const watcher = createTaskWatcher({
      // The host's own polls (docs/app-tasks.md): `apps.task_get` through the same prop as the
      // frame's `get`, outside the frame's budget.
      poll: (id) => latest.current.onTask ? latest.current.onTask("get", { id }) : Promise.reject(new Error("disabled: app tasks are not available here")),
      // Only into this runner's own frame, and only while it is live: an unmounted or stopped runner
      // has already ended every watch, and this check covers a poll that resolves in between.
      post: (task) => {
        const target = frame.current?.contentWindow;
        if (live.current && target) postTaskEvent(target, task);
      },
      onEnd: (id) => { guard.watchEnd(id); },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => { window.clearInterval(handle as number); },
      now: () => Date.now(),
    });
    // Downloads belong to the mount like the watcher: a save waiting for the viewer is this frame's,
    // and ends (as `disabled`) when the runner stops or unmounts.
    const downloads = createDownloadController({
      isActive: () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true,
      save: (file) => { saveFile(file, { document, url: URL, defer: (fn) => { window.setTimeout(fn, 10_000); } }); },
      onPrompt: (pending) => { setPendingSave(pending); },
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => { window.clearTimeout(handle as number); },
    });
    mount.current = { nonce, guard, watcher, downloads };
  }
  const { guard, watcher, downloads } = mount.current;
  const srcdoc = useMemo(() => buildSrcdoc(props.source, __KYOUBE_APP_SDK__, mount.current!.nonce), [props.source]);

  useEffect(() => {
    // A stopped runner registers no listener at all: flipping `stopped` runs
    // this effect's cleanup first, which clears `live` and unsubscribes.
    if (stopped) return;
    live.current = true;
    const handler = (event: MessageEvent) => {
      void handleAppMessage(event, frame.current?.contentWindow ?? null, {
        context: () => latest.current.context,
        onData: (method, params) => latest.current.onData(method, params),
        onToast: (title, tone) => { latest.current.onToast(title, tone); },
        onOpenApp: (slug) => { latest.current.onOpenApp(slug); },
        onDecide: (set, input) => latest.current.onDecide ? latest.current.onDecide(set, input) : Promise.reject(new Error("disabled: typed decisions are not available here")),
        onConnection: (name, request) => latest.current.onConnection ? latest.current.onConnection(name, request) : Promise.reject(new Error("disabled: connections are not available here")),
        onDecisionOutcome: (decisionId, question, value) => latest.current.onDecisionOutcome ? latest.current.onDecisionOutcome(decisionId, question, value) : Promise.reject(new Error("disabled: typed decisions are not available here")),
        onTask: (op, params) => latest.current.onTask ? latest.current.onTask(op, params) : Promise.reject(new Error("disabled: app tasks are not available here")),
        onTaskOpen: (id) => latest.current.onTaskOpen ? latest.current.onTaskOpen(id) : Promise.reject(new Error("disabled: app tasks are not available here")),
        onWatch: (id, on) => { if (on) watcher.start(id); else watcher.stop(id); },
        onDownload: (file) => downloads.request(file),
        isLive: () => live.current,
        guard,
      });
    };
    window.addEventListener("message", handler);
    return () => {
      live.current = false;
      window.removeEventListener("message", handler);
      // Unmount and stop both land here: no watch outlives the listener.
      watcher.stopAll();
      downloads.dispose();
    };
  }, [stopped, guard, watcher, downloads]);

  // The frame's height is measured, not styled — `frame-height.ts` says why
  // neither `h-full` nor a `min-h-[…]` class can size it under upstream's
  // plugin page, and `scripts/app-frame-check.mjs` lays it out in that page's
  // DOM chain in a real browser. A *layout* effect, so the first paint already
  // has the height; a plain effect would flash the browser's 150px default.
  // Keyed on `stopped` because the frame is only in the DOM while the runner
  // is live: once stopped there is nothing to fit, and the disposer has run.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    return keepFrameFitted(element);
  }, [stopped]);

  /**
   * Counting loads, and nothing else. Ruling P4-R29: this handler must never
   * announce the viewer's context, because it cannot tell whose document just
   * loaded. An app that assigns `location` while its own srcdoc is still
   * parsing leaves that document without ever firing `load` — so the *first*
   * load this sees is the arriving document's, and a context announcement here
   * would hand companyId, the viewer's id and level, and the app's declared
   * tables to it at `targetOrigin: "*"`. The context now leaves the host only
   * in answer to a `hello` carrying this mount's nonce, which the arriving
   * document cannot know; the SDK repeats that hello until the answer comes,
   * so nothing is lost by not announcing here.
   *
   * A second load is a navigation the app performed on itself — nothing in the
   * sandbox or the CSP stops a frame navigating its own browsing context, and
   * `contentWindow`/`event.source` stay the same WindowProxy across it, so the
   * arriving document would otherwise inherit a working bridge. The runner dies
   * instead: `live` is cleared synchronously, before React re-renders, so a
   * message racing this handler is already refused.
   */
  const onLoad = useCallback(() => {
    loads.current += 1;
    if (loads.current > 1) guard.stop("navigated");
  }, [guard]);

  if (stopped) return <div className="rounded border p-4 text-sm text-red-600">{stopNotice(stopped)}</div>;
  // `bg-background`, not white: an app that paints for `prefers-color-scheme:
  // dark` (as the skill asks apps to) would otherwise sit on a white sheet
  // wherever its own background is transparent. No height class: the layout
  // effect above sets `style.height` from measurements. `display: block`
  // inline rather than trusting the host's preflight for it — an inline frame
  // sits on a line box whose descender space below it is exactly the overflow
  // that makes `main` scroll — and `box-sizing: border-box` so the measured
  // height includes the border it is measured with.
  return (
    <>
      {pendingSave && <SaveBar pending={pendingSave} appName={appLabel(props.context)} />}
      <iframe ref={frame} onLoad={onLoad} title="Kyoube app" sandbox="allow-scripts allow-forms allow-modals allow-downloads" srcDoc={srcdoc} className="w-full rounded border bg-background" style={{ display: "block", boxSizing: "border-box" }} />
    </>
  );
}

/** Shown above the frame when an app asks to save a file and the viewer has not just clicked (see `download.ts`). */
export function SaveBar(props: { pending: PendingSave; appName: string }) {
  return (
    <div role="alertdialog" aria-label="Save a file" className="rounded border text-sm" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 8, marginBottom: 8 }}>
      <span style={{ flex: "1 1 16rem", minWidth: 0, overflowWrap: "anywhere" }}>
        <strong>{props.appName}</strong> wants to save <strong>{props.pending.filename}</strong> ({formatSize(props.pending.size)}).
      </span>
      <button type="button" className={button} onClick={props.pending.save}>Save</button>
      <button type="button" className={button} onClick={props.pending.dismiss}>Dismiss</button>
    </div>
  );
}
