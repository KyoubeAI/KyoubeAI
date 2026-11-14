// scripts/demo/seed-review-company.mjs
// Builds the "KyoubeAI Review" company on an instance through its HTTP API, and resets it when run
// again: the company that directory reviewers use when they test the assistant connection
// (docs/mcp.md). Every object is found by name. A re-run puts back the sample rows, files and agent
// instructions, removes the tables, top-level project entries and apps reviewers added, and cancels
// open app tasks and the agent's open tasks. docs/operations.md says what a re-run does not put back.
// Outside the review company, the script reads only the list of companies (to find it by name) and
// may turn on assistant connections, which is an instance-wide setting; every other call names the
// review company's id or one of its objects. It refuses to reset a project folder that is not the
// project's own managed folder. The script holds no credentials: the instance-admin board key comes
// from the environment.
//
//   KYOUBE_SEED_API_KEY=… node scripts/demo/seed-review-company.mjs --base-url http://localhost:3300 [--decisions] [--new-invite]
//
// Until the reviewer has joined, it prints an operator invite link. An open invite is kept on a
// re-run, since its link may already be with a reviewer; --new-invite revokes it and makes another.
//
// With --decisions it also stores KYOUBE_SEED_DECISIONS_API_KEY as a company secret and points
// kyoube.apps at KYOUBE_SEED_DECISIONS_PROVIDER and KYOUBE_SEED_DECISIONS_MODEL
// (KYOUBE_SEED_DECISIONS_BASE_URL for the custom provider), so the Tickets AI column fills and some
// rows wait for review.
import { pathToFileURL } from "node:url";

export const COMPANY = "KyoubeAI Review";
export const REVIEWER_EMAIL = "reviewer@kyoubeai.com";
export const AGENT_CWD = "/kyoubeai/workspaces/kyoubeai-review";
export const DECISIONS_SECRET = "kyoube-decisions-key";
export const OPEN_TASK_STATUSES = ["waiting", "working", "needs_review", "blocked"];
/** Core task (issue) statuses that are not finished; done and cancelled are. */
export const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
/** The core lists a company's tasks up to this many at once. */
export const ISSUE_LIST_LIMIT = 1000;
/** The Review Assistant's entry instructions (AGENTS.md), put back on every run. */
export const AGENT_INSTRUCTIONS = "You are Review Assistant, an agent in the KyoubeAI Review demo company. Work only on the task you are given.\n";

// ---- sample data (all fictional) --------------------------------------------------------------

const LEADS = [
  ["Mira Okafor", "Bramblewood Bakery", "new", 1200],
  ["Tomasz Lindqvist", "Harbourline Freight", "contacted", 8400],
  ["Aiko Ferreira", "Quillstone Legal", "qualified", 15600],
  ["Dev Raman", "Saltmarsh Outdoor", "lost", 2300],
  ["Hana Kowalczyk", "Copperleaf Dental", "new", 4100],
  ["Luis Abernathy", "Tidewater Printing", "contacted", 3650],
  ["Priya Delacroix", "Northgate Robotics", "qualified", 27500],
  ["Jonas Achterberg", "Fernhill Florists", "new", 900],
  ["Zara Whitlock", "Ironbridge Analytics", "contacted", 12000],
  ["Kofi Nakamura", "Lanternfish Studios", "qualified", 9800],
  ["Elin Moreau", "Pebblebrook Pharmacy", "lost", 5400],
  ["Ravi Castellano", "Bluefinch Logistics", "new", 7200],
  ["Sofia Brennan", "Oakhollow Builders", "contacted", 18300],
  ["Mateo Lindgren", "Greywater Brewing", "qualified", 6100],
  ["Imani Rasmussen", "Starling Accountancy", "new", 3300],
  ["Felix Oyelaran", "Willowmere Hotels", "contacted", 22000],
  ["Noor Haverkamp", "Riverstone Clinics", "qualified", 31000],
  ["Oskar Mbeki", "Juniper Lane Coffee", "lost", 1500],
  ["Leah Strand", "Cobalt Fern Software", "new", 14200],
  ["Arjun Pellegrini", "Thistledown Events", "contacted", 4800],
];

const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];
const ORDERS = LEADS.map(([, company], i) => ({
  number: `ORD-${1001 + i}`,
  customer: company,
  total: Number((((i * 37) % 23) * 41.5 + 89.99).toFixed(2)),
  status: ORDER_STATUSES[i % ORDER_STATUSES.length],
  placed: `2026-10-${String(10 + i).padStart(2, "0")}`,
}));

