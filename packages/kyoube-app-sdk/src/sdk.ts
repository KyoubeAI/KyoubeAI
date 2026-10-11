import { startHello } from "./handshake.js";
import { isKyoubeReady, isKyoubeResponse, isKyoubeTaskEvent, KYOUBE_PROTOCOL, type KyoubeMethod } from "./protocol.js";

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

class KyoubeAppError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "KyoubeAppError"; this.code = code; }
}

/**
 * The nonce arrives in a `<script>` the runner writes immediately above this one (the placement
 * contract is documented on `buildSrcdoc` in the plugin's `src/ui/apps/srcdoc.ts`), so it is in the
 * DOM as well as on `window`. Deleting the global is therefore only half the job: `document.body
 * .innerHTML`, a `querySelectorAll("script")` sweep, or `document.head.firstChild.nextSibling
 * .textContent` would all read it straight back out. This removes that element, and only that
 * element — it is checked to be the script the runner wrote before it goes, so an SDK that somehow
 * ended up somewhere else removes nothing.
 */
function scrubNonceScript(): void {
  if (typeof document === "undefined") return;
  const self = document.currentScript;
  const previous = self ? self.previousElementSibling : null;
  if (!previous || previous.tagName !== "SCRIPT") return;
  if ((previous.textContent ?? "").indexOf("window.__kyoubeNonce=") !== 0) return;
  previous.remove();
}

