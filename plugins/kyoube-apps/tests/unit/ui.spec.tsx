import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarEntry } from "../../src/ui/SidebarEntry.js";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";
import { AppRunner, SaveBar } from "../../src/ui/apps/AppRunner.js";
import { APP_CSP } from "../../src/ui/apps/srcdoc.js";
import { AppsPage } from "../../src/ui/apps/AppsPage.js";
import { DataPage } from "../../src/ui/DataPage.js";
import { appNameOf } from "../../src/ui/phone.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

function installBridge(overrides: Record<string, unknown> = {}) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => context,
      useHostLocation: () => ({ pathname: "/acme/dashboard", search: "", hash: "" }),
      useHostNavigation: () => ({ resolveHref: (to: string) => `/acme${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }) }),
      usePluginData: () => ({ data: { level: "read", actorKind: "user", hint: "" }, loading: false, error: null, refresh: () => {} }),
      usePluginAction: () => async () => ({ settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] }),
      usePluginToast: () => () => null,
      ...overrides,
    },
  };
}
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("UI", () => {
  it("the runner's header has a phone menu and keeps its wide buttons for larger screens", () => {
    installBridge({ useHostLocation: () => ({ pathname: "/acme/app-artifact/contacts", search: "", hash: "" }) });
    const html = renderToStaticMarkup(createElement(AppsPage, { context }));
    expect(html).toContain('data-kyoube-runner=""');
    expect(html).toContain('data-kyoube-runner-bar=""');
    expect(html).toMatch(/class="[^"]*kyoube-wide-only[^"]*"[^>]*>Source &amp; versions/);
    expect(html).toMatch(/class="[^"]*kyoube-phone-only[^"]*"[^>]*aria-label="More"/);
  });

  it("the Data page starts on the table list on a phone", () => {
    installBridge({ usePluginData: () => ({ data: [{ name: "contacts", displayName: "Contacts", fields: [] }], loading: false, error: null, refresh: () => {} }) });
    expect(renderToStaticMarkup(createElement(DataPage, { context }))).toContain('data-kyoube-data-view="list"');
  });

  it("names the app from its runtime context", () => {
    expect(appNameOf({ app: { slug: "contacts", name: "Contacts", version: 1 } }, "contacts")).toBe("Contacts");
    expect(appNameOf(null, "contacts")).toBe("contacts");
    expect(appNameOf({ app: { name: 7 } }, "contacts")).toBe("contacts");
  });
  it("SidebarEntry links to the data page for members with read access", () => {
    installBridge();
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toContain('href="/acme/data"');
    installBridge({ usePluginData: () => ({ data: { level: "none" }, loading: false, error: null, refresh: () => {} }) });
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
  });
  it("DataAccessSettingsPage renders its headings", () => {
    installBridge();
    const html = renderToStaticMarkup(createElement(DataAccessSettingsPage, { context }));
    expect(html).toContain("Data access");
    // Ruling P2-R7: effects don't run under renderToStaticMarkup, so `data` stays
    // null and "Default level for agents" (rendered only once data loads) never
    // appears. Assert the always-rendered levels explanation paragraph instead.
    expect(html).toContain("<code>none</code>");
    expect(html).toMatch(/none.*read.*write.*schema/);
  });
});

/**
 * Ruling P4-R38, amending P3-R6: the frame's `sandbox` and the policy it is served under were
 * asserted by no test at all — adding `allow-same-origin` passed every suite in the repository.
 * P3-R6 kept the unit suite off `AppRunner` because importing it needs the SDK bundle esbuild
 * inlines; the rule is now narrower: a test may import it because `vitest.config.ts` stubs that
 * define with an empty string. Nothing here reads the SDK's `dist/`.
 *
 * `renderToStaticMarkup` (no effects, no DOM) is enough: both attributes are part of the render.
 */
function attribute(html: string, name: string): string {
  // Case-insensitive: React's server renderer writes `srcDoc` as it was spelled in JSX, and HTML
  // attribute names are case-insensitive to a parser either way.
  const match = new RegExp(`${name}="([^"]*)"`, "i").exec(html);
  if (!match) throw new Error(`no ${name} attribute in the rendered frame`);
  // React escapes attribute values, and the policy is full of apostrophes — decode before
  // comparing, so the assertion is against the string the browser will parse.
  return match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("AppRunner frame", () => {
  const context = { app: { slug: "crm", version: 3 }, companyId: "c1", viewer: { id: "u1", level: "write" } };
  const props = {
    source: "<!doctype html><html><body><p>hello</p></body></html>",
    context,
    onData: async () => null,
    onToast: () => {},
    onOpenApp: () => {},
  };

  it("sandboxes the app frame with exactly the four allowed tokens", () => {
    const html = renderToStaticMarkup(createElement(AppRunner, props));
    expect(attribute(html, "sandbox")).toBe("allow-scripts allow-forms allow-modals allow-downloads");
    // The one token that would undo the opaque origin — and with it every other guarantee in
    // SECURITY.md's Apps section — must never appear anywhere in the rendered frame.
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-popups");
  });

  it("asks before a save the viewer did not just click for", () => {
    const pending = { filename: "Balloons.xlsx", size: 43_000, save: () => {}, dismiss: () => {} };
    const html = renderToStaticMarkup(createElement(SaveBar, { pending, appName: "Balloon sheets" }));
    expect(html).toContain("Balloon sheets");
    expect(html).toContain("Balloons.xlsx");
    expect(html).toContain("42 KB");
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Dismiss</button>");
  });

  it("serves the app document under the app policy", () => {
    const html = renderToStaticMarkup(createElement(AppRunner, props));
    const srcdoc = attribute(html, "srcdoc");
    expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`);
    expect(srcdoc).toContain("<p>hello</p>");
  });

  // The frame's height comes from `frame-height.ts` measuring the page, not
  // from a class. Upstream's compiled Tailwind has no rule for `min-h-[600px]`
  // (it compiles only the classes its own sources use) and its `h-full`
  // resolves to `auto` under the plugin page, which has no height — both sat
  // on the frame while it rendered 150px tall. Neither may come back, and the
  // frame must be a block: an inline frame sits on a line box whose descender
  // space below it would be exactly the overflow that makes `main` scroll.
  it("leaves the frame's height to the measuring code, not to classes the host never compiled", () => {
    const html = renderToStaticMarkup(createElement(AppRunner, props));
    expect(attribute(html, "class")).not.toMatch(/\bh-full\b|min-h-\[/);
    expect(attribute(html, "style")).toContain("display:block");
  });
});