const TICKETS = [
  ["Refund for a double charge", "I was charged twice for order ORD-1004. Please send the second payment back to my card."],
  ["How do I export my invoices?", "Is there a way to download all of last month's invoices as one file?"],
  ["Cancel and refund my subscription", "We no longer need the service. Please cancel the plan and refund this month."],
  ["Delivery arrived damaged", "The parcel for ORD-1009 came with a cracked lid. Can you send a replacement?"],
  ["Wrong size sent", "I ordered the large crate and got the small one. I'd like my money back rather than an exchange."],
  ["Thanks for the quick fix", "The login problem is gone. Thank you for sorting it out so fast."],
  ["Change billing address", "Please update the billing address on our account to the new office."],
  ["Charged after cancelling", "I cancelled last week but was still billed today. I want that charge reversed."],
  ["Can I add a second user?", "Our assistant needs access too. How do we add another seat?"],
  ["Order never arrived", "ORD-1012 shows delivered but nothing came. Either resend it or refund me, whichever is faster."],
  ["Discount code not applied", "The code from your newsletter did not work at checkout. Can you apply it now?"],
  ["Return label request", "I'd like to send back the unused items from ORD-1015. Where do I get a return label?"],
  ["Love the new dashboard", "Just wanted to say the new dashboard is much easier to read."],
  ["Please refund the late fee", "The late fee on my last invoice was a mistake on your side. Please refund it."],
  ["Invoice shows the wrong VAT number", "Our VAT number on invoice 2291 is out of date. Can you reissue it?"],
  ["Product stopped working", "The scale I bought stopped turning on after two weeks. What are my options?"],
  ["Money back guarantee", "Your site promises a 30-day money back guarantee. I'd like to use it for ORD-1018."],
  ["Slow support replies", "It took four days to hear back last time. Is there a faster channel?"],
  ["Overpaid my invoice", "I paid 150 instead of 105 by mistake. Can the difference be returned?"],
  ["Upgrade to the annual plan", "We want to switch to yearly billing. What's the price?"],
];

const README = `# Launch plan

Working folder for the spring launch of the Lead desk. Sample data for reviewing KyoubeAI; every
name, company and number in it is invented.

- \`notes/meeting-2026-11-10.md\`: notes from the kick-off meeting
- \`data/prices.csv\`: the price list the sales team quotes from

Open questions live at the end of the meeting notes.
`;

const MEETING_NOTES = `# Kick-off, 10 November 2026

Present: Mira (sales), Tomasz (operations), Aiko (marketing)

## Decisions

- Launch the Lead desk to the sales team on 1 December.
- Every qualified lead gets a two-sentence summary before the weekly review.
- Prices stay as in \`data/prices.csv\` until January.

## Actions

- Mira: clean up the lead stages by Friday.
- Tomasz: check the order statuses against the warehouse list.
- Aiko: draft the launch announcement.

## Open questions

- Should lost leads be archived after 90 days?
- Do we offer the annual discount to existing customers?
`;

const PRICES = `product,plan,monthly_eur,annual_eur
Lead desk,Starter,19,190
Lead desk,Team,49,490
Lead desk,Business,129,1290
Order sync,Add-on,15,150
Priority support,Add-on,29,290
`;

