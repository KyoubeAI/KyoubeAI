# Changelog

All notable changes to KyoubeAI are recorded here, in terms of what changed for someone running or
building on it. The format is loosely [Keep a Changelog](https://keepachangelog.com/); versioning is
[SemVer](https://semver.org/).

## 1.13.0 - 2026-10-23

### Added

- **Need-to-know visibility.** A company can be switched from **open** (everyone sees every project
  and task, as before) to **need-to-know** on the Groups page. Operators and viewers then see the
  projects of their groups and the tasks they are involved in (created, assigned, responsible, or in
  the chat), with every subtask beneath, unless their group has **Sees everything in the company**
  ticked. Owners and admins always see everything. Search, live updates and task creation follow the
  same rule, and anything addressed by a hidden task or project answers "not found". Company-wide
  pages (Activity, Approvals, Costs and the like) refuse a restricted person instead of being cut
  down. Switching to need-to-know lists who becomes restricted first and needs a licence; switching
  back never does. Every company starts open, so upgrading changes nothing until you switch one
  ([docs/groups.md](docs/groups.md#visibility)).
- Groups carry **projects**: a group's form has a **Projects** picker, and its members see those
  projects in a need-to-know company.
- `kyoube doctor` has a `visibility` line (the decision module loads, the core patches are in place,
  the shadow variables are unset, sign-in is on) and one `visibility <companyId>` line per
  need-to-know company (database and policy file agree, file fresh, who sees all and how many are
  restricted). It fails if `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE=shadow` or
  `PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW` is set.
- The README has a **Groups and visibility** section, and `SECURITY.md` a **Visibility** section with
  the model, what fails closed and what is not covered.

### Changed

- Eight standing core patches (`visibility-*` in `docker/core-patches/patches.mjs`) put KyoubeAI's
  decision module in the core's authorization decision, live-events socket, company search, task
  creation routes and every route addressed by a task or project. The build fails if a core release
  moves the code one of them anchors on, and `CONTRIBUTING.md` records them as the fourth standing
  behaviour exception.
- The groups plugin (`kyoube.apps`) is 0.14.0: migration `0009_visibility.sql` adds a visibility mode
  per company, a sees-everything flag per group and the projects of each group. It writes the policy
  the core reads to `/kyoubeai/kyoube/visibility/` on every change, at worker start and every five
  minutes. Kyoube Files is 0.4.0 and Kyoube Notify 0.2.0: both refuse a restricted person the project
  folders, notifications and approval requests of hidden work. Kyoube Studio is 0.6.0: it reads tasks
  and approvals through the core as the signed-in person, so it holds three capabilities fewer
  (`issues.read`, `issue.comments.read`, `approvals.read`), and the Workspace page no longer shows an
  open-task figure. The bootstrap reinstalls all four on update.
- The image installs `libatomic1`, which the official Node 26 builds that harness installers such as
  Hermes download for themselves need.

### Fixed

- `install.sh` refuses an address that is not an `http://` or `https://` URL with a host and a valid
  port, on the prompt and with `--url`, instead of writing it to `KYOUBE_PUBLIC_URL` where the core
  refuses it at startup.

## 1.12.1 - 2026-10-22

### Fixed

- **The board key no longer runs out.** The core gives a board key from `kyoube setup` 30 days, and
  nothing renewed it. Once it expired, plugin updates, the agent working rules and user groups
  stopped, while the app kept running and looked healthy. The agent rules loop now renews the
  stored key a week before it expires. It mints a new key for the same person, checks it and stores
  it, revokes the old one an hour later, and retries hourly if something fails. A key that has already expired still
  needs `kyoube setup`, and a key in `KYOUBE_BOARD_API_KEY` is still yours to replace
  ([docs/operations.md](docs/operations.md#the-board-key-expires)).
- `kyoube doctor`'s `board key` line shows when the key expires. It warns when renewal is overdue
  and fails when the core no longer takes the key, with the fix.
- The board key file is written whole (a temporary file, synced and renamed into place) and is always
  mode `600`.

## 1.12.0 - 2026-10-21

### Added

- **Agent questions.** A stuck agent may send one question to another agent and keep its task, as a
  last resort. Each agent's **ask level**, on its profile (**Can ask other agents**), decides whom it
  may ask: no agents, its line (the managers above it and the agents below it; the default) or any
  agent. A task may carry one open question to an agent and three in all. The core refuses anything
  else, and only the agent asked, or a person, can answer. The agent working rules block moves to v2
  with two new rules, and `kyoube doctor` shows how often agents ask
  ([docs/agent-rules.md](docs/agent-rules.md#agent-questions)).

### Changed

- The repository moved to the KyoubeAI organization, <https://github.com/KyoubeAI/KyoubeAI> (the old
  address redirects), and the image moved with it, to `ghcr.io/kyoubeai/kyoubeai`, which has every
  release from 1.0.0 on. `./update.sh` switches an install's `KYOUBE_IMAGE` to the new image as it
  updates, and `--rollback` switches it back. Releases are still copied to the old image for now, so an
  install whose `update.sh` predates the move can update too
  ([docs/upgrading.md](docs/upgrading.md#the-move-to-the-kyoubeai-organization)).
- The licensor and copyright holder in `LICENSE` and `NOTICE.md` is Hub360+ Technologies Pte. Ltd.
- Kyoube Studio (`kyoube.studio`) is 0.5.0, for the ask level on the agent profile, and Kyoube Agent
  Rules (`kyoube.agent-rules`) is 0.3.2, so the bootstrap reinstalls both on update. No migration.
- Kyoube Agent Rules 0.3.2 reads the core's built-in agent marker by the core's own rule, so an agent
  that writes a marker the core would not read into its own metadata still counts as a top agent.

## 1.11.0 - 2026-10-16

### Changed

- The core is Paperclip 2026.1012.0 (was 2026.1005.0), with the plugin SDK pinned to match. 12
  database migrations run on the first start, workspace restore locks change format, and every newly
  hired standard agent gets 14 grants from the core, **Can change agents** among them. Back up first,
  and read [docs/upgrading.md](docs/upgrading.md#moving-an-install-from-core-202610050).
- Every KyoubeAI core patch, the Studio theme, the rebrand and the installable-app step apply on this
  core unchanged. The pi and Hermes chat fixes are still not upstream, so they stay. The rebrand's
  sweep allows two new upstream development trees (`feature-map`, `integrations/assistant-plugins`).
- The agent working rules protect a manager with a low-trust policy, which this core can evaluate,
  instead of skipping it. `kyoube.agent-rules` is 0.3.1, so the bootstrap reinstalls it on update.
- SECURITY.md and docs/groups.md record a new accepted residual: on this core an agent's email inbox
  (AgentMail) needs no experimental setting, and the core assigns each new email thread to that agent
  without the assignment check user groups rely on.

## 1.10.0 - 2026-10-15

### Added

- App downloads: a Kyoube App can save a file it built (a CSV, a workbook, a PDF) to the viewer's
  computer with `kyoube.ui.download(filename, data)`, where `data` is a string, a `Blob`, an
  `ArrayBuffer` or a typed array. The host page checks the call: only csv, tsv, txt, json, md, xlsx,
  docx, pptx, pdf, png, jpg/jpeg and zip, at most 25 MB, at most 3 per 10 seconds per running app.
  The host cleans the file name, and the type comes from the extension. A save made straight from a
  click happens at once. Otherwise the person sees "*App* wants to save *file* (size). Save /
  Dismiss" above the app, and the app gets `declined` after Dismiss or 25 seconds. Free; no licence
  needed. See [docs/apps.md](docs/apps.md#saving-files).
- The Kyoube Apps agent skill teaches agents to export through `kyoube.ui.download` from a click
  handler.

### Changed

- The app frame's sandbox adds `allow-downloads`, so an app's own `<a download>` link also saves a
  file, without the checks above. SECURITY.md records this as an accepted residual: the file goes
  only to the viewer's disk, but a file a browser can run (html, svg), once opened, can send what it
  holds to a server.
- Kyoube Data & Apps (`kyoube.apps`) is 0.13.0, so the bootstrap reinstalls the plugin on update.
  No migration.

## 1.9.0 - 2026-10-11

### Added

- App tasks: a Kyoube App can hand a task to a company agent and show the result. The manifest
  declares named task templates (the agent's name, a title and instructions with `{{row.x}}` and
  `{{input.x}}` placeholders, a table and up to 20 fields, up to 5 typed inputs, and the fields the
  agent writes). The app calls `kyoube.tasks.start(template, { rowId?, inputs? })`, follows the task
  with `kyoube.tasks.watch` (and `get`, `list`, `cancel`, `open`), shows the agent's reply as text
  and re-reads its data when the task is `done`. The agent receives a normal task whose data sits in
  a fenced block marked as data, each value cut to 2,000 characters and the block to 16,000. Publishing
  a version that adds or changes a template, or that would change the agent a template reaches,
  needs a person (`tasksConfirmed`); agents cannot publish or roll back to it. A published version
  keeps the agent ids it was published with, recorded in the same transaction as the publish, so
  renaming an agent changes nothing. Only people start or cancel tasks, and the core's own assignment
  rule decides, so a person who may not assign a protected agent is refused inside an app too.
  Limits: 10 templates per app, 10 starts a minute per person per app, 25 open tasks per app, 10
  watches per running app frame (one page showing the app). A task for a paused agent is refused, and
  one whose wake-up the core refuses (for example over budget) is cancelled at once and the start
  fails, so no task is left stranded. A cancel cannot stop a run already in progress
  (`runMayContinue`). Every start and cancel is audited without row values. Company Settings, Data
  access, "Apps that hand work to agents" shows each template, its agent and whether the agent can
  write Data. Free; no licence needed. See [docs/app-tasks.md](docs/app-tasks.md).
- The Kyoube Apps and Kyoube Data agent skills teach agents how to declare task templates and how
  to handle a task an app sent them, and `docs/apps.md` has a Tasks section with a complete example
  app.
- Kyoube Data & Apps (`kyoube.apps`) is 0.12.0; a migration adds one empty table (`app_tasks`), and
  the bootstrap reinstalls the plugins on update to pick it up (`docs/architecture.md`, "Plugin hot
  reload"). Nothing changes until a person publishes an app version with task templates.

## 1.8.0 - 2026-10-10

### Added

- Connections: a Kyoube App or an agent can call an outside service (a payments API, a CRM, a
  weather feed) with an API key the company stores once. An admin adds the connection under Settings,
  Plugins, Kyoube Data & Apps (company selected) with a name, an `https` base URL, an auth style
  (Bearer token, a custom header or Basic) and a company secret, and chooses `read` (GET only) or
  `read-write`. The key stays on the server. Apps declare the connections they use in the manifest
  and call `kyoube.connections.call(name, { method, path, query, headers, body })`; `kyoube.ready()`
  reports which are `available`. Publishing a version that adds a connection or widens it to
  `read-write` needs a person (`connectionsConfirmed`); agents cannot publish it. Agents need a
  grant per connection, set by an owner or admin under Company Settings, Data access, Connections,
  and use `GET /connections` and `POST /connections/{name}/call` (tools `connections_list` and
  `connections_call`). Their non-GET calls can be held by the guardrail (`connection_write`). Calls
  return any status as it is, text up to 2 MiB, at most 30 per 10 seconds per running app, and every
  call is audited without bodies or query values. Free; no licence needed. See
  [docs/connections.md](docs/connections.md).
- The Kyoube Apps and Kyoube Data agent skills teach agents how connections are set up and used, and
  `docs/apps.md` has a Connections section with a complete example app.
- Kyoube Data & Apps (`kyoube.apps`) is 0.11.0; a migration adds one empty table
  (`connection_grants`), and the bootstrap reinstalls the plugins on update to pick it up
  (`docs/architecture.md`, "Plugin hot reload"). Nothing changes until an instance admin adds a
  connection.

## 1.7.0 - 2026-10-09

### Added

- User groups (licensed): decide which people may use which agents and apps, and set a group data
  level. A group holds people, agents, apps and an optional data level (read, write or schema; never
  below read, highest wins; groups can lower operators but never raise viewers, whom the core keeps
  read-only). An agent or app in no group stays open to everyone; owners and admins are
  never restricted. Manage groups under Company Settings, Groups, which is also where an agent's
  restrictions are shown; the Data access page shows where each level comes from. Agent changes apply within about a minute
  through the agent rules loop. Any valid licence unlocks creating and changing groups; existing
  groups keep being enforced, and can be deleted, without one. See [docs/groups.md](docs/groups.md).
- `kyoube.agent-rules` 0.3.0 gains `access.members.read`, and `kyoube.apps` is 0.10.0; the bootstrap
  reinstalls the plugins on update to pick them up (`docs/architecture.md`, "Plugin hot reload").

### Changed

- Agent chat honours assignment rules for protected agents (second standing core patch,
  `groups-chat-open-assign-check` and `groups-chat-message-assign-check`). Opening a chat with a
  protected agent, and sending a message in one, needs the right to assign it. Viewers cannot
  assign or chat with any agent on this core, which refuses every change a viewer sends.
- The agent rules routes (`kyoube.agent-rules` reconcile, revert and groups apply) and the
  `kyoube.apps` group sync routes now answer only the `kyoube agent-rules` loop or a company owner or
  admin; before, any signed-in person passed. The loop proves itself with a rules token it creates in
  `/kyoubeai/kyoube/rules-token` (mode 600) and sends in each request body. The board key's user must be a member (any role) of each company for the
  rules and group sync to run there; the core refuses the key otherwise.
- With `KYOUBE_AGENT_RULES=off`, `kyoube agent-rules --watch` keeps running and syncs only user groups
  each minute, instead of exiting; `kyoube doctor` shows the sync on its own `user groups` line.

## 1.6.0 - 2026-10-08

### Changed

- The core is Paperclip 2026.1005.0 (was 2026.916.1), with the plugin SDK pinned to match.
  Harnesses no longer stop to ask permission; an @-mention no longer starts an agent's run; Agent
  Chat (experimental, off by default) gets its own page; 14 database migrations run on the first
  start. Back up first, and read [docs/upgrading.md](docs/upgrading.md#moving-an-install-from-core-20269161).
- The agent Test route fix (`adapter-test-unsaved-harness-switch`) is upstream in this core, so
  KyoubeAI no longer patches it.
- The agent working rules save an agent's `AGENTS.md` on the revision they read, which this core
  requires. When someone saves the file between the read and the write, the core refuses the write,
  their edit stays, and the next pass (within a minute) adds the rules block to it.

### Fixed

- Task chat with a pi agent shows each reply and thinking block once. pi sends a message's text again
  when it ends, when its turn ends and when the run ends, and the chat showed every copy, so a reply
  appeared four or five times (`pi-transcript-once-*`, same change as upstream PR #14320).
- Task chat with a Hermes agent is readable. The agent form showed **Quiet output** on by default but
  Hermes ran in its terminal mode unless the box had been saved, which echoed the whole prompt and
  instructions, wrapped text at 80 columns and drew boxes. An unset Quiet output is now quiet
  (`hermes-quiet-default`, same change as upstream PR #12016). Each line of Hermes output was also a
  separate chat message, which broke paragraphs, lists and tables apart; a reply is now one message
  (`hermes-transcript-one-message`). Hermes runs from before the update still carry the echoed
  prompt in their **Worked** details, now as one block.

## 1.5.0 - 2026-10-07

### Added

- KyoubeAI installs as an app on phones and computers, and sends push notifications when an agent
  asks you something, when an approval is waiting, and when your task is done or blocked; failed
  runs and comments are opt-in (new `kyoube.notify` 0.1.0, docs/mobile.md). Each instance sends Web
  Push itself, encrypted, with no KyoubeAI server in between. It needs an `https://` address.
- The Notifications page, linked from Home and the Workspace page (Studio 0.4.0).

### Changed

- On phones: at most two toasts show, above the tab bar; the app runner's header folds into a menu;
  the Data page shows the table list, then one table (Kyoube Data & Apps 0.9.0). Agents are told to
  build apps that work at 375px wide.

## 1.4.1 - 2026-10-07

### Added

- A **Can change agents** switch on the agent profile (Studio 0.3.0). It gives or takes away the
  agent's `agents:configure` grant, which lets the agent change its own and other agents'
  instructions, skills and settings. Agents asked for this grant, but the core UI had no control for
  it. Only company owners and admins can flip it.
- The agent working rules give the company's top agent, the one that reports to nobody,
  `agents:configure` and `skills:create`, as the core does for a top agent whose role is `ceo`
  (agent-rules 0.2.0). They are given once, so switching the grant off on the profile sticks.

### Fixed

- Clicking an agent under "Your team right now" on the dashboard opened "Organization not found".
  The core's Dashboard gives plugin widgets no company prefix, so Studio's Home now adds it to its
  links itself.

## 1.4.0 - 2026-10-05

### Added

- Typed decisions (docs/decisions.md): a company brings its own key for a Jev-class model (TypeSafe,
  OpenRouter, Vercel AI Gateway, or any HTTPS endpoint serving `/v1/systemone`) and gets closed
  answers: a choice, a level or true/false, each with a confidence and an `auto` or `review` status.
  An instance admin sets the provider, model and key secret per company in the plugin settings; a
  company admin turns each use on and sets a daily cap under Company Settings → Data access.
- Agents ask typed questions over `POST /decisions/decide` (text, JSON, or Data rows read under the
  agent's own access) and the `decisions_decide` and `decisions_status` tools, taught by the new
  `kyoube-decisions` skill.
- AI columns: Data fields the model fills in from other fields of the row, in the background, with a
  review lane on the Data page, `GET /tables/:table/review`, `data_list_review` and Refill. A
  person's edit is kept and recorded as confirmed or changed.
- Typed decisions in Kyoube Apps: apps declare decision sets in their manifest and call
  `kyoube.decide` and `kyoube.decideOutcome`. A version that adds or changes sets needs a person to
  publish it, after a disclosure of exactly which fields it sends.
- The guardrail on risky agent actions: when switched on, an agent's drop, rename, field removal,
  bulk update or delete, and app publish, rollback or archive is checked against its task. Anything
  doubtful, or a check that cannot run, waits on a people-only confirmation card and runs once after
  a person allows it.
- `scripts/decisions-eval.mjs`, a by-hand check of a provider against 200 labelled decisions.

### Upgrading

- `kyoube.apps` goes from 0.4.3 to 0.8.0. On upgrade, `kyoube ensure-plugins` grants it
  `http.outbound`, `secrets.read-ref`, `issues.read`, `issue.interactions.create` and
  `issue.interactions.read` without a separate approval. It never gets `issue.interactions.respond`
  or `approvals.respond`.
- Nothing leaves the server until an instance admin sets a provider and key for a company and a
  company admin switches a use on. Every use starts off.
- Migrations `0003` to `0005` add the decision settings, usage counter, decision log, AI cell state
  and guardrail holds. They run when the plugin starts.

## 1.3.0 - 2026-10-03

### Added

- Licensing: an instance allows 5 users for free, and a KyoubeAI licence key raises the limit. The
  limit is enforced when an account is created; existing users are never locked out. The key is
  applied on Settings → Plugins → KyoubeAI Licence or with `kyoube license set`, and checked offline.
  See docs/licensing.md.
- `kyoube users list` and `kyoube users remove <email>`, to free a seat.
- `kyoube doctor` reports the licence and whether the limit is enforced, and can now print `WARN`.

### Upgrading

- An instance that already has more than 5 users keeps all of them, but no new user can be added
  until a licence key is applied. `kyoube doctor` shows `WARN` until then.

## 1.2.0 - 2026-10-01

### Agents

- **Agents finish their own tasks.** Every agent's `AGENTS.md` gets a KyoubeAI rules block:
  - an agent does its task end to end
  - it asks the person who started the task for approvals
  - it hands work to another agent only when that person asks, or its new `## Handoffs` section
    says so
  - a manager splits work only across its own team

  The core's default "ask QA, ask your boss" sentences are removed where they appear word for word.
- **Approval cards go to people.** Confirmation, question, checkbox, verdict and suggested-task
  cards can now only be answered by a person.
- **Work moves up to a manager agent only with your decision.** Manager agents are protected; an
  agent that cannot do a task hands it back to you with an "Escalate" or "Keep" decision.
- `kyoube agent-rules` keeps all of this in force: once a minute, from container start. It works
  through the new `kyoube.agent-rules` plugin, with no change to the core.
  - `kyoube doctor` reports it.
  - `KYOUBE_AGENT_RULES=off` plus `kyoube agent-rules off` removes it.

  See `docs/agent-rules.md`.
- Studio's third getting-started step is now "See it through" (`kyoube.studio` 0.2.1).

## 1.1.0 - 2026-10-01

### Install and update

- `./install.sh` takes a fresh `git clone` to a running, claimed instance with its plugins. It writes `.env` (generated secrets; the one question is the address), downloads the release's image, starts the stack, waits for you to claim it, and runs the plugin approval. It is safe to re-run: on an install that has data it repairs the version that install runs and refuses, before it changes anything, to move it to another (that is `./update.sh`). It refuses to write a new `.env` over the database volume of another install on the machine. `--edge` builds from source.
- `./update.sh` updates to the newest release after a backup. It downloads the image before it changes anything, merges new settings into `.env` (only the image, version and core-version settings are moved; the rest of your settings stay as they are), and offers to install harnesses your agents use. An update that stopped part way continues when you run it again, and it will not move onto code older than, or unrelated to, what the stack runs. It also updates a stack that runs an older release than the checkout, which is how a 1.0 install moves to 1.1: `git checkout v1.1.0`, then `./update.sh`. `./update.sh --rollback` returns to the release you came from: it checks the backup saved just before that update, puts back the `.env` (keeping the one it replaces as `.kyoube/env.before-rollback`) and restores the backup, so anything written since is replaced. A rollback that stops part way is finished by running it again, and nothing else runs until it is. `--edge` follows a branch and rebuilds; a rollback never drops commits made on that branch.
- `docker-compose.override.yml` is git-ignored, for local compose wiring that `./update.sh` should not trip over.

### Harnesses

- The image no longer bakes in pi, Hermes Agent or a pinned Claude Code. It is 4.79 GB instead of 7.29 GB, about 2.5 GB smaller. Install the harnesses you want from the Terminal with `kyoube harness install <name>` or their own installers. They land in `/kyoubeai/.local`, first on every PATH, and survive restarts, updates and core upgrades along with their logins. The core image's own Claude Code, Codex, Gemini CLI, Kimi Code and OpenCode remain as fallbacks; a copy you install comes first.
- The `node` user, which the server, agents and Terminal shells run as, has passwordless `sudo` (`SECURITY.md`, Terminal). System packages installed with apt are kept and put back at every start, within three minutes; one that cannot be reinstalled in that time (offline, or gone from a newer base image) stays on the list and is retried at the next start. Backups leave out the download caches (`.cache`, `.npm`). The Terminal page's help lists these commands (`kyoube.terminal` 0.2.5).
- `kyoube doctor` lists each harness it finds with its version and origin, fails when an agent's harness is missing or installed but not running, and reports the kept packages, failing when they could not be put back at the last start.

### Fixes

- **Claude subscription connections now last a year instead of about 8 hours.** Connections shows `kyoube connect claude`, which signs in with `claude setup-token`. Connections made before 1.1 must be connected again once.
- **Test works on a harness switch before it is saved.** It used to fail with "Saved agent is not compatible with the adapter being tested"; the same fix is upstream in 9335b7d. If the agent's environment has hidden values, enter them again to test a different harness.
- **A harness installed from the Terminal is found** by both Terminal shells and agents.
- **Public instances allow subscription sign-in and local MCP tools** by default (`KYOUBE_TRUSTED_RUNTIME_HOST=auto`; set it empty to turn that off).
- **The telemetry notes are corrected.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, set on the `app` service, reaches the server and agent runs but not Terminal shells; `SECURITY.md` says how to cover those.
- The first two fixes reach the core through `docker/core-patches` at image build time (`anthropic-signin-setup-token`, `adapter-test-unsaved-harness-switch`); the second entry is deleted at the first stable core that carries 9335b7d.

### Development

- `pnpm test:sh` runs the shell tests (bats) for `install.sh`, `update.sh` and the container scripts, and `scripts/install-e2e.sh` runs both scripts end to end on the smoke image, rollback included. CI runs both. `CONTRIBUTING.md` has a "Running from source" section (`./install.sh --edge`, `./update.sh --edge`) and a release checklist.

## 1.0.0 - 2026-09-25

The first release: KyoubeAI as a self-hosted, multi-user AI operating system for an organisation, built
entirely as an overlay and four plugins on a pinned core release (2026.916.1), and branded as KyoubeAI
on every surface.

### Docker packaging

- One `docker compose up -d` brings up the whole stack: the `app` image (this repository's overlay, built
  `FROM` a pinned core release) and a dedicated `db` service (Postgres 17) holding two databases, the
  core's own `kyoubeai` database and Kyoube's separate `kyoube` database.
- Three agent harnesses pre-installed at pinned versions and ready to authenticate from the browser:
  Claude Code (`CLAUDE_CODE_VERSION`, 2.1.281), pi (0.87.1) and Hermes Agent (0.21.4, release
  v2026.9.21). The build fails unless each CLI's `--version` prints exactly the pinned version.
- A `kyoube` CLI bundled in the image (`setup`, `ensure-plugins`, `doctor`) handles first-boot plugin
  installation, automatic upgrades on every start, and one-command health diagnostics.
- The container's home is `/kyoubeai` (compose volume `kyoubeai-home`, `HERMES_HOME=/kyoubeai/.hermes`);
  the Postgres role and database are `kyoubeai`. Operators configure the stack with `KYOUBE_*` keys in
  `.env` (`KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION`, `KYOUBE_PORT`, …),
  which `docker-compose.yml` maps onto the core's own settings. `TRUST_PROXY` is passed through for
  deployments behind a reverse proxy or tunnel.
- Telemetry is off by default in the container and in every Terminal shell (`DO_NOT_TRACK=1`,
  `DISABLE_TELEMETRY=1`), and the core's hosted announcement cards are turned off.
  `SECURITY.md` records what was and was not verified for
  each bundled component.

### Branding

- Every surface says KyoubeAI: the web UI (title, sign-in lockup, favicon, PWA manifest, every display
  string), API messages, the system prompts agents are given and the adapter configuration labels,
  harness docs and Skills-tab origin labels an operator reads, the built-in skills, the `kyoube` CLI and
  the docs. The core image is transformed at build time by `docker/rebrand/` (re-applied on every build,
  verified, fails the build on drift), and the build also sweeps the whole image: every tree outside a
  documented allowlist of never-executed upstream source must contain no display text of the core's own
  brand or the build fails, so a future core bump that moves a user-facing string into a new place cannot ship
  unbranded. `docs/branding.md` lists what is deliberately left alone (the environment variables agents
  read, skill keys, enum values, the header) and the known residuals (the hash-pinned `packages/db`
  migrations, one of which seeds the default execution environment's description).
- The brand is data: `docker/brand/` holds the name, URLs, mark and lockup; a rename or a new logo is a
  file swap and a rebuild.

### Studio

- **KyoubeAI's own design.** The app uses the KyoubeAI website's palette and type (zinc neutrals, a deep
  teal accent, Instrument Serif for greetings) and opens **dark** by default; a choice made with the
  theme toggle still wins.
  - **Sidebar.** Built for the core's streamlined shell: a search field and one solid **New task**
    button; Home, Inbox, Tasks, Projects; a **Build** group (Data, Apps, Routines); a **Team** roster
    where each agent has a face, a live status dot and a line saying what it is doing; and
    **Workspace** at the bottom. KyoubeAI's Data, Apps and Terminal links look and behave like the
    core's rows (icons, spacing, active state).
  - **Workspace page** (`/<company>/workspace`): All agents with the org chart, members and invites,
    Audit, Timeline (`/activity/timeline`), Costs (`/activity/costs`), Approvals, Skills, Artifacts,
    Projects, Connectors, Settings, and for owners and admins Plugins and Terminal. Every one of them is
    still reachable from ⌘K.
  - **Home.** The dashboard opens with a greeting that counts what needs you, a getting-started strip
    for new workspaces, **Needs you** (approvals, reviews, blocked tasks, agents in error),
    **Your team right now** and **Latest updates**, above the core's metrics and charts.
  - **Agent profile** (`/<company>/team/<agent>`). A page for each agent: its character and live
    status, title, manager and harness; an **On duty** switch, **Chat** and **Assign task**;
    **Overview** (working now with its own latest notes, recent work, tasks done this week, open tasks,
    spend this month, skills, who it works with) and **Tasks**, plus the core's Instructions, Skills,
    Runs and Settings tabs. Every link to an agent opens the profile, including `/agents/<agent>` and
    `/agents/<agent>/overview`; **Runs** opens the agent's runs under Audit, **Settings** opens
    Harness / Runtime, and `?classic=1` keeps the core's own overview. Pausing and assigning go through
    the core's documented board API as the signed-in person, so the core's permissions and side effects
    apply.
  - **Characters.** Every agent gets a face from its icon and name; `bot`, `cpu` and `circuit-board`
    are robots, and the character is painted over the core header's avatar. Task assignee chips, the
    org chart and the agents list keep the core's icons until the core supports agent pictures.
  - **Renames.** Dashboard is **Home**. The core calls its outside-tools area Connectors, so "Apps"
    means only KyoubeAI's Apps. KyoubeAI's plugin pages are titled by their page and drop the host's
    Back link.
  - Built as a fourth plugin, `kyoube.studio` (0.2.0, `plugins/kyoube-studio`), and a build-time step,
    `docker/theme`, which runs before the rebrand, checks every rule, hook and token against the core
    before writing, and fails the build naming what moved. Every skin rule that hides or moves core UI
    is gated on the Studio plugin, so without it the stock layout shows. `scripts/smoke.sh` signs in
    with headless Chrome (`scripts/studio-live-check.mjs`) to check the design and that fallback, and
    CI keeps its screenshots. `docker/theme` is documented as the second standing exception to "Never
    patch the core". Details: `docs/theme.md`.

### Terminal

- A browser terminal (`kyoube.terminal` plugin, 0.2.4) inside the container for company owners and
  admins: authenticate the agent harnesses, run `kyoube doctor`, and administer the box, without
  shelling into the host.
- Sessions are bound to the user who opened them, survive page reloads (attach/resume), close themselves
  after an idle timeout, and are audited on open/close/denial. Keystrokes and output are never logged.
- Output is pulled with back-to-back `terminal.wait` long-polls (a worker action that answers as soon
  as output past the caller's sequence number exists, when the shell exits, or after a bounded
  timeout), because the core (2026.831.1 through 2026.916.1) never wires its plugin SSE stream bridge.
  The terminal box fits exactly: `scripts/terminal-fit-check.mjs` runs in CI and fails if fitting ever
  changes the box.

### Data

- Every company gets its own isolated Postgres schema and role in the `kyoube` database, created on
  first use and provably unreachable from any other company's role.
- People design and populate it from a **Data** page in the UI; agents use the same operations through
  REST routes under `/api/plugins/kyoube.apps/api/` or the 17 `kyoube.apps:data_*` tools, guided by a
  managed **Kyoube Data** skill. The skill leads with the REST routes, because the core (2026.831.1
  through 2026.916.1) hands a run the tool gateway only when the agent already has an installed MCP
  connection.
- The **Kyoube Data** and **Kyoube Apps** skills reach every company's skill library by themselves:
  `kyoube ensure-plugins` installs them into every company at each container start, the first visit
  to a company's pages does the same, and a company created later gets them on creation. Enabling a
  skill on an agent stays a per-agent choice on the agent's Skills tab.
- Per-person access (from company role) and per-agent access (explicit grants, defaulting to none) at
  four levels (none, read, write, schema), enforced identically for the UI, the tools, and the REST
  routes.
- Read-only SQL (`data_sql_select`) for reporting: single `SELECT` statements only, restricted to a
  company's own tables and an allowlist of safe built-in functions, run with a statement timeout and a
  row cap.
- Dropped tables and fields are recoverable for 30 days (configurable to hard delete), and every
  mutation, schema change, and grant change is recorded in a per-company audit trail.

### Apps

- AI-built, database-backed single-file HTML applications (CRMs, trackers, small internal tools) that
  run sandboxed inside the KyoubeAI UI at `/<company>/app-artifact/<slug>` and talk to a company's Data
  tables through an injected `window.kyoube` SDK; the frame fills the window exactly
  (`scripts/app-frame-check.mjs` runs in CI).
- Agents build, update, and publish apps through the REST routes or the 7 `kyoube.apps:apps_*` tools,
  guided by a managed **Kyoube Apps** skill; people browse a gallery, review an app's source and version
  history, publish, and roll back. `kyoube.apps` is 0.4.3.
- Apps run in an iframe with an opaque origin and a restrictive Content-Security-Policy (no network
  access, no cookies, no host DOM), and every data call an app makes is re-authorised under the
  identity of the person viewing it, so an app can never exceed what that person could already do.

### Files

- A **Files** tab on every project page and a **Files** link under each project in the sidebar
  (`kyoube.files` plugin, 0.3.0). It shows the project's working folder (the configured workspace, or
  the managed folder the core creates for the project and starts its agents in) and lets company
  members browse it, open and edit text files, preview Markdown and images, create files and folders,
  upload, download, rename and delete. The listing and any open file refresh themselves every few
  seconds so an agent's changes appear as they land; a save is refused if an agent changed the file
  since it was opened, with a choice to reload or overwrite.
- HTML files open rendered as the page they are, in a sandboxed frame with no network access and the
  page's own relative stylesheets, scripts and images inlined from the folder; SVG files open as
  drawings. A **View/Edit source** toggle shows the markup.
- A folder icon at the right end of the top bar on every task that belongs to a project docks the
  project folder in a panel on the right of the screen, beside the chat (no backdrop), with the same
  browser and editor; it follows the viewer from task to task until closed.
- Who may browse and who may change files are per-instance settings (**Settings → Plugins → Kyoube
  Files**; by default every role browses and every role but `viewer` edits). No path can leave the
  project folder, symbolic links are never followed, and every change is written to the activity log
  with its path, never its content. `SECURITY.md` has a **Files** section describing the bounds.

### Onboarding and core patches

- The first-run wizard can finish before a harness is signed in. Its **Connect a model** step cannot
  sign a Claude or OpenAI subscription in on a KyoubeAI server (the core allows that only to the local
  operator of a `local_trusted` instance), so under any Connect error it offers **Skip for now and
  connect the harness later from the Terminal page**: the agent is hired without the sign-in and the
  environment test, and the harness is connected afterwards from the Terminal page or with a provider
  key in `.env`. `scripts/onboarding-live-check.mjs` walks the wizard to that skip on every smoke run.
- `docker/core-patches` holds fixes for upstream bugs until their upstream fixes ship, each applied at
  image build time and checked against the pinned core: the onboarding skip above
  (`onboarding-skip-harness-*`), and task chat with a pi agent showing only the agent's own messages
  (`pi-transcript-non-assistant-messages`; upstream's pi transcript parser turns the user turn and
  every tool result into agent text). If a patch stops matching because a build uses a different core
  than the release pins, the error names both versions and the `.env` line to change.

### Operations

- `scripts/backup.sh` / `scripts/restore.sh` back up and restore both databases, the Kyoube cluster
  roles, and the persistent home volume (agent credentials, workspaces) as one unit, rehearsed
  end-to-end in CI.
- Images published to GHCR: release tags (`1.0.0`, plus `latest`) for
  `linux/amd64` and `linux/arm64`, and an amd64-only `sha-<commit>` test image on every push to `main`.
  `docker-compose.yml` runs equally well from a prebuilt image or built from source.
- `scripts/check-pins.sh` and `scripts/bump-core.sh` keep the core image version and the plugin SDK
  version locked together across every file that pins them, enforced in CI.
- A weekly workflow builds and smoke-tests against the core's `:beta` channel and opens an issue on
  failure, so a breaking upstream change is caught before it reaches a stable version bump.
- A written security model (`SECURITY.md`) covering the three trust zones, a governance guide
  (`docs/governance.md`) with copy-paste recommended tool profiles and policies, and a security review
  checklist template for future releases.

### Licence

- Source-available under the Business Source License 1.1 (`BUSL-1.1`). Production use is free for up
  to five users, provided KyoubeAI is not offered to others as a hosted, managed or embedded service;
  evaluation, development and testing are free without limit; any other production use needs a
  commercial licence. Each version becomes available under the Apache License, Version 2.0 four years
  after it is published. `LICENSE` has the terms, `NOTICE.md` the copyright line and the core's MIT
  notice, and contributions need the agreement in `CLA.md` (see `CONTRIBUTING.md`).
