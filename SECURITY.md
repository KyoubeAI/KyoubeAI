# Security Policy

## Reporting a vulnerability

Report a security vulnerability in **KyoubeAI** (this repository — the bootstrap CLI, the `kyoube.terminal`
and `kyoube.apps` plugins, `install.sh` and `update.sh`, and the Docker overlay) through GitHub's private
Security Advisory feature:

**<https://github.com/KyoubeAI/KyoubeAI/security/advisories/new>**

Do not open a public issue for a security vulnerability. We aim to acknowledge a report and set a
disclosure timeline within **7 days**.

A vulnerability in **the core itself** (Paperclip — the upstream host this project runs `FROM` a
published image, rebranded, themed and with the build-time fixes listed under [Trust zones](#trust-zones))
is out of scope here, except for those fixes; report it upstream instead (see
[Out of scope](#out-of-scope) below).

## Scope

KyoubeAI is a Docker overlay on the upstream core:
a Postgres 17 cluster, the four Kyoube plugins (`kyoube.terminal`, `kyoube.apps`, `kyoube.files`, `kyoube.studio`), and the `kyoube`
bootstrap CLI that renders config, installs the plugins, installs harnesses, and runs diagnostics. Every
Kyoube feature is a plugin; the image changes the core only at build time, by the rebrand, the theme and
a short list of fixes (see [Trust zones](#trust-zones)). So this document describes the security
properties of the overlay, not of the core's own auth, sessions, board API, or MCP tool gateway.

## Trust zones

KyoubeAI's design rests on three zones of trust, each with a different guarantee:

1. **The core.** Upstream, pinned by exact version (`KYOUBE_CORE_VERSION`, bumped in lock-step
   with `@paperclipai/plugin-sdk`), and not changed at run time. It provides authentication, sessions,
   company membership and roles, the activity log, the board API, and the plugin host. Its own security
   model (auth, deployment modes, the MCP tool gateway) is documented upstream — see
   [Out of scope](#out-of-scope). The image build does change it in three ways: the rebrand and the
   theme (presentation only, `docs/branding.md`, `docs/theme.md`), and the fixes in
   `docker/core-patches/patches.mjs`. There are eleven: nine in the served UI (the first-run wizard's
   "Skip for now", and display fixes for the pi and Hermes task chat), one in the Hermes adapter's
   server source (`hermes-quiet-default`: an unset Quiet output passes Hermes `-Q`, as the agent form
   already showed) and, new in 1.1, one in the compiled server code.
   `anthropic-signin-setup-token` changes the command the server presents for a Claude subscription
   sign-in, in `server/dist/services/local-ai-login.js`: `claude auth login` becomes
   `kyoube connect claude`, which runs `claude setup-token` in the same sign-in folder. (The agent Test
   route fix that 1.1 also carried, `adapter-test-unsaved-harness-switch`, is upstream since core
   2026.1001, upstream commit 9335b7d, and was deleted.) Each patch has to match the core's code exactly once, or
   the image build fails and names the patch, so a core bump cannot carry one over silently. A flaw in
   one of these patches is in scope here.
2. **Kyoube plugins — trusted code.** `kyoube.terminal`, `kyoube.apps` and `kyoube.files` are first-party
   code, reviewed and shipped with the image, running as core plugin workers. The apps plugin holds its
   **own** database credential — the `kyoube` Postgres login role (`LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT`,
   created once by `docker/postgres-init/01-kyoube.sh`) — which owns the separate `kyoube` database and
   has **no** privilege on the `kyoubeai` database at all (`REVOKE CONNECT ON DATABASE kyoubeai FROM
   PUBLIC`, and `kyoube` is never granted it). A compromise of a Kyoube plugin cannot reach the core's
   own data through that credential; it is still, however, trusted code running inside the same
   container as the core, with everything that implies (see [Terminal](#terminal) below). The files
   plugin holds no credential at all: it reads and writes project folders on the home volume as the
   container's `node` user, within the bounds described under [Files](#files).
3. **Apps — untrusted, sandboxed code.** An app is one HTML document, typically written by an agent,
   that a person with schema access chooses to publish. It runs in a browser iframe with an opaque
   origin and a restrictive Content-Security-Policy, and every data call it makes is re-authorised
   under the identity of the person *viewing* the app, never the app's own. See [Apps](#apps) below for
   exactly what that sandbox does and does not cover.

## Terminal

Company **owners and admins** (the roles are configurable under **Settings → Plugins → Kyoube
Terminal**) get a browser terminal into the `app` container as the `node` user — this is **full
instance access**: the Postgres superuser password, every agent harness's stored credentials, the
board API key, and the ability to run anything the container's user can run. It is not a sandboxed or
scoped surface, and it is not intended to be one; treat it exactly like shell access to the whole
deployment, and keep `allowedRoles` tight.

Since 1.1 the `node` user has passwordless `sudo` inside the container. The server, its agents and every
Terminal shell run as `node`, so agents have root in the container too. This is a small step from the
trust that already existed: `node` owns the core's code in `/app` and can read the server's environment,
including the database credentials and `BETTER_AUTH_SECRET`. The boundary is the container itself: it is
not privileged, keeps Docker's default seccomp and AppArmor profiles and a `pids_limit`, and the compose
file adds no capabilities beyond Docker's defaults. Root in the container (which `sudo` reaches) holds
those defaults, `NET_RAW` among them, so it can open raw sockets, for example to spoof traffic on the
Docker network. If you do not need that, drop it in an untracked `docker-compose.override.yml`; `sudo`
and the Terminal work the same without it:

```yaml
services:
  app:
    cap_drop: [NET_RAW]
```

`/kyoubeai/.local/bin` is first on the `PATH` of the server, every agent and every Terminal shell, and
agents can write there, so anything placed in it shadows any command of the same name, not only
harnesses. That is the same trust as a harness's own settings files such as `~/.claude/settings.json`.
The container's start-up and the server's own Node are the exception: they run the image's programs by
absolute path, so a `node` or `chown` installed there cannot stop the container starting. Codex's sandbox
bypass stays on, because its own sandbox cannot run in a container.

**Trusted runtime host.** `KYOUBE_TRUSTED_RUNTIME_HOST` defaults to `auto`: the entrypoint
(`docker/entrypoint.sh`) exports `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` set to the container's hostname,
which tells the core that this container is a host where local tools may run. The core only checks it on
an authenticated, public instance (`KYOUBE_DEPLOYMENT_EXPOSURE=public`); on a private one, the default,
nothing depends on it. On a public instance it gates two things. The first is enabling and running local
stdio MCP connections, which the server runs inside the container as `node`. Registering the commands
they may run (`POST /api/companies/:id/tools/stdio-templates`) is not gated by it: that takes
`tools:admin`, checked by the core's `assertToolsAdmin`, which an instance admin and the core's local
implicit actor pass as well, with or without a trusted host. The second is the server-host sign-in for
subscription connections (Claude, Codex, Grok) in Connections, with its command run in the container's
Terminal. By default only the owner and admin roles hold `tools:admin` (the core's
`company-member-roles`). Because `node` has passwordless `sudo`, those commands run as a
user that can become root in the container. That is the same trust as the Terminal, whose `allowedRoles`
default to owner and admin, and as `agents:configure`, which the same two roles hold and which can
already set the command an agent runs.

To turn it off, set `KYOUBE_TRUSTED_RUNTIME_HOST=` (empty) in `.env` and run `docker compose up -d`. On
a public instance the core then refuses to enable local stdio MCP connections and to run them, and
server-host subscription sign-in is unavailable; an API key, or a harness's own login made in the
Terminal, still works. A private instance behaves the same either way. Any other value is used as the
host id itself, and a `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` set directly in a compose override wins.

Every session open and close, and every access denial, is recorded in the company's activity
log — **keystrokes and terminal output are never logged**, only that a session existed and who opened
it. Every terminal action (`open`, `attach`, `wait`, `input`, `resize`, `close`, `list`, `kill`) re-derives the
caller's identity from the actor the core supplies and re-checks their company role against
`allowedRoles` on every call, bound to that session's own company.

**Where that role check comes from.** `terminal.open` reads the caller's role from the core's
members API **every time**, bypassing (and refreshing) the 30-second membership cache described
under [Data](#data): opening a terminal is full instance access, so it is never granted on a cached
answer. `attach`, `wait`, `input`, `resize`, `close`, `list` and `kill` take the cached answer, because each
one acts on a session this user already opened. Plainly: a demoted or removed admin cannot open a
new terminal from the moment the change lands, and can keep typing into a session they already have
open for **at most 30 seconds** after it — less, if any `terminal.open` in that company refreshes the
cache sooner. The session's shell is not killed by the role change itself; it keeps running until
someone kills it (`terminal.kill`, available to any allowed role in the company) or the idle sweep
closes it, 30 minutes idle by default.

**`terminal.can_open` is advisory, not an authorization check.** The terminal plugin registers a UI
data read, `terminal.can_open`, that takes a `companyId` and a `userId` and answers whether that user's
company role is in the terminal's `allowedRoles`. The core's plugin data-provider API carries no
actor context, so the worker cannot verify that the caller is the user it is being asked about: anyone
who can perform the read can ask about any user id. The host confines that to company membership — a
data read is scoped to a company the caller belongs to — so the exposure is that one member of a
company can learn whether another member of the same company holds a role allowed to open a terminal.
No credential, no session content and no capability is disclosed. The answer is used for one thing:
whether the Terminal entry appears in that user's sidebar. It grants nothing. Every terminal action
re-derives the caller's identity from the host-supplied actor and re-checks the role against
`allowedRoles` through the members API — `terminal.open` against a fresh read of it on every call,
`attach`/`wait`/`input`/`resize`/`close`/`list`/`kill` against the 30-second cached one (see above), each
additionally bound to the session's own company — so a forged `userId` in the data read cannot open,
reach or reveal a terminal session.

Terminal output is pulled, never pushed: the page polls `terminal.wait`, which is bound to the
session's owner and company exactly like `attach` (a session in another company answers `not_found`,
another user's `forbidden`), so there is no per-session secret to guard and no channel that could be
listed or guessed. The SSE stream channel the original design relied on is gone: upstream core
(2026.831.1 through 2026.1012.0) never wires its plugin stream bridge (the route answers 501), which is why the terminal
does not use it.

## Data

Every company gets its own Postgres schema (`c_<company uuid, hex>`) and its own `NOLOGIN` role
(`kyoube_c_<hex>`) that owns that schema and nothing else. Every data operation — through the
`kyoube.apps:data_*` tools, the REST routes, or an app's runtime calls — runs inside a transaction that
sets a statement timeout, sets `search_path` to that schema alone, and `SET LOCAL ROLE`s into the
company's own role before touching anything, so cross-company data access is impossible at the
Postgres level, not just at the plugin's: no other company role holds any privilege on a schema that
isn't its own.

- **Access levels** are `none < read < write < schema`, held per person (via their company role, or a
  user group's level, see [Groups](#groups)) or per agent (an explicit grant, defaulting to `none`), set
  under **Company Settings → Data access**.
- **UI data reads are advisory, not an authorization check** — the same shape of residual as
  `terminal.can_open` above. The plugin's UI-facing reads (`data.tables`, `data.table`, `data.rows`,
  `data.count`, `data.access`, behind `DataPage.tsx`, `SidebarEntry.tsx`, and the apps gallery's
  `AppsPage.tsx`/`AppsSidebarEntry.tsx`) build their actor from `params.userId`, which is
  client-supplied, not host-authenticated: the core's plugin data-provider bridge passes it straight
  through instead of deriving it from the signed-in session the way an action call does. This is safe
  only because a read needs no more than `read`-level access, which every company member already
  holds, and because the core's own company-membership check gates the read before it ever reaches
  the plugin worker — that gate is the real authorization, not the identity the read reports. Every
  mutation and schema change instead takes its actor from the host-authenticated action context,
  exactly as every Terminal action does.
- **Read-only SQL (`data_sql_select`, `POST /sql`).** A statement must be exactly one `SELECT` (CTEs
  and `UNION [ALL]` included) with no locking clause, at most 20,000 characters, with at most 50 bound
  parameters, returning at most 1,000 rows within a 5-second statement timeout. It may name only that
  company's own active tables, written as bare names — a schema-qualified name of any kind, a Postgres
  catalog relation, `information_schema`, `kyoube_meta`, and another company's schema are all rejected
  before the query runs. It may call only an allowlist of pure builtin functions (common aggregate,
  string, math, date/time, JSON, array and window functions, documented in the Kyoube Data skill);
  every other function is rejected, and no `pg_*` function is on the list at all. Casts to Postgres'
  OID alias types (`regclass`, `regproc`, `regtype`, …) are rejected, since they resolve catalog
  identifiers. The statement runs as the company's own NOLOGIN role in a read-only transaction, so even
  a validator gap could not reach another company's data or the core's own database. Introspection
  goes through `data_list_tables` / `data_describe_table`. One residual: `OPERATOR(schema.op)` parses
  as an operator rather than a function call, so the schema-prefix rule does not reach it — an operator
  resolves only to an operator, both operands are still checked, and nothing in this plugin creates a
  user-defined operator, so the reachable set is Postgres' own built-in operators (documented in
  `src/data/sql-functions.ts`). The allowlist is itself the security boundary for what SQL may reach;
  requesting an addition to it is a code change and review, not a runtime setting.
- **Row and statement caps.** A call may target at most 500 row ids and bind at most 5,000 parameter
  values (one per column per row, plus two); both are enforced on every statement the records service
  assembles (`insert`, `update`, `delete`, `query`, `count`).
- **Audit.** Every schema and row mutation, every agent-grant and data-settings change, and every app
  lifecycle change (create, publish, rollback, archive) writes one row to `kyoube_meta.audit` **inside
  the same transaction as the change itself** — a change is never committed unrecorded, and an audit
  row is never left behind for a change that rolled back. Audit rows record the actor, the operation,
  and identifying metadata (table/field/app names, affected ids or counts) — **never row contents**.
  Postgres error `detail` (which can carry the offending value) is scrubbed before a mapped error
  reaches any caller-visible surface or the activity log; the raw driver error is kept only in the
  operator log, for diagnosis.
- **Soft deletes.** Dropped tables and removed fields are recoverable for 30 days unless the company
  has enabled hard deletes.
- **Company-role cache.** KyoubeAI caches each company's membership list from the core for 30 seconds
  (the terminal keeps its own cache of the same shape — see [Terminal](#terminal) for which of its
  actions bypass it).
  Schema changes (creating, altering, renaming or dropping tables and fields, and creating indexes),
  data-access administration (agent grants and company data settings), and publishing, rolling back or
  archiving an app all re-read the caller's role from the core first, so removing or demoting a member
  takes those away immediately. Reads and row writes take the cached answer: for up to 30 seconds after
  a member is removed or demoted, an in-flight session of theirs may still read, insert, update or
  delete rows at their previous level. Nothing they do in that window is unaudited — every mutation is
  recorded in `kyoube_meta.audit` with their identity — and the window closes on its own. Revoking a
  company's data access entirely (rather than one member's) takes effect at once.

## Groups

User groups (`docs/groups.md`) restrict which people may open which apps, give work to which agents,
and what data level they hold. Group tables are in `kyoube_meta` (`groups`, `group_members`,
`group_agents`, `group_apps`).

- **Apps.** An app in a group is hidden from the gallery and refused (`forbidden`) on get, runtime,
  runtime data, decide and preview for anyone outside its groups. The check is in `AppService`, reads
  the tables on every call (no cache) and so does not depend on the browser. Restricting an app
  hides and refuses the app only: its tables stay reachable on the Data page and through any other
  app that declares them, at the person's own data level.
- **Data levels.** `DataService.levelFor` takes the highest level among a person's groups that set
  one, otherwise the role mapping. A viewer stays at `read` whatever their groups say: the core
  refuses every non-GET request from a viewer ("Viewer access is read-only"), so groups can lower an
  operator but never raise a viewer. A group level is never below `read`: the Data page's UI reads
  build their actor from a client-supplied id (see [Data](#data)) and are safe only because `read` is
  the floor. A group level cannot reveal anything a member could not already read.
- **Owners and admins** are exempt from all of it and always `schema`.
- **Managing groups, and data-access administration.** Only owners and admins, with the caller's
  role re-read from the core on every mutation. Agent grants, data settings and typed-decision
  settings stay with owners and admins by role: a group's `schema` level never grants them. The
  settings page reads groups through host-authenticated actions, never the client-supplied id path,
  so a client-supplied id cannot reveal who is in a group.
- **Audit.** Every group mutation writes one `kyoube_meta.audit` row in the same transaction,
  recording ids and never people's names.
- **Licence.** Any valid key unlocks creating and changing groups. Enforcement never depends on the
  licence: an expired or removed key leaves existing groups in force, and deleting a group is always
  allowed.
- **Agents.** Enforcement uses the core's own checks. `kyoube.agent-rules` marks listed agents
  protected and scopes people's `tasks:assign` grants, once a minute, so a change takes up to a
  minute to apply. A grant someone scoped by hand is left alone and reported, and one changed after
  KyoubeAI wrote it stays as they set it (unless it equals the person's original role default or
  KyoubeAI's last write). An agent whose authorization policy has keys KyoubeAI does not change cannot
  be protected and is reported as skipped. The core already refuses everyone assignment to an agent
  with such a policy, but the chat check below covers protected agents only and does not cover it.
  If the agent-access list cannot be read or is malformed, the company's group step is skipped and
  reported, never applied as "no groups".
  While the watcher is not running, agent restrictions stop updating; `kyoube doctor` warns.
  Accepted residual: from core 2026.1012.0 an agent's email inbox (AgentMail) works without the
  experimental Chat connectors setting, and the core creates a task assigned to that agent for every
  new email thread with no assignment check. A restricted agent with an inbox therefore takes work
  from anyone who can email it. Only someone with `tools:manage_connections` (owners and admins by
  default) can set up an inbox.
- **Sync routes: the kyoube CLI, or owners and admins.** A plugin route declared `auth: "board"` is
  not limited to instance admins: the core's board check only asks whether the caller is a signed-in
  person rather than an agent, so every company member passes it. "Board-only" therefore means "no
  agents". The routes that read or change who may use which agent, or which agents may ask which,
  check more: `kyoube.apps` `POST /groups/agent-access` and `POST /groups/sync-report`,
  `kyoube.studio` `POST /ask-levels`, and `kyoube.agent-rules`
  `POST /groups/apply`, `POST /reconcile` and `POST /revert` answer 403 unless the request body's
  `rulesToken` matches the **rules token**, or the caller's company role, read fresh from the core's
  members list, is owner or admin. The check runs before any work, so a refused request reads, writes
  and records nothing. The rules token is 32 random bytes in `kyoube/rules-token` on the home volume
  (mode 600, owned by `node`), created by `kyoube agent-rules` on its first run. Only the container's
  own processes can read it, so a request carrying it came from the kyoube CLI; the plugins compare it
  in constant time and read the file on every request, so a missing or unreadable file refuses that
  path. It travels only in POST bodies, never in a URL, and is never logged. The board key's user
  must be a member (any role) of each company for the agent working rules and group sync to run
  there, because the core refuses the key in any other company before a plugin runs; the token lets
  that member pass the owner-or-admin check without holding either role. **Residual:**
  code running inside the container (an agent's harness, the Terminal) can read the token, as it can
  the board key. Delete the file to rotate it; the next pass creates a new one.
- **Chat.** The core's Agent Chat routes skip the assignment check. A standing core patch
  (`groups-chat-open-assign-check`, `groups-chat-message-assign-check`) adds it, for protected agents,
  when a chat is opened and when a message is sent. Other chat actions in an open chat (answering an
  interaction card, uploading an attachment) are only checked against the chat's owner by the core.
  Someone who loses the right cannot reopen their chat panel; the conversation stays readable as an
  issue. Viewers cannot assign or chat with any agent on this core, which refuses their every
  non-GET request; agent-rules never gives a viewer an assignment grant.
- **Agent questions.** A standing core patch (`agent-questions-ask-level`) checks every question card
  an agent addresses to another agent: the asker's ask level (no agents, its line, any agent) and the
  per-task limits (one open, three in all). A question it lets through is answerable by the addressed
  agent or a person; every other card stays people-only. The check reads the level from the agent's
  metadata, which the loop copies from Studio once a minute. If the check cannot run, the question is
  refused. **Residuals:** an agent with `agents:configure` (every new agent on core 2026.1012.0) can
  edit its own metadata or `reportsTo`, widening what it may ask until the next pass, at most a minute
  for the level. Refused questions are not recorded, so `kyoube doctor` counts only questions that
  were let through.
- **Residual: agents are visible.** The core has no per-agent visibility, so people outside a group
  can still see its agents, their tasks and their runs. Groups restrict giving work and chat, not
  seeing.
- **Residual: people are shown by id and role.** The core's plugin API gives no display names.
- **Residual: `data.access` can hint at a colleague's group.** The Data page's `data.access` read
  builds its actor from a client-supplied user id (the existing model, see [Data](#data)), and returns
  that person's effective level, which now includes any group level. A member who sends a named
  colleague's id can therefore learn their level and, by comparing it with their role, whether a group
  sets it (not which group).

## Apps

An app is one HTML document written by an agent and reviewed by whoever publishes it. It runs in an
iframe with `sandbox="allow-scripts allow-forms allow-modals allow-downloads"` (no `allow-same-origin`, so an opaque
origin: no cookies, no storage, no host DOM) under an injected `Content-Security-Policy` of
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`. Data reaches it only through
a `postMessage` bridge that re-authorises every call under **the viewer's own identity** and against
the published manifest's declared tables, so an app can never do more than the person using it could do
on the Data page.

Each mount also has a **call budget** (60 requests per rolling 10 seconds, of which at most 5 may be
toasts; every non-handshake request counts, including one the host refuses as invalid — a message
that is not a well-formed request, or carries the wrong nonce, is dropped without being charged).
Five residuals are known and accepted, documented in full in `docs/apps.md`:

- **DNS prefetch and preconnect are not governed by CSP.** `<link rel="dns-prefetch">` /
  `<link rel="preconnect">` ask the browser to resolve a hostname and open a socket, not to fetch a
  resource, and no CSP directive covers them. This is a one-way, low-bandwidth channel — nothing is
  fetched, no response is readable, and `connect-src 'none'` still blocks every actual request — so it
  can leak a fact (via a hostname), not a table. Forbidden by the authoring rules; every version's
  source is stored and reviewable.
- **An app can navigate its own frame, and briefly keeps the same `WindowProxy`.** Neither a sandbox
  token nor a CSP directive stops a frame assigning `location`. Two independent mechanisms close this:
  the runner counts loads and kills the app on the second, and every message must carry the per-mount
  handshake nonce the runner inlined ahead of the SDK — 16 random bytes written into the document
  immediately ahead of the injected `window.kyoube` SDK, before any app-authored byte is parsed — which
  the SDK removes from both `window` and the DOM as it installs, so app code never reads it back and a
  document that merely arrives by navigation cannot know it. Nor can app code read it off the SDK's own
  traffic: the SDK binds `window.parent` at install, before any app byte is parsed, so assigning over
  that property afterwards intercepts nothing (ruling P4-R37). What an app in the frame holds
  regardless is the context it asked for through its own `kyoube.ready()`, and the choice of URL it
  navigates itself to — a cooperating app needs no nonce for either. Three attempts without the nonce
  stop the app. The viewer's context is released
  only in answer to a message carrying that nonce, never on a frame load, so a document arriving by
  navigation alone is told nothing about the company, the viewer or the app. The residual is that the
  *navigation itself* still happens, so a URL an app navigates to is a URL the browser requests; it
  carries no host credentials (opaque origin, no cookies, no storage) and gets nothing back that the
  app can read.
- **An app can save a file without the download checks.** `allow-downloads` is on the sandbox so apps
  can export files. `kyoube.ui.download` is checked on the host page (an allowlist of data and
  document types, 25 MB, a cleaned name, 3 per 10 seconds, a Save bar when the viewer did not just
  click). The frame can still save a file by itself with `<a download>`, skipping those checks. The
  file goes only to the viewer's own disk and nothing is sent while the app runs (`connect-src
  'none'` is unchanged). But a file a browser can run, an `.html` or `.svg` saved this way, can send
  what it holds to a server once the viewer opens it from disk. That is a weaker form of the
  self-navigation residual above, since it needs the viewer to open the file. Forbidden by the
  authoring rules; every version's source is stored and reviewable.
- **`sql_select` allows a schema-qualified `OPERATOR(schema.op)`** — see the Data section above.
- **`viewer.name` is always empty in v1** — the host gives an app the viewer's id, not their display
  name (see `docs/apps.md`), so an app cannot greet a viewer by name.

## Connections

Connections (`docs/connections.md`) let a Kyoube App or an agent call an outside service with a key
the company stores. The plugin worker makes every call; the app's frame keeps `connect-src 'none'`.

- **The key stays in the worker.** It is a company secret an admin picks in the plugin settings. The
  worker resolves it (cached 60 seconds) and adds it to the outgoing request only. It is never sent
  to the frame or an agent, never in a response, an error message, the audit or the activity log.
  Response headers are cut to an allow-list (`content-type`, `content-length`, `etag`,
  `last-modified`, `location`, `retry-after`, `x-request-id`, `x-ratelimit-*`), so a service that
  echoes the key or sets a cookie cannot hand it back.
- **A call cannot be redirected.** The caller cannot change the scheme, host or port. The path is
  joined to the base URL as text and refused when it holds an absolute URL, a leading slash or
  backslash, `//`, a dot segment in any form (encoded, double-encoded, full-width, or a server-
  normalised one such as `..;`), raw non-ASCII characters, a leftover `%` or a control character.
  The caller may set only six request headers, never `authorization`, `cookie`, `host` or the
  connection's own header. The core refuses private and reserved addresses, pins the connection to
  the resolved address and never follows a redirect, so a 3xx is returned as it is. A base URL must
  be `https`.
- **Calls run as the caller.** An app's viewer needs data level `read` for a GET and `write` for the
  rest, the manifest must declare the connection, and the connection's own methods apply; each can
  only narrow. Groups decide who opens the app. An agent needs a per-connection grant from an owner
  or admin (read fresh by role, default `none`), a grant never widens the connection, and the
  guardrail can hold an agent's non-GET call for a person's confirmation. The confirmation covers
  connection, method, path, query and body, so it cannot be swapped for another call.
- **A person decides what an app may reach.** A version that adds a connection, or widens one from
  `read` to `read-write`, must be published by a person who sees the host, auth style and methods and
  confirms (`connectionsConfirmed`). Agents cannot publish or roll back to such a version.
- **Every call is audited without contents.** One `kyoube_meta.audit` row per call: connection,
  method, path without the query, status, duration, response size and how it was called. Never
  request or response bodies, query values, headers or the secret. Agent calls also go to the
  activity log. If the audit row for a completed write cannot be saved, the response is still
  returned and the failure is logged on the server; a GET fails instead, so a read is not released
  unrecorded.
- **Limits.** 20 connections per company, 10 per app, 1 MiB request body, 2 MiB text response, 25
  seconds per call, 30 calls per 10 seconds per running app (inside the 60-request budget).
- **Residual: data can leave the company.** A published app can send data its viewer can read to a
  service it declared, and an agent with a grant can do the same within its grant. A read-only
  connection limits changes at the other end, not what a GET's query string can carry. The controls
  are the publish confirmation, explicit agent grants, the guardrail and the audit. Give a connection
  the narrowest methods and a key scoped at the service to what the apps need.
- **Residual: the service sees the company's key and the data sent.** Anything a service does with a
  request is outside KyoubeAI.
- **Residual: text only.** Binary responses are not supported and come back garbled or `too_large`.
  A service that returns secrets in a body can show them to the caller that asked, which is why
  access is narrow.

## App tasks

App tasks (`docs/app-tasks.md`) let a Kyoube App hand work to a company agent. The agent receives the
task as a normal task and acts with its own access.

- **No new authority.** The task is created as the person using the app, after the same assignment
  decision the core makes for that person (`previewAssignment`), so a protected agent still needs a
  `tasks:assign` grant, even for an owner or admin. The agent works under its own data grant, with the
  guardrail and the audit applying to its writes. Only people start or cancel tasks; agents cannot.
- **A person decides what an app may ask.** A version that adds a template or changes any part of one
  must be published by a person who sees the agent, the exact title and instructions, the table and
  fields and the inputs (`tasksConfirmed`). Agents cannot publish or roll back to such a version. A
  published version keeps the agent ids it was published with, written in the same transaction as the
  publish, so a rename cannot redirect a template; names are looked up only when a template is added
  or changed, or when the agent it reaches would change, which also needs a person. A rollback to a
  version with the same text but another agent, or a publish over a version with no agent recorded,
  is held to the same rule.
- **Prompt injection from Data.** Row values and inputs reach the agent in one labelled JSON block
  inside a `json` fence. Values are JSON-encoded, each cut to 2,000 characters, the block to 16,000
  (`"_cut": true` when anything was cut), and any run of three or more backticks is broken up, so a
  value cannot close the fence or add a heading. Inputs are typed and short. Row values also reach the
  title and instructions through `{{row.x}}` placeholders, flattened to one line (every line break,
  U+2028 and U+2029 included), with braces removed, fence runs broken and cut to 200 characters.
  Outside the data block the agent reads only text a person confirmed (the template's title and
  instructions and the fixed sections), the app's slug, version and template key, and those placeholder
  copies; the app's display name, which an agent can change, is not sent. Template authors should put
  row placeholders in the middle of a sentence. Residual: a placeholder copy is still up to 200
  characters of row text in the instructions.
- **Data shared with the agent** is the declared fields of one row the person can read, and typed
  inputs. The instructions are fixed text a person confirmed.
- **Residual: a row value can still try to persuade the agent.** A hostile value inside the data block
  can ask the agent to do something else. The agent is told to treat the block as data, and its own
  data access and the guardrail bound the damage; nothing stops an agent from writing outside the
  named fields except its instructions.
- **Residual: cancel is not a stop.** The core cannot stop a run already in progress; a cancelled
  task's agent may still write before it ends (`runMayContinue`). If recording the cancel fails, the
  task is already cancelled although the app saw an error.
- **The result is untrusted text.** The agent's reply reaches the app as plain text of at most 20,000
  characters; an app must show it with `textContent`.
- **Spam.** 10 starts a minute per person per app, 25 open tasks per app, 5 `tasks.start` per 10
  seconds per frame, 10 watches per frame, and the core's own budget checks on wake-ups. A start for a
  paused agent is refused; one whose wake-up the core refuses is cancelled at once (audited as
  `app_task_cancel` with `reason: "wake_refused"`), so refused work never sits in the agent's queue.
- **Every start and cancel is audited without contents** (`app_task_start`, `app_task_cancel`: app,
  version, template, agent and task id; never row values or inputs). The core's activity log records
  the person and the plugin on creation.

## Files

The **Files** tab on a project page lets company members browse and change the project's working
folder — the configured workspace, or the managed folder the core creates for the project under
`/kyoubeai/instances/default/projects/<companyId>/<projectId>/` — which is the folder the project's
agents run in. It is deliberately a narrow surface: one folder per project, chosen by the core (the
plugin asks the host for the project's effective local folder through `ctx.projects.getPrimaryWorkspace`
and never derives or accepts a path from the browser), for people who can already open that project.

**Who may use it.** Every action — reads included — is a host-authenticated `performAction` call, so
the caller's identity is the actor the core supplies, never a client-supplied id, and it must be a
signed-in user (agents are refused; they have the folder already). The user's company role is checked
against the plugin's `readRoles` (default: every role) or `writeRoles` (default: every role but
`viewer`) under **Settings → Plugins → Kyoube Files**. Reads take the same 30-second membership cache as
the Data page; every mutation reads the members API afresh, so a demoted or removed member can browse
for at most 30 more seconds and can change nothing from the moment the change lands. Project
visibility in core 2026.831.1 through 2026.1012.0 is company-wide (`project:read` is granted to every active member in its
simple permissions mode), so the company role is the right unit here; if a future core adds
per-project membership the plugin will need to consult it, and this section will say so. The project
must be in the host's company scope: `getPrimaryWorkspace` answers `null` otherwise, and a
`params.companyId` that contradicts the host's scope is rejected as spoofing, exactly as in the other
two plugins.

**What it can reach.** Two invariants, both enforced in `WorkspaceFiles`
(`plugins/kyoube-files/src/fs-service.ts`) and covered by its tests:

1. *Nothing outside the project folder is ever touched.* A path is normalised before the disk is
   consulted (absolute paths, `..` segments, NUL bytes and backslashes are refused outright), and the
   *resolved* location of every parent directory is then checked against the folder's own resolved
   location — so a symbolic link that an agent, or a cloned repository, left inside the folder cannot
   lead a listing, a read or a write out of it.
2. *Symbolic links are never followed.* They are listed as links, may be renamed or deleted (which
   acts on the link, never its target), and are refused for read and write. Following one would let a
   link to, say, `/kyoubeai/.claude/.credentials.json` be read by anyone who can browse the project.

Within those bounds the plugin does what a file manager does: `.env` files, keys an agent wrote into
the folder, and `.git` internals are all visible and editable to anyone the role settings admit, the
same as they are to every agent that runs there. Keep secrets an agent needs in the core's Secrets, not
in the project folder, and keep `readRoles` no wider than the people who should see the project's work.

**Limits.** The editor opens files up to `maxEditableKb` (1 MiB by default; larger files are download-
only, never truncated — a truncated file that was then saved would be a destroyed file), a single upload
is capped at `maxUploadMb` (5 MiB by default, clamped to 7 because the core's 10 MB JSON body limit is
the ceiling for a base64 payload), and a download at `maxDownloadMb` (25 MiB). A save carries the
modification time the file had when it was opened and is refused (`conflict`) if the file changed
since, so a person and an agent editing the same file cannot silently overwrite each other; the person
chooses to reload or overwrite.

**HTML preview.** An HTML file opens rendered, in an `<iframe sandbox="allow-scripts allow-forms
allow-modals">` (no `allow-same-origin`: an opaque origin with no cookies, no storage and no host DOM)
under the same policy the [Apps](#apps) runner injects — `default-src 'none'`, `connect-src 'none'`,
`form-action 'none'`, `base-uri 'none'`, inline script and style only, `data:`/`blob:` images — so a
page an agent wrote can run its own script but cannot reach the network, navigate the host, or read
anything the viewer can. Because the frame cannot fetch, the plugin inlines the stylesheets, scripts
and images the page references by *relative* path from the same project folder (through the same
authorised `files.read` action, so nothing the viewer could not open is inlined; at most 40 files, and
absolute URLs are left unresolved and therefore blocked). The preview shows nothing that the source
view would not, to the same person.

**The task panel.** The folder icon in the top bar is a `globalToolbarButton` slot, whose host
context carries only the company. The component reads the task reference from the URL and asks the
worker (`files.locate`) which project it belongs to — through `ctx.issues.get`, which answers `null`
for a task outside the company — and shows the icon only when the caller's role may browse. The
docked panel then goes through exactly the same actions and checks as the project tab.

**What is logged.** Every mutation writes one line to the company's activity log — the operation, the
path, the workspace and the user — and never file content. Reads are not logged.

## Studio

The Studio design is two parts. `docker/theme` adds a stylesheet, fonts and a short inline boot
script to the served UI at build time; the script only sets two attributes on `<html>` (a platform
hint for the ⌘K label and the layout flag) and makes no network requests. The `kyoube.studio` plugin
draws Home, the sidebar's Build group and Team roster, the agent profiles and the Workspace page.

**What it reads.** Through the host-scoped `getData` bridge only: the company's agents (name, title,
icon, status, last run, error reason), its tasks (identifier, title, status, assignee, timestamps),
its pending approvals (type and the title or name in the payload), its projects (a count), its
members' roles, an agent's harness and skill names (from its adapter configuration; no other
configuration value leaves the worker), and the agent's own comments on the task it is working on. That is the same company-wide information the core's own dashboard, inbox and task
list show every member; hidden tasks are skipped. It has no API routes, no agent tools, no jobs, no
outbound network, no database and no secrets, and the plugin itself writes nothing: its only
capabilities are `agents.read`, `issues.read`, `issue.comments.read`, `approvals.read`,
`projects.read`, `access.members.read` and the UI slot registrations.

**The profile's actions.** The agent profile's **On duty** switch and **Assign task** form call the
core's documented board API from the browser as the signed-in person (`POST /api/agents/{id}/pause`
and `/resume`, `POST /api/companies/{companyId}/issues`), exactly as the core's own buttons do: the
core checks that person's access and applies its own side effects (pausing cancels the agent's active
run; the new task wakes the agent). The plugin grants no one a power they did not already have.

**Which company.** The host puts the caller's authorized company into every bridge call and refuses a
call without one unless the caller is an instance admin, so a person only ever sees their own
company's figures. The Workspace page's owner/admin check (which cards to show) uses the user id the
page sends and is cosmetic only: the Terminal and Plugins pages it links to enforce their own access.

**In the browser.** The only thing Studio stores is a per-company flag in `localStorage` recording
that the getting-started strip was dismissed. Agent characters are SVG generated from a fixed set of
shapes; an agent's name only picks among them and is never put into the markup.

## Push notifications

`kyoube.notify` sends Web Push from the instance to the push services of people's browsers (see
`docs/mobile.md`).

**Where it sends.** Only to a device's push endpoint, and only if the endpoint is `https://` on
`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com` or `*.notify.windows.com`,
with no port and no credentials in the URL. The check runs when a device is added (`notify.subscribe`,
`parseSubscription` in `src/webpush/endpoints.ts`), and anything else is refused there. Stored device
records are written only through that action, so every stored endpoint has passed it; a send uses the
stored endpoint and does not check it again. This is what stops a crafted "subscription" from making
the server post to an address of someone's choosing. Browser keys that are not on the P-256 curve are
refused at the same point.

**How it sends.** The push goes out through Node's own `fetch` with redirects refused, not the host's
`ctx.http.fetch`. The SDK bridge turns a request body into a string and drops every other option, so it
cannot carry an encrypted binary body or refuse a redirect. The endpoint allowlist, applied when a device
is added, is therefore the only gate on where a push goes. The plugin's tests cover the allowlist and the
subscription checks; they do not re-check endpoints at send time, because the send path has no such check. The manifest does not declare `http.outbound`.

**What is in a notification.** An agent's name, a task identifier and title, or an approval's type and
name, and a question's title or a fixed label. Never comment text, a question's summary or body, or app
data, because a lock screen is visible to others. Only active company members are sent anything, and
checked on every send; viewers are not sent approvals.

**What the push services see.** That a notification was sent to a device, when, and its size. The
payload is encrypted (RFC 8291) to the device's own keys, so they cannot read it.

**The VAPID private key** lives in the plugin's state, inside the core database, so it is in backups of
it. Restoring someone else's backup changes the instance's keys; devices then need turning off and on
(`docs/mobile.md`, Troubleshooting).

**The test endpoint file.** For the smoke test only, the worker also accepts exactly the one URL named in
`/kyoubeai/kyoube/push-test-endpoint`, so a local receiver can prove a real push decrypts. Only
`scripts/smoke.sh` writes it. `kyoube doctor` fails a public instance that has the file and warns on a
private one.

## Telemetry

**Licensing is offline.** Licence keys are checked on the instance against public keys built into the
image (`packages/license`). Nothing is sent to KyoubeAI or any other server, and an instance needs no
internet connection to apply or keep a licence.

Two switches are set in two places, because one place is not enough. `docker/Dockerfile`'s runtime
stage sets `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` in the **container** environment, which covers
the core server, the `kyoube` CLI, and anything the entrypoint starts. A **Terminal** session
does not inherit that environment: `plugins/kyoube-terminal/src/spawn-env.ts` hands node-pty a
closed, explicitly built environment (that is what keeps database credentials and provider keys out
of a shell), so it sets the same two switches on every shell it spawns — which is where you install
and sign in to the harnesses. Both names are conventions rather than one product's switch. **This is
not a claim that the image is telemetry-free**: it bundles third-party software this project does not
build, and what follows says exactly which parts were verified and which were not.

| Component | Where it comes from | What is known |
|---|---|---|
| **Core** (server, CLI) | the base image | First-party telemetry, **opt-out and on by default**. Verified in upstream's source: `resolveTelemetryConfig` (`packages/shared/src/telemetry/config.ts`) returns `enabled: false` when `PAPERCLIP_TELEMETRY_DISABLED=1`, when `DO_NOT_TRACK=1`, on a CI runner, or when the config file says `telemetry.enabled: false`; with it disabled the client is never constructed. Otherwise it POSTs batches of named events to `https://telemetry.paperclip.ing/ingest` (with an AWS API Gateway fallback), carrying a random per-install `installId`, the version, and event dimensions; upstream's own contract forbids PII, prompts, file paths and secrets. **`DO_NOT_TRACK=1` is what this image sets, so it is off.** |
| **Claude Code** | the core image's copy (`/usr/local/bin/claude`) and any copy a user installs | Reads `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, then `DISABLE_TELEMETRY`, then `DO_NOT_TRACK`, and treats either of the last two as "no telemetry" — verified by inspecting an installed CLI binary (2.1.266), **not** the copy in the core image or a newer one a user installs. It also supports an opt-in OpenTelemetry exporter (`CLAUDE_CODE_ENABLE_TELEMETRY`), which this image does not set. What it sends *by default*, signed in, was not verified here. |
| **node-pty** | terminal plugin dependency | Spawns local processes; it has no network path of its own. |

Two more things an operator should know. The core image also carries Codex, OpenCode, Gemini CLI and
Kimi Code, and `kyoube harness install` or your own installer can add newer copies of those and
others (pi, Hermes Agent) under `/kyoubeai/.local`. They are third-party software this project
neither builds nor inspects; the two switches above are set for them like everything else, but
whether they honour them is not verified here. And telemetry is not the same thing as an agent's own
traffic: a harness you authenticate talks to its model provider by design, and no environment
variable changes that.

The one option deliberately left off is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which also
disables update checks. To opt in, set it on the `app` service in `docker-compose.override.yml`
(untracked, so `./update.sh` is not blocked by local edits), then run `docker compose up -d`:

```yaml
services:
  app:
    environment:
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
```

Set on the `app` service, it reaches the server and every agent run. It does not reach Terminal shells,
because the core starts plugin workers with a stripped environment; export it in `~/.profile` to cover
interactive `claude` sessions too.

The core facts above were read from an upstream checkout of `master` dated 2026-09-04; the
image pins a published release (`KYOUBE_CORE_VERSION`). They are the same code family, not a
byte-for-byte comparison against the image, so treat the `DO_NOT_TRACK` behaviour as verified for
that source and re-check it after a large upstream bump.

## Out of scope

- **The core itself.** Authentication, sessions, the board API, deployment modes, and the MCP tool
  gateway are upstream's responsibility (the build-time fixes in `docker/core-patches` are ours) —
  report a vulnerability there through
  [the upstream project's Security Policy](https://github.com/paperclipai/paperclip/security/advisories/new),
  and see its [`SECURITY.md`](https://github.com/paperclipai/paperclip/blob/main/SECURITY.md).
- **The host OS, Docker Engine, and the network the deployment runs on.** KyoubeAI assumes a
  reasonably maintained host; see [`docs/operations.md`](docs/operations.md) for resource limits and
  [`docs/upgrading.md`](docs/upgrading.md) for keeping the image current.
- **A deployment exposed to the public internet without TLS.** `kyoube doctor` warns
  (check `exposure`) when `KYOUBE_DEPLOYMENT_EXPOSURE=public` and `KYOUBE_PUBLIC_URL` is not an
  `https://` address; putting TLS in front of a public deployment is the operator's responsibility.

## Secrets and rotation

Secrets live in `.env` (`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `KYOUBE_DB_PASSWORD`, provider API
keys) and on the `kyoubeai-home` volume (the board API key at `kyoube/board-key.json`, the agent rules
token at `kyoube/rules-token`, and every agent harness's own login under `.claude`, `.codex`, `.pi`, `.hermes` and wherever a harness you install keeps
its own, plus what installers leave in `.local`, `.kyoube` and `.cache`). **A backup contains all of it except
the download caches** — `scripts/backup.sh` dumps both databases and archives the home volume without
`.cache` and `.npm` — so store and transmit a backup directory with the same care as `.env` itself.

See [`docs/operations.md`](docs/operations.md#rotating-the-board-api-key) for rotating the board API
key, [`docs/operations.md#resetting-harness-credentials`](docs/operations.md#resetting-harness-credentials)
for resetting an agent harness's login, and
[`docs/operations.md#restore`](docs/operations.md#restore) for how `KYOUBE_DB_PASSWORD` is re-applied to
the `kyoube` role from the deployment's own secret (never from the backup) when restoring onto a fresh
cluster.
