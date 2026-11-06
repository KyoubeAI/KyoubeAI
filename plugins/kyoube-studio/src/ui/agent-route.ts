/**
 * How the Studio layout meets the core's own agent page (`/<co>/agents/<ref>/<view>`).
 *
 * The core page has fixed views and no plugin slot, so the Concept C profile
 * is a Studio page (`/<co>/team/<ref>`). The core page's default view sends
 * people to the profile instead: "overview" since core 2026.916, "dashboard"
 * before it, and the bare agent URL, which the core resolves to its default.
 * Its other views (Instructions, Skills, Harness / Runtime, …) stay the
 * core's, with the agent's character in their header. `?classic=1` keeps the
 * core's own overview.
 */
import { characterFor } from "../characters.js";

const CORE_AGENT_PAGE = /^\/[^/]+\/agents\/([^/]+)(?:\/([^/]+))?\/?$/;
/**
 * The agent list's filter tabs, each a core route of its own
 * (`/<co>/agents/<tab>`, the core's `AGENT_FILTER_TABS`) that outranks
 * `agents/:agentId`, so none of them is ever an agent.
 */
const AGENT_LIST_TABS = ["all", "active", "paused", "error", "builtin"] as const;
/** Core routes under `/agents/` that are not an agent: the new-agent page and the list's filter tabs. */
const NOT_AN_AGENT = new Set<string>(["new", ...AGENT_LIST_TABS]);
/** The core's default agent view, under its current and its previous name. */
const DEFAULT_VIEWS = new Set(["overview", "dashboard"]);

/** The agent a core agent URL is about, and which view, or null for other pages. */
export function coreAgentPage(pathname: string): { ref: string; tab: string } | null {
  const match = CORE_AGENT_PAGE.exec(pathname);
  if (!match) return null;
  const ref = decodeURIComponent(match[1]!);
  if (NOT_AN_AGENT.has(ref)) return null;
  return { ref, tab: match[2] ? decodeURIComponent(match[2]) : "overview" };
}

/** Where the Studio layout sends a core agent URL: its default view goes to the profile; everything else stays. */
export function agentRedirectTarget(pathname: string, search: string): string | null {
  if (/(?:^|[?&])classic=1(?:&|$)/.test(search)) return null;
  const page = coreAgentPage(pathname);
  if (!page || !DEFAULT_VIEWS.has(page.tab)) return null;
  return `/team/${encodeURIComponent(page.ref)}`;
}

/**
 * The core agent page's header, recognised by the page's own wrapper: every
 * view renders inside `.agent-settings-content`, whose first `<header>` holds
 * the agent's avatar and name.
 */
export const CORE_AGENT_HEADER = ".agent-settings-content > header";

/** `value` as a double-quoted CSS string, safe inside an attribute selector. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n\f]/g, " ")}"`;
}

/**
 * CSS that paints an agent's character over the avatar in the core agent
 * page's header, for the agent on screen. The core labels that avatar
 * "<agent name> avatar" (role="img"), so the rule matches that agent's header
 * only, and when the core changes that markup the selector simply stops
 * matching.
 */
export function coreAvatarCss(agent: { name: string; icon: string | null }): string {
  const { tint, svg } = characterFor(agent.icon, agent.name);
  const avatar = `${CORE_AGENT_HEADER} [role="img"][aria-label=${cssString(`${agent.name} avatar`)}]`;
  const image = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  return [
    `${avatar} { background: ${image} center / 100% no-repeat, var(--kyoube-tile-${tint}, #e9e9ec); width: 56px; height: 56px; border-radius: 30%; }`,
    `${avatar} > * { opacity: 0; }`,
  ].join("\n");
}

/**
 * The core's agent list (`/<co>/agents/<filter>`) shows a list or an org
 * chart; the choice is the page's own state, which starts as the list and has
 * no URL of its own. Studio opens it on the org chart instead: when someone
 * arrives on the list from another page, the roster presses the core's
 * "Org chart view" toggle once. Moving between the filter tabs keeps whatever
 * view they picked, and when the core renames that toggle nothing is pressed
 * and the list shows, as stock.
 */
const AGENT_LIST_PAGE = /^\/[^/]+\/agents\/([^/]+)\/?$/;

/** Whether `pathname` is the core's agent list, under any filter tab. */
export function isAgentListPage(pathname: string): boolean {
  const tab = AGENT_LIST_PAGE.exec(pathname)?.[1];
  return tab !== undefined && (AGENT_LIST_TABS as readonly string[]).includes(tab);
}

/** Whether moving from `previous` (null on first load) to `next` opens the agent list afresh. */
export function opensAgentList(previous: string | null, next: string): boolean {
  return isAgentListPage(next) && (previous === null || !isAgentListPage(previous));
}

/** The core's toggle for the org chart view, labelled by the core itself. */
export const ORG_VIEW_TOGGLE = 'button[aria-label="Org chart view"]';

/**
 * Presses the org chart toggle under `root` if it is there. Returns true once
 * the org chart is showing (pressed now, or already), false while the toggle
 * has not rendered yet.
 */
export function pressOrgView(root: Pick<ParentNode, "querySelector">): boolean {
  const toggle = root.querySelector<HTMLElement>(ORG_VIEW_TOGGLE);
  if (!toggle) return false;
  if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
  return true;
}
