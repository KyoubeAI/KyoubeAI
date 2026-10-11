import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";

type Status = "ready" | "agent_cannot_write" | "agent_missing";
interface OverviewApp { slug: string; name: string; templates: Array<{ key: string; agentId: string | null; agentName: string | null; table: string | null; writes: string[]; status: Status }> }

/** Spec §1: which apps hand work to which agents, and whether each agent can take it today. */
export function AppTasksSection() {
  const load = usePluginAction("tasks.overview");
  const [apps, setApps] = useState<OverviewApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load({}).then((result) => { setError(null); setApps(Array.isArray(result) ? (result as OverviewApp[]) : []); }).catch((err: unknown) => setError(errorText(err)));
  }, []);

  const statusText = (template: OverviewApp["templates"][number]) => {
    if (template.status === "agent_missing") return <span className="text-red-600">agent not found</span>;
    if (template.status === "agent_cannot_write") return <span className="text-amber-700">{template.agentName ?? "The agent"} can't write Data yet</span>;
    return <span>ready</span>;
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" data-kyoube-section="app-tasks">
      <h2 className="text-sm font-semibold">Apps that hand work to agents</h2>
      {error && <div className="text-red-600">{error}</div>}
      {apps && apps.length === 0 && <p className="text-foreground/60">No apps hand work to agents yet.</p>}
      {apps?.map((app) => (
        <div key={app.slug} className="flex max-w-3xl flex-col gap-1 rounded border p-2" data-kyoube-app-tasks={app.slug}>
          <div className="font-medium">{app.name}</div>
          {app.templates.map((template) => (
            <div key={template.key} className="flex flex-col border-t pt-1 first:border-t-0 first:pt-0" data-kyoube-break="">
              <div><code>{template.key}</code> → {template.agentName ?? "unknown agent"}</div>
              <div className="text-foreground/70">
                {template.table ? <>Sees <code>{template.table}</code></> : "No Data"}
                {template.writes.length > 0 && <> · may change {template.writes.join(", ")}</>}
              </div>
              <div>{statusText(template)}</div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
