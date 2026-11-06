import { useEffect, useState, type FormEvent } from "react";
import { useHostContext, useHostNavigation, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { awaitingSetup } from "../model.js";
import { BoardApiError, assignTask, setAgentOnDuty } from "./board-api.js";

/** The agent fields the on-duty switch and the assign form read. */
export interface ActionAgent { id: string; name: string; status: string; lifecycleState?: string | null }

export function AssignForm({ agent, onDone, idPrefix = "ks-assign" }: { agent: ActionAgent; onDone: () => void; idPrefix?: string }) {
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
      const issue = await assignTask(host.companyId, agent.id, title, details);
      const ref = issue.identifier || issue.id;
      toast({ title: `Assigned ${issue.identifier ?? "the task"} to ${agent.name}`, tone: "success", action: { label: "Open", href: navigation.resolveHref(`/issues/${encodeURIComponent(ref)}`) } });
      onDone();
    } catch (caught) {
      setError(caught instanceof BoardApiError ? caught.message : "The task could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ks-assign" onSubmit={submit}>
      <label htmlFor={`${idPrefix}-title`}>What should {agent.name} do?</label>
      <input id={`${idPrefix}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: draft three posts for the launch" autoFocus required maxLength={300} />
      <textarea id={`${idPrefix}-details`} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Details, links, and what done looks like (optional)" rows={3} />
      {error ? <p className="ks-assign-error" role="alert">{error}</p> : null}
      <div className="ks-assign-actions">
        <button type="button" className="ks-btn ks-btn-lg" onClick={onDone} disabled={busy}>Cancel</button>
        <button type="submit" className="ks-btn ks-btn-lg" data-tone="primary" disabled={busy || !title.trim()}>{busy ? "Assigning…" : "Assign task"}</button>
      </div>
    </form>
  );
}

export function DutySwitch({ agent, onChanged }: { agent: ActionAgent; onChanged: () => void }) {
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  // What the server just confirmed, shown until the profile's next read agrees,
  // so a second click never repeats the first.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const status = agent.status;
  // The core keeps status "paused" while it takes an agent on duty (a new one is checked first),
  // until its worker finishes; from there it can be paused, never resumed.
  const actual = status !== "paused" || awaitingSetup(agent.lifecycleState);
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
      await setAgentOnDuty(agent.id, !onDuty);
      setConfirmed(!onDuty);
      toast({ title: onDuty ? `${agent.name} is off duty` : `${agent.name} is back on duty`, body: onDuty ? "It stops its current run and takes no new work until you switch it back." : undefined, tone: "success" });
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
