import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildOrgTree, focusIds } from "../src/org/org-tree.js";
import { effectiveCollapsed, OrgChart, playableMoments, type OrgChartProps } from "../src/org/OrgChart.js";
import { momentSnapshot } from "../src/org/org-moments.js";
import type { OrgAgent } from "../src/org/org-types.js";
import { FLAT, INDUSTRIAL, org } from "./org-fixtures.js";

const render = (agents: OrgAgent[], extra: Partial<OrgChartProps> = {}) =>
  renderToStaticMarkup(
    createElement(OrgChart, {
      agents,
      doneTaskIds: new Set<string>(),
      selectedId: null,
      onSelect: () => {},
      present: false,
      onPresentChange: () => {},
      storageKey: null,
      ...extra,
    }),
  );

const count = (html: string, needle: string | RegExp) =>
  typeof needle === "string" ? html.split(needle).length - 1 : (html.match(needle) ?? []).length;

/** The opening tag of every card. */
const cardTags = (html: string) => html.match(/<button[^>]*data-org-card="[^"]*"[^>]*>/g) ?? [];

/** One head over ten teams of five: 61 agents. */
function bigOrg(stuckId?: string): OrgAgent[] {
  const rows: Array<[string, string, string | null, OrgAgent["state"]?]> = [["ceo", "Chief", null]];
  for (let t = 0; t < 10; t++) {
    rows.push([`lead${t}`, `Lead ${t}`, "ceo"]);
    for (let m = 0; m < 5; m++) {
      const id = `m${t}-${m}`;
      rows.push([id, `Member ${t}-${m}`, `lead${t}`, id === stuckId ? "attention" : undefined]);
    }
  }
  return org(rows);
}

