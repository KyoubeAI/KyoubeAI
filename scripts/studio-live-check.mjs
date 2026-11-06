#!/usr/bin/env node
/**
 * Signs in to a running stack in headless Chrome and asks the rendered app
 * whether the KyoubeAI Studio design is really there — the theme from
 * docker/theme and the kyoube.studio plugin together — and whether it still
 * falls back to the stock layout when the plugin is gone. The build-time
 * checks in docker/theme prove the hooks exist in the bundle; this proves the
 * browser does what the skin intends with them on this core.
 *
 *   node scripts/studio-live-check.mjs <base-url> <email> <password> <company-prefix> [board-token]
 *
 * It also opens an agent through the core's own URLs and checks that the
 * Studio profile answers, that the core's agent views show the agent's
 * character and display-face name, and that `?classic=1` keeps the core's
 * overview, that the roster's org icon opens Studio's org chart at /team, which
 * draws every agent, its reporting lines and team panels, opens the side panel
 * and enters presentation mode, and that every filter tab of the agent list
 * stays on the list (naming any tab a core bump adds, which Studio must learn).
 * With a board token it disables kyoube.studio, checks that the stock sidebar
 * comes back, and enables it again. Screenshots of Home (dark and light), an
 * agent profile, the Workspace page and the org chart (team-dark.png,
 * team-light.png, team-phone.png) are written to STUDIO_SHOTS_DIR when that is set, for a
 * person to look at after a core bump; nothing compares pixels.
 *
 * Exit 0 on pass, 1 on failure, 2 when no Chrome is installed (scripts/smoke.sh
 * treats 2 as a failure unless KYOUBE_ALLOW_NO_CHROME=1, as for the brand check).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cdp, Page, launchChrome, signIn } from "./lib/cdp.mjs";
import { findChrome } from "./lib/headless-chrome.mjs";
import { teamTrial } from "./lib/team-trial.mjs";

const [baseArg, email, password, prefix, boardToken] = process.argv.slice(2);
const base = (baseArg ?? "").replace(/\/+$/, "");
const shotsDir = process.env.STUDIO_SHOTS_DIR || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs in the page: everything the checks below need to know about the sidebar and Home. */
const INSPECT = `(() => {
  const nav = document.querySelector("aside nav");
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const link = (suffix, scope = nav) => scope && [...scope.querySelectorAll("a")].find((a) => (a.getAttribute("href") || "").endsWith(suffix));
  const coreLink = (suffix) => nav && [...nav.querySelectorAll("a")].find((a) => (a.getAttribute("href") || "").endsWith(suffix) && !a.closest("[data-kyoube-studio]") && !a.hasAttribute("data-kyoube-nav"));
  const team = document.querySelector('[data-kyoube-studio="team"]');
  const build = document.querySelector('[data-kyoube-studio="build"]');
  const data = link("/data");
  const home = document.querySelector('[data-kyoube-studio="home"]');
  const metrics = home && home.closest("main") && [...home.closest("main").querySelectorAll("a")].find((a) => (a.getAttribute("href") || "").endsWith("/costs") && !a.closest("[data-kyoube-studio]"));
  const search = link("/search");
  const newTask = nav && nav.querySelector("button:has(> svg.lucide-square-pen)");
  const root = getComputedStyle(document.documentElement);
  return {
    dark: document.documentElement.classList.contains("dark"),
    radius: root.getPropertyValue("--radius").trim(),
    accent: root.getPropertyValue("--kyoube-accent").trim(),
    themeLinked: [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /\\/assets\\/kyoube-theme-[0-9a-f]{8}\\.css$/.test(l.getAttribute("href") || "")),
    teamShown: shown(team),
    teamRows: team ? team.querySelectorAll(".ks-row").length : 0,
    firstAgentHref: team && team.querySelector(".ks-row") ? team.querySelector(".ks-row").getAttribute("href") : null,
    // The core's Org section (Agents, Skills, Connectors, Audit) moves to the Workspace page.
    orgShown: shown(coreLink("/activity")),
    stockAgentsShown: shown(coreLink("/agents")),
    coreRoutinesShown: shown(coreLink("/routines")),
    studioRoutinesShown: shown(nav && nav.querySelector('a[data-kyoube-nav="routines"]')),
    buildBeforeData: !!build && !!data && !!(build.compareDocumentPosition(data) & Node.DOCUMENT_POSITION_FOLLOWING),
    dataShown: shown(data),
    workspaceShown: shown(nav && nav.querySelector('a[data-kyoube-nav="workspace"]')),
    // The link's first text, so the core's "N live" runs badge after the label is left out.
    homeLabel: (() => {
      const a = link("/dashboard");
      if (!a) return "";
      const walk = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
      return (walk.nextNode()?.textContent || "").trim();
    })(),
    searchBorder: search ? getComputedStyle(search).borderTopWidth : null,
    newTaskFilled: !!newTask && getComputedStyle(newTask).backgroundColor !== "rgba(0, 0, 0, 0)",
    homeShown: shown(home),
    homeAboveMetrics: !!home && !!metrics && home.getBoundingClientRect().top < metrics.getBoundingClientRect().top,
  };
})()`;

