import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECTIONS } from "../anchors.mjs";
import { TEXT_RULES } from "../rules.mjs";
import { THEME_ASSET, ThemeError, overriddenTokens, runTheme, sectionRoutes } from "../theme.mjs";
import { BUNDLE, CORE_CSS, INDEX_HTML } from "./fixtures/core-2026.1023.0.mjs";

const THEME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = () => {};

let root;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "kyoube-theme-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A core tree with the real 2026.1023.0 excerpts, optionally edited to simulate an upstream change. */
async function coreTree({ bundle = BUNDLE, css = CORE_CSS, html = INDEX_HTML } = {}) {
  const assets = path.join(root, "ui", "dist", "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(root, "ui", "dist", "index.html"), html);
  await writeFile(path.join(assets, "index-YJY9oyby.js"), bundle);
  await writeFile(path.join(assets, "index-CUVXSWy6.css"), css);
}

const read = (rel) => readFile(path.join(root, rel), "utf8");
const count = (text, literal) => text.split(literal).length - 1;

describe("runTheme on core 2026.1023.0", () => {
  it("finds the core's toast viewport, which the phone toast cap relies on", async () => {
    await coreTree();
    const result = await runTheme({ root, themeDir: THEME_DIR, log: quiet });
    const { ANCHORS } = await import("../anchors.mjs");
    expect(ANCHORS.map((anchor) => anchor.id)).toEqual(expect.arrayContaining(["toast-viewport", "toast-list"]));
    expect(result.anchors).toBe(ANCHORS.length);
  });

  it("applies every text rule exactly as declared and reports it", async () => {
    await coreTree();
    const lines = [];
    const result = await runTheme({ root, themeDir: THEME_DIR, report: true, log: (line) => lines.push(line) });
    expect(result.rules).toHaveLength(TEXT_RULES.length);
    for (const rule of TEXT_RULES) expect(result.rules).toContain(`${rule.id} ${rule.expect}/${rule.expect}`);
    expect(lines.join("\n")).toMatch(/theme: anchors \d+\/\d+; sidebar sections top=7, work=10, org=4/);
  });

  it("renames Dashboard to Home in both sidebars and the core's last Apps breadcrumbs to Connectors", async () => {
    await coreTree();
    await runTheme({ root, themeDir: THEME_DIR, log: quiet });
    const bundle = await read("ui/dist/assets/index-YJY9oyby.js");
    // Both sidebars (streamlined and legacy) are renamed; the mobile bar's own "Home" link was already there.
    expect(count(bundle, 'to:"/dashboard",label:"Home"')).toBe(3);
    expect(bundle).not.toContain('to:"/dashboard",label:"Dashboard"');
    expect(bundle).toContain('[{label:"Home"}]');
    expect(count(bundle, '{label:"Connectors",href:"/apps"}')).toBe(3);
    expect(bundle).not.toContain('{label:"Apps",href:"/apps"}');
    expect(bundle).toMatch(/[\w$]+\(\[\{label:[\w$]+\.displayName\?\?[\w$]+\.pluginDisplayName\}\]\)/);
  });

  it("makes dark the default and links the theme after the core stylesheet with the boot flag", async () => {
    await coreTree();
    await runTheme({ root, themeDir: THEME_DIR, log: quiet });
    const html = await read("ui/dist/index.html");
    expect(html).toContain('const fallback = "dark";');
    const core = html.indexOf('/assets/index-CUVXSWy6');
    const theme = html.indexOf(`/assets/${THEME_ASSET}`);
    expect(core).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(core);
    expect(count(html, THEME_ASSET)).toBe(1);
    expect(html).toContain('root.setAttribute("data-kyoube-shell", "studio")');
    expect(await read(`ui/dist/assets/${THEME_ASSET}`)).toBe(await readFile(path.join(THEME_DIR, "theme.css"), "utf8"));
    const fonts = await readdir(path.join(root, "ui", "dist", "fonts", "kyoube"));
    expect(fonts).toEqual(expect.arrayContaining(["OFL.txt", "InstrumentSerif-Regular-latin.woff2", "InstrumentSerif-Italic-latin.woff2"]));
  });

  it("changes nothing on a dry run", async () => {
    await coreTree();
    await runTheme({ root, themeDir: THEME_DIR, dryRun: true, log: quiet });
    expect(await read("ui/dist/index.html")).toBe(INDEX_HTML);
    expect(await read("ui/dist/assets/index-YJY9oyby.js")).toBe(BUNDLE);
  });

  it("refuses to run twice on the same tree", async () => {
    await coreTree();
    await runTheme({ root, themeDir: THEME_DIR, log: quiet });
    await expect(runTheme({ root, themeDir: THEME_DIR, log: quiet })).rejects.toThrow(/already links kyoube-theme\.css/);
  });
});

describe("runTheme when the core changes", () => {
  async function failureFor(edit) {
    await coreTree(edit);
    const error = await runTheme({ root, themeDir: THEME_DIR, log: quiet }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ThemeError);
    // Nothing is written when a check fails.
    expect(await read("ui/dist/index.html")).toBe(edit.html ?? INDEX_HTML);
    return error.message;
  }

  it("names a text rule whose target moved", async () => {
    const message = await failureFor({ bundle: BUNDLE.replaceAll('to:"/dashboard",label:"Dashboard"', 'to:"/dashboard",label:"Overview"') });
    expect(message).toContain('text rule "home-sidebar-label" matched 0 time(s)');
  });

  it("names a text rule that matches more often than declared", async () => {
    const message = await failureFor({ bundle: `${BUNDLE};x([{label:"Dashboard"}])` });
    expect(message).toContain('text rule "home-breadcrumb" matched 2 time(s)');
  });

  it("names a hook the skin relies on", async () => {
    const message = await failureFor({ bundle: BUNDLE.replace("} avatar`", "} portrait`") });
    expect(message).toContain('anchor "agent-avatar-label"');
  });

  it("stops when the hidden Org section gains a link", async () => {
    const bundle = BUNDLE.replace('label:"Org",collapsible', 'label:"Org",collapsible:x,y:[{to:"/reports",label:"Reports"}],z');
    const message = await failureFor({ bundle });
    expect(message).toContain('sidebar section "org" changed: added [/reports]');
  });

  it("only reports a new link in a section the skin keeps", async () => {
    await coreTree({ bundle: BUNDLE.replace('label:"Work",collapsible', 'label:"Work",collapsible:x,y:[{to:"/reports",label:"Reports"}],z') });
    const lines = [];
    await runTheme({ root, themeDir: THEME_DIR, report: true, log: (line) => lines.push(line) });
    expect(lines.join("\n")).toContain("work=11 (new: /reports)");
  });

  it("names a token the core stopped declaring", async () => {
    const message = await failureFor({ css: CORE_CSS.replace(/--sidebar-border:[^;}]*;?/, "") });
    expect(message).toContain("the core no longer declares --sidebar-border");
  });

  it("stops when index.html lost the dark-default anchor", async () => {
    const message = await failureFor({ html: INDEX_HTML.replace('const fallback = prefersDark ? "dark" : "light";', "const fallback = pick();") });
    expect(message).toContain('text rule "dark-by-default" matched 0 time(s)');
  });
});

