import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { APP_BUDGET, createAppGuard, handleAppMessage, postTaskEvent, routeAppRequest, taskPagePath, type AppBridgeCallbacks } from "../../src/ui/apps/bridge.js";

const NONCE = "TESTnonce_0123456789-x";

function request(method: string, params: Record<string, unknown>, id = "1"): KyoubeRequest {
  return { kyoube: 1, id, method, params, nonce: NONCE } as unknown as KyoubeRequest;
}

function frame(overrides: Partial<AppBridgeCallbacks> = {}, clock = { at: 1_000 }) {
  const posted: Array<Record<string, unknown>> = [];
  const target = { postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); } };
  const tasks: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  const watches: Array<[string, boolean]> = [];
  const guard = createAppGuard(NONCE, { onStop: () => {}, now: () => clock.at });
  const callbacks: AppBridgeCallbacks = {
    context: () => ({}),
    onData: async () => ({ rows: [] }),
    onToast: () => {},
    onOpenApp: () => {},
    onTask: async (op, params) => { tasks.push([op, params]); return { id: "t1", op }; },
    onTaskOpen: async (id) => { opened.push(id); },
    onWatch: (id, on) => { watches.push([id, on]); },
    isLive: () => true,
    guard,
    ...overrides,
  };
  const send = (data: unknown) => handleAppMessage({ source: target, data }, target, callbacks);
  return { posted, tasks, opened, watches, send, guard, clock };
}

describe("routing task requests", () => {
  it("routes start with only the validated keys", () => {
    expect(routeAppRequest(request("tasks.start", { template: "summarise" }))).toEqual({ kind: "task", op: "start", params: { template: "summarise" } });
    expect(routeAppRequest(request("tasks.start", { template: "summarise", rowId: "r1", inputs: { tone: "short", n: 3 }, extra: "x" })))
      .toEqual({ kind: "task", op: "start", params: { template: "summarise", rowId: "r1", inputs: { tone: "short", n: 3 } } });
  });
  it("rejects a bad template, rowId or inputs on start", () => {
    const bad: Array<Record<string, unknown>> = [
      {},
      { template: "Summarise" },
      { template: "a".repeat(41) },
      { template: 7 },
      { template: "s", rowId: 5 },
      { template: "s", rowId: "r".repeat(101) },
      { template: "s", inputs: "tone=short" },
      { template: "s", inputs: ["short"] },
      { template: "s", inputs: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 } },
      { template: "s", inputs: { Tone: "short" } },
      { template: "s", inputs: { tone: { nested: true } } },
      { template: "s", inputs: { tone: "x".repeat(201) } },
      { template: "s", inputs: { n: Number.POSITIVE_INFINITY } },
      { template: "s", inputs: { n: Number.NaN } },
    ];
    for (const params of bad) expect(routeAppRequest(request("tasks.start", params))).toMatchObject({ kind: "reject", code: "invalid" });
  });
  it("routes get and cancel with a well-formed id only", () => {
    const uuid = "6f1c2b9e-7a1d-4c4b-9a55-1c2d3e4f5a6b";
    expect(routeAppRequest(request("tasks.get", { id: uuid }))).toEqual({ kind: "task", op: "get", params: { id: uuid } });
    expect(routeAppRequest(request("tasks.cancel", { id: uuid, extra: 1 }))).toEqual({ kind: "task", op: "cancel", params: { id: uuid } });
    for (const id of ["", "a".repeat(101), "../x", "t 1", "t/1", 5, null, undefined]) {
      expect(routeAppRequest(request("tasks.get", { id }))).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("tasks.cancel", { id }))).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("tasks.open", { id }))).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("tasks.watch", { id }))).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("tasks.unwatch", { id }))).toMatchObject({ kind: "reject", code: "invalid" });
    }
    expect(routeAppRequest(request("tasks.get", { id: "a".repeat(100) }))).toMatchObject({ kind: "task" });
  });
  it("routes list with an optional template and rowId", () => {
    expect(routeAppRequest(request("tasks.list", {}))).toEqual({ kind: "task", op: "list", params: {} });
    expect(routeAppRequest(request("tasks.list", { template: "summarise", rowId: "r1", other: 1 }))).toEqual({ kind: "task", op: "list", params: { template: "summarise", rowId: "r1" } });
    expect(routeAppRequest(request("tasks.list", { template: "Bad!" }))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("tasks.list", { rowId: 3 }))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("tasks.list", { rowId: "r".repeat(101) }))).toMatchObject({ kind: "reject", code: "invalid" });
  });
  it("routes open, watch and unwatch", () => {
    expect(routeAppRequest(request("tasks.open", { id: "t1" }))).toEqual({ kind: "taskOpen", id: "t1" });
    expect(routeAppRequest(request("tasks.watch", { id: "t1" }))).toEqual({ kind: "taskWatch", id: "t1", on: true });
    expect(routeAppRequest(request("tasks.unwatch", { id: "t1" }))).toEqual({ kind: "taskWatch", id: "t1", on: false });
  });
});

