// @vitest-environment happy-dom
// tests/unit/ui-publish-tasks.spec.tsx
//
// The task-template part of the publish dialog: what it lists, what the person must tick, what is sent.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublishDialog, type PublishPreviewData } from "../../src/ui/apps/PublishDisclosure.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };

const template = (over: Record<string, unknown> = {}) => ({
  key: "summarise", agent: "Ada", agentFound: true, agentCanWrite: null as boolean | null,
  title: "Summarise {{row.subject}}", instructions: "Read it.\n<b>Be brief</b>", table: "tickets", fields: ["subject", "body"],
  inputs: { tone: { type: "choice", options: ["friendly", "formal"] }, count: { type: "number", min: 1, max: 10 }, note: { type: "text", maxLength: 200 } },
  writes: ["body"], added: false, changed: false, ...over,
});
const preview = (changed: boolean, list = [template()], version = 3): PublishPreviewData => ({
  version, changed: false, provider: null, available: true, sets: [],
  tasks: { changed, list },
} as PublishPreviewData);

let calls: Array<{ action: string; params: Record<string, unknown> }> = [];
let container: HTMLElement;
let root: Root;
beforeEach(() => {
  calls = [];
  (globalThis as BridgeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginAction: (action: string) => async (params: Record<string, unknown>) => { calls.push({ action, params }); return {}; },
      usePluginToast: () => () => null,
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
});

function render(p: PublishPreviewData, mode: "publish" | "rollback" = "publish") {
  act(() => { root.render(createElement(PublishDialog, { slug: "triage", appName: "Triage", mode, preview: p, onDone: () => {}, onCancel: () => {} })); });
}
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const submit = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Publish" || b.textContent === "Roll back")!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };

describe("PublishDialog task templates", () => {
  it("lists each template with its agent, text, data and inputs, instructions as text", () => {
    render(preview(false));
    const text = container.textContent ?? "";
    expect(text).toContain("Tasks for agents");
    expect(text).toContain("summarise");
    expect(text).toContain("Ada");
    expect(text).toContain("Summarise {{row.subject}}");
    expect(text).toContain("tickets");
    expect(text).toContain("subject, body");
    expect(text).toContain("tone: friendly | formal");
    expect(text).toContain("count: number 1–10");
    expect(text).toContain("note: text ≤ 200");
    const pre = container.querySelector("pre")!;
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.textContent).toContain("<b>Be brief</b>");
    expect(pre.querySelector("b")).toBeNull();
  });

  it("marks added and changed templates, and an agent that is not found", () => {
    render(preview(true, [template({ added: true }), template({ key: "other", changed: true, agentFound: false, agent: "Ghost" })]));
    expect(container.querySelector('[data-kyoube-task="summarise"]')!.getAttribute("data-kyoube-changed")).toBe("added");
    expect(container.querySelector('[data-kyoube-task="other"]')!.getAttribute("data-kyoube-changed")).toBe("changed");
    expect(container.textContent).toContain("Agent not found");
  });

  it("shows nothing for an older worker or an empty list", () => {
    render({ version: 1, changed: false, provider: null, available: true, sets: [] });
    expect(container.textContent).not.toContain("Tasks for agents");
    render(preview(false, []));
    expect(container.textContent).not.toContain("Tasks for agents");
  });

  it("blocks Publish until the box is ticked when templates changed, then sends tasksConfirmed", async () => {
    render(preview(true));
    expect(container.textContent).toContain("This version adds or changes task templates, so it needs a person to publish it. Agents cannot.");
    expect(container.textContent).toContain("These agents may be sent this work by anyone who can open the app");
    expect(submit().disabled).toBe(true);
    await click(checkbox());
    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(calls).toEqual([{ action: "apps.publish", params: { slug: "triage", version: 3, decisionsConfirmed: false, tasksConfirmed: true } }]);
  });

  it("sends no tasksConfirmed when nothing changed, and drops the tick for another version or mode", async () => {
    render(preview(false));
    expect(checkbox()).toBeNull();
    await click(submit());
    expect(calls[0]!.params).not.toHaveProperty("tasksConfirmed");
    render(preview(true));
    await click(checkbox());
    render(preview(true, [template()], 4));
    expect(checkbox().checked).toBe(false);
    expect(submit().disabled).toBe(true);
    await click(checkbox());
    render(preview(true, [template()], 4), "rollback");
    expect(checkbox().checked).toBe(false);
  });

  it("warns for a template whose agent cannot write Data yet", () => {
    render(preview(false, [template({ agentCanWrite: false }), template({ key: "ok", agentCanWrite: true })]));
    const text = container.textContent ?? "";
    expect(text).toContain("Ada can't write Data yet. Ask an admin to give it write access, or its tasks will be refused.");
    expect(text.match(/can't write Data yet/g)).toHaveLength(1);
  });
});
