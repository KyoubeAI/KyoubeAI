// @vitest-environment happy-dom
// tests/unit/groups-ui.spec.tsx
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";
import { GroupsSettingsPage, restrictionConfirmText } from "../../src/ui/groups/GroupsSettingsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> }; IS_REACT_ACT_ENVIRONMENT?: boolean };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

type Visibility = { mode: "open" | "need_to_know"; seesAll: string[]; restricted: Array<{ userId: string; role: string | null }> };
const SALES = { id: "g1", name: "Sales", dataLevel: null, members: ["u2"], agents: [], apps: ["app1"], seesAll: false, projects: [] as string[] };
const OPEN: Visibility = { mode: "open", seesAll: [], restricted: [] };
const options = {
  members: [{ id: "u2", role: "operator" }],
  agents: [],
  apps: [{ id: "app1", name: "Contacts", icon: "C" }],
  projects: [{ id: "p1", name: "Website" }, { id: "p2", name: "Billing" }],
};

let calls: Array<[string, unknown]>;
let toasts: Array<{ title: string; tone: string }>;
/** When set, `groups.save` is refused with this error. */
let saveError: Error | null;
/** When set, `groups.set_visibility` is refused with this error. */
let visibilityError: Error | null;
/** What `groups.list` answers; `groups.set_visibility` changes its mode, as the backend does. */
let visibility: Visibility;
let groups: Array<typeof SALES>;
function installBridge(unlocked: boolean, current: Visibility = OPEN, existing: Array<typeof SALES> = [SALES]) {
  calls = [];
  toasts = [];
  saveError = null;
  visibilityError = null;
  visibility = current;
  groups = existing;
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      usePluginToast: () => (toast: { title: string; tone: string }) => { toasts.push(toast); return null; },
      usePluginAction: (key: string) => async (params: unknown) => {
        calls.push([key, params]);
        if (key === "groups.list") return { unlocked, groups, sync: null, visibility };
        if (key === "groups.options") return options;
        if (key === "groups.save" && saveError) throw saveError;
        if (key === "groups.set_visibility") {
          if (visibilityError) throw visibilityError;
          visibility = { ...visibility, mode: (params as { mode: Visibility["mode"] }).mode };
          return visibility;
        }
        return null;
      },
    },
  };
}

let container: HTMLElement;
let root: Root;
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
  vi.restoreAllMocks();
});

