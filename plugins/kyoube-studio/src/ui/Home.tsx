import { useMemo, useState } from "react";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { buildHome, type NeedItem, type NeedKind, type UpdateItem } from "../model.js";
import { useTeamData } from "./board-data.js";
import { Icon, type IconName } from "./icons.js";
import { memberDetail } from "./nav.js";
import { Avatar, useCompanyNavigation } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { greeting, longDate, plural, timeAgo } from "./time.js";

const HOME_POLL_MS = 30_000;
const TEAM_ON_HOME = 5;
const STATE_WORD = { working: "Working", waiting: "Waiting", attention: "Needs attention", paused: "Paused", idle: "Idle" } as const;

const NEED_ICON: Record<NeedKind, IconName> = { approval: "shield", review: "file", blocked: "alert", agent: "alert" };
const UPDATE_ICON: Record<UpdateItem["tone"], IconName> = { teal: "check", sky: "tasks", violet: "file", amber: "alert", rose: "x" };

function dismissKey(companyId: string | null): string {
  return `kyoube.studio.getStarted.dismissed:${companyId ?? "none"}`;
}

function readDismissed(companyId: string | null): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(dismissKey(companyId)) === "1"; } catch { return false; }
}

/** "3 things need you." / "Nothing needs you right now." */
export function headline(needsTotal: number): { lead: string; count: string | null; tail: string } {
  if (needsTotal === 0) return { lead: "Nothing needs you", count: null, tail: " right now." };
  return { lead: "", count: needsTotal === 1 ? "1 thing" : `${needsTotal} things`, tail: " need you." };
}

function needMeta(item: NeedItem): string {
  return [item.identifier, item.agentName, timeAgo(item.at)].filter(Boolean).join(" · ");
}

