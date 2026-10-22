import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { IssueLike } from "../model.js";
import { useBoardSnapshot } from "./board-data.js";
import { Icon } from "./icons.js";
import { WORKSPACE_GROUPS, type WorkspaceCard } from "./links.js";
import { useCompanyParams } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { plural } from "./time.js";

export interface WorkspaceFigures {
  agents: number;
  people: number;
  projects: number;
  /** Counted here from the tasks the signed-in person may see; null until they are in. */
  openTasks: number | null;
  isAdmin: boolean;
}

/** Tasks still open: not hidden, not done and not cancelled. */
export function openTasks(issues: IssueLike[]): number {
  return issues.filter((issue) => issue.hiddenAt == null && !["done", "cancelled"].includes(issue.status)).length;
}

export function cardMeta(card: WorkspaceCard, figures: WorkspaceFigures | null): string | null {
  if (!card.meta || !figures) return null;
  switch (card.meta) {
    case "agents": return plural(figures.agents, "agent");
    case "people": return plural(figures.people, "person", "people");
    case "projects": return plural(figures.projects, "project");
    case "openTasks": return figures.openTasks == null ? null : `${figures.openTasks} open`;
  }
}

/** The Workspace page: one place for everything the Studio sidebar keeps out of the way. */
export function WorkspacePage(_props: PluginPageProps) {
  ensureStyles();
  const navigation = useHostNavigation();
  const host = useHostContext();
  const figures = usePluginData<Omit<WorkspaceFigures, "openTasks">>("workspace", useCompanyParams());
  // Read once, without a poll; a read the roster made in the last few seconds is reused.
  const board = useBoardSnapshot(host.companyId ?? "", 0);
  const data: WorkspaceFigures | null = figures.data ? { ...figures.data, openTasks: board.data ? openTasks(board.data.issues) : null } : null;
  return (
    <div className="ks-ws" data-kyoube-studio="workspace" data-kyoube-page="workspace">
      <header className="ks-ws-head">
        <h1>Workspace</h1>
        <p>Everything for running your company that you don’t need every day.</p>
      </header>
      {WORKSPACE_GROUPS.map((group) => {
        const cards = group.cards.filter((card) => !card.adminOnly || data?.isAdmin);
        if (cards.length === 0) return null;
        return (
          <section key={group.title} className="ks-ws-group">
            <h2>{group.title}</h2>
            <div className="ks-cards">
              {cards.map((card) => {
                const meta = cardMeta(card, data);
                return (
                  <a key={card.id} {...navigation.linkProps(card.to)} className="ks-card" data-card={card.id}>
                    <span className="ks-card-title"><span className="ks-tile" data-tone={card.tone}><Icon name={card.icon} size={15} /></span>{card.title}</span>
                    <p>{card.description}</p>
                    {meta ? <span className="ks-card-meta">{meta}</span> : null}
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
