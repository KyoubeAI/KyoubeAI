import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useHostContext, useHostLocation, useHostNavigation, usePluginData, type HostNavigation } from "@paperclipai/plugin-sdk/ui";
import { characterFor } from "../characters.js";
import type { AgentState } from "../model.js";
import { Icon, type IconName } from "./icons.js";

/** Calls `tick` every `intervalMs` (never at 0 or less), skipping while the tab is hidden. */
export function usePoll(tick: () => void, intervalMs: number): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      latest.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/**
 * `usePluginData` with a poll, keeping the last good answer on screen while a
 * refresh is in flight (the hook reports `data: null` during it) and skipping
 * polls while the tab is hidden.
 */
export function usePolledData<T>(key: string, params: Record<string, unknown>, intervalMs: number) {
  const result = usePluginData<T>(key, params);
  // The last good answer is kept per request: moving to another agent must
  // not show the previous one's data while the new read is in flight.
  const requestKey = `${key}:${JSON.stringify(params)}`;
  const last = useRef<{ key: string; data: T | null }>({ key: requestKey, data: null });
  if (last.current.key !== requestKey) last.current = { key: requestKey, data: null };
  if (result.data) last.current.data = result.data;
  const refresh = useRef(result.refresh);
  refresh.current = result.refresh;
  usePoll(() => refresh.current(), intervalMs);
  const kept = last.current.data;
  return { data: result.data ?? kept, loading: result.loading && kept === null, error: result.error, refresh: () => refresh.current() };
}

/** The company-scoped params every Studio data call sends, stable across renders. */
export function useCompanyParams(): Record<string, unknown> {
  const host = useHostContext();
  return useMemo(() => ({ companyId: host.companyId, userId: host.userId }), [host.companyId, host.userId]);
}

/**
 * `useHostNavigation()`, with links that keep the company. The core's Dashboard
 * renders its widgets with only `{ companyId }` as context (pages/Dashboard.tsx,
 * core 2026.916), so `companyPrefix` is null there and the host leaves
 * `/team/<agent>` as it is: the core then reads "team" as a company and answers
 * "Organization not found". On a company page the URL's first segment is the
 * company's prefix, so the link gets it from there.
 */
export function useCompanyNavigation(): HostNavigation {
  const navigation = useHostNavigation();
  const host = useHostContext();
  const location = useHostLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const prefix = !host.companyPrefix && segments.length > 1 ? segments[0]! : null;
  return useMemo(() => {
    if (!prefix) return navigation;
    const withPrefix = (to: string) => (to.startsWith("/") && !to.startsWith("//") && !to.startsWith(`/${prefix}/`) ? `/${prefix}${to}` : to);
    return {
      resolveHref: (to) => navigation.resolveHref(withPrefix(to)),
      navigate: (to, options) => navigation.navigate(withPrefix(to), options),
      linkProps: (to, options) => navigation.linkProps(withPrefix(to), options),
    };
  }, [navigation, prefix]);
}

/** True when `href` (a full company-prefixed link) is the current page or a page under it. */
export function isActivePath(pathname: string, href: string | undefined): boolean {
  if (!href) return false;
  const target = href.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const here = pathname.replace(/\/+$/, "");
  return here === target || here.startsWith(`${target}/`);
}

export function Avatar({ icon, name, size, state }: { icon: string | null; name: string; size: number; state?: AgentState }) {
  const character = useMemo(() => characterFor(icon, name), [icon, name]);
  return (
    <span className="ks-avatar" data-tint={character.tint} style={{ width: size, height: size }}>
      <span className="ks-avatar-art" dangerouslySetInnerHTML={{ __html: character.svg }} />
      {state ? <span className="ks-dot" data-state={state} /> : null}
    </span>
  );
}

// The core's own sidebar-row classes (SidebarNavItem), so a Kyoube link sits
// in the sidebar pixel for pixel like the core's. They exist in the core's
// stylesheet because the core renders them itself.
const NAV_BASE = "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors";
const NAV_IDLE = "text-foreground/80 hover:bg-accent/50 hover:text-foreground";
const NAV_ACTIVE = "bg-accent text-foreground";

/** A sidebar link that looks and behaves like the core's, marked for the theme with `data-kyoube-nav`. */
export function SidebarLink({ to, icon, label, navId, trailing }: { to: string; icon: IconName; label: string; navId: string; trailing?: ReactNode }) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const props = navigation.linkProps(to);
  const active = isActivePath(location.pathname, props.href);
  return (
    <a {...props} data-kyoube-nav={navId} aria-current={active ? "page" : undefined} className={`${NAV_BASE} ${active ? NAV_ACTIVE : NAV_IDLE}`}>
      <span className="relative shrink-0"><Icon name={icon} /></span>
      <span className="kyoube-nav-text min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </a>
  );
}
