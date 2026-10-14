import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ruling P4-R37 (extending P4-R29). `window.parent` is `[Replaceable]`: app code that assigns
 * `window.parent = interceptor` after the SDK installed would, if the SDK read the property at
 * post time, capture every message it sends — the handshake nonce included. The SDK therefore
 * binds the parent once, at install, before any app-authored byte has been parsed.
 *
 * These tests install the SDK the way the runner does: the nonce on the global, a window whose
 * `parent` is not itself, and no document at all (the node environment), so `scrubNonceScript`
 * takes its early return exactly as it would in a frame with no `currentScript`.
 */

interface Posted { message: Record<string, unknown>; targetOrigin: string }

type Listener = (event: { source: unknown; data: unknown }) => void;

function installEnv(nonce: string) {
  const posts: Posted[] = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => void posts.push({ message: message as Record<string, unknown>, targetOrigin }) };
  const listeners: Listener[] = [];
  const win = {
    parent: parent as unknown,
    addEventListener: (type: string, listener: Listener) => { if (type === "message") listeners.push(listener); },
  };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).__kyoubeNonce = nonce;
  return {
    posts,
    parent,
    /** What `window.kyoube` ended up being, after the SDK's `defineProperty`. */
    sdk: () => (win as unknown as { kyoube: { ready(): Promise<unknown>; data: { query(table: string, spec?: Record<string, unknown>): Promise<unknown> } } }).kyoube,
    /** Replaces `window.parent` the way hostile app code would, after install. */
    hijack: () => {
      const stolen: unknown[] = [];
      win.parent = { postMessage: (message: unknown) => void stolen.push(message) };
      return stolen;
    },
    deliver: (event: { source: unknown; data: unknown }) => { for (const listener of listeners) listener(event); },
  };
}

async function install(nonce: string) {
  const env = installEnv(nonce);
  vi.resetModules();
  await import("../src/sdk.js");
  return env;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).__kyoubeNonce;
});

describe("SDK install", () => {
  it("posts to the parent captured at install, even after app code replaces window.parent", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    // The handshake is posted synchronously at install, before any app code could run.
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]!.message).toMatchObject({ id: "hello", nonce: "nonce-abcdefghijklmnop" });
    // The nonce is gone from the global the runner wrote it to.
    expect((globalThis as Record<string, unknown>).__kyoubeNonce).toBeUndefined();

    const stolen = env.hijack();
    const call = env.sdk().data.query("contacts", { limit: 1 });
    // The interceptor sees nothing; the real parent got the request, nonce and all.
    expect(stolen).toEqual([]);
    expect(env.posts).toHaveLength(2);
    const request = env.posts[1]!.message;
    expect(request).toMatchObject({ method: "data.query", nonce: "nonce-abcdefghijklmnop", params: { table: "contacts", limit: 1 } });

    env.deliver({ source: env.parent, data: { kyoube: 1, id: request.id, result: [{ id: 1 }] } });
    await expect(call).resolves.toEqual([{ id: 1 }]);
    expect(stolen).toEqual([]);
  });

  it("accepts host messages only from the parent captured at install", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const impostor = { postMessage: () => {} };
    env.hijack();

    // A `ready` from the window app code substituted is not the host's.
    env.deliver({ source: impostor, data: { kyoube: 1, event: "ready", context: { companyId: "spoofed" } } });
    let resolved: unknown = "pending";
    void env.sdk().ready().then((context) => { resolved = context; });
    await Promise.resolve();
    expect(resolved).toBe("pending");

    env.deliver({ source: env.parent, data: { kyoube: 1, event: "ready", context: { companyId: "c1" } } });
    await Promise.resolve();
    expect(resolved).toEqual({ companyId: "c1" });
    // Answered: the retry schedule stops rather than posting for the life of the page.
    const posted = env.posts.length;
    vi.advanceTimersByTime(10_000);
    expect(env.posts).toHaveLength(posted);
  });
});

