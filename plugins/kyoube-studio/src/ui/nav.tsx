import { useEffect, useMemo, type ReactNode } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { summarizeTeam, type TeamMember, type TeamSnapshot } from "../model.js";
import { WORKSPACE_ROUTE } from "../manifest.js";
import { agentRedirectTarget, coreAgentPage, coreAvatarCss } from "./agent-route.js";
import { useTeamData } from "./board-data.js";
import { Icon } from "./icons.js";
import { Avatar, SidebarLink, isActivePath } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { timeAgo } from "./time.js";

/** Agents listed before "All agents"; the rest are one click away. */
export const TEAM_LIMIT = 8;
const TEAM_POLL_MS = 15_000;
const AVATAR_STYLE_ID = "kyoube-studio-agent-avatar";

/**
 * The roster is mounted on every page, so it also looks after the core's
 * agent page (see agent-route.ts): its default view opens the Studio profile,
 * and its other tabs get the agent's character in the header.
 */
function useCoreAgentPages(team: TeamSnapshot | null) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  useEffect(() => {
    const root = document.documentElement;
    const target = agentRedirectTarget(location.pathname, location.search);
    if (!target) {
      root.removeAttribute("data-kyoube-redirecting");
      return;
    }
    // Hide the core page for the moment the redirect takes (styles.ts), and never for longer than 1.5 s.
    root.setAttribute("data-kyoube-redirecting", "");
    navigation.navigate(target, { replace: true });
    const timer = setTimeout(() => root.removeAttribute("data-kyoube-redirecting"), 1500);
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);
  useEffect(() => {
    const page = coreAgentPage(location.pathname);
    const profilePath = page ? `/team/${encodeURIComponent(page.ref)}` : null;
    const member = page ? team?.members.find((m) => m.href === profilePath || m.id === page.ref) : undefined;
    const css = member ? coreAvatarCss(member) : "";
    let style = document.getElementById(AVATAR_STYLE_ID);
    if (!style && css) {
      style = document.createElement("style");
      style.id = AVATAR_STYLE_ID;
      document.head.appendChild(style);
    }
    if (style) style.textContent = css;
  }, [location.pathname, team]);
  useEffect(() => () => {
    document.getElementById(AVATAR_STYLE_ID)?.remove();
    document.documentElement.removeAttribute("data-kyoube-redirecting");
  }, []);
}

function SectionLabel({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <>
      <div className="ks-label">
        <span className="ks-label-text">{text}</span>
        {children ? <span className="ks-label-actions">{children}</span> : null}
      </div>
      <div className="ks-divider" aria-hidden="true" />
    </>
  );
}

/** The "Build" label above KyoubeAI's Data and Apps links (sidebar order 10). */
export function StudioBuildLabel(_props: PluginSidebarProps) {
  ensureStyles();
  return (
    <div data-kyoube-studio="build">
      <SectionLabel text="Build" />
    </div>
  );
}

/** Routines, under Build (sidebar order 40); the theme hides the core's own Routines link. */
export function StudioRoutinesLink(_props: PluginSidebarProps) {
  return <SidebarLink to="/routines" icon="routines" label="Routines" navId="routines" />;
}

export function memberDetail(member: TeamMember, now: number = Date.now()): string {
  if (member.state === "idle" && member.detail === "Idle" && member.lastActiveAt) return `Idle · ${timeAgo(member.lastActiveAt, now)}`;
  return member.detail;
}

/** The team roster (sidebar order 50): every agent with a face, a live status dot and what they are doing. */
export function StudioTeam(_props: PluginSidebarProps) {
  ensureStyles();
  // boot.js flags the page before this loads; keep the flag while the roster
  // is here, and drop it if the roster goes (plugin disabled mid-session), so
  // the theme's gated rules let go of the page too.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-kyoube-shell", "studio");
    return () => root.removeAttribute("data-kyoube-shell");
  }, []);
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const source = useTeamData(TEAM_POLL_MS);
  // Each agent's state comes from the tasks the signed-in person may see.
  const team = useMemo(() => (source.agents && source.board ? summarizeTeam(source.agents, source.board.issues) : null), [source.agents, source.board]);
  useCoreAgentPages(team);
  const members = team?.members ?? [];
  const total = team?.total ?? 0;
  return (
    <div data-kyoube-studio="team" className="ks-team">
      <SectionLabel text={total > 0 ? `Team · ${total}` : "Team"}>
        <a {...navigation.linkProps("/agents/all")} className="ks-icon-btn" title="All agents and the org chart" aria-label="All agents and the org chart"><Icon name="org" size={14} /></a>
        <a {...navigation.linkProps("/agents/new")} className="ks-icon-btn" title="Hire an agent" aria-label="Hire an agent"><Icon name="plus" size={14} /></a>
      </SectionLabel>
      {!team && !source.error ? (
        <><div className="ks-skeleton" /><div className="ks-skeleton" /></>
      ) : !team ? (
        // The first reads failed (worker restarting, host busy). The poll retries; say so rather than "no agents".
        <p className="ks-empty" role="status">Couldn’t load the team. Retrying…</p>
      ) : members.length === 0 ? (
        <p className="ks-empty">No agents yet. <a {...navigation.linkProps("/agents/new")}>Hire your first</a></p>
      ) : (
        members.slice(0, TEAM_LIMIT).map((member) => {
          const props = navigation.linkProps(member.href);
          const detail = memberDetail(member);
          // The profile, or one of the agent's core tabs (Instructions, Settings, …).
          const active = isActivePath(location.pathname, props.href) || isActivePath(location.pathname, navigation.resolveHref(member.href.replace(/^\/team\//, "/agents/")));
          return (
            <a
              key={member.id}
              {...props}
              className="ks-row"
              aria-current={active ? "page" : undefined}
              title={`${member.name} · ${detail}`}
            >
              <Avatar icon={member.icon} name={member.name} size={26} state={member.state} />
              <span className="ks-who">
                <b>{member.name}</b>
                <span data-state={member.state}>{detail}</span>
              </span>
            </a>
          );
        })
      )}
      {total > TEAM_LIMIT ? (
        <a {...navigation.linkProps("/agents/all")} className="ks-more"><Icon name="users" size={14} /><span>All agents ({total})</span></a>
      ) : null}
    </div>
  );
}

/** The Workspace link at the bottom of the sidebar (sidebarPanel slot). */
export function StudioFooter(_props: PluginSidebarProps) {
  ensureStyles();
  return (
    <div data-kyoube-studio="footer">
      <SidebarLink to={`/${WORKSPACE_ROUTE}`} icon="gear" label="Workspace" navId="workspace" />
    </div>
  );
}
