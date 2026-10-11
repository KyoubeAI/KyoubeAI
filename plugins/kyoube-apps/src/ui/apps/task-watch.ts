/**
 * The host side of `kyoube.tasks.watch` (docs/app-tasks.md). The frame asks once; from then on the
 * runner — not the frame — polls `apps.task_get` for that id and pushes a `task` event into the
 * frame when something the app can see changed. The polls are the host's own work, so they cost
 * the frame nothing from its bridge budget; what bounds them is here: one poll every 5 s per id,
 * never two in flight for the same id, at most 30 minutes per watch, and an end at `done` or
 * `cancelled`. The bridge's guard caps a frame at 10 watches.
 *
 * A failed poll ends the watch only when the worker refused outright — `not_found`, `forbidden` or
 * `disabled`, which no later poll will answer differently. Anything else (a plugin restart, a
 * timeout, a dropped connection) is waited out: the next tick tries again, and the 30-minute cap
 * and the no-overlap rule bound what that costs.
 *
 * Pure apart from the error mapping: the timers and the clock are injected, so the stop conditions
 * are unit-tested without a DOM.
 */
import { appErrorPayload } from "./bridge.js";

export const TASK_WATCH = {
  intervalMs: 5_000,
  maxMs: 30 * 60_000,
} as const;

/** The worker's answers that are final for this viewer and this id: the watch ends on them. */
const REFUSALS: ReadonlySet<string> = new Set(["not_found", "forbidden", "disabled"]);

export interface TaskWatchDeps {
  /** `apps.task_get` for this id; resolves with the worker's `AppTask`. */
  poll(id: string): Promise<unknown>;
  /** Hands a changed task to the frame. Called only for a watch still running. */
  post(task: Record<string, unknown>): void;
  /** A watch ended — by `stop`, `stopAll`, a final status, the time limit or a refusal — so its slot can be freed. */
  onEnd?(id: string): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export interface TaskWatcher {
  /** Starts watching `id`, or — when it is already watched — restarts its clock and posts its state again. */
  start(id: string): void;
  stop(id: string): void;
  /** Ends every watch; the runner calls it on unmount and whenever it stops. */
  stopAll(): void;
}

interface Watch { handle: unknown; startedAt: number; last: string | null; inFlight: boolean }

const FINAL = new Set(["done", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createTaskWatcher(deps: TaskWatchDeps): TaskWatcher {
  const watches = new Map<string, Watch>();

  const end = (id: string): void => {
    const watch = watches.get(id);
    if (!watch) return;
    watches.delete(id);
    deps.clearInterval(watch.handle);
    deps.onEnd?.(id);
  };

  const poll = (id: string, watch: Watch): void => {
    // Every reply is checked against the map: a watch that was stopped (or replaced) while its get
    // was in flight posts nothing.
    if (watches.get(id) !== watch) return;
    if (deps.now() - watch.startedAt >= TASK_WATCH.maxMs) { end(id); return; }
    if (watch.inFlight) return;
    watch.inFlight = true;
    deps.poll(id).then((task) => {
      watch.inFlight = false;
      if (watches.get(id) !== watch) return;
      // Not the watched task: nothing to post, and nothing that says the next poll will differ.
      if (!isRecord(task) || task.id !== id) return;
      // What the app can act on: a new status, a new result, or any other update the issue records.
      const seen = JSON.stringify([task.status, task.updatedAt, task.result]);
      if (seen !== watch.last) {
        watch.last = seen;
        deps.post(task);
      }
      if (typeof task.status === "string" && FINAL.has(task.status)) end(id);
    }, (error: unknown) => {
      watch.inFlight = false;
      if (watches.get(id) !== watch) return;
      // The host's rejection carries the worker's code inside its message (see `appErrorPayload`).
      if (REFUSALS.has(appErrorPayload(error).code)) end(id);
    });
  };

  return {
    start(id: string): void {
      const existing = watches.get(id);
      if (existing) {
        // A second watch of the same id: the app has a new listener that has heard nothing yet.
        existing.startedAt = deps.now();
        existing.last = null;
        poll(id, existing);
        return;
      }
      const watch: Watch = { handle: null, startedAt: deps.now(), last: null, inFlight: false };
      watches.set(id, watch);
      watch.handle = deps.setInterval(() => { poll(id, watch); }, TASK_WATCH.intervalMs);
      poll(id, watch);
    },
    stop: end,
    stopAll(): void {
      for (const id of [...watches.keys()]) end(id);
    },
  };
}