describe("typed decisions", () => {
  it("posts decide and decideOutcome as protocol requests", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const sdk = env.sdk() as unknown as { decide(set: string, input: unknown): Promise<unknown>; decideOutcome(id: string, question: string, value: unknown): Promise<unknown> };
    const decided = sdk.decide("triage", { rowId: "r1" });
    const sent = env.posts.at(-1)!.message;
    expect(sent).toMatchObject({ method: "decisions.decide", nonce: "nonce-abcdefghijklmnop", params: { set: "triage", input: { rowId: "r1" } } });
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent.id, result: { decisionId: "d1", answers: {} } } });
    await expect(decided).resolves.toEqual({ decisionId: "d1", answers: {} });
    void sdk.decideOutcome("d1", "urgent", false);
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "decisions.outcome", params: { decisionId: "d1", question: "urgent", value: false } });
  });
});

describe("connections", () => {
  it("posts connections.call as a protocol request", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const sdk = env.sdk() as unknown as { connections: { call(name: string, request?: unknown): Promise<unknown> } };
    const done = sdk.connections.call("crm", { path: "/x" });
    const sent = env.posts.at(-1)!.message;
    expect(sent).toMatchObject({ method: "connections.call", nonce: "nonce-abcdefghijklmnop", params: { name: "crm", request: { path: "/x" } } });
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent.id, result: { status: 200, headers: {}, body: "" } } });
    await expect(done).resolves.toEqual({ status: 200, headers: {}, body: "" });
  });
});

type TaskApi = {
  start(template: string, opts?: Record<string, unknown>): Promise<unknown>;
  get(id: string): Promise<unknown>;
  list(filter?: Record<string, unknown>): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  open(id: string): Promise<unknown>;
  watch(id: string, onChange: (task: unknown) => void): () => void;
};
const tasksOf = (env: Awaited<ReturnType<typeof install>>) => (env.sdk() as unknown as { tasks: TaskApi }).tasks;

describe("tasks", () => {
  it("posts start, get, list, cancel and open as protocol requests", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const tasks = tasksOf(env);
    const started = tasks.start("summarise", { rowId: "r1", inputs: { tone: "short" } });
    const sent = env.posts.at(-1)!.message;
    expect(sent).toMatchObject({ method: "tasks.start", nonce: "nonce-abcdefghijklmnop", params: { template: "summarise", rowId: "r1", inputs: { tone: "short" } } });
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent.id, result: { id: "t1", status: "waiting" } } });
    await expect(started).resolves.toEqual({ id: "t1", status: "waiting" });

    // Absent options are left out rather than sent as undefined.
    void tasks.start("plain");
    expect(env.posts.at(-1)!.message.params).toEqual({ template: "plain" });
    void tasks.get("t1");
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.get", params: { id: "t1" } });
    void tasks.list({ template: "summarise", rowId: "r1" });
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.list", params: { template: "summarise", rowId: "r1" } });
    void tasks.list();
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.list", params: {} });
    void tasks.cancel("t1");
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.cancel", params: { id: "t1" } });
    const opened = tasks.open("t1");
    const open = env.posts.at(-1)!.message;
    expect(open).toMatchObject({ method: "tasks.open", params: { id: "t1" } });
    env.deliver({ source: env.parent, data: { kyoube: 1, id: open.id, result: null } });
    await expect(opened).resolves.toBeUndefined();
  });

  it("watch posts tasks.watch once and calls back only for its own id, from the host only", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const seen: unknown[] = [];
    const stop = tasksOf(env).watch("t1", (task) => { seen.push(task); });
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.watch", params: { id: "t1" } });
    const posted = env.posts.length;

    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t2", status: "done" } } });
    env.deliver({ source: { postMessage: () => {} }, data: { kyoube: 1, event: "task", task: { id: "t1", status: "done" } } });
    expect(seen).toEqual([]);
    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t1", status: "working" } } });
    expect(seen).toEqual([{ id: "t1", status: "working" }]);
    expect(env.posts).toHaveLength(posted);

    stop();
    expect(env.posts.at(-1)!.message).toMatchObject({ method: "tasks.unwatch", params: { id: "t1" } });
    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t1", status: "done" } } });
    expect(seen).toHaveLength(1);
    // stop() is idempotent: a second call posts nothing more.
    const after = env.posts.length;
    stop();
    expect(env.posts).toHaveLength(after);
  });

  it("keeps the host watching while another watcher of the same id is left", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = tasksOf(env).watch("t1", (task) => { a.push(task); });
    tasksOf(env).watch("t1", (task) => { b.push(task); });
    stopA();
    expect(env.posts.some((post) => post.message.method === "tasks.unwatch")).toBe(false);
    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t1", status: "done" } } });
    expect(a).toEqual([]);
    expect(b).toHaveLength(1);
  });

  it("a callback that throws does not stop the others", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const seen: unknown[] = [];
    tasksOf(env).watch("t1", () => { throw new Error("app bug"); });
    tasksOf(env).watch("t1", (task) => { seen.push(task); });
    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t1", status: "done" } } });
    expect(seen).toHaveLength(1);
  });

  it("drops the listener when the host refuses the watch", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const seen: unknown[] = [];
    tasksOf(env).watch("t1", (task) => { seen.push(task); });
    const sent = env.posts.at(-1)!.message;
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent.id, error: { code: "limit", message: "limit: too many watches" } } });
    await Promise.resolve();
    await Promise.resolve();
    env.deliver({ source: env.parent, data: { kyoube: 1, event: "task", task: { id: "t1", status: "done" } } });
    expect(seen).toEqual([]);
  });
});

