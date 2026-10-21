import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import type { AskLevel } from "../ask-levels.js";
import type { TeamSnapshot } from "../model.js";
import type { AgentProfile, ProfileResult, ProfileTask } from "../profile.js";
import { BoardApiError, assignTask, setAgentOnDuty } from "./board-api.js";
import { Icon } from "./icons.js";
import { Avatar, useCompanyParams, usePolledData } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { timeAgo } from "./time.js";

const PROFILE_POLL_MS = 15_000;

/** `/BAP/team/ai-manager/tasks` → { ref: "ai-manager", view: "tasks" }; `/BAP/team` → { ref: null }. */
export function parseTeamPath(pathname: string): { ref: string | null; view: "overview" | "tasks" } {
  const parts = pathname.split("/").filter(Boolean);
  const at = parts.indexOf("team");
  const ref = at === -1 ? null : parts[at + 1] ? decodeURIComponent(parts[at + 1]!) : null;
  const view = at !== -1 && parts[at + 2] === "tasks" ? "tasks" : "overview";
  return { ref, view };
}

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_ICON_CLASS: Record<string, string> = { in_progress: "prog", in_review: "rev", blocked: "blk", todo: "todo", backlog: "todo", done: "done", cancelled: "gone" };

function TaskRow({ task }: { task: ProfileTask }) {
  const navigation = useHostNavigation();
  const when = task.at ? (task.status === "done" ? `done ${timeAgo(task.at)}` : timeAgo(task.at)) : "";
  return (
    <a {...navigation.linkProps(task.href)} className="ks-need">
      <span className="ks-sti" data-s={STATUS_ICON_CLASS[task.status] ?? "todo"} aria-hidden="true" />
      <span className="ks-text">
        <b>{task.title}</b>
        <span><span className="ks-id">{task.identifier}</span>{task.identifier ? " · " : ""}{task.status === "done" ? when : `${task.statusLabel.toLowerCase()}${when ? ` · ${when}` : ""}`}</span>
      </span>
      {task.action ? <span className="ks-btn" data-tone={task.action === "Review" ? "accent" : undefined}>{task.action}</span> : null}
    </a>
  );
}

