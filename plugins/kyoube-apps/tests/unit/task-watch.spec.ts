import { describe, expect, it } from "vitest";
import { TASK_WATCH, createTaskWatcher } from "../../src/ui/apps/task-watch.js";

/** Hand-driven timers and clock: `tick()` fires every live interval once, as five seconds passing would. */
function harness(poll: (id: string) => Promise<unknown>) {
  const clock = { at: 0 };
  let next = 1;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const posted: Array<Record<string, unknown>> = [];
  const ended: string[] = [];
  const polls: string[] = [];
  const watcher = createTaskWatcher({
    poll: (id) => { polls.push(id); return poll(id); },
    post: (task) => { posted.push(task); },
    onEnd: (id) => { ended.push(id); },
    setInterval: (fn, ms) => { const handle = next++; intervals.set(handle, { fn, ms }); return handle; },
    clearInterval: (handle) => { intervals.delete(handle as number); },
    now: () => clock.at,
  });
  const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const tick = async () => {
    clock.at += TASK_WATCH.intervalMs;
    for (const entry of [...intervals.values()]) entry.fn();
    await flush();
  };
  return { watcher, posted, ended, polls, intervals, clock, flush, tick };
}

const task = (status: string, updatedAt = "2026-10-11T10:00:00Z", result: string | null = null, id = "t1") => ({ id, status, updatedAt, result, template: "s", rowId: null });

describe("TaskWatcher", () => {
  it("polls every 5 s, posting once immediately and then only on a change", async () => {
    expect(TASK_WATCH.intervalMs).toBe(5_000);
    let current = task("waiting");
    const h = harness(async () => current);
    h.watcher.start("t1");
    await h.flush();
    expect([...h.intervals.values()].map((entry) => entry.ms)).toEqual([5_000]);
    expect(h.posted).toEqual([current]);
    await h.tick();
    await h.tick();
    expect(h.polls).toHaveLength(3);
    expect(h.posted).toHaveLength(1);
    current = task("working", "2026-10-11T10:01:00Z");
    await h.tick();
    expect(h.posted.at(-1)).toEqual(current);
    current = task("working", "2026-10-11T10:01:00Z", "partial");
    await h.tick();
    expect(h.posted).toHaveLength(3);
    current = task("working", "2026-10-11T10:02:00Z", "partial");
    await h.tick();
    expect(h.posted).toHaveLength(4);
  });

  it("stops at done and at cancelled, after posting that state", async () => {
    for (const status of ["done", "cancelled"]) {
      let current = task("working");
      const h = harness(async () => current);
      h.watcher.start("t1");
      await h.flush();
      current = task(status, "2026-10-11T11:00:00Z", status === "done" ? "All done" : null);
      await h.tick();
      expect(h.posted.at(-1)).toEqual(current);
      expect(h.ended).toEqual(["t1"]);
      expect(h.intervals.size).toBe(0);
      const polls = h.polls.length;
      await h.tick();
      expect(h.polls).toHaveLength(polls);
    }
  });

  it("stops after 30 minutes", async () => {
    expect(TASK_WATCH.maxMs).toBe(30 * 60_000);
    const h = harness(async () => task("working"));
    h.watcher.start("t1");
    await h.flush();
    for (let i = 0; i < 30 * 12 - 1; i += 1) await h.tick();
    expect(h.ended).toEqual([]);
    const polls = h.polls.length;
    await h.tick();
    expect(h.ended).toEqual(["t1"]);
    expect(h.polls).toHaveLength(polls);
    expect(h.intervals.size).toBe(0);
  });

  it("stop(id) ends one watch; a reply still in flight is not posted", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const h = harness(() => new Promise((resolve) => { pending.push(resolve); }));
    h.watcher.start("t1");
    h.watcher.start("t2");
    h.watcher.stop("t1");
    pending[0]!(task("working"));
    pending[1]!(task("working", undefined, null, "t2"));
    await h.flush();
    expect(h.posted.map((entry) => entry.id)).toEqual(["t2"]);
    expect(h.ended).toEqual(["t1"]);
    expect(h.intervals.size).toBe(1);
  });

  it("stopAll() ends every watch, as on unmount", async () => {
    const h = harness(async (id) => task("working", undefined, null, id));
    h.watcher.start("t1");
    h.watcher.start("t2");
    await h.flush();
    h.watcher.stopAll();
    expect(h.intervals.size).toBe(0);
    expect(h.ended.sort()).toEqual(["t1", "t2"]);
    const posted = h.posted.length;
    await h.tick();
    expect(h.posted).toHaveLength(posted);
    // Starting again after a stop is a fresh watch.
    h.watcher.start("t1");
    await h.flush();
    expect(h.posted).toHaveLength(posted + 1);
  });

  it("does not overlap polls: a slow get skips the ticks it spans", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const h = harness(() => new Promise((resolve) => { pending.push(resolve); }));
    h.watcher.start("t1");
    await h.tick();
    await h.tick();
    expect(h.polls).toHaveLength(1);
    pending[0]!(task("working"));
    await h.flush();
    await h.tick();
    expect(h.polls).toHaveLength(2);
  });

  it("keeps polling through transient failures, so an update after a worker blip still arrives", async () => {
    let fail = true;
    const h = harness(async () => {
      // The host bridge's own rejection shape: a transport code, no worker code in the message.
      if (fail) throw { code: "WORKER_ERROR", message: "worker restarting" };
      return task("done", "2026-10-11T10:05:00Z", "All done");
    });
    h.watcher.start("t1");
    await h.flush();
    // 25 s of failures: six polls, far more than a 10–15 s blip.
    for (let i = 0; i < 5; i += 1) await h.tick();
    expect(h.polls).toHaveLength(6);
    expect(h.ended).toEqual([]);
    expect(h.posted).toEqual([]);
    fail = false;
    await h.tick();
    expect(h.posted).toEqual([task("done", "2026-10-11T10:05:00Z", "All done")]);
    expect(h.ended).toEqual(["t1"]);
  });

  it("treats a timeout as transient too", async () => {
    const h = harness(async () => { throw { code: "TIMEOUT", message: "timeout: the worker took too long" }; });
    h.watcher.start("t1");
    await h.flush();
    for (let i = 0; i < 6; i += 1) await h.tick();
    expect(h.ended).toEqual([]);
    expect(h.intervals.size).toBe(1);
  });

  it("ends the watch, freeing its slot, on a definitive refusal", async () => {
    for (const message of ["not_found: no such task", "forbidden: You don't have access to this app. Ask a company admin.", "disabled: app tasks are not available here"]) {
      const h = harness(async () => { throw { code: "WORKER_ERROR", message }; });
      h.watcher.start("t1");
      await h.flush();
      expect(h.ended).toEqual(["t1"]);
      expect(h.intervals.size).toBe(0);
      const polls = h.polls.length;
      await h.tick();
      expect(h.polls).toHaveLength(polls);
    }
  });

  it("ignores a reply that is not the watched task, and keeps watching", async () => {
    const h = harness(async () => ({ id: "other", status: "done" }));
    h.watcher.start("t1");
    await h.flush();
    expect(h.posted).toEqual([]);
    expect(h.ended).toEqual([]);
  });

  it("re-watching an id posts its current state again without a second timer", async () => {
    const h = harness(async () => task("working"));
    h.watcher.start("t1");
    await h.flush();
    h.watcher.start("t1");
    await h.flush();
    expect(h.posted).toHaveLength(2);
    expect(h.intervals.size).toBe(1);
  });
});
