# Upgrading

Two things move independently: **KyoubeAI** (this repository — the bootstrap CLI, the plugins, the
overlay image) and **the core** (Paperclip — the upstream host image the overlay is built `FROM`).
The core is changed only at image build time (a rebrand, the theme and a short list of fixes in
`docker/core-patches`), so a core upgrade is a version bump and a rebuild, unless one of those steps stops
matching the new core ([What can break](#what-can-break)).

**Take a backup first, every time.** `bash scripts/backup.sh` costs a minute and is the only way
back from a migration you do not like — see [Rolling back](#rolling-back) and
[docs/operations.md](operations.md).

## Upgrading KyoubeAI

Since 1.1, `./update.sh` does all of this: the backup, the new release, your `.env`, the restart and
the check (README, [Update](../README.md#update)). The steps below are the same work by hand, for when
you want to see each one, and what `./update.sh --edge` automates for an install built from source.

From source:

```bash
bash scripts/backup.sh
git pull
grep '^KYOUBE_CORE_VERSION=' .env.example .env
git diff ORIG_HEAD -- .env.example     # settings the update added
docker compose up -d --build
docker compose exec app kyoube doctor
```

**Update the core pin in `.env` before you build.** `.env` is yours, so `git pull` never changes it,
but it pins the core with `KYOUBE_CORE_VERSION`. When a release moves to a new core, the `grep` above
shows two different values: copy the `.env.example` one into `.env` (if your `.env` still uses the
0.1.x name `PAPERCLIP_VERSION`, change that line the same way). Otherwise the build uses the old core
and stops at the core-patches step with `this build uses core <old>, but this KyoubeAI release is made
for core <new>`.

From a published image (`KYOUBE_IMAGE=ghcr.io/kyoubeai/kyoubeai` in `.env`), check out the tag of the
release you are moving to, so `docker-compose.yml`, the scripts and `.env.example` match the image,
then set `KYOUBE_VERSION` in `.env` to the same version:

```bash
bash scripts/backup.sh
git fetch --tags
git checkout v1.0.1                          # the release you are moving to
git diff v1.0.0 v1.0.1 -- .env.example       # settings the release added or changed
# in .env: KYOUBE_VERSION=1.0.1, plus any new settings
docker compose pull                          # must succeed on its own
docker compose up -d
docker compose exec app kyoube doctor
```

Which tags exist, and what is in them: a release tag (`1.0.0`, plus `latest` for the newest
non-prerelease one) is built for **linux/amd64 and linux/arm64**, and is the only kind of tag a
deployment should run. The `sha-<commit>` tags a push to `main` publishes are **amd64-only** — they
exist to test one commit, are not built for arm64 at all, and are not release artefacts.

**Plugins re-install themselves.** The entrypoint starts `kyoube ensure-plugins --watch`, which
compares the plugin versions on disk in the new image against the versions the core has installed
and upgrades any that differ. You do not run `kyoube setup` again, because the board key on the
`kyoubeai-home` volume is still valid: from 1.12.1 the agent rules loop renews it before the core's
30 days run out. An install that ran an earlier release for more than 30 days after `kyoube setup`
may hold an expired key, and so may a stack stopped for weeks, a rollback to 1.12.0 or earlier, or a
restore of an old backup. If `kyoube doctor` says `Agent token did not verify`, run `kyoube setup`
once ([operations.md](operations.md#the-board-key-expires)). Watch the plugins update with
`docker compose logs -f app`.

Two upgrade paths exist, and which one is taken is decided upstream. A plain version bump goes
through `POST /api/plugins/:id/upgrade`. A manifest that declares a **new capability** cannot be
upgraded without board approval, so `ensure-plugins` soft-uninstalls the plugin (no `purge`, so
plugin data survives) and installs the same path again; the log line says so explicitly. Either way
the end state is the plugin `ready` at the new version.

`kyoube doctor` is the check that matters. Its `plugins` line lists every `kyoube.*` plugin as
`key@version=status`; every one of them should read `=ready`, at the versions the new image ships.
A plugin stuck in another status has its own log under **Settings → Plugins → *plugin* → Logs**.

If a plugin is deliberately disabled by an operator, `ensure-plugins` leaves it alone and says so —
that is not a failure, but `doctor` will not call it `ready` either.

## The move to the KyoubeAI organization

After 1.11.0 the repository moved to the KyoubeAI organization, <https://github.com/KyoubeAI/KyoubeAI>,
and its image to `ghcr.io/kyoubeai/kyoubeai`. Every release up to 1.11.0 is in both the old image (the
`KYOUBE_IMAGE` an `.env` written before the move names) and the new one.

- **`./update.sh` moves the install for you.** GitHub redirects the old address, so `git fetch` keeps
  working. An `update.sh` from a release after 1.11.0 changes `KYOUBE_IMAGE` in `.env` to the new image
  as it updates (it says `the published image moved`). An older one keeps the old image, so each release
  is also copied there for now, and the update after that one switches the install.
- **Point the checkout at the new address** whenever you like:
  `git remote set-url origin https://github.com/KyoubeAI/KyoubeAI.git`.
- **Without `./update.sh`**, set `KYOUBE_IMAGE=ghcr.io/kyoubeai/kyoubeai` in `.env` when you next change
  `KYOUBE_VERSION`.
- **`./update.sh --rollback`** after the switch puts the old image back in `.env`; the release you came
  from is still there.

## Moving to 1.1

1.1 adds `./install.sh` and `./update.sh`, takes the agent harnesses out of the image, and gives the
Terminal `sudo`. `./update.sh` takes the backup for you.

- **Update with `./update.sh`, from the new checkout.** A 1.0 checkout has no `update.sh`, so check out
  the release first. The script finds which release the stack still runs from `KYOUBE_VERSION` in
  `.env`.

  An install on the published image (a `KYOUBE_IMAGE` on `ghcr.io` in `.env`):

  ```bash
  git fetch --tags
  git checkout v1.1.0
  ./update.sh
  ```

  It pins `COMPOSE_PROJECT_NAME` in `.env` if it is missing, says `the stack runs v1.0.0; this checkout
  is at v1.1.0`, downloads the 1.1.0 image before it changes anything, lists the harnesses your agents
  use, takes a backup, records a rollback point (`.kyoube/update-state`), adds the keys that are new in
  `.env.example` and lists them, restarts on 1.1.0, offers to install the harnesses your agents use that
  the new image lacks, and runs `kyoube doctor`. `./update.sh --rollback` works afterwards.

  `git checkout v1.1.0` leaves HEAD detached, which is fine for releases: `./update.sh` fetches the tags
  itself and checks out the next release when there is one. `./update.sh --edge` needs a branch, so run
  `git checkout main` (or your branch) first if you switch to it.

  An install built from source (`docker compose up -d --build`, `KYOUBE_VERSION=dev` in `.env`) brings
  the new code with `git pull` and then runs `./update.sh --edge`. It sees that the source image is older
  than the checkout, takes the same backup and rebuilds. A 1.0 build left no record of the commit it was
  built from (1.1 keeps one in `.kyoube/built-commit`), so the rollback point is where the branch stood
  before the pull; if no earlier position is known, the script says that `--rollback` will return the
  data but not the older code.

  The script refuses, before it changes anything, when the code the stack runs is not part of the history
  of the code it would move to (a source build newer than the release, for one), or when `KYOUBE_VERSION`
  in `.env` is neither a release nor `dev`; its message says what to check out or set first.
  Re-running `./install.sh` repairs the version you have; moving to another version is `./update.sh`.
  On an install that has data, `./install.sh` refuses, before it changes anything, to switch the
  checkout, `KYOUBE_IMAGE` or `KYOUBE_VERSION`, or to build other code than the source build's.

  Two source installs on one machine each need their own `KYOUBE_IMAGE` in `.env`
  ([docs/operations.md](operations.md#two-source-installs-on-one-machine)).
- **pi and Hermes Agent are no longer in the image**, and Claude Code is no longer pinned (the core
  image keeps its own copy as a fallback). `./update.sh` shows which harnesses your agents use, and right
  after the restart offers to install any the new image lacks (`kyoube harness install pi`, `hermes`,
  `claude`); you can also run those from the Terminal. `kyoube doctor` fails `harnesses in use` for each
  harness an agent needs that is missing, and names the command. Hermes' settings, sessions and memory in
  `~/.hermes` are reused.
- **Claude subscription connections made before 1.1 hold an 8-hour token.** Connect each one again
  (README → Harnesses → [Claude Code](../README.md#claude-code)).
- **Keep local compose wiring in an untracked `docker-compose.override.yml`.** It is now in
  `.gitignore`. `./update.sh`, and `./install.sh` without `--edge`, refuse to run while a tracked file
  has local changes, so move edits you made to `docker-compose.yml` there first.
- **`./update.sh` keeps `KYOUBE_CORE_VERSION` in `.env` in step with `.env.example`**, with or without
  `--edge`, so you no longer copy the core pin by hand. `--edge` also fast-forwards the branch.
- **Public instances get the trusted runtime host.** `KYOUBE_TRUSTED_RUNTIME_HOST=auto`, the new default,
  turns on server-host sign-in for subscription connections in Connections and local stdio MCP tools on
  an instance with `KYOUBE_DEPLOYMENT_EXPOSURE=public`; a private instance is unaffected.
  [SECURITY.md](../SECURITY.md) ("Trusted runtime host") says what that trusts. To turn it off, set
  `KYOUBE_TRUSTED_RUNTIME_HOST=` (empty) in `.env` and run `docker compose up -d`.

## Moving to typed decisions

`kyoube.apps` 0.5.0 to 0.8.0 adds typed decisions ([`decisions.md`](decisions.md)) and with them
new capabilities: `http.outbound` and `secrets.read-ref` (0.5.0), then `issues.read`,
`issue.interactions.create` and `issue.interactions.read` (0.8.0). `kyoube ensure-plugins` grants
them on upgrade without asking (it reinstalls the plugin and keeps its data), so no board approval
appears. Nothing is sent anywhere until an instance admin sets a provider and key for a company and
a company admin switches a use on; until then every use answers `disabled`. `kyoube.apps` never
gets the capability to answer a card or an approval (`issue.interactions.respond`,
`approvals.respond`).

## Moving an install from core 2026.1005.0

This release moves from core 2026.1005.0 to 2026.1012.0. Read this before you rebuild.

- **Check `KYOUBE_CORE_VERSION=2026.1012.0` in `.env`.** `./update.sh` keeps it in step with
  `.env.example`; a hand-run `docker compose up -d --build` uses whatever `.env` says.
- **Back up first.** The core adds 12 database migrations (`0294` to `0305`). They run on the first
  start and cannot be undone: `bash scripts/backup.sh`. One of them (`0298`) fills in default usage
  instructions for existing Honcho, Mem0, Zep, Supermemory and Cognee connections.
- **Workspace restore locks changed format.** The core now keeps them as SQLite files in
  `/kyoubeai/instances/default/locks/directory-merge/`, and the old and new core must never write to
  the same home volume at once. `docker compose up -d` stops the old container before it starts the
  new one, so a normal update is safe. A `<hash>.lock` directory the old core left behind (after a
  crash, say) keeps blocking that workspace. After the update, run
  `docker compose exec app sh -c 'ls -d /kyoubeai/instances/default/locks/directory-merge/*.lock 2>/dev/null'`.
  If it lists anything, move those directories out of the folder. Never move or delete a
  `.lock.sqlite` file.
- **New agents can change other agents.** The core now gives every newly hired standard agent 14
  grants: changing agents and skills (`agents:configure`, `skills:create` and their suggest-changes
  pair), tool connections, profiles, runtime and audit, its responsible person's inbox, task
  assignment and active checkouts. Agents you already have keep what they had. A new hire's profile
  therefore shows **Can change agents** on; switch it off there for an agent that should not. Agents
  still cannot set the command or environment another agent runs. The agent working rules still take
  the broad "assign to anyone" grant from every agent and give each manager its own-team grant, which
  is the same grant the core now gives new agents.
- **Low-trust managers are protected.** The core now evaluates a low-trust agent's trust policy
  together with its assignment policy, so the agent working rules protect such a manager instead of
  reporting it under `agent rules skipped`.
- **Custom tool grants are enforced as written.** A grant whose `scope.allow` matches no tool,
  connection or app no longer falls back to a broader policy, and a grant with an unknown or
  malformed selector denies. KyoubeAI writes no such grants; if an agent loses a tool after the
  update, review the grants someone set by hand.
- **Email inboxes are no longer experimental.** An agent can get an AgentMail inbox without the Chat
  connectors setting, and each new email thread becomes a task assigned to it. User groups do not
  cover this ([groups.md](groups.md)).
- **Assistant connections (MCP)** let Claude Code, Codex and other MCP clients sign in as a person
  and work with tasks. They are off by default (Settings → Experimental) and need an `https://`
  `KYOUBE_PUBLIC_URL`.
- **Shorter default instructions.** New companies and new hires get short role descriptions instead
  of long manuals. Saved instructions are unchanged, and the agent working rules block is added as
  before.
- **The core image's own CLIs moved** to Claude Code 2.1.296, Codex 0.162.1 and OpenCode 1.19.0. They
  are fallbacks: a harness installed from the Terminal still comes first.

## Moving an install from core 2026.916.1

This release moves from core 2026.916.1 to 2026.1005.0 (upstream releases 2026.1001.0 and
2026.1005.0). Read this before you rebuild.

- **Check `KYOUBE_CORE_VERSION=2026.1005.0` in `.env`.** `./update.sh` keeps it in step with
  `.env.example`; a hand-run `docker compose up -d --build` uses whatever `.env` says.
- **Back up first.** The core adds 14 database migrations (`0280` to `0293`). They run on the first
  start and cannot be undone: `bash scripts/backup.sh`.
- **Harnesses no longer stop to ask permission.** The core now starts Claude Code with every tool
  allowed, Codex without its approval prompts and sandbox, OpenCode with `allow` and Gemini CLI in YOLO
  mode, unless an agent's settings say otherwise. On KyoubeAI little changes: Claude agents already
  skipped permissions and Codex's sandbox cannot run in a container. The core's own checks (company,
  task, approvals, the agent working rules' grants) still apply to everything an agent does through it.
- **@-mentioning an agent no longer starts a run.** A mention is context only. To hand an agent work,
  assign the task or ask it for a review; a comment still wakes the task's assignee.
- **Agent Chat has its own page** (`/chats`), with a model and effort picker on each message. It is
  still experimental and off by default: turn on Settings → Experimental → Agent Chat, and a **Chat**
  link appears under Inbox in the sidebar.
- **Keyboard-shortcut settings are gone** from the core (and its `/api/auth/preferences` route).
- **The Composio connector broker is gone.** Connectors made through it stop working; nothing in
  KyoubeAI used it.
- **Native-runner agents get two new tools**, `reassign_task` and `hire_agent`. Reassigning needs
  the agent's "can assign tasks" grant, the one the agent working rules manage, and hiring goes
  through the same approvals as before.

## Moving an install from core 2026.831.1

Builds of KyoubeAI made before 1.0.0 ran on core 2026.831.1; 1.0.0 runs on core 2026.916.1, a large
upstream release. Read this before you rebuild an install made from one of those builds.

- **Set `KYOUBE_CORE_VERSION=2026.916.1` in `.env`.** An install from an earlier build still pins
  2026.831.1 there, and the build then fails at the core-patches step
  ([Upgrading KyoubeAI](#upgrading-kyoubeai)).
- **Back up first.** The core adds 49 database migrations (`0231` to `0279`). They run on the first
  start and cannot be undone: `bash scripts/backup.sh`.
- **Behind a reverse proxy or tunnel, set `TRUST_PROXY`.** The core now believes `X-Forwarded-Host`
  only from a proxy it trusts. If sign-in or saving fails with an origin error behind Caddy, Traefik,
  nginx or a Cloudflare tunnel, set `TRUST_PROXY` in `.env`: `uniquelocal` trusts a proxy container
  on the same Docker network, and also a proxy on the host that reaches the container over a Docker
  bridge. Leave it empty when people reach the app directly.
- **The streamlined shell is the default.** The core's new sidebar replaces the old one, and Studio
  is built for it. Settings → Experimental → **Streamlined UI** switches back, but the Studio sidebar
  then shows the legacy Agents and Organization sections.
- **Some pages moved.** The org chart is a view on All agents; Timeline, Costs and an agent's runs are
  under Audit (`/activity/timeline`, `/activity/costs`, `/activity/runs`). Old URLs redirect, and the
  Workspace page links the new places.
- **Onboarding changed.** The first-run wizard's **Connect a model** step offers a Claude or OpenAI
  subscription or an API key. A subscription cannot be signed in from the wizard on a KyoubeAI server;
  use **Skip for now and connect the harness later from the Terminal page**, then install and connect
  the harness as README → [Harnesses](../README.md#harnesses) describes.
- **Announcements stay off.** The core now shows Paperclip's hosted announcement cards by default;
  KyoubeAI's `docker-compose.yml` turns them off (`PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false"`).
- **Agent credentials are no longer echoed.** Agent API responses redact plaintext `env` values.
  Nothing in KyoubeAI reads them; a script of your own might.
- **The native runner gate is open.** `enableNativeRunner` now defaults to on for self-hosted
  instances. Nothing switches automatically, and existing agents keep their adapters.
- **Harnesses.** Since 1.1 the image ships none of its own; you install the ones you want from the
  Terminal ([Moving to 1.1](#moving-to-11)). Their logins on the `kyoubeai-home` volume carry over.

## Upgrading from 0.1.x

0.2.0 renamed what the container and the database are called: the home volume is `kyoubeai-home` mounted at `/kyoubeai`, the core role and database are `kyoubeai`,
and `.env` uses `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE` and `KYOUBE_CORE_VERSION`. One script
moves an existing install across, and it is safe to re-run:

```bash
bash scripts/backup.sh                 # with the 0.1.x checkout, before pulling
git pull
bash scripts/migrate-from-0.1.sh       # stops app, renames the role/database, copies the home volume, starts 0.2.x
docker compose exec app kyoube doctor
```

What it does, in order: stops `app`; snapshots the cluster and the old volume under
`backups/pre-0.2-migration-…` (skip with `--no-backup`); renames the three keys in `.env` (a
`.env.bak` is kept); renames the Postgres role and database in place through a temporary superuser;
builds or pulls the 0.2.x image; lets compose create `kyoubeai-home` and copies `paperclip-home`
into it; starts the stack and runs `kyoube doctor`.

**The compatibility link.** A 0.1.x database can hold absolute `/paperclip/…` paths — agents'
workspace directories, execution workspaces — and so can harness state on the volume. The script
leaves a marker (`/kyoubeai/.migrated-from-paperclip-home`); while it exists the entrypoint keeps
`/paperclip` as a symlink to `/kyoubeai`, so those paths keep working. `bash scripts/migrate-from-0.1.sh --check`
counts what still points at the old path; when it says `0`, delete the marker
(`docker compose exec app rm -f /kyoubeai/.migrated-from-paperclip-home`) and the link is gone at the
next start. `kyoube doctor` reports the link under `legacy home link` until then.

**The old volume** (`<project>_paperclip-home`) is left in place; remove it with `docker volume rm`
once you are satisfied. A 0.1.x backup still restores with `scripts/restore.sh`: it recognises the old
file names, restores into the new layout and leaves the marker for you.

**If you ran `docker compose up -d --build` before the migration** — the natural thing to do after a
`git pull` — the 0.2.x app starts, creates and fills `<project>_kyoubeai-home`, and then crash-loops
on `role "kyoubeai" does not exist`, because the cluster is still the 0.1.x one. The migration
refuses to overwrite that half-populated volume, and a bare `docker volume rm` fails with *volume is
in use* while the stopped container still references it. Remove the container first, then the volume,
then migrate:

```bash
docker compose rm -sf app
docker volume rm <project>_kyoubeai-home
bash scripts/migrate-from-0.1.sh
```

**Rolling back to 0.1.x** is a restore of the pre-upgrade backup on the 0.1.x checkout, as in
[Rolling back](#rolling-back); the renamed cluster is not usable by a 0.1.x image.

## Upgrading the core

### Read these first

1. **The core's (Paperclip's) release notes** for every version between yours and the target. Breaking changes to
   the plugin host, the board API, or the database schema land there.
2. **`doc/plugins/PLUGIN_AUTHORING_GUIDE.md`** in the core repository, diffed against the
   version you are on. The plugins in `plugins/` are written against that contract — manifest
   fields, capability names, the action/data bridge, the tool gateway, the UI slot host. A change
   there is the most likely reason a bump needs code and not just a pin.
3. The `@paperclipai/plugin-sdk` changelog for the same range: the SDK version and the image version
   are pinned together on purpose.

### Do the bump

```bash
bash scripts/bump-core.sh 2026.914.1
```

That rewrites every pin in one go — `ARG KYOUBE_CORE_VERSION` in `docker/Dockerfile`,
`KYOUBE_CORE_VERSION` in `.env.example` and `scripts/smoke.env`, the default in `docker-compose.yml`,
and the `@paperclipai/plugin-sdk` dependency of every plugin — then reinstalls and runs
`scripts/check-pins.sh`, which fails if any of them disagree.

Then, in order:

```bash
pnpm test           # unit suites for the bootstrap CLI and every plugin
pnpm build          # every package builds against the new SDK
bash scripts/smoke.sh   # the full docker end-to-end, 12-25 minutes
```

How long the smoke takes is dominated by the image build: about 12 minutes when the build cache is
warm, roughly twice that when a new `KYOUBE_CORE_VERSION` invalidates it.

The smoke is the real gate: it builds the image, claims a fresh instance, installs both plugins,
rehearses a version bump and a capability escalation, exercises the terminal, data and apps paths,
and finishes with a full backup/restore round trip. If it passes, commit:

```bash
git commit -am "chore: bump core to 2026.914.1"
```

Finally, roll it out: copy the new `KYOUBE_CORE_VERSION` into your deployment's own `.env` (it is not
tracked, so `bump-core.sh` cannot touch it) and `docker compose up -d --build`.

### What can break

- **The image build stops at the `core-patches` step** with a line like
  `core patch "<id>" matched 0 time(s) … expected 1`. Most entries in `docker/core-patches/patches.mjs`
  are a fix to an upstream bug that shipped here first; the new core either carries the upstream fix
  (delete the entry — that is the intended outcome) or changed the code's shape (check the upstream
  file the entry names; redo the pattern only if the bug is still there). The `standing` entries
  (licensing, user groups, agent questions) are never deleted: when one fails, redo it for the new
  core, as `CONTRIBUTING.md` ("Never patch the core") describes. Never loosen a pattern to make the
  build pass. An entry that declares its upstream fix (`upstreamFix`) does not stop the build
  on a core that carries that fix: the log says `<id>: already fixed upstream`, and the entry is
  deleted at the bump all the same.
- **The image build stops at the `theme` step** with a line naming a text rule, an anchor, a sidebar
  section or a token (for example `text rule "home-sidebar-label" matched 0 time(s)` or
  `sidebar section "organization" changed: added [/reports]`). The core moved something the Studio
  design relies on; nothing was written. `docs/theme.md` ("After a core bump") says what to change for
  each message. Never relax a rule's `expect` to make the build pass. When it passes, look at the
  `studio-screenshots` the smoke leaves (CI artifact, or `STUDIO_SHOTS_DIR` locally).
- **The image build stops at the `pwa` step** with `pwa verification failed:` and one or more lines.
  The core changed something the installable app and push notifications rely on; nothing was written.
  Each line names the file; read the new one in the core before changing anything:
  - `ui/dist/sw.js is missing` or `core sw.js changed: expected one fetch listener, found N`: the core's
    service worker moved or was rewritten. Read the new `sw.js` and decide whether
    `importScripts("/kyoube-push-sw.js")` still belongs at its end.
  - `core sw.js now handles push itself`: the core added its own push handler. Delete the import
    (`docker/pwa`) rather than run two push handlers, and check what the core's push does.
  - `site.webmanifest is not valid JSON` or `is not a JSON object`: the core's manifest changed form.
    Look at the new file.
  - `<meta name="apple-mobile-web-app-title" matched N time(s)`: the core's `index.html` changed
    its iOS tags. Look at the new `index.html` and move the anchor.
  - `sw.js already imports kyoube-push-sw.js`: the step ran twice on the same core layer. Rebuild from
    a clean core layer.

  A warning that the bundle no longer calls `register("/sw.js")` does not stop the build:
  **Turn on** (Home card and Notifications page) registers the worker itself. See
  [`mobile.md`](mobile.md), and never relax a check to make the build pass.
- **A capability was renamed or removed upstream.** The plugin install fails outright. Fix the
  manifest in `plugins/*/src/manifest.ts`.
- **The plugin host changed a bridge or route shape.** Usually surfaces as a plugin that installs
  but never reaches `ready`; the plugin's own log names the throw.
- **The smoke's `agent rules` section fails, or `kyoube doctor` fails `agent rules` after the bump.**
  The core changed a call the agent working rules rely on: resolver governance, agent authorization
  policies and grants, instructions bundles or decisions. The failure names the call. See
  [`agent-rules.md`](agent-rules.md), "After a core update". Never loosen the smoke's assertions to
  make the bump pass. If the post-restart doctors in the smoke show `agent rules` failing with a 503
  from `kyoube.agent-rules`, the core changed how it answers a plugin route before the worker runs;
  see `pluginReady` in `docker/bootstrap/src/agent-rules/api.ts`.
- **The smoke's `decisions` or `guardrail` step fails.** Typed decisions rely on three core
  conventions the plugin SDK does not type: a `format: "secret-ref"` field in plugin config (the
  secret picker, and the stored `{ type: "secret_ref", secretId, version }` binding that
  `ctx.secrets.resolve` accepts); `resolverPolicy: "human_only"` on a confirmation card a plugin
  raises, with `resolvedByUserId` set when a person answers and an agent's answer refused
  (`interaction_human_only`); and `kyoube ensure-plugins` turning a capability escalation into a
  reinstall. The failing assertion names which one. See [`decisions.md`](decisions.md). Never
  loosen the smoke's assertions to make the bump pass.
- **The core's own migrations run on first start** against the `kyoubeai` database, before the app
  serves anything. Give it time — the compose healthcheck allows a 180-second start period for
  exactly this — and read `docker compose logs -f app` rather than restarting into a half-migrated
  database.

## Rolling back

Reverting the code is easy; reverting a database is not.

After `./update.sh`, `./update.sh --rollback` does it for you. It checks the update's backup against its
`SHA256SUMS` before anything stops, then stops the app, puts the checkout and `.env` back as they were
before that update, restores the backup, starts the stack and runs `kyoube doctor`. It undoes the last
update only, and everything written since that backup is replaced. The `.env` it replaces is kept as
`.kyoube/env.before-rollback`, so a setting you changed after the update can be copied back. Without a
terminal it needs `--yes`.

After an `--edge` update, a branch the update fast-forwarded goes back to where it stood, keeping the
commits it had before. A branch with commits made after the update is left where it is. The code the
stack ran is checked out, detached when it is not the branch's tip, and the command says where the
branch and the checkout are and how to return to the branch.

A rollback that stops part way (a failed restore, for one) is finished by running
`./update.sh --rollback` again; until then every other `./update.sh` refuses, so nothing backs up or
starts on the half-restored data. The steps below are for everything else.

```bash
git revert <the bump commit>       # or: git checkout <previous tag>
docker compose up -d --build
```

On a published image, check out the previous release tag instead, set `KYOUBE_VERSION` in `.env`
back to that release, and run `docker compose pull && docker compose up -d` rather than building.

**Databases migrate forward only.** Neither the core's migrations nor Kyoube's have a `down` step.
An older image against a database a newer image has already migrated is unsupported: it may start
and then fail in obscure ways, or refuse to start at all. If a core migration has to be undone,
the supported route is to restore the backup you took before the upgrade:

```bash
bash scripts/restore.sh backups/<the one from before the bump>
```

Restore replaces both databases and the home volume wholesale, so everything written since that
backup is lost — which is the argument for taking one immediately before every bump, not nightly
only.

Restoring onto the older image also puts the plugin rows back in step with it, without you doing
anything: the restored `kyoubeai` database still lists the newer image's plugin versions, and
`ensure-plugins` compares each installed version against the one on disk for **difference, not
newness**, so it re-installs them at the older image's versions on the next start. That is what you
want here — but it is also why running an older image against a database you have *not* restored is
not a rollback: the plugins would be downgraded while the schema stayed migrated forward.

### The 0.1.x migration's own snapshot

`scripts/migrate-from-0.1.sh` writes `backups/pre-0.2-migration-<timestamp>/` containing
`cluster.sql` (a `pg_dumpall --no-role-passwords` of the whole cluster) and `paperclip-home.tgz`.
That is **not** a `scripts/backup.sh` archive and `scripts/restore.sh` cannot read it: at that point
in the migration the `kyoubeai` role and database do not exist yet — the cluster is still
`paperclip` — so `backup.sh`, which dumps the `kyoubeai` database as the `kyoubeai` role, cannot run.
It is a last resort behind the backup you took with the 0.1.x checkout; restore it by hand, onto an
**empty** cluster:

```bash
SNAP=backups/pre-0.2-migration-<timestamp>
docker compose down                    # stop everything
docker volume rm <project>_pgdata      # the cluster must be empty; postgres-init re-bootstraps it
docker compose up -d --wait db
docker compose exec -T db psql -U kyoubeai -d postgres -f - < "$SNAP/cluster.sql"
```

`psql` is deliberately run without `ON_ERROR_STOP`: `pg_dumpall` output recreates roles and databases
the freshly bootstrapped cluster already has, and those "already exists" errors are expected.

`cluster.sql` carries no passwords (that is what `--no-role-passwords` buys: no role password hashes
sitting in `./backups`), so re-set the two the deployment uses. Read them inside the container from
its own environment, exactly as `scripts/restore.sh` does, so they never reach your shell history:

```bash
docker compose exec -T db sh -c 'psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 -f -' <<'SQL'
\set pw `echo "$POSTGRES_PASSWORD"`
ALTER ROLE paperclip PASSWORD :'pw';
SQL
docker compose exec -T db sh -c 'psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 -f -' <<'SQL'
\set pw `echo "$KYOUBE_DB_PASSWORD"`
ALTER ROLE kyoube PASSWORD :'pw';
SQL
```

(The first role is `paperclip` if you are restoring to the pre-migration state, `kyoubeai` if the
rename had already happened; adjust the `-U` user the same way.) Then put the home volume back and
start the app:

```bash
docker run --rm -i -v <project>_paperclip-home:/to alpine:3.20 \
  sh -c 'rm -rf /to/..?* /to/.[!.]* /to/* 2>/dev/null; exec tar xzf - -C /to' \
  < "$SNAP/paperclip-home.tgz"
docker compose up -d
```

The Kyoube plugin's own `kyoube_meta` migrations are **checksummed** as well as forward-only. Each
file's SHA-256 is recorded in `kyoube_meta.migrations` when it is applied, and the worker refuses to
start if an already-applied file has changed:
`migration 0001_meta.sql was modified after being applied`. So:

- Never edit a migration that has shipped. Add a new numbered file instead.
- If you hit that error after switching branches or rolling back, the database is ahead of the code.
  Go back to the newer code, or restore a backup taken before the migration ran. Editing the
  checksum row to make the error go away leaves the schema and the code disagreeing silently.