describe("OrgChart", () => {
  it("draws one card per agent, a panel per team and a line per reporting pair", () => {
    const html = render(INDUSTRIAL);
    expect(count(html, "data-org-card=")).toBe(32);
    expect(count(html, "data-org-panel=")).toBe(5);
    expect(count(html, "data-org-line=")).toBe(31);
    expect(html).toContain('data-kyoube-org=""');
    expect(html).toContain('data-org-line="morgan:pat"');
    expect(html).toContain('data-size="head"');
  });

  it("labels cards for screen readers", () => {
    const [lead, ...rest] = org([["kai", "Kai", null, "working"], ["k1", "Kai Aide", "kai"]]);
    const kai: OrgAgent = { ...lead!, title: "Tech Lead", detail: "Fixing the login page", task: { id: "t12", identifier: "CUBE-12", title: "Fixing the login page", href: "/BAP/issues/CUBE-12" } };
    const untitled: OrgAgent = { ...rest[0]!, title: "" };
    const html = render([kai, untitled]);
    expect(html).toContain('aria-label="Kai, Tech Lead, working on CUBE-12"');
    expect(html).toContain('aria-label="Kai Aide, Idle"');
    expect(html).toContain("Fixing the login page");
    expect(html).toContain('data-state="working"');
  });

  it("dims everyone outside the focused chain", () => {
    const focus = focusIds(buildOrgTree(INDUSTRIAL), "ana");
    expect(focus.size).toBe(5);
    const html = render(INDUSTRIAL, { selectedId: "ana" });
    const tags = cardTags(html);
    expect(tags).toHaveLength(32);
    expect(tags.filter((t) => t.includes("data-dim")).length).toBe(32 - focus.size);
    expect(tags.find((t) => t.includes('data-org-card="ana"'))).not.toContain("data-dim");
    expect(html).toMatch(/data-org-line="pat:ana"(?![^>]*data-dim)[^>]*>/);
    expect(html).toMatch(/data-org-line="lee:kim"[^>]*data-dim/);
    expect(html).toMatch(/data-org-panel="team:lee"[^>]*data-dim/);
    expect(html).toMatch(/data-org-panel="team:pat"(?![^>]*data-dim)[^>]*>/);
  });

  it("effectiveCollapsed opens only the given panels", () => {
    const input = new Set(["team:a", "team:b"]);
    expect(effectiveCollapsed(input, ["team:a", null])).toEqual(new Set(["team:b"]));
    expect(input).toEqual(new Set(["team:a", "team:b"]));
  });

  it("a selectedId that is not in agents renders no side panel and no dimming", () => {
    const html = render(INDUSTRIAL, { selectedId: "nobody", renderPanel: (a) => createElement("b", null, a.name) });
    expect(html).not.toContain("data-org-side");
    expect(html).not.toContain("data-dim");
  });

  it("renders the side panel through renderPanel", () => {
    let seen: { manager: string | null; reports: string[] } | null = null;
    const html = render(INDUSTRIAL, {
      selectedId: "kim",
      renderPanel: (agent, ctx) => {
        seen = { manager: ctx.manager?.id ?? null, reports: ctx.reports.map((r) => r.id) };
        return createElement("b", null, `panel for ${agent.name}`);
      },
    });
    expect(html).toMatch(/<aside[^>]*data-org-side[^>]*>[\s\S]*<b>panel for Analytics Kim<\/b>[\s\S]*<\/aside>/);
    expect(html).toMatch(/<aside[\s\S]*aria-label="Close"[\s\S]*<\/aside>/);
    expect(seen).toEqual({ manager: "lee", reports: ["kim1", "kim2", "kim3"] });
  });

  it("starts collapsed above 60 agents", () => {
    const agents = bigOrg();
    expect(agents).toHaveLength(61);
    const html = render(agents);
    expect(count(html, "data-org-chip=")).toBe(10);
    expect(count(html, "data-org-card=")).toBe(1);
    expect(html).toContain('data-org-card="ceo"');
    expect(html).toContain("Team · Lead 0 · 6");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("data-alert");
  });

  it("a collapsed team with someone stuck keeps a red dot", () => {
    const html = render(bigOrg("m3-2"));
    expect(count(html, "data-alert")).toBe(1);
    expect(html).toMatch(/data-org-chip="team:lead3"[\s\S]*?<i[^>]*data-alert/);
  });

  it("renders a flat company as the shelf alone", () => {
    const solo = FLAT.filter((a) => a.id.startsWith("solo"));
    const html = render(solo);
    expect(html).toContain("data-org-shelf");
    expect(html).toContain("Not in a team yet");
    expect(count(html, "data-org-card=")).toBe(solo.length);
    expect(count(html, "data-org-panel=")).toBe(0);
    expect(count(html, "data-org-line=")).toBe(0);
  });

  it("playableMoments plays nothing while hidden or with reduced motion", () => {
    const before = momentSnapshot(org([["a", "A", null, "working"]]), []);
    const after = momentSnapshot(org([["a", "A", null, "attention"]]), []);
    expect(playableMoments(before, after, { hidden: true, reducedMotion: false })).toEqual([]);
    expect(playableMoments(before, after, { hidden: false, reducedMotion: true })).toEqual([]);
  });

  it("playableMoments passes diffMoments through otherwise", () => {
    const before = momentSnapshot(org([["a", "A", null, "working"]]), []);
    const after = momentSnapshot(org([["a", "A", null, "attention"]]), []);
    const env = { hidden: false, reducedMotion: false };
    expect(playableMoments(before, after, env)).toEqual([{ kind: "problem", agentId: "a" }]);
    expect(playableMoments(null, after, env)).toEqual([]);
  });

  it("src/org imports only react and characters", () => {
    const dir = new URL("../src/org/", import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(files).toContain("OrgChart.tsx");
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const [, spec] of source.matchAll(/from\s+"([^"]+)"/g)) {
        const ok = spec === "react" || spec === "react/jsx-runtime" || spec!.startsWith("./") || spec === "../characters.js";
        expect(ok, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