/**
 * Runs in the page at /team: the chart's height, and how far the document and the chart's nearest
 * scrolling ancestor (the core's <main> on a desktop) overflow. Studio sizes the chart to the window
 * by measuring, so any overflow means the core's layout moved under it.
 */
const CHART_FIT = `(() => {
  const chart = document.querySelector("[data-kyoube-org]");
  let scroller = chart ? chart.parentElement : null;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const doc = document.scrollingElement;
  return {
    chartHeight: chart ? Math.round(chart.getBoundingClientRect().height) : 0,
    pageOverflow: doc ? doc.scrollHeight - innerHeight : 0,
    scrollerOverflow: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
  };
})()`;

/** Names a /team page that scrolls, or a chart shorter than its 520 px minimum, at `size`. */
async function checkChartFit(page, size, problems) {
  const fit = await page.evaluate(CHART_FIT);
  if (fit.pageOverflow > 1) problems.push(`team: the page scrolls by ${fit.pageOverflow}px at ${size} (the org chart no longer fits the window; check its height against the core's layout)`);
  if (fit.scrollerOverflow > 1) problems.push(`team: the main content scrolls by ${fit.scrollerOverflow}px at ${size} (the org chart no longer fits the window; check its height against the core's layout)`);
  if (fit.chartHeight < 520) problems.push(`team: the org chart is ${fit.chartHeight}px tall at ${size}, shorter than its 520px minimum`);
}

function expectAll(label, facts, expectations, problems) {
  for (const [key, want] of Object.entries(expectations)) {
    const got = facts[key];
    const ok = typeof want === "function" ? want(got) : got === want;
    if (!ok) problems.push(`${label}: ${key} is ${JSON.stringify(got)}`);
  }
}

