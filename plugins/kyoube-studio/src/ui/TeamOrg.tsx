import { useMemo, useRef, useState } from "react";
import { useHostContext, useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { summarizeTeam, type TeamMember } from "../model.js";
import { ensureOrgStyles, OrgChart, type OrgAgent, type OrgPanelContext } from "../org/index.js";
import { collapsedKey } from "../org/org-view.js";
import { AssignForm, DutySwitch } from "./agent-actions.js";
import { useTeamData } from "./board-data.js";
import { memberDetail } from "./nav.js";
import { Avatar } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { timeAgo } from "./time.js";

const TEAM_POLL_MS = 15_000;
const STATE_WORD = { working: "Working", waiting: "Waiting on you", attention: "Needs attention", paused: "Paused", idle: "Idle" } as const;

/** A roster member as the chart draws it: the roster's own wording on the card. */
export function toOrgAgent(member: TeamMember, now: number = Date.now()): OrgAgent {
  return {
    id: member.id,
    name: member.name,
    title: member.title,
    icon: member.icon,
    state: member.state,
    detail: memberDetail(member, now),
    task: member.task ? { id: member.task.id, identifier: member.task.identifier, title: member.task.title, href: member.task.href } : null,
    reportsTo: member.reportsTo,
    href: member.href,
  };
}

/** `/<company>/team`: the org chart, with the picked agent's details and actions in its side panel. */
export function TeamOrg() {
  ensureStyles();
  ensureOrgStyles();
  const host = useHostContext();
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const source = useTeamData(TEAM_POLL_MS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const team = useMemo(() => (source.agents && source.board ? summarizeTeam(source.agents, source.board.issues) : null), [source.agents, source.board]);
  const members = team?.members ?? [];
  const orgAgents = useMemo(() => members.map((member) => toOrgAgent(member)), [team]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneTaskIds = useMemo(() => new Set((source.board?.issues ?? []).filter((issue) => issue.status === "done").map((issue) => issue.id)), [source.board]);
  const lastRead = useRef(Date.now());
  useMemo(() => { lastRead.current = Date.now(); }, [source.agents, source.board]);
  const present = new URLSearchParams(location.search).get("present") === "1";
  const storageKey = host.userId && host.companyId ? collapsedKey(host.userId, host.companyId) : null;

  const renderPanel = (agent: OrgAgent, ctx: OrgPanelContext) => {
    const member = members.find((m) => m.id === agent.id);
    const row = source.agents?.find((a) => a.id === agent.id);
    const open = assigning === agent.id;
    return (
      <div className="ko-panel-body">
        <div className="ko-panel-who">
          <Avatar icon={agent.icon} name={agent.name} size={56} state={agent.state} />
          <div>
            <b>{agent.name}</b>
            {agent.title ? <p>{agent.title}</p> : null}
            <span className="ks-state" data-state={agent.state}><i />{STATE_WORD[agent.state]}</span>
          </div>
        </div>
        {agent.task ? <p><a {...navigation.linkProps(agent.task.href)}>{agent.task.identifier} · {agent.task.title}</a></p> : null}
        {member?.lastActiveAt ? <p>Last active {timeAgo(member.lastActiveAt)}</p> : null}
        {ctx.manager ? (
          <div className="ko-panel-links"><span>Reports to</span><button type="button" className="ks-btn" onClick={() => ctx.select(ctx.manager!.id)}>{ctx.manager.name}</button></div>
        ) : null}
        {ctx.reports.length > 0 ? (
          <div className="ko-panel-links">
            <span>Manages</span>
            {ctx.reports.map((report) => <button key={report.id} type="button" className="ks-btn" onClick={() => ctx.select(report.id)}>{report.name}</button>)}
          </div>
        ) : null}
        {row ? <DutySwitch agent={row} onChanged={source.refresh} /> : null}
        <button type="button" className="ks-btn ks-btn-lg" aria-expanded={open} onClick={() => setAssigning(open ? null : agent.id)}>Assign task</button>
        {open && row ? <AssignForm agent={row} idPrefix="ko-assign" onDone={() => { setAssigning(null); source.refresh(); }} /> : null}
        {agent.href ? <a {...navigation.linkProps(agent.href)} className="ks-btn ks-btn-lg">Open profile</a> : null}
      </div>
    );
  };

  return (
    <div className="ks-ws" data-kyoube-page="org">
      <header className="ks-ws-head">
        <h1>Team</h1>
        <div className="ko-head-links">
          <a {...navigation.linkProps("/agents/all")} className="ks-btn">List</a>
          <a {...navigation.linkProps("/agents/new")} className="ks-btn">Hire an agent</a>
        </div>
      </header>
      {!team && !source.error ? (
        <><div className="ks-skeleton" /><div className="ks-skeleton" /></>
      ) : !team ? (
        <p className="ks-empty" role="status">Couldn’t load the team. Retrying…</p>
      ) : members.length === 0 ? (
        <p className="ks-empty">No agents yet. <a {...navigation.linkProps("/agents/new")}>Hire your first</a></p>
      ) : (
        <>
          {source.error ? <p className="ks-empty" role="status">Last updated {timeAgo(new Date(lastRead.current).toISOString())}</p> : null}
          <OrgChart
            key={host.companyId}
            agents={orgAgents}
            doneTaskIds={doneTaskIds}
            selectedId={selectedId}
            onSelect={setSelectedId}
            renderPanel={renderPanel}
            present={present}
            onPresentChange={(next) => navigation.navigate(next ? "/team?present=1" : "/team", { replace: true })}
            storageKey={storageKey}
            fillWindow
            fillKey={Boolean(source.error)}
          />
        </>
      )}
    </div>
  );
}
