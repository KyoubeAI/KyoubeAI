// @vitest-environment happy-dom
// tests/unit/app-tasks-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

const OVERVIEW = [
  { slug: "triage", name: "Triage", templates: [
    { key: "summarise", agentId: "a1", agentName: "Ada", table: "tickets", writes: [], status: "ready" },
    { key: "fix", agentId: "a1", agentName: "Ada", table: "tickets", writes: ["body"], status: "agent_cannot_write" },
    { key: "gone", agentId: "a9", agentName: null, table: null, writes: [], status: "agent_missing" },
  ] },
];

let container: HTMLElement;
let root: Root;
function install(overview: unknown) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginToast: () => () => null,
      usePluginAction: (key: string) => async () => {
        if (key === "tasks.overview") { if (overview instanceof Error) throw overview; return overview; }
        if (key === "data.grants") return { settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] };
        if (key === "connections.status") return { connections: [], problems: [], missing: [] };
        if (key === "connections.grants") return { grants: [], agents: [] };
        if (key === "groups.people_levels") return [];
        return null;
      },
    },
  };
}
beforeEach(() => {
  (globalThis as BridgeGlobal).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as BridgeGlobal).__paperclipPluginBridge__;
});

describe("Apps that hand work to agents", () => {
  it("renders each template with its status as stacked rows, no table", async () => {
    install(OVERVIEW);
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    const section = container.querySelector("[data-kyoube-section='app-tasks']")!;
    const text = section.textContent ?? "";
    expect(text).toContain("Apps that hand work to agents");
    expect(text).toContain("Triage");
    expect(text).toContain("summarise");
    expect(text).toContain("Ada");
    expect(text).toContain("tickets");
    expect(text).toContain("ready");
    expect(text).toContain("Ada can't write Data yet");
    expect(text).toContain("agent not found");
    expect(section.querySelector("table")).toBeNull();
  });

  it("says so when no app hands work to agents", async () => {
    install([]);
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    expect(container.textContent).toContain("No apps hand work to agents yet.");
  });

  it("shows the error when the overview is refused", async () => {
    install(new Error("only company owners and admins see this"));
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    expect(container.textContent).toContain("only company owners and admins see this");
  });
});