describe("handleAppMessage and tasks", () => {
  it("forwards get, list, cancel and start and replies with the result", async () => {
    const { send, posted, tasks } = frame();
    await send(request("tasks.get", { id: "t1" }, "g"));
    expect(posted.at(-1)).toEqual({ kyoube: 1, id: "g", result: { id: "t1", op: "get" } });
    await send(request("tasks.list", { template: "summarise" }, "l"));
    await send(request("tasks.cancel", { id: "t1" }, "c"));
    await send(request("tasks.start", { template: "summarise", rowId: "r1" }, "s"));
    expect(tasks).toEqual([["get", { id: "t1" }], ["list", { template: "summarise" }], ["cancel", { id: "t1" }], ["start", { template: "summarise", rowId: "r1" }]]);
    expect(posted.at(-1)).toMatchObject({ id: "s", result: { op: "start" } });
  });
  it("never calls onTask with an invalid request", async () => {
    const { send, posted, tasks } = frame();
    await send(request("tasks.start", { template: "BAD" }, "x"));
    await send(request("tasks.get", { id: "../etc" }, "y"));
    expect(tasks).toEqual([]);
    expect(posted.at(-1)).toMatchObject({ id: "y", error: { code: "invalid" } });
  });
  it("allows 5 starts per window; the 6th gets limit and still spends one of the 60", async () => {
    expect(APP_BUDGET.taskStarts).toBe(5);
    const { send, posted, tasks } = frame();
    for (let i = 0; i < 6; i += 1) await send(request("tasks.start", { template: "s" }, `s${i}`));
    expect(tasks).toHaveLength(5);
    expect(posted.at(-1)).toMatchObject({ id: "s5", error: { code: "limit", message: "limit: too many task starts" } });
    for (let i = 0; i < 54; i += 1) await send(request("data.query", { table: "t" }, `d${i}`));
    expect(posted.at(-1)).toMatchObject({ id: "d53", result: { rows: [] } });
    await send(request("data.query", { table: "t" }, "over"));
    expect(posted.at(-1)).toMatchObject({ id: "over", error: { code: "limit", message: "limit: too many requests" } });
  });
  it("lets starts again once the window has passed", async () => {
    const { send, posted, clock } = frame();
    for (let i = 0; i < 5; i += 1) await send(request("tasks.start", { template: "s" }, `s${i}`));
    clock.at += APP_BUDGET.windowMs;
    await send(request("tasks.start", { template: "s" }, "later"));
    expect(posted.at(-1)).toMatchObject({ id: "later", result: { op: "start" } });
  });
  it("get, list and cancel cost one request each and no start", async () => {
    const { send, posted } = frame();
    for (let i = 0; i < 20; i += 1) await send(request("tasks.get", { id: "t1" }, `g${i}`));
    for (let i = 0; i < 20; i += 1) await send(request("tasks.list", {}, `l${i}`));
    for (let i = 0; i < 15; i += 1) await send(request("tasks.cancel", { id: "t1" }, `c${i}`));
    // 55 spent: five starts still fit, and they take the last five of the 60.
    for (let i = 0; i < 5; i += 1) await send(request("tasks.start", { template: "s" }, `s${i}`));
    expect(posted.at(-1)).toMatchObject({ id: "s4", result: { op: "start" } });
    await send(request("tasks.get", { id: "t1" }, "over"));
    expect(posted.at(-1)).toMatchObject({ id: "over", error: { code: "limit", message: "limit: too many requests" } });
  });
  it("replies { code, message } for a failure", async () => {
    const { send, posted } = frame({ onTask: async () => { throw { code: "WORKER_ERROR", message: "forbidden: You can only read Data, so you can't ask an agent to change it." }; } });
    await send(request("tasks.start", { template: "s" }, "e"));
    expect(posted.at(-1)).toEqual({ kyoube: 1, id: "e", error: { code: "forbidden", message: "forbidden: You can only read Data, so you can't ask an agent to change it." } });
  });
  it("answers disabled without the callbacks", async () => {
    const { send, posted } = frame({ onTask: undefined, onTaskOpen: undefined, onWatch: undefined });
    await send(request("tasks.get", { id: "t1" }, "a"));
    expect(posted.at(-1)).toMatchObject({ id: "a", error: { code: "disabled" } });
    await send(request("tasks.open", { id: "t1" }, "b"));
    expect(posted.at(-1)).toMatchObject({ id: "b", error: { code: "disabled" } });
    await send(request("tasks.watch", { id: "t1" }, "c"));
    expect(posted.at(-1)).toMatchObject({ id: "c", error: { code: "disabled" } });
  });
  it("posts no reply once the runner is no longer live", async () => {
    let live = true;
    const { send, posted } = frame({ isLive: () => live, onTask: async () => { live = false; return { id: "t1" }; } });
    await send(request("tasks.get", { id: "t1" }, "late"));
    expect(posted).toEqual([]);
  });
});