describe("helpers", () => {
  it("lists the routes between two literals", () => {
    expect(sectionRoutes('a label:"X" {to:"/one"} {to:"/two"} END {to:"/three"}', 'label:"X"', "END")).toEqual(["/one", "/two"]);
    expect(sectionRoutes("nothing here", 'label:"X"', "END")).toBeNull();
  });

  it("reads the sidebar sections the fixture was cut from", () => {
    // Routes in order of first appearance: Work names /issues twice (the chat-rail and the plain Tasks link).
    for (const section of SECTIONS) expect([...new Set(sectionRoutes(BUNDLE, section.start, section.end))]).toEqual(section.expected);
  });

  it("collects the core tokens theme.css overrides, not its own", () => {
    const tokens = overriddenTokens(":root{--background:#fff;--kyoube-accent:#0f766e;/* --commented:1 */}.dark{--background:#000}");
    expect(tokens).toEqual(["--background"]);
  });
});

describe("theme.css", () => {
  const cssPromise = readFile(path.join(THEME_DIR, "theme.css"), "utf8");
  const GATE = ':is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"]))';
  // The toast cap is gated on the boot flag, which stays set while the Studio
  // roster is on the page (boot.js clears it after 6 s otherwise).
  const TOAST_GATE = ':root[data-kyoube-shell="studio"] aside[aria-live="polite"][aria-atomic="false"]';

  it("shows at most the two newest toasts on a phone, above the tab bar", async () => {
    const css = (await cssPromise).replace(/\/\*[\s\S]*?\*\//g, "");
    const media = css.slice(css.indexOf("@media (max-width: 639px)"));
    expect(media).toContain(`${TOAST_GATE} > ol > :nth-child(n+3) { display: none; }`);
    expect(media).toMatch(new RegExp(`${TOAST_GATE.replace(/[[\]().*+?^$|\\]/g, "\\$&")} \\{[^}]*bottom: calc\\(76px \\+ env\\(safe-area-inset-bottom\\)\\)`));
  });

  /** Splits a selector list on its top-level commas (not those inside :is(), :has(), attribute values). */
  function splitSelectors(list) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < list.length; i += 1) {
      const ch = list[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (ch === "," && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
    }
    parts.push(list.slice(start));
    return parts;
  }

  function rules(css) {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (const match of flat.matchAll(re)) out.push({ selector: match[1].trim(), body: match[2] });
    return out;
  }

  it("gates every rule that hides or moves core UI on Studio being present", async () => {
    const css = await cssPromise;
    const offenders = rules(css)
      .filter((rule) => /(?<![\w-])display\s*:\s*none|(?<![\w-])order\s*:/.test(rule.body))
      .filter((rule) => !rule.selector.startsWith("@"))
      .flatMap((rule) => splitSelectors(rule.selector))
      .map((selector) => selector.trim())
      .filter((selector) => selector.length > 0)
      .filter((selector) => !selector.includes(GATE) && !selector.includes('[data-kyoube-studio="home"]') && !selector.includes("[data-kyoube-page]") && !selector.includes("[data-kyoube-nav") && !selector.includes(TOAST_GATE));
    expect(offenders).toEqual([]);
  });

  it("sets every colour it sets in light mode again for dark mode", async () => {
    const css = (await cssPromise).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = (name) => {
      const start = css.indexOf(`${name} {`);
      return css.slice(start, css.indexOf("}", start));
    };
    const names = (text) => [...text.matchAll(/(--[a-z0-9-]+)\s*:\s*(#|rgb|color-mix)/g)].map((m) => m[1]);
    const light = names(block(":root")).filter((name) => !name.startsWith("--agent-"));
    const dark = new Set(names(block(".dark")));
    expect(light.filter((name) => !dark.has(name))).toEqual([]);
  });

  it("never names the upstream project, which the rebrand sweep would flag", async () => {
    expect(await cssPromise).not.toMatch(/Paperclip/);
  });
});
