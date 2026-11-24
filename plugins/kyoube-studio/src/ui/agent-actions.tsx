import { useEffect, useRef, useState, type FormEvent } from "react";
import { useHostContext, useHostNavigation, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { awaitingSetup } from "../model.js";
import { BoardApiError, MAX_TASK_FILES, assignTask, attachTaskFiles, setAgentOnDuty } from "./board-api.js";
import { Icon } from "./icons.js";

/** The agent fields the on-duty switch and the assign form read. */
export interface ActionAgent { id: string; name: string; status: string; lifecycleState?: string | null }

/** "820 B", "14.2 KB", "3.1 MB", as the core's task dialog shows a staged file. */
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export function AssignForm({ agent, onDone, idPrefix = "ks-assign" }: { agent: ActionAgent; onDone: () => void; idPrefix?: string }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const toast = usePluginToast();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addFiles = (picked: readonly File[]) => {
    const next = [...files];
    for (const file of picked) if (!next.some((kept) => sameFile(kept, file))) next.push(file);
    setError(next.length > MAX_TASK_FILES ? `A new task can carry up to ${MAX_TASK_FILES} files. Add the rest in the task's conversation.` : null);
    setFiles(next.slice(0, MAX_TASK_FILES));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host.companyId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const issue = await assignTask(host.companyId, agent.id, title, details);
      const ref = issue.identifier || issue.id;
      const action = { label: "Open", href: navigation.resolveHref(`/issues/${encodeURIComponent(ref)}`) };
      const { failed } = files.length > 0 ? await attachTaskFiles(host.companyId, issue.id, files) : { failed: [] };
      toast(failed.length > 0
        ? { title: `Assigned ${issue.identifier ?? "the task"} to ${agent.name}`, body: `${failed.length === 1 ? "This file" : "These files"} could not be added: ${failed.join(", ")}. Add ${failed.length === 1 ? "it" : "them"} in the task's conversation.`, tone: "warn", action }
        : { title: `Assigned ${issue.identifier ?? "the task"} to ${agent.name}`, tone: "success", action });
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
      <div className="ks-assign-files">
        <input ref={fileInput} id={`${idPrefix}-files`} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button type="button" className="ks-btn" onClick={() => fileInput.current?.click()} disabled={busy || files.length >= MAX_TASK_FILES}><Icon name="file" size={14} />Add files</button>
        {files.length > 0 ? (
          <ul aria-label="Files for this task">
            {files.map((file) => (
              <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                <Icon name="file" size={13} />
                <span>{file.name}</span>
                <small>{fileSize(file.size)}</small>
                <button type="button" aria-label={`Remove ${file.name}`} title="Remove" disabled={busy} onClick={() => setFiles((current) => current.filter((kept) => !sameFile(kept, file)))}><Icon name="x" size={13} /></button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ?<p className="ks-assign-error" role="alert">{error}</p> : null}
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
