import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import type { AskLevel } from "../ask-levels.js";
import { buildProfile, type AgentProfile, type ProfileAgentLike, type ProfileTask } from "../profile.js";
import { useIssueComments, useTeamData } from "./board-data.js";
import { AssignForm, DutySwitch } from "./agent-actions.js";
import { Icon } from "./icons.js";
import { Avatar, usePolledData } from "./shared.js";
import { ensureStyles } from "./styles.js";
import { timeAgo } from "./time.js";
import { TeamOrg } from "./TeamOrg.js";

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
  if (agent.lifecycleState === "preparing" || agent.lifecycleState === "verifying") {
    const checking = agent.lifecycleState === "verifying";
    const failed = Boolean(agent.lifecycleError);
    return (
      <section className="ks-panel ks-now" aria-label="Getting ready">
        <div className="ks-now-top"><span className="ks-state" data-state={failed ? "attention" : undefined}><i />{failed ? (checking ? "Waiting for its AI connection" : "Could not get ready") : (checking ? "Checking its AI connection" : "Getting ready")}</span></div>
        <p className="ks-now-note">{failed
          ? checking
            ? "Its harness could not reach a model, so it takes no work yet. Sign it in or choose a connection on its Runtime tab; KyoubeAI checks again every minute."
            : "Setting it up failed, so it takes no work yet; KyoubeAI checks again every minute."
          : checking
            ? "KyoubeAI is checking that its harness can reach a model. It takes work once the check passes."
            : "It takes work once it is set up."}</p>
        {failed && checking ? <div className="ks-now-actions"><a {...navigation.linkProps(profile.links.settings)} className="ks-btn" data-tone="accent">Open Runtime</a></div> : null}
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

/** The level an arrow key moves to from `current` (wrapping at the ends), or null for a key the group does not use. */
export function askLevelStep(current: AskLevel, key: string): AskLevel | null {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (step === 0) return null;
  const index = ASK_OPTIONS.findIndex((option) => option.level === current);
  return ASK_OPTIONS[(index + step + ASK_OPTIONS.length) % ASK_OPTIONS.length]!.level;
}

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
  // Set by an arrow key: once the change settles, focus moves to the option that is now checked.
  const group = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef(false);
  const actual = access.askLevel ?? "line";
  const current = confirmed ?? actual;
  const locked = profile.agent.status === "pending_approval" || profile.agent.status === "terminated";
  const disabled = busy || locked || !access.canManage;
  useEffect(() => {
    if (confirmed === null) return;
    if (confirmed === actual) { setConfirmed(null); return; }
    const timer = setTimeout(() => setConfirmed(null), 20_000);
    return () => clearTimeout(timer);
  }, [confirmed, actual]);
  // A button that turns disabled while focused drops its focus, so the arrow key's focus is put back once the change has settled.
  useEffect(() => {
    if (busy || !keyboardMove.current) return;
    keyboardMove.current = false;
    group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [busy, current]);
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
  // Arrow keys move the selection as in a radio group (WAI-ARIA), wrapping at the ends. Nothing happens while disabled.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = askLevelStep(current, event.key);
    if (next === null) return;
    event.preventDefault();
    keyboardMove.current = true;
    void choose(next);
  };
  const why = !access.canManage ? "Only company owners and admins can change this" : locked ? "Available once the agent is approved" : undefined;
  return (
    <div className="ks-perm ks-perm-wide">
      <span className="ks-text"><b>Can ask other agents</b><span>Lets this agent send another agent a question when it is stuck. The task stays with it. Takes effect within a minute.</span></span>
      <div ref={group} className="ks-seg" role="radiogroup" aria-label="Can ask other agents" title={why} onKeyDown={onKeyDown}>
        {ASK_OPTIONS.map((option) => (
          <button key={option.level} type="button" role="radio" aria-checked={current === option.level} tabIndex={option.level === current ? 0 : -1} disabled={disabled} onClick={() => void choose(option.level)}>{option.label}</button>
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

/** The worker's `agent` read: the agent and what it may do (null when the host would not say). Its tasks are read here. */
type AgentRead = { found: true; agent: ProfileAgentLike; access: AgentProfile["access"] } | { found: false; agent: null; access: null };

function Profile({ agentRef, view }: { agentRef: string; view: "overview" | "tasks" }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const params = useMemo(() => ({ companyId: host.companyId, agentRef, userId: host.userId }), [host.companyId, agentRef, host.userId]);
  const result = usePolledData<AgentRead>("agent", params, PROFILE_POLL_MS);
  const source = useTeamData(PROFILE_POLL_MS);
  const [assigning, setAssigning] = useState(false);
  const data = result.data;
  // Only ever render the agent that was asked for (a poll can still be answering for the previous one).
  const asked = data && data.found && (data.agent.urlKey === agentRef || data.agent.id === agentRef) ? data : null;
  // The company's agents, with this one as its own read has it (a new hire may not be in the list yet).
  const agents = useMemo(() => {
    if (!asked || !source.agents) return null;
    const listed = source.agents.some((row) => row.id === asked.agent.id);
    return listed ? source.agents.map((row) => (row.id === asked.agent.id ? asked.agent : row)) : [...source.agents, asked.agent];
  }, [asked, source.agents]);
  const issues = source.board?.issues ?? null;
  // The task it is working on, worked out from the tasks alone, says whose comments to read.
  const currentTaskId = useMemo(() => {
    if (!agents || !issues) return null;
    const first = buildProfile(agentRef, agents, issues, [], Date.now());
    return first.found ? first.current?.task.id ?? null : null;
  }, [agentRef, agents, issues]);
  const comments = useIssueComments(currentTaskId, PROFILE_POLL_MS);
  const built = useMemo(() => (agents && issues ? buildProfile(agentRef, agents, issues, comments, Date.now()) : null), [agentRef, agents, issues, comments]);
  const profile: AgentProfile | null = asked && built?.found ? { ...built, access: asked.access } : null;

  if (!profile) {
    return (
      <div className="ks-profile" data-kyoube-page="team">
        {data && !data.found ? (
          <div className="ks-panel ks-none">This agent does not exist or has been removed. <a {...navigation.linkProps("/team")}>See the team</a></div>
        ) : (result.error && !result.loading) || source.error ? (
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
  // After a change, read the agent and its tasks again (the tasks fresh, past the short cache).
  const refresh = () => { setAssigning(false); result.refresh(); source.refresh(); };

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
          <DutySwitch agent={profile.agent} onChanged={refresh} />
          {chatTask ? <a {...navigation.linkProps(chatTask.href)} className="ks-btn ks-btn-lg" title={`Open ${chatTask.identifier} to talk to ${agent.name}`}><Icon name="chat" size={15} />Chat</a> : null}
          <button type="button" className="ks-btn ks-btn-lg" data-tone="primary" onClick={() => setAssigning((open) => !open)} aria-expanded={assigning}><Icon name="plus" size={15} />Assign task</button>
        </div>
      </header>

      {assigning ? <AssignForm agent={profile.agent} onDone={refresh} /> : null}
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

/** `/<company>/team` (the team) and `/<company>/team/<agent>[/tasks]` (an agent's profile). */
export function AgentProfilePage(_props: PluginPageProps) {
  ensureStyles();
  const location = useHostLocation();
  const { ref, view } = parseTeamPath(location.pathname);
  return ref ? <Profile key={ref} agentRef={ref} view={view} /> : <TeamOrg />;
}