(function install() {
  // Ruling P4-R18: the runner writes the mount's handshake nonce into a global immediately
  // above this script, inside the head it prepends — so this line runs before any app-authored
  // byte has been parsed. Read it once, delete the global, and remove the element that carried
  // it: from here on the value exists only in this closure, and app code (which shares the realm,
  // and could otherwise read either the property or the script's own text) has no way to reach
  // it. Both happen before the frame check below, so neither copy survives whatever document this
  // ends up in; `window.x = …` creates a configurable property, so the delete really does go.
  const holder = globalThis as { __kyoubeNonce?: unknown };
  const nonce = typeof holder.__kyoubeNonce === "string" ? holder.__kyoubeNonce : "";
  delete holder.__kyoubeNonce;
  scrubNonceScript();
  if (typeof window === "undefined" || window.parent === window) return;
  // Ruling P4-R37: `window.parent` is `[Replaceable]` — app code may assign over it. Bind the
  // host's window here, at install, before any app-authored byte has been parsed, and use this
  // binding for every post and for the `event.source` check below. Reading the property at post
  // time instead would let `window.parent = interceptor`, assigned by the app afterwards, capture
  // everything the SDK sends (the nonce included) and forge what it receives.
  const parentWindow = window.parent;
  const pending = new Map<string, Pending>();
  let context: unknown = null;
  const readyListeners: Array<(context: unknown) => void> = [];
  // `kyoube.tasks.watch` callbacks by task id. The host polls each watched id and posts a `task`
  // event when it changes; it is only told to stop once the last callback for an id is gone.
  const taskWatchers = new Map<string, Set<(task: unknown) => void>>();
  let counter = 0;
  // Assigned once the handshake starts, below; the listener is registered first so a `ready` that
  // answers the very first hello is never missed.
  let helloAnswered = (): void => {};

  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow) return;
    const message: unknown = event.data;
    if (isKyoubeReady(message)) {
      // The host may answer more than once (it answers every hello it accepts, and the retries
      // below mean there is usually more than one in flight): the later context simply replaces
      // the earlier, and the waiting listeners have already been drained.
      helloAnswered();
      context = message.context;
      for (const listener of readyListeners.splice(0)) listener(context);
      return;
    }
    if (isKyoubeTaskEvent(message)) {
      // A copy, so a callback that stops its own watch does not change the set mid-loop; each runs
      // on its own, so one that throws cannot keep the others from hearing about the change.
      for (const listener of [...(taskWatchers.get(message.task.id) ?? [])]) {
        try { listener(message.task); } catch { /* the app's own bug; the other watchers still run */ }
      }
      return;
    }
    if (!isKyoubeResponse(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new KyoubeAppError(message.error.code, message.error.message));
    else entry.resolve(message.result);
  });

  function call(method: KyoubeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = `k${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new KyoubeAppError("timeout", `${method} timed out`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      parentWindow.postMessage({ kyoube: KYOUBE_PROTOCOL, id, method, params, nonce }, "*");
    });
  }

  /** Removes one watch callback; when it was the last for that id, tells the host to stop polling. */
  function unwatch(id: string, listener: (task: unknown) => void): void {
    const listeners = taskWatchers.get(id);
    if (!listeners || !listeners.delete(listener)) return;
    if (listeners.size > 0) return;
    taskWatchers.delete(id);
    call("tasks.unwatch", { id }).catch(() => {});
  }

  function watch(id: string, onChange: (task: unknown) => void): () => void {
    let listeners = taskWatchers.get(id);
    if (!listeners) { listeners = new Set(); taskWatchers.set(id, listeners); }
    // A fresh wrapper per call, so watching the same id twice with one function gives two stops.
    const listener = (task: unknown): void => { onChange(task); };
    listeners.add(listener);
    // A refused watch (`limit`, `invalid`, `disabled`) is never polled, so its callback could only
    // ever sit there: it is dropped, without an unwatch for a watch the host never started.
    call("tasks.watch", { id }).catch(() => {
      const current = taskWatchers.get(id);
      if (current && current.delete(listener) && current.size === 0) taskWatchers.delete(id);
    });
    return () => { unwatch(id, listener); };
  }

  const kyoube = {
    version: KYOUBE_PROTOCOL,
    get context() { return context; },
    ready(): Promise<unknown> { return context ? Promise.resolve(context) : new Promise((resolve) => readyListeners.push(resolve)); },
    data: {
      query: (table: string, spec: Record<string, unknown> = {}) => call("data.query", { ...spec, table }),
      get: (table: string, id: string) => call("data.get", { table, id }),
      count: (table: string, where?: unknown) => call("data.count", { table, where }),
      describe: (table: string) => call("data.describe", { table }),
      insert: (table: string, rows: unknown[]) => call("data.insert", { table, rows }),
      update: (table: string, target: Record<string, unknown>, patch: Record<string, unknown>) => call("data.update", { table, ...target, patch }),
      delete: (table: string, target: Record<string, unknown>) => call("data.delete", { table, ...target }),
    },
    ui: {
      toast: (title: string, tone: "info" | "success" | "warn" | "error" = "info") => call("ui.toast", { title, tone }),
      openApp: (slug: string) => call("ui.openApp", { slug }),
    },
    // Typed decisions (docs/decisions.md): the app names a set its manifest declares and a row or
    // unsaved values; the host builds the state from the set's declared fields and nothing else.
    decide: (set: string, input: { rowId: string } | { values: Record<string, unknown> }) => call("decisions.decide", { set, input }),
    decideOutcome: (decisionId: string, question: string, value: string | boolean) => call("decisions.outcome", { decisionId, question, value }),
    connections: { call: (name: string, request: Record<string, unknown> = {}) => call("connections.call", { name, request }) },
    // App tasks (docs/app-tasks.md): a person asks an agent to do a template the manifest declares.
    // Options the app leaves out are left out of the request rather than sent as `undefined`.
    tasks: {
      start: (template: string, opts: { rowId?: string; inputs?: Record<string, string | number> } = {}) => call("tasks.start", {
        template,
        ...(opts.rowId !== undefined ? { rowId: opts.rowId } : {}),
        ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
      }),
      get: (id: string) => call("tasks.get", { id }),
      list: (filter: { template?: string; rowId?: string } = {}) => call("tasks.list", {
        ...(filter.template !== undefined ? { template: filter.template } : {}),
        ...(filter.rowId !== undefined ? { rowId: filter.rowId } : {}),
      }),
      cancel: (id: string) => call("tasks.cancel", { id }),
      open: (id: string) => call("tasks.open", { id }).then(() => undefined),
      watch,
    },
    Error: KyoubeAppError,
  };
  Object.defineProperty(window, "kyoube", { value: Object.freeze(kyoube), writable: false, configurable: false });
  // Ruling P4-R29: the host announces the context only in answer to this hello — never on a frame
  // load, which cannot say whose document arrived — so a hello posted before the runner's listener
  // is attached would otherwise leave the app waiting forever. It is repeated until answered, then
  // bounded so a frame nobody is listening to falls silent rather than posting for the life of the
  // page.
  helloAnswered = startHello(
    () => { parentWindow.postMessage({ kyoube: KYOUBE_PROTOCOL, id: "hello", method: "ui.toast", params: { __hello: true }, nonce }, "*"); },
    { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); } },
  );
})();