function WorkingNow({ profile, onAssign }: { profile: AgentProfile; onAssign: () => void }) {
  const navigation = useHostNavigation();
  const { agent, state, current, waitingOn } = profile;
  if (state === "working" && current) {
    return (
      <section className="ks-panel ks-now" aria-label="Working now">
        <div className="ks-now-top"><span className="ks-state" data-state="working"><i />Working now</span><span className="ks-id">{current.task.identifier}</span></div>
        <a {...navigation.linkProps(current.task.href)} className="ks-now-title">{current.task.title}</a>
        <div className="ks-bar" aria-hidden="true"><i /></div>
        {current.notes.length > 0 ? (
          <ul className="ks-log">
            {current.notes.map((note, index) => (
              <li key={index} data-latest={index === current.notes.length - 1 || undefined}>
                <Icon name={index === current.notes.length - 1 ? "pen" : "check"} size={14} />
                <span>{note.text}</span>
              </li>
            ))}
          </ul>
        ) : <p className="ks-now-note">Started {timeAgo(current.task.at) || "just now"}. Its notes on the task appear here as it works.</p>}
      </section>
    );
  }
  if (state === "waiting" && waitingOn) {
    return (
      <section className="ks-panel ks-now" aria-label="Waiting on you">
        <div className="ks-now-top"><span className="ks-state" data-state="waiting"><i />Waiting on you</span><span className="ks-id">{waitingOn.identifier}</span></div>
        <a {...navigation.linkProps(waitingOn.href)} className="ks-now-title">{waitingOn.title}</a>
        <div className="ks-now-actions"><a {...navigation.linkProps(waitingOn.href)} className="ks-btn" data-tone="accent">{waitingOn.action ?? "Open"}</a></div>
      </section>
    );
  }
  if (state === "attention") {
    return (
      <section className="ks-panel ks-now" aria-label="Needs attention">
        <div className="ks-now-top"><span className="ks-state" data-state="attention"><i />Stopped</span></div>
        <p className="ks-now-title">{agent.errorReason ? `Its last run failed: ${agent.errorReason.replace(/`/g, "")}` : "Its last run failed."}</p>
        <div className="ks-now-actions"><a {...navigation.linkProps(profile.links.runs)} className="ks-btn">See runs</a></div>
      </section>
    );
  }
  if (state === "paused") {
    return (
      <section className="ks-panel ks-now" aria-label="Off duty">
        <div className="ks-now-top"><span className="ks-state"><i />{agent.status === "pending_approval" ? "Awaiting approval" : "Off duty"}</span></div>
        <p className="ks-now-note">{agent.status === "pending_approval" ? "It starts working once the board approves it." : `Paused${agent.pausedAt ? ` ${timeAgo(agent.pausedAt)}` : ""}. Switch it on duty to let it take work again.`}</p>
      </section>
    );
  }
  return (
    <section className="ks-panel ks-now" aria-label="Not working">
      <div className="ks-now-top"><span className="ks-state"><i />Idle</span></div>
      <p className="ks-now-note">Not working on anything right now{agent.lastActiveAt ? `. Last active ${timeAgo(agent.lastActiveAt)}` : ""}.</p>
      <div className="ks-now-actions"><button type="button" className="ks-btn" data-tone="accent" onClick={onAssign}>Assign task</button></div>
    </section>
  );
}

function AssignForm({ profile, onDone }: { profile: AgentProfile; onDone: () => void }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const toast = usePluginToast();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host.companyId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const issue = await assignTask(host.companyId, profile.agent.id, title, details);
      const ref = issue.identifier || issue.id;
      toast({ title: `Assigned ${issue.identifier ?? "the task"} to ${profile.agent.name}`, tone: "success", action: { label: "Open", href: navigation.resolveHref(`/issues/${encodeURIComponent(ref)}`) } });
      onDone();
    } catch (caught) {
      setError(caught instanceof BoardApiError ? caught.message : "The task could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ks-assign" onSubmit={submit}>
      <label htmlFor="ks-assign-title">What should {profile.agent.name} do?</label>
      <input id="ks-assign-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: draft three posts for the launch" autoFocus required maxLength={300} />
      <textarea id="ks-assign-details" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Details, links, and what done looks like (optional)" rows={3} />
      {error ? <p className="ks-assign-error" role="alert">{error}</p> : null}
      <div className="ks-assign-actions">
        <button type="button" className="ks-btn ks-btn-lg" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="ks-btn ks-btn-lg" data-tone="primary" disabled={busy || !title.trim()}>{busy ? "Assigning…" : "Assign task"}</button>
      </div>
    </form>
  );
}

function DutySwitch({ profile, onChanged }: { profile: AgentProfile; onChanged: () => void }) {
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  // What the server just confirmed, shown until the profile's next read agrees,
  // so a second click never repeats the first.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const status = profile.agent.status;
  const actual = status !== "paused";
  const onDuty = confirmed ?? actual;
  const locked = status === "pending_approval" || status === "terminated";
  useEffect(() => {
    if (confirmed === null) return;
    if (confirmed === actual) { setConfirmed(null); return; }
    const timer = setTimeout(() => setConfirmed(null), 20_000);
    return () => clearTimeout(timer);
  }, [confirmed, actual]);
  const flip = async () => {
    setBusy(true);
    try {
      await setAgentOnDuty(profile.agent.id, !onDuty);
      setConfirmed(!onDuty);
      toast({ title: onDuty ? `${profile.agent.name} is off duty` : `${profile.agent.name} is back on duty`, body: onDuty ? "It stops its current run and takes no new work until you switch it back." : undefined, tone: "success" });
      onChanged();
    } catch (caught) {
      toast({ title: onDuty ? "Could not pause the agent" : "Could not resume the agent", body: caught instanceof Error ? caught.message : undefined, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" role="switch" aria-checked={onDuty} className="ks-switch" disabled={busy || locked} onClick={flip} title={locked ? "Available once the agent is approved" : undefined}>
      <i aria-hidden="true" />{onDuty ? "On duty" : "Off duty"}
    </button>
  );
}

const ASK_OPTIONS: Array<{ level: AskLevel; label: string }> = [
  { level: "none", label: "No agents" },
  { level: "line", label: "Its line" },
  { level: "any", label: "Any agent" },
];

const ASK_TOASTS: Record<AskLevel, (name: string) => string> = {
  none: (name) => `${name} can no longer ask other agents`,
  line: (name) => `${name} can now ask its line`,
  any: (name) => `${name} can now ask any agent`,
};

/**
 * Which agents this agent may send a question card to when it is stuck
 * (docs/agent-rules.md, "Agent questions"). The task stays with it; the core
 * refuses a question to anyone else. "Its line" is the managers above it and
 * the agents below it.
 */
function AskLevelControl({ profile, access, onChanged }: { profile: AgentProfile; access: NonNullable<AgentProfile["access"]>; onChanged: () => void }) {
  const toast = usePluginToast();
  const change = usePluginAction("agent.change-ask-level");
  const [busy, setBusy] = useState(false);
  // As on the duty switch: what the server just confirmed, until the next read agrees.
  const [confirmed, setConfirmed] = useState<AskLevel | null>(null);
  const actual = access.askLevel ?? "line";
  const current = confirmed ?? actual;
  const locked = profile.agent.status === "pending_approval" || profile.agent.status === "terminated";
  useEffect(() => {
    if (confirmed === null) return;
    if (confirmed === actual) { setConfirmed(null); return; }
    const timer = setTimeout(() => setConfirmed(null), 20_000);
    return () => clearTimeout(timer);
  }, [confirmed, actual]);
  const choose = async (level: AskLevel) => {
    if (level === current) return;
    setBusy(true);
    try {
      await change({ agentId: profile.agent.id, level });
      setConfirmed(level);
      toast({ title: ASK_TOASTS[level](profile.agent.name), tone: "success" });
      onChanged();
    } catch (caught) {
      toast({ title: "Could not change which agents it may ask", body: caught instanceof Error ? caught.message : undefined, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const why = !access.canManage ? "Only company owners and admins can change this" : locked ? "Available once the agent is approved" : undefined;
  return (
    <div className="ks-perm ks-perm-wide">
      <span className="ks-text"><b>Can ask other agents</b><span>Lets this agent send another agent a question when it is stuck. The task stays with it. Takes effect within a minute.</span></span>
      <div className="ks-seg" role="radiogroup" aria-label="Can ask other agents" title={why}>
        {ASK_OPTIONS.map((option) => (
          <button key={option.level} type="button" role="radio" aria-checked={current === option.level} disabled={busy || locked || !access.canManage} onClick={() => void choose(option.level)}>{option.label}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * agents:configure, which lets an agent change its own and other agents'
 * instructions, skills and settings. The core UI has no control for it.
 */
function ChangeAccess({ profile, access, onChanged }: { profile: AgentProfile; access: NonNullable<AgentProfile["access"]>; onChanged: () => void }) {
  const toast = usePluginToast();
  const change = usePluginAction("agent.change-access");
  const [busy, setBusy] = useState(false);
  // As on the duty switch: what the server just confirmed, until the next read agrees.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const actual = access.canChangeAgents;
  const on = confirmed ?? actual;
  const locked = profile.agent.status === "pending_approval" || profile.agent.status === "terminated";
  useEffect(() => {
    if (confirmed === null) return;
    if (confirmed === actual) { setConfirmed(null); return; }
    const timer = setTimeout(() => setConfirmed(null), 20_000);
    return () => clearTimeout(timer);
  }, [confirmed, actual]);
  const flip = async () => {
    setBusy(true);
    try {
      await change({ agentId: profile.agent.id, on: !on });
      setConfirmed(!on);
      toast({ title: on ? `${profile.agent.name} can no longer change agents` : `${profile.agent.name} can now change agents`, tone: "success" });
      onChanged();
    } catch (caught) {
      toast({ title: "Could not change what the agent may do", body: caught instanceof Error ? caught.message : undefined, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const why = !access.canManage ? "Only company owners and admins can change this" : locked ? "Available once the agent is approved" : undefined;
  return (
    <section className="ks-panel" aria-label="Permissions">
      <div className="ks-panel-head"><b>Permissions</b></div>
      <div className="ks-perm">
        <span className="ks-text"><b>Can change agents</b><span>Edit its own and other agents’ instructions, skills and settings.</span></span>
        <button type="button" role="switch" aria-checked={on} aria-label="Can change agents" className="ks-switch" disabled={busy || locked || !access.canManage} onClick={flip} title={why}><i aria-hidden="true" /></button>
      </div>
      {access.askLevel != null ? <AskLevelControl profile={profile} access={access} onChanged={onChanged} /> : null}
    </section>
  );
}

function Profile({ agentRef, view }: { agentRef: string; view: "overview" | "tasks" }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const params = useMemo(() => ({ companyId: host.companyId, agentRef, userId: host.userId }), [host.companyId, agentRef, host.userId]);
  const result = usePolledData<ProfileResult>("agent", params, PROFILE_POLL_MS);
  const [assigning, setAssigning] = useState(false);
  const data = result.data;
  // Only ever render the agent that was asked for (a poll can still be answering for the previous one).
  const profile = data && data.found && (data.agent.urlKey === agentRef || data.agent.id === agentRef) ? data : null;

  if (!profile) {
    return (
      <div className="ks-profile" data-kyoube-page="team">
        {data && !data.found ? (
          <div className="ks-panel ks-none">This agent does not exist or has been removed. <a {...navigation.linkProps("/team")}>See the team</a></div>
        ) : result.error && !result.loading ? (
          <div className="ks-panel ks-none" role="status">Couldn’t load this agent. Retrying…</div>
        ) : (
          <div className="ks-prof"><span className="ks-skeleton ks-skeleton-avatar" /><div className="ks-prof-name"><span className="ks-skeleton" style={{ width: 280, height: 34 }} /><span className="ks-skeleton" style={{ width: 360 }} /></div></div>
        )}
      </div>
    );
  }

  const { agent, stats } = profile;
  const base = `/team/${encodeURIComponent(agent.urlKey)}`;
  // "Chat" opens the task you would talk to it in: what it is on now, else what waits on you, else its latest.
  const chatTask = profile.current?.task ?? profile.waitingOn ?? profile.tasks.waiting[0] ?? profile.tasks.active[0] ?? profile.tasks.queued[0] ?? profile.recent[0] ?? null;
  const tabs: Array<{ label: string; to: string; current: boolean; count?: number }> = [
    { label: "Overview", to: base, current: view === "overview" },
    { label: "Tasks", to: `${base}/tasks`, current: view === "tasks", count: stats.open },
    { label: "Instructions", to: profile.links.instructions, current: false },
    { label: "Skills", to: profile.links.skills, current: false },
    { label: "Runs", to: profile.links.runs, current: false },
    { label: "Settings", to: profile.links.settings, current: false },
  ];
  const refresh = () => { setAssigning(false); result.refresh(); };

  return (
    <div className="ks-profile" data-kyoube-page="team" data-agent={agent.urlKey}>
      <header className="ks-prof">
        <Avatar icon={agent.icon} name={agent.name} size={72} state={profile.state} />
        <div className="ks-prof-name">
          <h1>{agent.name}</h1>
          <div className="ks-prof-meta">
            <span>{agent.title ?? agent.roleLabel}</span>
            {profile.reportsTo ? <span><Icon name="org" size={14} />Reports to <a {...navigation.linkProps(profile.reportsTo.href)}>{profile.reportsTo.name}</a></span> : null}
            {agent.harness ? <span><Icon name="cpu" size={14} />{agent.harness}</span> : null}
          </div>
        </div>
        <div className="ks-prof-actions">
          <DutySwitch profile={profile} onChanged={refresh} />
          {chatTask ? <a {...navigation.linkProps(chatTask.href)} className="ks-btn ks-btn-lg" title={`Open ${chatTask.identifier} to talk to ${agent.name}`}><Icon name="chat" size={15} />Chat</a> : null}
          <button type="button" className="ks-btn ks-btn-lg" data-tone="primary" onClick={() => setAssigning((open) => !open)} aria-expanded={assigning}><Icon name="plus" size={15} />Assign task</button>
        </div>
      </header>

      {assigning ? <AssignForm profile={profile} onDone={refresh} /> : null}
      {agent.status === "pending_approval" ? (
        <div className="ks-banner" data-tone="waiting">This agent is waiting for board approval before it can run. <a {...navigation.linkProps("/approvals/pending")}>Review approvals</a></div>
      ) : null}

      <nav className="ks-tabs" aria-label={`${agent.name} sections`}>
        {tabs.map((tab) => (
          <a key={tab.label} {...navigation.linkProps(tab.to)} aria-current={tab.current ? "page" : undefined}>
            {tab.label}{tab.count ? <span className="ks-tab-count">{tab.count}</span> : null}
          </a>
        ))}
      </nav>

      {view === "tasks" ? (
        <div className="ks-tasklists">
          {([
            ["Working on", profile.tasks.active],
            ["Waiting on you", profile.tasks.waiting],
            ["Up next", profile.tasks.queued],
            ["Done recently", profile.tasks.done],
          ] as const).map(([title, list]) => (
            <section key={title} className="ks-panel" aria-label={title}>
              <div className="ks-panel-head"><b>{title}</b><span>{list.length}</span></div>
              {list.length === 0 ? <div className="ks-none">Nothing here.</div> : list.map((t) => <TaskRow key={t.id} task={t} />)}
            </section>
          ))}
        </div>
      ) : (
        <div className="ks-pgrid">
          <div className="ks-pcol">
            <WorkingNow profile={profile} onAssign={() => setAssigning(true)} />
            <section className="ks-panel" aria-label="Recent work">
              <div className="ks-panel-head"><b>Recent work</b><a {...navigation.linkProps(`${base}/tasks`)}>All tasks</a></div>
              {profile.recent.length === 0 ? <div className="ks-none">No tasks yet. Assign one to get it started.</div> : profile.recent.map((t) => <TaskRow key={t.id} task={t} />)}
            </section>
          </div>
          <div className="ks-pcol">
            <section className="ks-panel" aria-label="This week">
              <div className="ks-stats">
                <div><b>{stats.doneThisWeek}</b><span>Tasks done this week</span></div>
                <div><b>{stats.open}</b><span>Open tasks</span></div>
                <div><b>{money(stats.spentMonthlyCents)}</b><span>{stats.budgetMonthlyCents > 0 ? `Spent of ${money(stats.budgetMonthlyCents)} this month` : "Spent this month"}</span></div>
              </div>
            </section>
            <section className="ks-panel" aria-label="Skills">
              <div className="ks-panel-head"><b>Skills</b><a {...navigation.linkProps(profile.links.skills)}>Manage</a></div>
              {profile.skills.length === 0 ? <div className="ks-none">No extra skills yet.</div> : <div className="ks-chips">{profile.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>}
            </section>
            {profile.access ? <ChangeAccess profile={profile} access={profile.access} onChanged={refresh} /> : null}
            <section className="ks-panel" aria-label="Works with">
              <div className="ks-panel-head"><b>Works with</b></div>
              {profile.worksWith.length === 0 ? <div className="ks-none">It works on its own so far.</div> : profile.worksWith.map((other) => (
                <a key={other.id} {...navigation.linkProps(other.href)} className="ks-need">
                  <Avatar icon={other.icon} name={other.name} size={30} />
                  <span className="ks-text"><b>{other.name}</b><span>{other.relation}</span></span>
                </a>
              ))}
            </section>
            {agent.about ? (
              <section className="ks-panel" aria-label="About">
                <div className="ks-panel-head"><b>About</b></div>
                <p className="ks-about">{agent.about}</p>
              </section>
            ) : null}
          </div>
        </div>
      )}
      <p className="ks-classic"><a {...navigation.linkProps(profile.links.classic)}>Open the core's own agent overview</a></p>
    </div>
  );
}

const STATE_WORD = { working: "Working", waiting: "Waiting on you", attention: "Needs attention", paused: "Paused", idle: "Idle" } as const;

function TeamIndex() {
  const navigation = useHostNavigation();
  const team = usePolledData<TeamSnapshot>("team", useCompanyParams(), PROFILE_POLL_MS);
  const members = team.data?.members ?? [];
  return (
    <div className="ks-ws" data-kyoube-page="team">
      <header className="ks-ws-head"><h1>Team</h1><p>Everyone who works here, and what they are doing now.</p></header>
      <div className="ks-cards">
        {members.map((member) => (
          <a key={member.id} {...navigation.linkProps(member.href)} className="ks-card ks-member">
            <Avatar icon={member.icon} name={member.name} size={48} state={member.state} />
            <span className="ks-card-title">{member.name}</span>
            <p>{member.title ?? ""}</p>
            <span className="ks-state" data-state={member.state}><i />{STATE_WORD[member.state]}</span>
          </a>
        ))}
        <a {...navigation.linkProps("/agents/new")} className="ks-card ks-member ks-hire">
          <span className="ks-hire-ph" aria-hidden="true"><Icon name="userPlus" size={18} /></span>
          <span className="ks-card-title">Hire an agent</span>
          <p>Pick a role and a model.</p>
        </a>
      </div>
    </div>
  );
}

/** `/<company>/team` (the team) and `/<company>/team/<agent>[/tasks]` (an agent's profile). */
export function AgentProfilePage(_props: PluginPageProps) {
  ensureStyles();
  const location = useHostLocation();
  const { ref, view } = parseTeamPath(location.pathname);
  return ref ? <Profile key={ref} agentRef={ref} view={view} /> : <TeamIndex />;
}