const APP_SOURCE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lead desk</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}.scroll{overflow-x:auto}button{min-height:44px}.summary{white-space:pre-wrap}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>Lead desk</h1>
<p id="note" role="status"></p>
<div class="scroll"><table><thead><tr><th>Name</th><th>Company</th><th>Stage</th><th>Value</th><th>Summary</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const note = document.getElementById("note");
const rowsEl = document.getElementById("rows");
let canTask = false;
function fail(err) { note.textContent = err.message || String(err); }
function cell(text) { const td = document.createElement("td"); td.textContent = text ?? ""; return td; }
function rowEl(r) {
  const tr = document.createElement("tr");
  const summary = cell(r.summary); summary.className = "summary";
  const action = document.createElement("td");
  const button = document.createElement("button"); button.textContent = "Summarise"; button.disabled = !canTask;
  button.addEventListener("click", () => summarise(r, button));
  action.append(button);
  tr.append(cell(r.name), cell(r.company), cell(r.stage), cell(r.value), summary, action);
  return tr;
}
async function load() {
  const { rows } = await kyoube.data.query("leads", { orderBy: [{ field: "name", direction: "asc" }], limit: 100 });
  rowsEl.replaceChildren(...rows.map(rowEl));
}
async function summarise(r, button) {
  button.disabled = true;
  note.textContent = "Asked the agent to summarise " + r.name + ".";
  try {
    const task = await kyoube.tasks.start("summarise", { rowId: r.id });
    const stop = kyoube.tasks.watch(task.id, (t) => {
      note.textContent = r.name + ": " + t.status.replace("_", " ");
      if (t.status === "done" || t.status === "cancelled") { stop(); load().catch(fail); }
    });
  } catch (err) { fail(err); button.disabled = false; }
}
kyoube.ready().then((ctx) => { canTask = ctx.tasks.available; return load(); }).catch(fail);
</script>
</body></html>
`;

export const SEED = {
  agent: { name: "Review Assistant", adapterType: "claude_local", budgetMonthlyCents: 500 },
  project: {
    name: "Launch plan",
    files: [
      { path: "README.md", content: README },
      { path: "notes/meeting-2026-11-10.md", content: MEETING_NOTES },
      { path: "data/prices.csv", content: PRICES },
    ],
  },
  tables: [
    {
      name: "leads",
      fields: [
        { name: "name", kind: "text", required: true },
        { name: "company", kind: "text" },
        { name: "email", kind: "email" },
        { name: "stage", kind: "select", options: { choices: ["new", "contacted", "qualified", "lost"] } },
        { name: "value", kind: "decimal" },
        { name: "summary", kind: "long_text" },
      ],
      rows: LEADS.map(([name, company, stage, value]) => ({
        name, company, stage, value,
        email: `${name.split(" ")[0].toLowerCase()}@${company.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`,
      })),
    },
    {
      name: "orders",
      fields: [
        { name: "number", kind: "text", required: true },
        { name: "customer", kind: "text" },
        { name: "total", kind: "decimal" },
        { name: "status", kind: "select", options: { choices: ORDER_STATUSES } },
        { name: "placed", kind: "date" },
      ],
      rows: ORDERS,
    },
    {
      name: "tickets",
      fields: [
        { name: "subject", kind: "text", required: true },
        { name: "body", kind: "long_text" },
        {
          name: "refund", kind: "boolean",
          options: {
            decision: {
              question: { type: "check", statement: "The customer is asking for their money back." },
              sourceFields: ["subject", "body"],
            },
          },
        },
      ],
      rows: TICKETS.map(([subject, body]) => ({ subject, body })),
    },
  ],
  app: {
    manifest: {
      name: "Lead desk",
      slug: "lead-desk",
      tables: [{ name: "leads", access: "readwrite" }],
      tasks: {
        summarise: {
          agent: "Review Assistant",
          title: "Summarise a lead",
          instructions: "Read the lead and write a two-sentence summary into its summary field.",
          table: "leads",
          // The core needs the fields the agent reads, and `writes` must be one of them.
          fields: ["name", "company", "stage", "value", "summary"],
          writes: ["summary"],
        },
      },
    },
    source: APP_SOURCE,
  },
};

// ---- pure helpers ------------------------------------------------------------------------------

/** The one item whose `name` is exactly `name`, or null. Two of them is an error: the script never guesses. */
export function findOne(items, name) {
  const found = items.filter((item) => item.name === name);
  if (found.length > 1) throw new Error(`more than one "${name}"; remove the extra one by hand, then run this again`);
  return found[0] ?? null;
}

/** The names that exist but are not wanted, sorted. */
export function extras(existingNames, wantedNames) {
  const wanted = new Set(wantedNames);
  return [...new Set(existingNames)].filter((name) => !wanted.has(name)).sort();
}

/** The app tasks that can still be cancelled. */
export function openTasks(tasks) {
  return tasks.filter((task) => OPEN_TASK_STATUSES.includes(task.status));
}

export function chunk(ids, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** The core lists an app's tasks newest first, at most this many. */
export const TASK_LIST_LIMIT = 50;

/** A full page: older tasks, open ones among them, may be past its end. */
export function taskListFull(tasks) {
  return tasks.length >= TASK_LIST_LIMIT;
}

/**
 * What to do about the reviewer's invite, given the company's active invites. An open operator
 * invite may already be in a reviewer's hands, so it is kept unless `--new-invite` asks for a new
 * one; then every open operator invite is revoked and one is created.
 */
export function inviteDecision(activeInvites, newInvite) {
  const open = activeInvites.filter((invite) => invite.allowedJoinTypes === "human" && invite.humanRole === "operator");
  if (open.length > 0 && !newInvite) return { keep: open, revoke: [], create: false };
  return { keep: [], revoke: open, create: true };
}

/**
 * The project's own folder, from kyoube.files' `files.workspaces` answer, or `{ problem }` when the
 * reset must not touch it. kyoube.files works in a project's configured primary workspace when it
 * has one, and anyone who can read the project can add one with any path, so the reset only goes
 * ahead in the managed folder the core keeps for this project:
 * `…/projects/<companyId>/<projectId>/_default`.
 */
export function managedFolder(folders, companyId, projectId) {
  const suffix = `/projects/${companyId}/${projectId}/_default`;
  const primary = (folders?.workspaces ?? []).find((w) => w.isPrimary) ?? null;
  if (!primary || typeof primary.path !== "string") return { problem: "kyoube.files shows no folder for it", suffix };
  const managed = primary.source === "managed" && primary.id === `${projectId}:managed` && primary.path.endsWith(suffix);
  if (!managed) return { problem: `it works in ${primary.path}, not in its own managed folder (…${suffix})`, path: primary.path, suffix };
  return { id: primary.id, path: primary.path };
}

/** The open core tasks assigned to `agentId` in `companyId`; anything else in the list is left alone. */
export function openIssues(issues, companyId, agentId) {
  return issues.filter((issue) => issue.companyId === companyId && issue.assigneeAgentId === agentId
    && OPEN_ISSUE_STATUSES.includes(issue.status));
}

/**
 * The warning for a seeded agent or project that is missing while the company has others of that
 * kind: a reviewer may have renamed it, and the run is about to create a second one.
 */
export function renameWarning(kind, wanted, existingNames) {
  if (existingNames.length === 0) return null;
  const names = [...existingNames].sort().map((name) => `"${name}"`).join(", ");
  return `WARNING: no ${kind} named "${wanted}", but the company has ${kind === "agent" ? "agents" : "projects"} ${names}. `
    + `A reviewer may have renamed it. Creating a new "${wanted}"; the renamed one is not reset. Remove it by hand.`;
}

/** The parts of an app version this script sets, for comparing a stored version with the seed. */
export function appShape(manifest, source) {
  return JSON.stringify({
    name: manifest.name,
    slug: manifest.slug,
    tables: (manifest.tables ?? []).map((t) => ({ name: t.name, access: t.access ?? null })),
    tasks: Object.fromEntries(Object.entries(manifest.tasks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, t]) => [key, {
      agent: t.agent, title: t.title, instructions: t.instructions, table: t.table ?? null, fields: t.fields ?? [], writes: t.writes ?? [],
    }])),
    source,
  });
}

/** The top-level names and folders the seeded files need, e.g. { top: ["README.md","data","notes"], dirs: { data: ["prices.csv"] } }. */
export function fileLayout(files) {
  const top = new Set();
  const dirs = {};
  for (const { path } of files) {
    const parts = path.split("/");
    top.add(parts[0]);
    if (parts.length === 2) (dirs[parts[0]] ??= []).push(parts[1]);
    else if (parts.length > 2) throw new Error(`seed file ${path} is nested too deep`);
  }
  return { top: [...top].sort(), dirs };
}

const USAGE = "usage: KYOUBE_SEED_API_KEY=<instance-admin board key> node scripts/demo/seed-review-company.mjs --base-url <url> [--decisions] [--new-invite]";

export function parseArgs(argv, env) {
  let baseUrl = null;
  let decisions = false;
  let newInvite = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--base-url") {
      baseUrl = argv[i + 1] ?? null;
      i += 1;
    } else if (flag === "--decisions") decisions = true;
    else if (flag === "--new-invite") newInvite = true;
    else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (!baseUrl) throw new Error(`--base-url is missing\n${USAGE}`);
  if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new Error(`--base-url must start with http:// or https://, got ${baseUrl}`);
  const key = (env.KYOUBE_SEED_API_KEY ?? "").trim();
  if (!key) throw new Error(`KYOUBE_SEED_API_KEY is not set\n${USAGE}`);
  const args = { baseUrl: baseUrl.replace(/\/+$/, ""), key, decisions, newInvite, decisionsConfig: null };
  if (decisions) {
    const need = ["KYOUBE_SEED_DECISIONS_API_KEY", "KYOUBE_SEED_DECISIONS_PROVIDER", "KYOUBE_SEED_DECISIONS_MODEL"];
    const missing = need.filter((name) => !(env[name] ?? "").trim());
    if (missing.length > 0) throw new Error(`--decisions needs ${missing.join(", ")}`);
    args.decisionsConfig = {
      apiKey: env.KYOUBE_SEED_DECISIONS_API_KEY.trim(),
      provider: env.KYOUBE_SEED_DECISIONS_PROVIDER.trim(),
      model: env.KYOUBE_SEED_DECISIONS_MODEL.trim(),
      baseUrl: (env.KYOUBE_SEED_DECISIONS_BASE_URL ?? "").trim() || null,
    };
  }
  return args;
}