describe("watching", () => {
  it("allows 10 live watches; the 11th gets limit; unwatch frees a slot", async () => {
    const { send, posted, watches } = frame();
    for (let i = 0; i < 10; i += 1) await send(request("tasks.watch", { id: `t${i}` }, `w${i}`));
    expect(watches).toHaveLength(10);
    expect(posted.at(-1)).toMatchObject({ id: "w9", result: null });
    await send(request("tasks.watch", { id: "t10" }, "w10"));
    expect(posted.at(-1)).toMatchObject({ id: "w10", error: { code: "limit" } });
    expect(watches).toHaveLength(10);
    // Watching an id already watched takes no second slot.
    await send(request("tasks.watch", { id: "t3" }, "again"));
    expect(posted.at(-1)).toMatchObject({ id: "again", result: null });
    await send(request("tasks.unwatch", { id: "t0" }, "u0"));
    expect(watches.at(-1)).toEqual(["t0", false]);
    await send(request("tasks.watch", { id: "t10" }, "w10b"));
    expect(posted.at(-1)).toMatchObject({ id: "w10b", result: null });
  });
  it("a watch the host ended (done, 30 min) frees its slot through watchEnd", () => {
    const { guard } = frame();
    for (let i = 0; i < 10; i += 1) expect(guard.watchStart(`t${i}`)).toBe(true);
    expect(guard.watchStart("t10")).toBe(false);
    guard.watchEnd("t4");
    expect(guard.watchStart("t10")).toBe(true);
  });
  it("watch and unwatch each cost one of the 60 requests", async () => {
    const { send, posted } = frame();
    for (let i = 0; i < 30; i += 1) {
      await send(request("tasks.watch", { id: "t1" }, `w${i}`));
      await send(request("tasks.unwatch", { id: "t1" }, `u${i}`));
    }
    await send(request("tasks.watch", { id: "t1" }, "over"));
    expect(posted.at(-1)).toMatchObject({ id: "over", error: { code: "limit", message: "limit: too many requests" } });
  });
});

describe("opening a task", () => {
  it("allows one open per 10 s", async () => {
    const { send, posted, opened, clock } = frame();
    await send(request("tasks.open", { id: "t1" }, "o1"));
    expect(posted.at(-1)).toEqual({ kyoube: 1, id: "o1", result: null });
    clock.at += APP_BUDGET.windowMs - 1;
    await send(request("tasks.open", { id: "t2" }, "o2"));
    expect(posted.at(-1)).toMatchObject({ id: "o2", error: { code: "limit" } });
    expect(opened).toEqual(["t1"]);
    clock.at += 1;
    await send(request("tasks.open", { id: "t2" }, "o3"));
    expect(opened).toEqual(["t1", "t2"]);
  });
  it("replies with the error when the open fails", async () => {
    const { send, posted } = frame({ onTaskOpen: async () => { throw new Error("not_found: no such task"); } });
    await send(request("tasks.open", { id: "t1" }, "o"));
    expect(posted.at(-1)).toMatchObject({ id: "o", error: { code: "not_found" } });
  });
  it("navigates only to a same-origin host path", () => {
    expect(taskPagePath("/ABC/issues/ABC-12")).toBe("/ABC/issues/ABC-12");
    expect(taskPagePath("/issues/6f1c2b9e-7a1d-4c4b-9a55-1c2d3e4f5a6b")).toBe("/issues/6f1c2b9e-7a1d-4c4b-9a55-1c2d3e4f5a6b");
    for (const url of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "ABC/issues/1", "", "/a b", "/x?y", "/x#y", "/x\n", 5, null, `/${"a".repeat(600)}`]) {
      expect(taskPagePath(url)).toBeNull();
    }
  });
});

describe("task events", () => {
  it("posts { kyoube, event: task, task } to the frame", () => {
    const posted: Array<[unknown, string]> = [];
    postTaskEvent({ postMessage: (message, origin) => { posted.push([message, origin]); } }, { id: "t1", status: "done" });
    expect(posted).toEqual([[{ kyoube: 1, event: "task", task: { id: "t1", status: "done" } }, "*"]]);
  });
});
