/**
 * What theme.css's skin relies on in the core's compiled UI, checked at build
 * time after TEXT_RULES ran.
 *
 * The skin is written to fail safe: every structural rule is gated on the
 * Studio plugin's own markup, and a selector that stops matching just shows
 * the stock look. These checks exist so that a core bump that moves a hook is
 * caught at build time with a named reason, instead of being discovered as a
 * slowly un-themed sidebar.
 *
 * ANCHORS: a literal that must appear at least `min` times in the bundle.
 * SECTIONS: the routes the core's sidebar puts in one section, compared with
 * the set the skin was written for. A section the skin hides must match its
 * set exactly: a new link there would otherwise disappear from the sidebar
 * without a home on the Workspace page.
 */

const BUNDLE = ["ui/dist/assets/*.js"];

export const ANCHORS = [
  { id: "nav-search-link", files: BUNDLE, literal: 'to:"/search",label:"Search"', min: 1, why: "the search field restyle targets the /search nav link" },
  { id: "nav-home-link", files: BUNDLE, literal: 'to:"/dashboard",label:"Home"', min: 1, why: "the Home icon swap targets the /dashboard nav link" },
  { id: "nav-new-task", files: BUNDLE, literal: '"New Task"', min: 1, why: "the New task button restyle targets the sidebar's compose button" },
  { id: "icon-square-pen", files: BUNDLE, literal: '"square-pen"', min: 1, why: "the New task button is found by its lucide-square-pen icon class" },
  { id: "icon-class-names", files: BUNDLE, literal: "lucide-${", min: 1, why: "icons must keep their per-name lucide-<name> class" },
  { id: "nav-work-section", files: BUNDLE, literal: 'label:"Work",collapsible', min: 1, why: "the Work header row is hidden so Tasks and Projects join the top group" },
  { id: "nav-org-section", files: BUNDLE, literal: 'label:"Org",collapsible', min: 1, why: "the Org section (Agents, Skills, Connectors, Audit) moves to the Workspace page" },
  { id: "nav-agents-section-menu", files: BUNDLE, literal: 'menu:{ariaLabel:"Agents section actions"', min: 1, why: "the core's own agent list (streamlined shell) is hidden by its section menu, as the Studio Team roster replaces it" },
  { id: "nav-agents-see-all", files: BUNDLE, literal: '{to:"/agents/all",state:', min: 1, why: "in the collapsed rail the core's agent list has no menu and is found by its See all agents link" },
  { id: "slot-sidebar", files: BUNDLE, literal: 'slotTypes:["sidebar"]', min: 1, why: "the Studio Build group and Team roster render in the sidebar slot" },
  { id: "slot-sidebar-panel", files: BUNDLE, literal: 'slotTypes:["sidebarPanel"]', min: 1, why: "the Workspace link renders in the sidebar panel slot" },
  { id: "slot-dashboard-widget", files: BUNDLE, literal: 'slotTypes:["dashboardWidget"]', min: 1, why: "the Studio Home renders in the dashboard widget slot" },
  { id: "dashboard-live-runs-heading", files: BUNDLE, literal: 'className:"mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground",children:', min: 1, why: "the stock live-runs panel is found by its heading" },
  { id: "plugin-page-back-link", files: BUNDLE, literal: '{className:"h-4 w-4 mr-1"}),"Back"]', min: 1, why: "KyoubeAI's plugin pages drop the host's Back link (a link to /dashboard above the page)" },
  { id: "agent-page-content", files: BUNDLE, literal: '"agent-settings-content ', min: 1, why: "the core agent page is recognised by its agent-settings-content wrapper, whose header holds the name and avatar" },
  { id: "agent-page-view-class", files: BUNDLE, literal: "`agent-settings-${", min: 1, why: "the wrapper also carries agent-settings-<view>; the overview's sections are found by agent-settings-overview" },
  { id: "agent-avatar-label", files: BUNDLE, literal: "} avatar`", min: 1, why: "the agent's character is painted over the header avatar, found by its aria-label \"<name> avatar\"" },
  { id: "toast-viewport", files: BUNDLE, literal: '"aria-live":"polite","aria-atomic":"false",className:"pointer-events-none fixed bottom-3 left-3', min: 1, why: "the phone toast cap targets the core's toast viewport (an aside with these attributes)" },
  // The core keeps the newest toast first (ui/src/context/ToastContext.tsx, `[nextToast, ...withoutCurrent]`),
  // and this column-reverse list shows it at the bottom, so :nth-child(n+3) are the older ones.
  { id: "toast-list", files: BUNDLE, literal: 'className:"flex w-full flex-col-reverse gap-2"', min: 1, why: "the phone toast cap hides all but the first two items of this list" },
  { id: "theme-boot-script", files: ["ui/dist/index.html"], literal: 'const key = "paperclip.theme";', min: 1, why: "the dark-by-default boot script" },
];

/**
 * Each entry: the literal that opens the section in the Sidebar component,
 * the literal that ends it, the routes expected between them, and whether
 * the skin hides the section (exact match required) or only a few of its
 * links (listed routes must still be present; additions are reported).
 */
export const SECTIONS = [
  {
    id: "top",
    start: '"New Task"',
    end: 'label:"Work",collapsible',
    expected: ["/search", "/dashboard", "/inbox", "/chats", "/decisions", "/status", "/board-chat"],
    mode: "contains",
  },
  {
    id: "work",
    start: 'label:"Work",collapsible',
    end: 'slotTypes:["sidebar"]',
    // /chats (2026.1023): with agent chat on, the streamlined shell moves Chat from the top group into Work.
    expected: ["/chats", "/issues", "/projects", "/routines", "/artifacts", "/cases", "/pipelines", "/goals", "/workspaces"],
    mode: "contains",
  },
  {
    // The streamlined shell's Org section. It ends where the component's
    // legacy branch begins (the Organization section an instance that opts
    // out of the streamlined shell still gets); when upstream deletes that
    // branch this entry reports "not found", which is the cue to pick the
    // next literal after the Org section instead.
    id: "org",
    start: 'label:"Org",collapsible',
    end: 'label:"Organization",collapsible',
    // Every one of these must have a card on the Studio Workspace page
    // (plugins/kyoube-studio/src/ui/links.ts, WORKSPACE_GROUPS).
    expected: ["/agents", "/skills", "/apps", "/activity"],
    mode: "exact",
  },
];