const buttonNamed = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("GroupsSettingsPage", () => {
  it("shows the licence banner and disables Save while Delete stays enabled when locked", async () => {
    installBridge(false);
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    expect(container.textContent).toContain("Managing groups needs a KyoubeAI licence");
    expect(container.textContent).toContain("Agent rules have not synced yet");
    expect(buttonNamed("Delete").disabled).toBe(false);
    await act(async () => buttonNamed("Sales").click());
    expect(buttonNamed("Save").disabled).toBe(true);
    expect(buttonNamed("Delete").disabled).toBe(false);
  });

  it("asks before a delete opens an app to everyone, and does not delete on cancel", async () => {
    installBridge(true);
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Delete").click());
    expect(confirm).toHaveBeenCalledWith("This makes Contacts usable by everyone. Continue?");
    expect(calls.some(([key]) => key === "groups.delete")).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => buttonNamed("Delete").click());
    expect(calls).toContainEqual(["groups.delete", { id: "g1" }]);
  });

  it("is laid out for a 375px phone: the list scrolls in its own box, long ids break, controls are 44px tall (R21)", async () => {
    installBridge(true);
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 375, height: 812 });
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    const page = container.querySelector<HTMLElement>("[data-kyoube-page='groups']")!;
    expect(page).not.toBeNull();
    const scroller = container.querySelector("table")!.parentElement!;
    expect(scroller.hasAttribute("data-kyoube-scroll")).toBe(true);
    expect(scroller.className).toContain("overflow-x-auto");
    const css = document.getElementById("kyoube-apps-phone-styles")?.textContent ?? "";
    expect(css).toContain("[data-kyoube-scroll] { max-width: 100%; overflow-x: auto; }");
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*\[data-kyoube-page="groups"\] button[\s\S]*min-height: 44px/);
    // The editor's pickers break long member ids instead of running past their box.
    await act(async () => buttonNamed("Sales").click());
    const label = [...container.querySelectorAll("fieldset label span")].find((span) => span.textContent?.startsWith("u2"))!;
    expect(label.hasAttribute("data-kyoube-break")).toBe(true);
    expect(label.className).toContain("break-all");
    // happy-dom applies the media query: at 375px the controls are 44px tall, at desktop width they are not.
    expect([window.innerWidth, getComputedStyle(buttonNamed("Save")).minHeight]).toEqual([375, "44px"]);
    expect(getComputedStyle(container.querySelector<HTMLInputElement>("input[maxlength='80']")!).minHeight).toBe("44px");
  });

  it("lets the Data access people table scroll in its own box and break long ids (R21)", async () => {
    const longId = "user_".concat("x".repeat(60));
    (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
      sdkUi: {
        usePluginToast: () => () => null,
        usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => {} }),
        usePluginAction: (key: string) => async () => {
          if (key === "groups.people_levels") return [{ userId: longId, role: "viewer", level: "read", source: "role: viewer (groups cannot raise a viewer)" }];
          if (key === "data.grants") return { settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] };
          return null;
        },
      },
    };
    await act(async () => root.render(createElement(DataAccessSettingsPage, { context })));
    expect(container.querySelector("[data-kyoube-page='data-access']")).not.toBeNull();
    const cell = [...container.querySelectorAll("td")].find((td) => td.textContent === longId)!;
    expect(cell.hasAttribute("data-kyoube-break")).toBe(true);
    expect(cell.closest("table")!.parentElement!.hasAttribute("data-kyoube-scroll")).toBe(true);
    expect(container.textContent).toContain("role: viewer (groups cannot raise a viewer)");
  });

  it("keeps desktop controls their own height (the 44px rule is phone-only)", async () => {
    installBridge(true);
    (window as unknown as { happyDOM: { setViewport: (v: { width: number; height: number }) => void } }).happyDOM.setViewport({ width: 1280, height: 800 });
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Sales").click());
    expect(window.innerWidth).toBe(1280);
    expect(getComputedStyle(buttonNamed("Save")).minHeight).not.toBe("44px");
  });

  it("keeps the editor open with the person's edits when a save is refused, and closes it once a save succeeds", async () => {
    installBridge(true);
    await act(async () => root.render(createElement(GroupsSettingsPage, { context })));
    await act(async () => buttonNamed("Sales").click());
    const name = () => container.querySelector<HTMLInputElement>("input[maxlength='80']");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name()!, "Sales EMEA");
      name()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const level = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(level, "write");
      level.dispatchEvent(new Event("change", { bubbles: true }));
    });

    saveError = new Error("a group named Sales EMEA already exists");
    await act(async () => buttonNamed("Save").click());
    expect(calls).toContainEqual(["groups.save", { group: { id: "g1", name: "Sales EMEA", dataLevel: "write", members: ["u2"], agents: [], apps: ["app1"], seesAll: false, projects: [] } }]);
    expect(toasts.at(-1)).toMatchObject({ tone: "error" });
    expect(name()?.value).toBe("Sales EMEA");
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("write");

    saveError = null;
    await act(async () => buttonNamed("Save").click());
    expect(toasts.at(-1)).toEqual({ title: "Group saved", tone: "success" });
    expect(name()).toBeNull();
  });
});