type DownloadApi = { download(filename: unknown, data: unknown): Promise<unknown> };
const uiOf = (env: Awaited<ReturnType<typeof install>>) => (env.sdk() as unknown as { ui: DownloadApi }).ui;
const downloadsIn = (env: Awaited<ReturnType<typeof install>>) => env.posts.filter((post) => post.message.method === "ui.download").map((post) => post.message);

describe("ui.download", () => {
  it("sends a string as UTF-8 bytes and resolves to undefined", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const saved = uiOf(env).download("notes.txt", "héllo");
    const [sent] = downloadsIn(env);
    expect(sent).toMatchObject({ method: "ui.download", nonce: "nonce-abcdefghijklmnop", params: { filename: "notes.txt" } });
    const bytes = (sent!.params as { bytes: unknown }).bytes;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes as Uint8Array)).toEqual(Array.from(new TextEncoder().encode("héllo")));
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent!.id, result: null } });
    await expect(saved).resolves.toBeUndefined();
  });

  it("sends an ArrayBuffer, and only a view's own bytes", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    void uiOf(env).download("a.bin.zip", new Uint8Array([1, 2, 3]).buffer);
    const backing = new Uint8Array([9, 9, 4, 5, 6, 9]);
    void uiOf(env).download("b.zip", new Uint8Array(backing.buffer, 2, 3));
    void uiOf(env).download("c.zip", new DataView(backing.buffer, 1, 2));
    const sent = downloadsIn(env).map((message) => Array.from((message.params as { bytes: Uint8Array }).bytes));
    expect(sent).toEqual([[1, 2, 3], [4, 5, 6], [9, 4]]);
    // A copy, not the app's own buffer: the app may reuse it straight after the call.
    const first = (downloadsIn(env)[1]!.params as { bytes: Uint8Array }).bytes;
    expect(first.buffer).not.toBe(backing.buffer);
    expect(first.byteLength).toBe(first.buffer.byteLength);
  });

  it("reads a Blob before sending it", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    void uiOf(env).download("sheet.csv", new Blob(["a,b\n1,2\n"], { type: "text/csv" }));
    await vi.waitFor(() => { expect(downloadsIn(env)).toHaveLength(1); });
    const bytes = (downloadsIn(env)[0]!.params as { bytes: Uint8Array }).bytes;
    expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2\n");
  });

  it("refuses anything else as invalid without posting", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    for (const data of [42, null, undefined, { a: 1 }, [1, 2]]) {
      await expect(uiOf(env).download("x.txt", data)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(downloadsIn(env)).toEqual([]);
  });

  it("surfaces the host's refusal code", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const saved = uiOf(env).download("x.html", "<p>");
    const [sent] = downloadsIn(env);
    env.deliver({ source: env.parent, data: { kyoube: 1, id: sent!.id, error: { code: "declined", message: "declined: the viewer did not save the file" } } });
    await expect(saved).rejects.toMatchObject({ code: "declined" });
  });
});