// ---- HTTP ------------------------------------------------------------------------------------

class SeedError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function makeClient(baseUrl, key) {
  async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new SeedError(`${method} ${path} did not reach ${baseUrl}: ${error.cause?.message ?? error.message}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      // A plugin action that refuses answers 502 WORKER_ERROR with the worker's "<code>: <text>" in `message`.
      // Only a string is a message; an object-valued `error` would print as [object Object].
      const message = typeof json?.message === "string" ? json.message
        : typeof json?.error === "string" ? json.error
        : (text.slice(0, 300) || res.statusText);
      const code = json?.code === "WORKER_ERROR" ? String(json.message ?? "").split(":")[0] : json?.code ?? null;
      throw new SeedError(`${method} ${path} answered ${res.status}: ${message}`, { status: res.status, code });
    }
    return json;
  }
  const get = (path) => call("GET", path);
  const post = (path, body = {}) => call("POST", path, body);
  const patch = (path, body) => call("PATCH", path, body);
  const put = (path, body) => call("PUT", path, body);
  const del = (path) => call("DELETE", path);
  return { get, post, patch, put, del };
}

function companyApi(http, companyId) {
  const enc = encodeURIComponent;
  const appsApi = "/api/plugins/kyoube.apps/api";
  return {
    action: async (plugin, key, params = {}) => (await http.post(`/api/plugins/${plugin}/actions/${key}`, { companyId, params }))?.data,
    apps: {
      get: (path) => http.get(`${appsApi}${path}${path.includes("?") ? "&" : "?"}companyId=${enc(companyId)}`),
      post: (path, body = {}) => http.post(`${appsApi}${path}`, { ...body, companyId }),
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the steps -------------------------------------------------------------------------------

async function seedCompany(http, summary) {
  const list = await http.get("/api/companies");
  const companies = Array.isArray(list) ? list : (list?.companies ?? []);
  const found = findOne(companies, COMPANY);
  if (found) {
    summary.push(["company", COMPANY, "unchanged"]);
    return found.id;
  }
  const created = await http.post("/api/companies", { name: COMPANY });
  summary.push(["company", COMPANY, "created"]);
  return created.id;
}

async function seedMcpSetting(http, summary) {
  const settings = await http.get("/api/instance/settings/experimental");
  if (settings?.enablePublicMcp === true) {
    summary.push(["setting", "assistant connections (instance-wide)", "unchanged"]);
    return;
  }
  await http.patch("/api/instance/settings/experimental", { enablePublicMcp: true });
  console.log("    assistant connections were off on this instance; turned them on (an instance-wide setting)");
  summary.push(["setting", "assistant connections (instance-wide)", "updated"]);
}

async function seedAgent(http, api, companyId, summary) {
  const agents = (await http.get(`/api/companies/${companyId}/agents`)).filter((a) => a.status !== "terminated");
  let agent = findOne(agents, SEED.agent.name);
  let status = "unchanged";
  if (!agent) {
    const warning = renameWarning("agent", SEED.agent.name, agents.map((a) => a.name));
    if (warning) console.log(`    ${warning}`);
    agent = await http.post(`/api/companies/${companyId}/agents`, { ...SEED.agent, adapterConfig: { cwd: AGENT_CWD } });
    status = "created";
  } else {
    const patch = {};
    if (agent.adapterType !== SEED.agent.adapterType) Object.assign(patch, { adapterType: SEED.agent.adapterType, adapterConfig: { cwd: AGENT_CWD } });
    if (agent.budgetMonthlyCents !== SEED.agent.budgetMonthlyCents) patch.budgetMonthlyCents = SEED.agent.budgetMonthlyCents;
    if (Object.keys(patch).length > 0) {
      agent = await http.patch(`/api/agents/${agent.id}`, patch);
      status = "updated";
    }
    // Only a person's pause is undone; a budget pause stays, so the cap still holds.
    if (agent.lifecycleState === "paused" && (agent.lifecycleHolds ?? []).includes("user")) {
      agent = await http.post(`/api/agents/${agent.id}/resume`, {});
      status = "updated";
    }
  }
  summary.push(["agent", SEED.agent.name, status]);
  if (agent.lifecycleState === "paused") {
    const holds = (agent.lifecycleHolds ?? []).join(", ") || "no reason given";
    console.log(`    note: agent "${SEED.agent.name}" is paused (${holds}); app tasks are refused until it is resumed`);
  } else if (agent.lifecycleState && agent.lifecycleState !== "ready") {
    // A new or changed agent is checked by the core before it takes work (its harness must sign in).
    console.log(`    note: agent "${SEED.agent.name}" is ${agent.lifecycleState}; app tasks start once the core has checked its Claude sign-in`);
  }
  const { grants } = await api.action("kyoube.apps", "data.grants");
  const current = (grants ?? []).find((g) => g.agentId === agent.id);
  if (current?.level === "write") {
    summary.push(["agent data access", `(write) for ${SEED.agent.name}`, "unchanged"]);
  } else {
    await api.action("kyoube.apps", "data.set_agent_grant", { agentId: agent.id, level: "write" });
    summary.push(["agent data access", `(write) for ${SEED.agent.name}`, current ? "updated" : "created"]);
  }
  await seedInstructions(http, agent, status === "created", summary);
  return { agent, created: status === "created" };
}

/**
 * Puts the agent's instructions back: AGENTS.md holds AGENT_INSTRUCTIONS and no other file is in
 * the bundle. A reviewer can change both over the assistant connection.
 */
async function seedInstructions(http, agent, agentCreated, summary) {
  const base = `/api/agents/${agent.id}/instructions-bundle`;
  const bundle = await http.get(base);
  if (bundle?.mode !== "managed" || bundle?.entryFile !== "AGENTS.md") {
    console.log(`    WARNING: the instructions of "${SEED.agent.name}" are not a managed AGENTS.md (mode ${bundle?.mode}, entry ${bundle?.entryFile}); left as they are`);
    summary.push(["agent instructions", `for ${SEED.agent.name}`, "not checked"]);
    return;
  }
  for (const file of bundle.files ?? []) {
    if (file.path === bundle.entryFile || file.virtual) continue;
    await http.del(`${base}/file?path=${encodeURIComponent(file.path)}&baseHash=${encodeURIComponent(file.contentHash)}`);
    summary.push(["agent instruction file", file.path, "deleted (not in the seed)"]);
  }
  const current = await http.get(`${base}/file?path=AGENTS.md`);
  if (current?.content === AGENT_INSTRUCTIONS) {
    summary.push(["agent instructions", `for ${SEED.agent.name}`, "unchanged"]);
    return;
  }
  // The core takes the hash of the version read as the base, and refuses the write if it has moved on.
  await http.put(`${base}/file`, { path: "AGENTS.md", content: AGENT_INSTRUCTIONS, baseHash: current?.contentHash ?? null });
  summary.push(["agent instructions", `for ${SEED.agent.name}`, agentCreated ? "created" : "reset"]);
}

/**
 * Cancels the open core tasks assigned to the seeded agent in the review company, such as ones a
 * reviewer created over the assistant connection, so they stop spending the agent's budget. App
 * tasks are cancelled before this, through their app.
 */
async function cancelAgentTasks(http, companyId, agent, summary) {
  const query = new URLSearchParams({ assigneeAgentId: agent.id, status: OPEN_ISSUE_STATUSES.join(","), limit: String(ISSUE_LIST_LIMIT) });
  const listed = await http.get(`/api/companies/${companyId}/issues?${query}`);
  const issues = Array.isArray(listed) ? listed : (listed?.issues ?? []);
  let cancelled = 0;
  for (const issue of openIssues(issues, companyId, agent.id)) {
    try {
      await http.patch(`/api/issues/${issue.id}`, { status: "cancelled" });
      cancelled += 1;
    } catch (error) {
      if (!(error instanceof SeedError)) throw error;
      console.log(`    WARNING: task ${issue.identifier ?? issue.id} ("${issue.title}") could not be cancelled: ${error.message}`);
    }
  }
  if (issues.length >= ISSUE_LIST_LIMIT) {
    console.log(`    WARNING: "${SEED.agent.name}" has at least ${ISSUE_LIST_LIMIT} open tasks and only ${ISSUE_LIST_LIMIT} can be listed; run this again to cancel the rest.`);
  }
  summary.push([`open tasks of ${SEED.agent.name}`, "", cancelled > 0 ? `reset (${cancelled} cancelled)` : "unchanged"]);
}

async function allRowIds(api, table) {
  const ids = [];
  for (let offset = 0; ;) {
    // The worker caps the page size; the answer says which limit it applied.
    const { rows, limit } = await api.apps.post(`/tables/${table}/rows/query`, { limit: 500, offset });
    ids.push(...rows.map((r) => r.id));
    if (rows.length < (limit ?? 500) || rows.length === 0) return ids;
    offset += rows.length;
  }
}

function sameFields(described, wanted) {
  return wanted.every((w) => (described.fields ?? []).some((f) => f.name === w.name && f.kind === w.kind));
}

async function seedTables(api, summary) {
  // An AI column can only be created while the company's AI columns are on (docs/decisions.md).
  const settings = await api.action("kyoube.apps", "decisions.settings");
  if (settings?.settings?.columns !== true) {
    await api.action("kyoube.apps", "decisions.set_settings", { columns: true });
    summary.push(["setting", "AI columns", "updated"]);
  } else {
    summary.push(["setting", "AI columns", "unchanged"]);
  }
  const existing = (await api.apps.get("/tables")).map((t) => t.name);
  for (const name of extras(existing, SEED.tables.map((t) => t.name))) {
    await api.apps.post(`/tables/${name}/drop`);
    summary.push(["table", name, "dropped (not in the seed)"]);
  }
  for (const table of SEED.tables) {
    let status = "reset";
    if (existing.includes(table.name) && !sameFields(await api.apps.get(`/tables/${table.name}`), table.fields)) {
      await api.apps.post(`/tables/${table.name}/drop`);
      status = "created again (its fields had changed)";
    } else if (!existing.includes(table.name)) {
      status = "created";
    }
    if (status !== "reset") {
      await api.apps.post("/tables", { name: table.name, fields: table.fields });
    } else {
      for (const ids of chunk(await allRowIds(api, table.name))) {
        await api.apps.post(`/tables/${table.name}/rows/delete`, { ids });
      }
    }
    for (const rows of chunk(table.rows)) await api.apps.post(`/tables/${table.name}/rows`, { rows });
    summary.push(["table", `${table.name} (${table.rows.length} rows)`, status]);
  }
}

async function seedProject(http, api, companyId, summary) {
  const listed = await http.get(`/api/companies/${companyId}/projects`);
  const projects = Array.isArray(listed) ? listed : (listed?.projects ?? []);
  let project = findOne(projects, SEED.project.name);
  if (project) {
    summary.push(["project", SEED.project.name, "unchanged"]);
  } else {
    const warning = renameWarning("project", SEED.project.name, projects.map((p) => p.name));
    if (warning) console.log(`    ${warning}`);
    project = await http.post(`/api/companies/${companyId}/projects`, { name: SEED.project.name });
    summary.push(["project", SEED.project.name, "created"]);
  }
  const projectId = project.id;
  // Nothing below lists, writes or deletes until the folder is known to be the project's own.
  const folder = managedFolder(await api.action("kyoube.files", "files.workspaces", { projectId }), companyId, projectId);
  if (folder.problem) {
    const fix = folder.path
      ? "Someone gave the project a primary workspace. Remove that workspace from the project (or delete the project), then run this again."
      : "Check that kyoube.files is installed and ready, then run this again.";
    throw new SeedError(`project "${SEED.project.name}" was not reset: ${folder.problem}. Nothing in any project folder was listed, written or deleted. ${fix}`);
  }
  // Every call names the managed folder; if the project is pointed elsewhere meanwhile, kyoube.files no longer lists it and refuses.
  const files = (key, params) => api.action("kyoube.files", key, { projectId, workspaceId: folder.id, ...params });
  const list = async (path) => {
    const listing = await files("files.list", { path });
    return listing?.exists === false ? [] : (listing?.entries ?? []);
  };
  const { top, dirs } = fileLayout(SEED.project.files);
  const wantedKind = (name) => (dirs[name] ? "dir" : "file");

  // Top level: remove what reviewers added, and anything in the seed's place of the wrong kind.
  const topEntries = await list("");
  for (const entry of topEntries) {
    if (!top.includes(entry.name)) {
      await files("files.delete", { path: entry.name, recursive: true });
      summary.push(["project entry", entry.name, "deleted (not in the seed)"]);
    } else if (entry.kind !== wantedKind(entry.name)) {
      await files("files.delete", { path: entry.name, recursive: true });
    }
  }
  const present = new Set((await list("")).map((e) => e.name));
  for (const dir of Object.keys(dirs).sort()) {
    if (!present.has(dir)) await files("files.create", { dir: "", name: dir, kind: "dir" });
    // Inside a seeded folder, too: only the seeded files stay.
    for (const entry of await list(dir)) {
      if (!dirs[dir].includes(entry.name) || entry.kind !== "file") {
        await files("files.delete", { path: `${dir}/${entry.name}`, recursive: true });
        summary.push(["project entry", `${dir}/${entry.name}`, "deleted (not in the seed)"]);
      }
    }
  }
  for (const file of SEED.project.files) {
    let current = null;
    try {
      current = await files("files.read", { path: file.path });
    } catch (error) {
      if (!(error instanceof SeedError) || error.code !== "not_found") throw error;
    }
    if (current && current.encoding === "utf8" && current.content === file.content) {
      summary.push(["file", file.path, "unchanged"]);
      continue;
    }
    await files("files.write", { path: file.path, content: file.content });
    summary.push(["file", file.path, current ? "reset" : "created"]);
  }
}

async function cancelOne(api, slug, id) {
  // The agent's run may still be closing, and the core refuses the change until it has (a
  // conflict); a conflict on a task that has meanwhile finished needs nothing more.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await api.action("kyoube.apps", "apps.task_cancel", { slug, id });
      return 1;
    } catch (error) {
      if (!(error instanceof SeedError) || error.code !== "conflict") throw error;
      const now = await api.action("kyoube.apps", "apps.task_get", { slug, id });
      if (!OPEN_TASK_STATUSES.includes(now?.status)) return 0;
      if (attempt >= 15) throw error;
      await sleep(1000);
    }
  }
}

/** Cancels the open tasks of one app; `mayRemain` when its task list is a full page even after that. */
async function cancelOpenTasks(api, slug) {
  let cancelled = 0;
  let tasks = await api.action("kyoube.apps", "apps.task_list", { slug });
  for (const task of openTasks(tasks)) cancelled += await cancelOne(api, slug, task.id);
  // A full page may hide older tasks: list again, cancel any open one it now shows, and say so.
  if (taskListFull(tasks)) {
    tasks = await api.action("kyoube.apps", "apps.task_list", { slug });
    for (const task of openTasks(tasks)) cancelled += await cancelOne(api, slug, task.id);
  }
  return { cancelled, mayRemain: taskListFull(tasks) };
}

/**
 * The first reset step that touches data: a task's run can go on after it is cancelled and the
 * agent may write rows, so tasks stop before the tables are reset. Every published app counts,
 * including ones archived later in this run (an archived app's tasks can no longer be listed).
 */
async function cancelAppTasks(api, summary) {
  const published = (await api.apps.get("/apps")).filter((a) => a.status === "published");
  let cancelled = 0;
  for (const app of published) {
    const result = await cancelOpenTasks(api, app.slug);
    cancelled += result.cancelled;
    if (result.mayRemain) {
      console.log(`    WARNING: app ${app.slug} has at least ${TASK_LIST_LIMIT} tasks and only the newest ${TASK_LIST_LIMIT} can be listed;`);
      console.log("             older open tasks may remain. Cancel them from the company's task list.");
    }
  }
  summary.push(["open app tasks", "", cancelled > 0 ? `reset (${cancelled} cancelled)` : "unchanged"]);
}

async function seedApp(api, agentCreated, summary) {
  const { slug } = SEED.app.manifest;
  const apps = (await api.apps.get("/apps")).filter((a) => a.status !== "archived");
  for (const app of apps.filter((a) => a.slug !== slug)) {
    await api.apps.post(`/apps/${app.slug}/archive`);
    summary.push(["app", `${app.name} (${app.slug})`, "archived (not in the seed)"]);
  }
  const existing = apps.find((a) => a.slug === slug);
  const want = appShape(SEED.app.manifest, SEED.app.source);
  let status;
  if (!existing) {
    await api.apps.post("/apps", { manifest: SEED.app.manifest, source: SEED.app.source });
    status = "created";
  } else {
    // `latest` by default: a draft a reviewer saved after the published version counts as a change.
    const { app, version } = await api.apps.get(`/apps/${slug}`);
    const same = !agentCreated && app.status === "published" && version && version.version === app.currentVersion
      && appShape(version.manifest, version.source) === want;
    if (same) {
      status = "unchanged";
    } else {
      await api.apps.post(`/apps/${slug}`, { manifest: SEED.app.manifest, source: SEED.app.source });
      status = "updated";
    }
  }
  if (status !== "unchanged") await api.apps.post(`/apps/${slug}/publish`, { tasksConfirmed: true });
  summary.push(["app", `${SEED.app.manifest.name} (${slug})`, status]);
}

async function seedDecisions(http, api, companyId, config, summary) {
  const ticketsAi = "the Tickets table's AI column (refund)";
  if (!config) {
    const settings = await api.action("kyoube.apps", "decisions.settings");
    if (settings?.provider?.configured) {
      summary.push(["decisions provider", settings.provider.provider ?? "set", "unchanged"]);
    } else {
      summary.push(["decisions provider", "(none set)", "unchanged"]);
      console.log(`    note: no decisions provider is set, so ${ticketsAi} stays empty and the review list is empty;`);
      console.log("          run again with --decisions and a provider key to fill it");
    }
    return;
  }
  const secrets = await http.get(`/api/companies/${companyId}/secrets`);
  const secret = findOne(Array.isArray(secrets) ? secrets : (secrets?.secrets ?? []), DECISIONS_SECRET);
  let secretId;
  if (secret) {
    await http.post(`/api/secrets/${secret.id}/rotate`, { value: config.apiKey });
    secretId = secret.id;
  } else {
    secretId = (await http.post(`/api/companies/${companyId}/secrets`, { name: DECISIONS_SECRET, value: config.apiKey })).id;
  }
  summary.push(["company secret", DECISIONS_SECRET, secret ? "updated" : "created"]);
  const current = await http.get(`/api/plugins/kyoube.apps/config?companyId=${encodeURIComponent(companyId)}`);
  const configJson = {
    ...(current?.configJson ?? {}),
    decisionsProvider: config.provider,
    decisionsModel: config.model,
    decisionsApiKey: { type: "secret_ref", secretId, version: "latest" },
  };
  if (config.baseUrl) configJson.decisionsBaseUrl = config.baseUrl;
  else delete configJson.decisionsBaseUrl;
  await http.post("/api/plugins/kyoube.apps/config", { companyId, configJson });
  await api.action("kyoube.apps", "decisions.set_settings", { columns: true });
  const settings = await api.action("kyoube.apps", "decisions.settings");
  if (!settings?.provider?.keyResolves) {
    throw new SeedError(`the decisions provider is set but its key does not resolve: ${settings?.provider?.problem ?? "no reason given"}`);
  }
  await api.apps.post("/tables/tickets/fields/refund/refill");
  summary.push(["decisions provider", `${config.provider} ${config.model}`, "updated"]);
  console.log(`    ${ticketsAi} is filling in the background; rows it is unsure of wait for review`);
}

/** `{ url }` for a new invite, `{ kept: true }` when an open one stays, `{}` once the reviewer is a member. */
async function seedReviewer(http, baseUrl, companyId, newInvite, summary) {
  const { members } = await http.get(`/api/companies/${companyId}/members`);
  const member = (members ?? []).find((m) => (m.user?.email ?? "").toLowerCase() === REVIEWER_EMAIL);
  if (member) {
    summary.push(["reviewer", `${REVIEWER_EMAIL} (${member.membershipRole}, ${member.status})`, "unchanged"]);
    if (member.membershipRole !== "operator") console.log(`    WARNING: ${REVIEWER_EMAIL} is ${member.membershipRole}, not operator; change it under Company Settings → Members`);
    return {};
  }
  // The core keeps only a hash of an invite's token, so an open invite's link cannot be printed
  // again. It may already be in a reviewer's hands, so it stays unless --new-invite asks otherwise.
  const { invites } = await http.get(`/api/companies/${companyId}/invites?state=active`);
  const decision = inviteDecision(invites ?? [], newInvite);
  if (!decision.create) {
    summary.push(["reviewer invite", `${REVIEWER_EMAIL} as operator (open, link given out before)`, "unchanged"]);
    return { kept: true };
  }
  for (const invite of decision.revoke) await http.post(`/api/invites/${invite.id}/revoke`, {});
  const created = await http.post(`/api/companies/${companyId}/invites`, { humanRole: "operator", allowedJoinTypes: "human" });
  const replaced = decision.revoke.length ? `, replacing ${decision.revoke.length} open invite(s)` : "";
  summary.push(["reviewer invite", `${REVIEWER_EMAIL} as operator${replaced}`, "created"]);
  return { url: `${baseUrl}${created.invitePath}` };
}

const CREDENTIAL_NOTE = [
  "    The link is a credential: it is not tied to the email, and anyone who opens it joins as operator.",
  "    Hand it only to the reviewer.",
];

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  const http = makeClient(args.baseUrl, args.key);
  const summary = [];
  console.log(`==> seeding "${COMPANY}" on ${args.baseUrl}`);
  const companyId = await seedCompany(http, summary);
  const api = companyApi(http, companyId);
  console.log(`    company id ${companyId}`);
  await seedMcpSetting(http, summary);
  const { agent, created: agentCreated } = await seedAgent(http, api, companyId, summary);
  await cancelAppTasks(api, summary);
  await cancelAgentTasks(http, companyId, agent, summary);
  await seedTables(api, summary);
  await seedProject(http, api, companyId, summary);
  await seedApp(api, agentCreated, summary);
  await seedDecisions(http, api, companyId, args.decisionsConfig, summary);
  const invite = await seedReviewer(http, args.baseUrl, companyId, args.newInvite, summary);
  console.log("==> summary");
  for (const [kind, name, status] of summary) console.log(`    ${[kind, name].filter(Boolean).join(" ")}: ${status}`);
  if (invite.url) {
    console.log(`==> reviewer invite: ${invite.url}`);
    console.log(`    Open this as ${REVIEWER_EMAIL} while sign-up is open.`);
    for (const line of CREDENTIAL_NOTE) console.log(line);
  } else if (invite.kept) {
    console.log("==> An invite is already open; pass --new-invite to replace it.");
    for (const line of CREDENTIAL_NOTE) console.log(line.replace("The link", "Its link"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`seed-review-company: ${error.message}`);
    process.exit(1);
  });
}