describe("GroupsSettingsPage visibility", () => {
  const restricted = [{ userId: "u2", role: "operator" }, { userId: "u3", role: "viewer" }];
  const render = async () => { await act(async () => root.render(createElement(GroupsSettingsPage, { context }))); };

  it("shows the mode, and switching to need-to-know asks with the count and ids of who becomes restricted", async () => {
    installBridge(true, { mode: "open", seesAll: [], restricted });
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    await render();
    expect(container.textContent).toContain("Visibility: open — everyone in the company sees every project and task.");
    expect(container.textContent).not.toContain("people restricted");
    await act(async () => buttonNamed("Switch to need-to-know").click());
    expect(confirm).toHaveBeenCalledTimes(1);
    const asked = (confirm.mock.calls[0] as unknown as [string])[0];
    expect(asked).toBe(restrictionConfirmText(restricted));
    expect(asked).toContain("2 people");
    expect(asked).toContain("u2 (operator), u3 (viewer)");
    expect(calls).toContainEqual(["groups.set_visibility", { mode: "need_to_know" }]);
    // The list is read again, so the page now shows the new mode, who is restricted, and the way back.
    expect(container.textContent).toContain("Visibility: need-to-know — operators and viewers see the projects of their groups and the tasks they are involved in, unless their group sees everything.");
    expect(container.textContent).toContain("2 people restricted");
    expect(buttonNamed("Switch to open")).toBeDefined();
    expect(toasts.at(-1)).toEqual({ title: "Visibility set to need-to-know", tone: "success" });
  });

  it("sends nothing when the switch is cancelled", async () => {
    installBridge(true, { mode: "open", seesAll: [], restricted });
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    await render();
    await act(async () => buttonNamed("Switch to need-to-know").click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some(([key]) => key === "groups.set_visibility")).toBe(false);
    expect(container.textContent).toContain("Visibility: open");
  });

  it("switching back to open never asks and works without a licence", async () => {
    installBridge(false, { mode: "need_to_know", seesAll: [], restricted: [] });
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    await render();
    expect(container.textContent).toContain("0 people restricted");
    expect(buttonNamed("Switch to open").disabled).toBe(false);
    await act(async () => buttonNamed("Switch to open").click());
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toContainEqual(["groups.set_visibility", { mode: "open" }]);
    expect(container.textContent).toContain("Visibility: open");
  });

  it("says person, not people, for one restricted person", async () => {
    installBridge(true, { mode: "need_to_know", seesAll: [], restricted: [{ userId: "u2", role: "operator" }] });
    await render();
    expect(container.textContent).toContain("1 person restricted");
  });

  it("disables switching on without a licence", async () => {
    installBridge(false, OPEN);
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    await render();
    const toggle = buttonNamed("Switch to need-to-know");
    expect(toggle.disabled).toBe(true);
    await act(async () => toggle.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some(([key]) => key === "groups.set_visibility")).toBe(false);
  });

  it("keeps the mode and shows the refusal when the backend refuses the switch", async () => {
    installBridge(true, { mode: "open", seesAll: [], restricted });
    window.confirm = vi.fn(() => true);
    await render();
    visibilityError = new Error("a licence is needed");
    await act(async () => buttonNamed("Switch to need-to-know").click());
    expect(toasts.at(-1)).toEqual({ title: "a licence is needed", tone: "error" });
    expect(container.textContent).toContain("Visibility: open");
  });

  it("saves sees-all and projects with the group", async () => {
    installBridge(true);
    await render();
    await act(async () => buttonNamed("Sales").click());
    const seesAll = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Sees everything in the company"))!.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(seesAll.checked).toBe(false);
    await act(async () => seesAll.click());
    const projects = [...container.querySelectorAll("fieldset")].find((fieldset) => fieldset.querySelector("legend")?.textContent === "Projects")!;
    expect(projects.textContent).toContain("Billing");
    const website = [...projects.querySelectorAll("label")].find((label) => label.textContent?.includes("Website"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => website.click());
    await act(async () => buttonNamed("Save").click());
    expect(calls).toContainEqual(["groups.save", { group: { id: "g1", name: "Sales", dataLevel: null, members: ["u2"], agents: [], apps: ["app1"], seesAll: true, projects: ["p1"] } }]);
  });

  it("opens an existing group with its sees-all flag and projects ticked", async () => {
    installBridge(true, OPEN, [{ ...SALES, seesAll: true, projects: ["p2"] }]);
    await render();
    await act(async () => buttonNamed("Sales").click());
    const ticked = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].filter((box) => box.checked).map((box) => box.closest("label")?.textContent?.trim());
    expect(ticked.sort()).toEqual(["Billing", "C Contacts", "Sees everything in the company", "u2 (operator)"]);
  });

  it("lists sees-all and project counts in the table", async () => {
    installBridge(true, OPEN, [{ ...SALES, seesAll: true, projects: ["p1", "p2"] }, { ...SALES, id: "g2", name: "Ops", seesAll: false, projects: [] }]);
    await render();
    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent);
    const seesAllAt = headers.indexOf("Sees all");
    const projectsAt = headers.indexOf("Projects");
    expect(seesAllAt).toBeGreaterThan(-1);
    expect(projectsAt).toBeGreaterThan(-1);
    const cells = (name: string) => [...[...container.querySelectorAll("tbody tr")].find((row) => row.querySelector("td")?.textContent === name)!.querySelectorAll("td")].map((td) => td.textContent);
    expect([cells("Sales")[seesAllAt], cells("Sales")[projectsAt]]).toEqual(["yes", "2"]);
    expect([cells("Ops")[seesAllAt], cells("Ops")[projectsAt]]).toEqual(["no", "0"]);
  });
});

describe("restrictionConfirmText", () => {
  it("names one person in the singular", () => {
    expect(restrictionConfirmText([{ userId: "u2", role: "operator" }])).toBe(
      "This restricts 1 person to the projects of their groups and the tasks they are involved in: u2 (operator). Owners and admins are not affected. Continue?",
    );
  });

  it("lists at most 20 people, then how many more", () => {
    const many = Array.from({ length: 23 }, (_, index) => ({ userId: `u${index + 1}`, role: "viewer" }));
    const text = restrictionConfirmText(many);
    expect(text).toContain("This restricts 23 people ");
    expect(text).toContain("u20 (viewer), and 3 more. Owners and admins are not affected. Continue?");
    expect(text).not.toContain("u21");
    const exactly = restrictionConfirmText(many.slice(0, 20));
    expect(exactly).toContain("u20 (viewer). Owners");
    expect(exactly).not.toContain("more");
  });

  it("shows a person without a role by id alone", () => {
    expect(restrictionConfirmText([{ userId: "u2", role: null }, { userId: "u3", role: "viewer" }])).toContain(": u2, u3 (viewer). Owners");
  });

  it("says so when nobody is restricted yet", () => {
    expect(restrictionConfirmText([])).toBe("Nobody is restricted yet: every operator and viewer is in a group that sees everything. Continue?");
  });
});
