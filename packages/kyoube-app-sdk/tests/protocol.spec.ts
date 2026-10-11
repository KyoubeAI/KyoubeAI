import { describe, expect, it } from "vitest";
import { ALLOWED_METHODS, isKyoubeReady, isKyoubeRequest, isKyoubeResponse, isKyoubeTaskEvent } from "../src/protocol.js";

/** A well-formed request, which every guard case below varies one field of. */
const request = (overrides: Record<string, unknown> = {}) => ({ kyoube: 1, id: "a", method: "data.query", params: { table: "x" }, nonce: "n0123456789abcdef", ...overrides });

describe("protocol guards", () => {
  it("recognises well-formed requests only", () => {
    expect(isKyoubeRequest(request())).toBe(true);
    expect(isKyoubeRequest(request({ method: "eval" }))).toBe(false);
    expect(isKyoubeRequest(request({ kyoube: 2 }))).toBe(false);
    expect(isKyoubeRequest(request({ kyoube: "1" }))).toBe(false);
    expect(isKyoubeRequest(request({ id: 5 }))).toBe(false);
    expect(isKyoubeRequest(request({ params: [] }))).toBe(false);
    expect(isKyoubeRequest({ kyoube: 1, id: "a", method: "data.query", nonce: "n0123456789abcdef" })).toBe(false);
    expect(isKyoubeRequest(null)).toBe(false);
    expect(ALLOWED_METHODS).toContain("ui.toast");
  });
  // Ruling P4-R18: every request the SDK sends — the handshake included — carries the
  // per-mount nonce the runner inlined ahead of it. A message without one did not come
  // from this runtime, so it is not a request at all.
  it("requires a string nonce on every request, the hello included", () => {
    expect(isKyoubeRequest({ kyoube: 1, id: "a", method: "data.query", params: { table: "x" } })).toBe(false);
    expect(isKyoubeRequest(request({ nonce: 7 }))).toBe(false);
    expect(isKyoubeRequest(request({ nonce: null }))).toBe(false);
    const hello = { kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true } };
    expect(isKyoubeRequest(hello)).toBe(false);
    expect(isKyoubeRequest({ ...hello, nonce: "n0123456789abcdef" })).toBe(true);
  });
  it("rejects params carrying an own __proto__ key", () => {
    // Object-literal `{ __proto__: ... }` syntax sets the prototype rather
    // than creating an own property, so it would not exercise this guard.
    // JSON.parse (like the structured clone postMessage uses) has no such
    // special case: it creates a genuine own data property named "__proto__",
    // which is exactly what a malicious app can smuggle across the sandbox.
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(isKyoubeRequest(request({ params: polluted }))).toBe(false);
    expect(isKyoubeRequest(request())).toBe(true);
  });
  it("recognises responses and ready events", () => {
    expect(isKyoubeResponse({ kyoube: 1, id: "a", result: 1 })).toBe(true);
    expect(isKyoubeResponse({ kyoube: 1, id: "a", error: { code: "forbidden", message: "no" } })).toBe(true);
    expect(isKyoubeResponse({ kyoube: 1, id: "a" })).toBe(false);
    expect(isKyoubeReady({ kyoube: 1, event: "ready", context: {} })).toBe(true);
    expect(isKyoubeReady({ kyoube: 1, event: "other" })).toBe(false);
  });
  it("allows connections.call", () => {
    expect(ALLOWED_METHODS).toContain("connections.call");
    expect(isKyoubeRequest(request({ method: "connections.call", params: { name: "crm", request: {} } }))).toBe(true);
  });
  it("allows the two typed-decision methods, nonce and all", () => {
    expect(ALLOWED_METHODS).toContain("decisions.decide");
    expect(ALLOWED_METHODS).toContain("decisions.outcome");
    expect(isKyoubeRequest(request({ method: "decisions.decide", params: { set: "triage", input: { rowId: "r1" } } }))).toBe(true);
    expect(isKyoubeRequest(request({ method: "decisions.outcome", params: { decisionId: "d", question: "q", value: true } }))).toBe(true);
    expect(isKyoubeRequest(request({ method: "decisions.ask" }))).toBe(false);
  });
  it("allows the seven task methods", () => {
    for (const method of ["tasks.start", "tasks.get", "tasks.list", "tasks.cancel", "tasks.open", "tasks.watch", "tasks.unwatch"]) {
      expect(ALLOWED_METHODS).toContain(method);
      expect(isKyoubeRequest(request({ method, params: { id: "t1" } }))).toBe(true);
    }
    expect(isKyoubeRequest(request({ method: "tasks.delete", params: { id: "t1" } }))).toBe(false);
  });
  it("recognises task events: a task object with a string id, nothing else", () => {
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "task", task: { id: "t1", status: "working" } })).toBe(true);
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "task", task: { status: "working" } })).toBe(false);
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "task", task: { id: 5 } })).toBe(false);
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "task", task: [] })).toBe(false);
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "task" })).toBe(false);
    expect(isKyoubeTaskEvent({ kyoube: 2, event: "task", task: { id: "t1" } })).toBe(false);
    expect(isKyoubeTaskEvent({ kyoube: 1, event: "ready", task: { id: "t1" } })).toBe(false);
    expect(isKyoubeTaskEvent(JSON.parse('{"kyoube":1,"event":"task","task":{"id":"t1","__proto__":{"x":1}}}'))).toBe(false);
    expect(isKyoubeTaskEvent(null)).toBe(false);
  });
});