export function StudioHome(_props: PluginWidgetProps) {
  ensureStyles();
  const host = useHostContext();
  const navigation = useCompanyNavigation();
  const source = useTeamData(HOME_POLL_MS);
  const [dismissed, setDismissed] = useState(() => readDismissed(host.companyId));
  // What needs you and the week, from the tasks and approvals the signed-in person may see.
  const data = useMemo(
    () => (source.agents && source.board ? buildHome(source.agents, source.board.issues, source.board.approvals, Date.now()) : null),
    [source.agents, source.board],
  );
  const now = new Date();

  if (!data) {
    return (
      <div className="ks-home" data-kyoube-studio="home">
        <div className="ks-hello"><div><h2>{greeting(now)}.</h2><p>{longDate(now)}{source.error ? " · couldn’t load your team’s news yet, retrying…" : ""}</p></div></div>
      </div>
    );
  }

  const title = headline(data.needsTotal);
  const steps = data.steps;
  const showSteps = !dismissed && !(steps.hireAgent && steps.giveTask && steps.seenThrough);
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissKey(host.companyId), "1"); } catch { /* private window: the strip just comes back next time */ }
  };
  const team = data.team.members.slice(0, TEAM_ON_HOME);

  return (
    <div className="ks-home" data-kyoube-studio="home">
      <div className="ks-hello">
        <div>
          <h2>{greeting(now)}. {title.lead}{title.count ? <em>{title.count}</em> : null}{title.tail}</h2>
          <p>{longDate(now)} · your team finished <b>{plural(data.doneThisWeek, "task")}</b> this week</p>
        </div>
      </div>

      {showSteps ? (
        <div className="ks-strip" aria-label="Getting started">
          <button type="button" className="ks-icon-btn ks-strip-close" aria-label="Hide getting started" onClick={dismiss}><Icon name="x" size={14} /></button>
          <a {...navigation.linkProps("/agents/new")} className="ks-step" data-done={steps.hireAgent}>
            <span className="ks-check" data-done={steps.hireAgent}>{steps.hireAgent ? <Icon name="check" size={12} /> : "1"}</span>
            <span className="ks-step-text"><b>Hire an agent</b><span>Pick a role and a model</span></span>
          </a>
          <span className="ks-arrow" aria-hidden="true"><Icon name="arrow" size={18} /></span>
          <a {...navigation.linkProps("/issues")} className="ks-step" data-done={steps.giveTask}>
            <span className="ks-check" data-done={steps.giveTask}>{steps.giveTask ? <Icon name="check" size={12} /> : "2"}</span>
            <span className="ks-step-text"><b>Give it a task</b><span>Plain words are enough</span></span>
          </a>
          <span className="ks-arrow" aria-hidden="true"><Icon name="arrow" size={18} /></span>
          <a {...navigation.linkProps("/issues")} className="ks-step" data-done={steps.seenThrough}>
            <span className="ks-check" data-done={steps.seenThrough}>{steps.seenThrough ? <Icon name="check" size={12} /> : "3"}</span>
            <span className="ks-step-text"><b>See it through</b><span>It finishes the task and asks you only when it needs you</span></span>
            {team.length > 0 ? (
              <span className="ks-stack" aria-hidden="true">
                {team.slice(0, 3).map((member) => <Avatar key={member.id} icon={member.icon} name={member.name} size={30} />)}
              </span>
            ) : null}
          </a>
        </div>
      ) : null}

      <div className="ks-grid">
        <section className="ks-panel" aria-label="Needs you">
          <div className="ks-panel-head"><b>Needs you</b><a {...navigation.linkProps("/inbox")}>Open Inbox</a></div>
          {data.needs.length === 0 ? (
            <div className="ks-none"><span className="ks-check"><Icon name="check" size={12} /></span>You’re all caught up.</div>
          ) : (
            data.needs.map((item) => (
              <a key={`${item.kind}:${item.id}`} {...navigation.linkProps(item.href)} className="ks-need">
                <span className="ks-kind" data-kind={item.kind}><Icon name={NEED_ICON[item.kind]} size={14} /></span>
                <span className="ks-text"><b>{item.title}</b><span>{needMeta(item)}</span></span>
                <span className="ks-btn" data-tone={item.kind === "review" || item.kind === "approval" ? "accent" : undefined}>{item.action}</span>
              </a>
            ))
          )}
          {source.board?.approvalsHidden ? <div className="ks-none">Approvals are not shown to you.</div> : null}
        </section>

        <section className="ks-panel" aria-label="Your team right now">
          <div className="ks-panel-head">
            <b>Your team right now</b>
            <span>{[data.team.working > 0 ? `${data.team.working} working` : null, data.team.waiting > 0 ? `${data.team.waiting} waiting` : null].filter(Boolean).join(" · ") || plural(data.team.total, "agent")}</span>
          </div>
          {team.length === 0 ? (
            <div className="ks-none">No agents yet. <a {...navigation.linkProps("/agents/new")}>Hire your first</a></div>
          ) : (
            team.map((member) => (
              <a key={member.id} {...navigation.linkProps(member.href)} className="ks-need">
                <Avatar icon={member.icon} name={member.name} size={30} />
                <span className="ks-text"><b>{member.name}</b><span>{member.task ? `${member.task.identifier} · ${member.task.title}` : member.title ?? memberDetail(member)}</span></span>
                <span className="ks-state" data-state={member.state}><i />{STATE_WORD[member.state]}</span>
              </a>
            ))
          )}
        </section>
      </div>

      {data.updates.length > 0 ? (
        <section className="ks-panel ks-updates" aria-label="Latest updates">
          <div className="ks-panel-head" style={{ padding: "0 0 12px", border: 0 }}><b>Latest updates</b><a {...navigation.linkProps("/issues")}>All tasks</a></div>
          <div className="ks-track">
            {data.updates.map((update) => (
              <a key={update.id} {...navigation.linkProps(update.href)} className="ks-event" title={update.title}>
                <span className="ks-node" data-tone={update.tone}><Icon name={UPDATE_ICON[update.tone]} size={13} /></span>
                <span className="ks-event-text">
                  <b>{update.label}: {update.identifier || update.title}</b>
                  <span>{[update.agentName, timeAgo(update.at)].filter(Boolean).join(" · ")}</span>
                </span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

