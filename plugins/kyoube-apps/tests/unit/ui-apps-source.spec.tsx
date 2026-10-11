// @vitest-environment happy-dom
// tests/unit/ui-apps-source.spec.tsx
//
// The Source & versions panel on an app's page, in a DOM: Publish and Roll back wait while a preview
// loads or a dialog is open, every request names the version its preview resolved, and a tick given
// for one dialog is never carried into the next.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppsPage } from "../../src/ui/apps/AppsPage.js";
import type { PublishPreviewData } from "../../src/ui/apps/PublishDisclosure.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };

const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };
const withSets = (version: number): PublishPreviewData => ({
  version, changed: true, provider: "openrouter", available: true,
  sets: [{ key: "triage", table: "tickets", fields: ["subject"], advisory: false, questions: [{ key: "queue", type: "choice", text: "Which team?" }] }],
});

let calls: Array<{ action: string; params: Record<string, unknown> }> = [];
let previews: Array<(data: PublishPreviewData) => void> = [];
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  calls = [];
  previews = [];
  (globalThis as BridgeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  const actions: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    // Not published: the runner shows a line of text instead of a frame.
    "apps.runtime": async () => { throw { code: "WORKER_ERROR", message: "not_found: app \"triage\" is not published" }; },
    "apps.get": async () => ({
      app: { slug: "triage", name: "Triage", description: null, icon: null, status: "published", currentVersion: 2, latestVersion: 3 },
      version: { version: 3, manifest: {}, source: "", notes: null, createdAt: "2026-10-05T00:00:00Z" },
    }),
    "apps.publish_preview": () => new Promise((resolve) => { previews.push(resolve); }),
  };
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => context,
      useHostLocation: () => ({ pathname: "/acme/app-artifact/triage", search: "", hash: "" }),
      useHostNavigation: () => ({ resolveHref: (to: string) => `/acme${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }) }),
      usePluginData: () => ({ data: { level: "schema" }, loading: false, error: null, refresh: () => {} }),
      usePluginAction: (action: string) => async (params: Record<string, unknown>) => {
        calls.push({ action, params });
        return (actions[action] ?? (async () => ({})))(params);
      },
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

const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label) ?? null;
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
async function click(element: HTMLElement | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => { element.click(); });
}
async function answerPreview(data: PublishPreviewData) {
  await act(async () => { previews.shift()!(data); });
}
const sent = (action: string) => calls.filter((call) => call.action === action).map((call) => call.params);

async function openSource() {
  await act(async () => root.render(createElement(AppsPage, { context } as never)));
  await click(button("Source & versions"));
}

describe("the app's Source & versions panel", () => {
  it("holds Publish and Roll back while a preview loads or a dialog is open, and starts each dialog unticked", async () => {
    await openSource();
    await click(button("Publish latest"));
    expect(sent("apps.publish_preview")).toEqual([{ slug: "triage", version: "latest" }]);
    expect([button("Publish latest")!.disabled, button("Roll back one version")!.disabled]).toEqual([true, true]);
    await answerPreview(withSets(3));
    expect(container.textContent).toContain("Publish version 3?");
    expect([button("Publish latest")!.disabled, button("Roll back one version")!.disabled]).toEqual([true, true]);
    await click(checkbox());
    await click(button("Cancel"));
    expect([button("Publish latest")!.disabled, button("Roll back one version")!.disabled]).toEqual([false, false]);

    await click(button("Roll back one version"));
    await answerPreview(withSets(1));
    expect(container.textContent).toContain("Roll back to version 1?");
    expect(checkbox()!.checked).toBe(false);
    expect(button("Roll back")!.disabled).toBe(true);
    await click(checkbox());
    await click(button("Roll back"));
    expect(sent("apps.rollback")).toEqual([{ slug: "triage", version: 1, decisionsConfirmed: true }]);
  });

  it("publishes an app without decision sets in one click, naming the version it previewed", async () => {
    await openSource();
    await click(button("Publish latest"));
    await answerPreview({ ...withSets(3), changed: false, sets: [] });
    expect(sent("apps.publish")).toEqual([{ slug: "triage", version: 3 }]);
    expect(button("Publish latest")!.disabled).toBe(false);
  });

  it("opens the dialog for changed task templates alone, to publish and to roll back", async () => {
    const withTasks = (version: number, changed: boolean): PublishPreviewData => ({
      ...withSets(version), changed: false, sets: [],
      tasks: { changed, list: [{ key: "draft_reply", agent: "Support Bot", agentFound: true, agentCanWrite: true, title: "Reply", instructions: "Draft a reply.", table: "tickets", fields: ["subject"], inputs: {}, writes: ["subject"], added: changed, changed: false }] },
    });
    await openSource();
    await click(button("Publish latest"));
    await answerPreview(withTasks(3, true));
    expect(sent("apps.publish")).toEqual([]);
    expect(container.textContent).toContain("Publish version 3?");
    expect(button("Publish")!.disabled).toBe(true);
    await click(checkbox());
    await click(button("Publish"));
    expect(sent("apps.publish")).toEqual([{ slug: "triage", version: 3, decisionsConfirmed: false, tasksConfirmed: true }]);

    await click(button("Roll back one version"));
    await answerPreview(withTasks(1, true));
    expect(sent("apps.rollback")).toEqual([]);
    expect(container.textContent).toContain("Roll back to version 1?");
    await click(checkbox());
    await click(button("Roll back"));
    expect(sent("apps.rollback")).toEqual([{ slug: "triage", version: 1, decisionsConfirmed: false, tasksConfirmed: true }]);

    // Unchanged templates need no confirmation: one click, as before.
    await click(button("Publish latest"));
    await answerPreview(withTasks(3, false));
    expect(sent("apps.publish").at(-1)).toEqual({ slug: "triage", version: 3 });
  });
});
