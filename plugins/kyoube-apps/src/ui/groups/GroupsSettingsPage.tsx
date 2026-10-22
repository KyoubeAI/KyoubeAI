import { useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "../format.js";
import { button, input } from "../forms.js";
import { ensurePhoneStyles } from "../phone.js";
import { openedBy } from "./opened.js";

interface Group { id: string; name: string; dataLevel: string | null; members: string[]; agents: string[]; apps: string[]; seesAll: boolean; projects: string[] }
type Restricted = Array<{ userId: string; role: string | null }>;
interface Visibility { mode: "open" | "need_to_know"; seesAll: string[]; restricted: Restricted }
interface ListData { unlocked: boolean; groups: Group[]; sync: { syncedAt: string; error: string | null } | null; visibility: Visibility }
interface Options { members: Array<{ id: string; role: string | null; name?: string }>; agents: Array<{ id: string; name: string }>; apps: Array<{ id: string; name: string; icon: string | null }>; projects: Array<{ id: string; name: string }> }
interface Draft { id?: string; name: string; level: string; members: string[]; agents: string[]; apps: string[]; seesAll: boolean; projects: string[] }

const EMPTY: Draft = { name: "", level: "", members: [], agents: [], apps: [], seesAll: false, projects: [] };
const LISTED_PEOPLE = 20;
const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

/** What the switch to need-to-know asks first: who would be restricted, by id and role (at most 20 named). */
export function restrictionConfirmText(restricted: Restricted): string {
  if (restricted.length === 0) return "Nobody is restricted yet: every operator and viewer is in a group that sees everything. Continue?";
  const named = restricted.slice(0, LISTED_PEOPLE).map((person) => (person.role ? `${person.userId} (${person.role})` : person.userId));
  const more = restricted.length - named.length;
  const list = more > 0 ? `${named.join(", ")}, and ${more} more` : named.join(", ");
  return `This restricts ${people(restricted.length)} to the projects of their groups and the tasks they are involved in: ${list}. Owners and admins are not affected. Continue?`;
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function CheckList(props: { title: string; items: Array<{ id: string; label: string }>; selected: string[]; onChange: (next: string[]) => void }) {
  const toggle = (id: string) => props.onChange(props.selected.includes(id) ? props.selected.filter((x) => x !== id) : [...props.selected, id]);
  return (
    <fieldset className="flex min-w-[12rem] flex-1 flex-col gap-1 rounded border p-2">
      <legend className="px-1 font-medium">{props.title}</legend>
      {props.items.map((item) => (
        <label key={item.id} className="flex items-center gap-2"><input type="checkbox" checked={props.selected.includes(item.id)} onChange={() => toggle(item.id)} /> <span className="min-w-0 break-all" data-kyoube-break="">{item.label}</span></label>
      ))}
      {props.items.length === 0 && <span className="text-foreground/60">None available.</span>}
    </fieldset>
  );
}

export function GroupsSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const toast = usePluginToast();
  const list = usePluginAction("groups.list");
  const loadOptions = usePluginAction("groups.options");
  const save = usePluginAction("groups.save");
  const remove = usePluginAction("groups.delete");
  const setVisibility = usePluginAction("groups.set_visibility");
  const [data, setData] = useState<ListData | null>(null);
  const [options, setOptions] = useState<Options>({ members: [], agents: [], apps: [], projects: [] });
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = () => list({}).then((result) => { setData(result as ListData); setError(null); }).catch((err) => setError(errorText(err)));
  useEffect(() => { ensurePhoneStyles(); }, []);
  useEffect(() => {
    if (!companyId) return;
    reload().catch(() => {});
    loadOptions({}).then((result) => setOptions(result as Options)).catch(() => {});
  }, [companyId]);

  const unlocked = data?.unlocked ?? false;
  const groups = data?.groups ?? [];
  const nameOf = (kind: "agents" | "apps", id: string) => options[kind].find((item) => item.id === id)?.name ?? id;
  /** Asks before a change leaves agents or apps in no group, which opens them to everyone. */
  const confirmOpened = (opened: { agents: string[]; apps: string[] }) => {
    const names = [...opened.agents.map((id) => nameOf("agents", id)), ...opened.apps.map((id) => nameOf("apps", id))];
    return names.length === 0 || window.confirm(`This makes ${names.join(", ")} usable by everyone. Continue?`);
  };
  /** Resolves true once the change succeeded, false (after an error toast) when it was refused. */
  const act = (promise: Promise<unknown>, title: string): Promise<boolean> =>
    promise.then(
      async () => { toast({ title, tone: "success" }); await reload(); return true; },
      (err) => { toast({ title: errorText(err), tone: "error" }); return false; },
    );

  const onSwitch = (visibility: Visibility) => {
    const toNeedToKnow = visibility.mode === "open";
    if (toNeedToKnow && !window.confirm(restrictionConfirmText(visibility.restricted))) return;
    void act(setVisibility({ mode: toNeedToKnow ? "need_to_know" : "open" }), toNeedToKnow ? "Visibility set to need-to-know" : "Visibility set to open");
  };
  const onSave = () => {
    if (!draft) return;
    if (draft.id && !confirmOpened(openedBy(groups, { groupId: draft.id, nextAgents: draft.agents, nextApps: draft.apps }))) return;
    const body = { id: draft.id, name: draft.name.trim(), dataLevel: draft.level || null, members: draft.members, agents: draft.agents, apps: draft.apps, seesAll: draft.seesAll, projects: draft.projects };
    // A refused save keeps the editor open with the person's edits, so nothing they typed is lost.
    void act(save({ group: body }), "Group saved").then((saved) => { if (saved) setDraft(null); });
  };
  const onDelete = (group: Group) => {
    if (!confirmOpened(openedBy(groups, { deleteId: group.id }))) return;
    void act(remove({ id: group.id }), "Group deleted").then((deleted) => { if (deleted) setDraft((current) => (current?.id === group.id ? null : current)); });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 text-sm" data-kyoube-page="groups">
      <h1 className="text-base font-semibold">Groups</h1>
      <p className="text-foreground/70">Groups decide which agents people may give work to, which apps they may open, and optionally their Data level. An agent or app in no group is open to everyone. Owners and admins are never restricted. Agent changes take effect within about a minute.</p>
      {error && <div className="text-red-600">{error}</div>}
      {data && (
        <>
          <p className="text-foreground/60">
            {data.sync ? `Agent rules last synced ${minutesAgo(data.sync.syncedAt)} min ago` : "Agent rules have not synced yet"}
            {data.sync?.error && <span className="ml-2 text-red-600">{data.sync.error}</span>}
          </p>
          {!unlocked && <div role="alert" className="rounded border border-amber-500 p-3">Managing groups needs a KyoubeAI licence (Settings → Plugins → KyoubeAI Licence). Existing groups are still enforced, and you can delete them.</div>}
          <section className="flex flex-col gap-2 rounded border p-3">
            <h2 className="font-medium">Visibility</h2>
            <p>
              {data.visibility.mode === "open"
                ? "Visibility: open — everyone in the company sees every project and task."
                : "Visibility: need-to-know — operators and viewers see the projects of their groups and the tasks they are involved in, unless their group sees everything."}
            </p>
            {data.visibility.mode === "need_to_know" && <p className="text-foreground/70">{people(data.visibility.restricted.length)} restricted</p>}
            <div>
              <button type="button" className={button} disabled={data.visibility.mode === "open" && !unlocked} onClick={() => onSwitch(data.visibility)}>
                {data.visibility.mode === "open" ? "Switch to need-to-know" : "Switch to open"}
              </button>
            </div>
          </section>
          <div><button type="button" className={button} onClick={() => setDraft({ ...EMPTY })}>New group</button></div>
          {/* A phone is narrower than the table: it scrolls inside its own box, never the page (R21). */}
          <div className="w-full max-w-3xl overflow-x-auto" data-kyoube-scroll="">
            <table className="w-full text-sm">
              <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Group</th><th className="px-2 py-1">Data level</th><th className="px-2 py-1">Members</th><th className="px-2 py-1">Agents</th><th className="px-2 py-1">Apps</th><th className="px-2 py-1">Sees all</th><th className="px-2 py-1">Projects</th><th className="px-2 py-1" /></tr></thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id} className="border-t">
                    <td className="px-2 py-1"><button type="button" className="break-words text-left underline" data-kyoube-break="" onClick={() => setDraft({ id: group.id, name: group.name, level: group.dataLevel ?? "", members: group.members, agents: group.agents, apps: group.apps, seesAll: group.seesAll, projects: group.projects })}>{group.name}</button></td>
                    <td className="px-2 py-1">{group.dataLevel ?? "from role"}</td>
                    <td className="px-2 py-1">{group.members.length}</td>
                    <td className="px-2 py-1">{group.agents.length}</td>
                    <td className="px-2 py-1">{group.apps.length}</td>
                    <td className="px-2 py-1">{group.seesAll ? "yes" : "no"}</td>
                    <td className="px-2 py-1">{group.projects.length}</td>
                    <td className="px-2 py-1"><button type="button" className={button} onClick={() => onDelete(group)}>Delete</button></td>
                  </tr>
                ))}
                {groups.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={8}>No groups yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {draft && (
            <section className="flex flex-col gap-3 rounded border p-3">
              <label className="flex flex-wrap items-center gap-2">Name <input className={`${input} min-w-0 flex-1`} maxLength={80} value={draft.name} disabled={!unlocked} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="flex items-center gap-2">Data level
                <select className={input} value={draft.level} disabled={!unlocked} onChange={(event) => setDraft({ ...draft, level: event.target.value })}>
                  <option value="">Data level from role</option>
                  <option value="read">read</option>
                  <option value="write">write</option>
                  <option value="schema">schema</option>
                </select>
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.seesAll} disabled={!unlocked} onChange={(event) => setDraft({ ...draft, seesAll: event.target.checked })} /> Sees everything in the company</label>
              <div className="flex flex-wrap gap-3">
                <CheckList title="Members" items={options.members.map((member) => ({ id: member.id, label: `${member.name ?? member.id}${member.role ? ` (${member.role})` : ""}` }))} selected={draft.members} onChange={(members) => setDraft({ ...draft, members })} />
                <CheckList title="Agents" items={options.agents.map((agent) => ({ id: agent.id, label: agent.name }))} selected={draft.agents} onChange={(agents) => setDraft({ ...draft, agents })} />
                <CheckList title="Apps" items={options.apps.map((app) => ({ id: app.id, label: `${app.icon ?? ""} ${app.name}`.trim() }))} selected={draft.apps} onChange={(apps) => setDraft({ ...draft, apps })} />
                <CheckList title="Projects" items={options.projects.map((project) => ({ id: project.id, label: project.name }))} selected={draft.projects} onChange={(projects) => setDraft({ ...draft, projects })} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={!unlocked || !draft.name.trim()} onClick={onSave}>Save</button>
                <button type="button" className={button} onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