async function api(pathname, method = "GET", body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { Authorization: `Bearer ${boardToken}`, "Content-Type": "application/json", Origin: base }, body: method === "POST" || method === "PATCH" ? JSON.stringify(body ?? {}) : undefined });
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function main() {
  if (!base || !email || !password || !prefix) {
    console.log("usage: studio-live-check.mjs <base-url> <email> <password> <company-prefix> [board-token]");
    return 1;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the Studio live check)");
    return 2;
  }
  const problems = [];
  const { wsUrl, close } = await launchChrome(chrome);
  const cdp = await Cdp.connect(wsUrl);
  try {
    const page = await Page.open(cdp, { width: 1440, height: 900 });
    const cookie = await signIn(base, email, password);
    await page.setCookie({ ...cookie, url: base });
    if (shotsDir) await mkdir(shotsDir, { recursive: true });

    // Home in the default theme, with nothing stored: KyoubeAI opens dark.
    await page.goto(`${base}/${prefix}/dashboard`);
    await page.waitForFunction(`!!document.querySelector('[data-kyoube-studio="team"] .ks-row') && !!document.querySelector('[data-kyoube-studio="home"] .ks-panel')`, { timeoutMs: 30_000 });
    await sleep(800);
    const facts = await page.evaluate(INSPECT);
    expectAll("home (default theme)", facts, {
      dark: true,
      themeLinked: true,
      radius: "0.625rem",
      accent: (v) => typeof v === "string" && v.length > 0,
      teamShown: true,
      teamRows: (n) => n >= 1,
      orgShown: false,
      stockAgentsShown: false,
      coreRoutinesShown: false,
      studioRoutinesShown: true,
      buildBeforeData: (v) => v === true || !facts.dataShown,
      workspaceShown: true,
      homeLabel: "Home",
      searchBorder: "1px",
      newTaskFilled: true,
      homeShown: true,
      homeAboveMetrics: true,
    }, problems);
    if (shotsDir) await writeFile(path.join(shotsDir, "home-dark.png"), await page.screenshot());

    // The theme toggle's stored choice still wins over the dark default.
    await page.evaluate(`localStorage.setItem("paperclip.theme", "light")`);
    await page.goto(`${base}/${prefix}/dashboard`);
    await page.waitForFunction(`!!document.querySelector('[data-kyoube-studio="home"] .ks-panel')`, { timeoutMs: 30_000 });
    if (await page.evaluate(`document.documentElement.classList.contains("dark")`)) problems.push("a stored light theme did not win over the dark default");
    if (shotsDir) await writeFile(path.join(shotsDir, "home-light.png"), await page.screenshot());

    // The Workspace page: a card for everything the sidebar hides, titled by the page, no Back link.
    await page.goto(`${base}/${prefix}/workspace`);
    await page.waitForFunction(`document.querySelectorAll('[data-kyoube-page="workspace"] .ks-card').length > 0`, { timeoutMs: 30_000 });
    const workspace = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-kyoube-page="workspace"] .ks-card')].map((a) => a.getAttribute("href"));
      const back = [...document.querySelectorAll("main a")].find((a) => a.textContent.trim() === "Back");
      return { cards, backShown: !!back && back.getClientRects().length > 0, title: document.title };
    })()`);
    for (const route of ["/agents/all", "/activity/timeline", "/activity/costs", "/activity", "/company/settings", "/apps", "/skills", "/artifacts"]) {
      if (!workspace.cards.some((href) => href && href.endsWith(route))) problems.push(`workspace: no card links ${route}`);
    }
    if (workspace.backShown) problems.push("workspace: the host's Back link is still shown");
    if (/Plugins/.test(workspace.title)) problems.push(`workspace: page title still names the plugin area (${workspace.title})`);
    if (shotsDir) await writeFile(path.join(shotsDir, "workspace-light.png"), await page.screenshot());

    // The agent profile (Concept C): the core's agent URLs open it, the core's
    // own views carry the agent's character, and ?classic=1 keeps the core view.
    const agentRef = facts.firstAgentHref ? decodeURIComponent(facts.firstAgentHref.split("/team/")[1] || "") : "";
    if (!agentRef) problems.push("profile: the team roster has no agent link to follow");
    else {
      const agentUrl = `${base}/${prefix}/agents/${encodeURIComponent(agentRef)}`;
      for (const view of ["", "/overview"]) {
        await page.goto(`${agentUrl}${view}`);
        try {
          await page.waitForFunction(`location.pathname.endsWith("/team/${encodeURIComponent(agentRef)}") && !!document.querySelector('[data-kyoube-page="team"] h1') && !!document.querySelector('[data-kyoube-page="team"] [role="switch"]')`, { timeoutMs: 20_000 });
          if (shotsDir && view === "") await writeFile(path.join(shotsDir, "profile-light.png"), await page.screenshot());
        } catch {
          problems.push(`profile: /agents/${agentRef}${view} did not open the Studio profile (at ${await page.evaluate("location.pathname")})`);
        }
      }
      await page.goto(`${agentUrl}/skills`);
      try {
        await page.waitForFunction(`(() => { const avatar = document.querySelector('.agent-settings-content > header [role="img"]'); return !!avatar && getComputedStyle(avatar).backgroundImage.startsWith('url("data:image/svg+xml'); })()`, { timeoutMs: 20_000 });
      } catch {
        problems.push("profile: the core agent page's header does not show the agent's character");
      }
      const nameFont = await page.evaluate(`(() => { const name = document.querySelector('.agent-settings-content > header h1'); return name ? getComputedStyle(name).fontFamily : null; })()`);
      if (!nameFont || !nameFont.includes("Instrument Serif")) problems.push(`profile: the core agent page's name is not in the display face (${JSON.stringify(nameFont)})`);
      if (shotsDir) await writeFile(path.join(shotsDir, "agent-core-light.png"), await page.screenshot());
      await page.goto(`${agentUrl}/overview?classic=1`, { settleMs: 2500 });
      if (!(await page.evaluate(`location.pathname.endsWith("/overview")`))) problems.push("profile: ?classic=1 did not keep the core's own agent overview");
    }

    // The agent list: the roster's org icon opens Studio's org chart, and every
    // filter tab the core draws stays on the list. Studio keeps its own copy of
    // the core's tab names (agent-route.ts) so it never takes a tab for an agent;
    // a tab added by a core bump shows up here by name.
    const orgIcon = `[data-kyoube-studio="team"] a[aria-label="Org chart"]`;
    await page.goto(`${base}/${prefix}/dashboard`);
    await page.waitForFunction(`!!document.querySelector('${orgIcon}')`, { timeoutMs: 30_000 });
    await page.evaluate(`document.querySelector('${orgIcon}').click()`);
    try {
      await page.waitForFunction(`/\\/team\\/?$/.test(location.pathname) && !!document.querySelector("[data-kyoube-org]")`, { timeoutMs: 15_000 });
    } catch {
      problems.push(`agent list: the roster's org icon did not open the org chart at /team (at ${await page.evaluate("location.pathname")})`);
    }
    await page.goto(`${base}/${prefix}/agents/all`);
    await page.waitForFunction(`document.querySelectorAll('main [role="tab"]').length > 0`, { timeoutMs: 15_000 }).catch(() => {});
    const knownTabs = ["all", "active", "paused", "error", "builtin"];
    const tabCount = await page.evaluate(`document.querySelectorAll('main [role="tab"]').length`);
    if (tabCount === 0) problems.push("agent list: no filter tabs found");
    for (let i = 0; i < tabCount; i += 1) {
      const label = await page.evaluate(`(() => {
        const tab = document.querySelectorAll('main [role="tab"]')[${i}];
        if (!tab) return null;
        // Radix tabs switch on mousedown.
        tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        tab.click();
        return tab.textContent.trim();
      })()`);
      if (label === null) continue;
      await sleep(1200);
      const at = await page.evaluate("location.pathname");
      const tab = /\/agents\/([^/]+)\/?$/.exec(at)?.[1];
      if (!tab) problems.push(`agent list: the "${label}" tab left the list (at ${at})`);
      else if (!knownTabs.includes(tab)) problems.push(`agent list: the core has a new filter tab "${tab}"; add it to AGENT_LIST_TABS in plugins/kyoube-studio/src/ui/agent-route.ts`);
      else if (await page.evaluate(`!!document.querySelector('[data-kyoube-page="team"]')`)) problems.push(`agent list: the "${label}" tab opened a Studio profile`);
    }

    // Studio's org chart at /team. With a board token three agents nobody reports to become a
    // standalone team (teamTrial; their managers are put back afterwards), so the lines and the
    // team panel are known; without one, only that cards are drawn.
    const teamUrl = `${base}/${prefix}/team`;
    const restore = [];
    let live = [];
    try {
      if (boardToken) {
        try {
          const company = (await api("/api/companies")).find((c) => c.issuePrefix === prefix);
          if (!company) problems.push(`team: no company has the prefix ${prefix}`);
          else live = (await api(`/api/companies/${company.id}/agents`)).filter((a) => a.status !== "terminated");
        } catch (error) {
          problems.push(`team: could not list the agents (${error instanceof Error ? error.message : error})`);
        }
      }
      const trial = teamTrial(live);
      const { lead, members: [second, third] = [] } = trial ?? {};
      const structured = trial !== null;
      if (boardToken && !structured) problems.push(`team: need 3 live agents with no reports to check reporting lines and a team panel (have ${live.length} agent(s))`);
      if (structured) {
        for (const patch of trial.patches) {
          restore.push({ id: patch.id, reportsTo: live.find((a) => a.id === patch.id).reportsTo ?? null });
          await api(`/api/agents/${patch.id}`, "PATCH", { reportsTo: patch.reportsTo });
        }
      }
      // The Home check above stored the light theme; the first chart shot is of the dark default.
      await page.evaluate(`localStorage.removeItem("paperclip.theme")`);
      await page.goto(teamUrl);
      try {
        await page.waitForFunction(boardToken && live.length > 0 ? `document.querySelectorAll("[data-org-card]").length === ${live.length}` : `document.querySelectorAll("[data-org-card]").length >= 1`, { timeoutMs: 30_000 });
      } catch {
        const drawn = await page.evaluate(`document.querySelectorAll("[data-org-card]").length`);
        problems.push(`team: ${drawn} agent card(s) drawn at /team, expected ${boardToken && live.length > 0 ? live.length : "at least 1"}`);
      }
      await checkChartFit(page, "1440x900", problems);
      if (structured) {
        const found = await page.evaluate(`(() => ({
          panel: !!document.querySelector('[data-org-panel="team:${lead.id}"]'),
          lineSecond: !!document.querySelector('[data-org-line="${lead.id}:${second.id}"]'),
          lineThird: !!document.querySelector('[data-org-line="${lead.id}:${third.id}"]'),
        }))()`);
        if (!found.panel) problems.push(`team: no team panel for the lead (data-org-panel="team:${lead.id}")`);
        if (!found.lineSecond) problems.push(`team: no reporting line from the lead to ${second.name} (data-org-line="${lead.id}:${second.id}")`);
        if (!found.lineThird) problems.push(`team: no reporting line from the lead to ${third.name} (data-org-line="${lead.id}:${third.id}")`);
      }

      // Opening a card shows the side panel.
      await page.evaluate(`document.querySelector("[data-org-card]")?.click()`);
      try {
        await page.waitForFunction(`!!document.querySelector("[data-org-side]")`, { timeoutMs: 10_000 });
      } catch {
        problems.push("team: clicking a card did not open the side panel (data-org-side)");
      }
      if (shotsDir) {
        await sleep(500); // The side panel slides and fades in.
        await writeFile(path.join(shotsDir, "team-dark.png"), await page.screenshot());
        await page.evaluate(`localStorage.setItem("paperclip.theme", "light")`);
        await page.goto(teamUrl);
        await page.waitForFunction(`!!document.querySelector("[data-kyoube-org]")`, { timeoutMs: 30_000 }).catch(() => problems.push("team: the chart did not draw after switching to the light theme"));
        await writeFile(path.join(shotsDir, "team-light.png"), await page.screenshot());
        await page.evaluate(`localStorage.removeItem("paperclip.theme")`);
      }

      // A phone-sized window.
      const phone = await Page.open(cdp, { width: 390, height: 844 });
      await phone.setCookie({ ...cookie, url: base });
      await phone.goto(teamUrl);
      await phone.waitForFunction(`document.querySelectorAll("[data-org-card]").length >= 1`, { timeoutMs: 30_000 }).catch(() => problems.push("team: no agent card drawn in a 390 px wide window"));
      await checkChartFit(phone, "390x844", problems);
      if (shotsDir) await writeFile(path.join(shotsDir, "team-phone.png"), await phone.screenshot());

      // Presentation mode.
      await page.goto(`${teamUrl}?present=1`);
      try {
        await page.waitForFunction(`!!document.querySelector('[data-org-present="true"]')`, { timeoutMs: 15_000 });
      } catch {
        problems.push("team: /team?present=1 did not enter presentation mode (data-org-present=\"true\")");
      }
    } catch (error) {
      problems.push(`team: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const original of restore) {
        try {
          await api(`/api/agents/${original.id}`, "PATCH", { reportsTo: original.reportsTo });
        } catch (error) {
          problems.push(`team: could not restore the manager of agent ${original.id} (${error instanceof Error ? error.message : error})`);
        }
      }
    }

    // Secondary sidebars (company settings) are <aside><nav> too; the skin must leave them whole.
    await page.goto(`${base}/${prefix}/company/settings`);
    await page.waitForFunction(`document.querySelectorAll("aside").length >= 2`, { timeoutMs: 20_000 }).catch(() => {});
    const settings = await page.evaluate(`(() => {
      const asides = [...document.querySelectorAll("aside")].filter((a) => !a.querySelector("button > svg.lucide-square-pen"));
      const links = asides.flatMap((a) => [...a.querySelectorAll("a")]).filter((a) => (a.getAttribute("href") || "").includes("/company/settings"));
      return { links: links.length, hidden: links.filter((a) => a.getClientRects().length === 0).map((a) => a.getAttribute("href")) };
    })()`);
    if (settings.links === 0) problems.push("company settings: no secondary sidebar links found");
    if (settings.hidden.length > 0) problems.push(`company settings: the skin hid secondary sidebar links ${settings.hidden.slice(0, 5).join(", ")}`);

    // Fail safe: without the Studio plugin the stock sidebar comes back.
    if (boardToken) {
      const plugins = await api("/api/plugins");
      const studio = plugins.find((plugin) => plugin.pluginKey === "kyoube.studio");
      if (!studio) problems.push("kyoube.studio is not installed");
      else {
        await api(`/api/plugins/${studio.id}/disable`, "POST");
        try {
          await page.goto(`${base}/${prefix}/dashboard`, { settleMs: 500 });
          await page.waitForFunction(`(() => { const a = [...document.querySelectorAll("aside nav a")].find((x) => (x.getAttribute("href") || "").endsWith("/activity")); return !!a && a.getClientRects().length > 0; })()`, { timeoutMs: 15_000 });
        } catch {
          problems.push("with kyoube.studio disabled, the stock sidebar (Org section) did not come back within 15 s");
        } finally {
          await api(`/api/plugins/${studio.id}/enable`, "POST");
        }
      }
    }
    if (page.consoleErrors.length > 0) console.log(`studio-live-check: page errors seen (not failing the check): ${page.consoleErrors.slice(0, 3).join(" | ")}`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    cdp.close();
    await close();
  }
  if (problems.length === 0) {
    console.log(`studio-live-check: ${base}/${prefix} renders the Studio design${boardToken ? " and falls back to the stock sidebar without the plugin" : ""}`);
    return 0;
  }
  console.log("studio-live-check: FAIL");
  for (const problem of problems) console.log(`  ${problem}`);
  return 1;
}

process.exitCode = await main();
