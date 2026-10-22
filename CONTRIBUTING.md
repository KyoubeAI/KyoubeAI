# Contributing to KyoubeAI

KyoubeAI is a Docker overlay on top of the upstream core (Paperclip, https://github.com/paperclipai/paperclip):
four core plugins (`kyoube.terminal`, `kyoube.apps`, `kyoube.files`, `kyoube.studio`), an app SDK,
and a small bootstrap CLI. This document is local setup, conventions, and the review checklist. For
how the pieces fit together, read [`docs/architecture.md`](docs/architecture.md) first.

## Local setup

Requirements: Node 24 (see `.nvmrc`), pnpm (pinned via `packageManager` in `package.json` — plain `pnpm`
switches itself to the pinned version, so `corepack enable` is optional; it is known to fail on some
Windows setups). For the full Docker smoke test: Docker Engine with Compose v2, `curl`, `jq`.

```bash
git clone https://github.com/KyoubeAI/KyoubeAI.git && cd KyoubeAI
pnpm install
```

Unit tests (bootstrap CLI, the plugins, the app SDK — no database needed):

```bash
pnpm test
pnpm typecheck
pnpm build
```

The shell scripts have their own tests, written for bats (installed by `pnpm install`): `install.sh`,
`update.sh` and `scripts/lib/host.sh` under `scripts/tests`, and the container scripts in
`docker/system` under `docker/system/tests`:

```bash
pnpm test:sh
```

The host scripts (`install.sh`, `update.sh`, `scripts/lib/host.sh`, `scripts/install-e2e.sh`) have to
run on the bash 3.2 that macOS ships, and the container scripts (`docker/system/*`,
`docker/entrypoint.sh`) are POSIX `sh`. CI runs ShellCheck over the host scripts and the
`docker/system` scripts.

The apps plugin also has an integration suite that runs its schema/records/company-isolation/migration
tests against a real Postgres. Start a throwaway one and export the URL it prints:

```bash
bash scripts/dev-db.sh
# prints: export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres
export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres
pnpm --filter @kyoube/plugin-apps test:integration
```

The full end-to-end check builds the image, brings up the compose stack, claims a fresh instance,
installs both plugins, and exercises the terminal/data/apps paths plus a backup/restore round trip. It is
what CI's `docker-smoke` job runs, and takes roughly 12–25 minutes locally depending on build cache:

```bash
pnpm smoke   # == bash scripts/smoke.sh
```

`scripts/install-e2e.sh` then tests `install.sh` and `update.sh` end to end on the image the smoke
built (`kyoubeai:smoke`, so run `pnpm smoke` first): in a throwaway clone with two local releases it
installs, claims the instance and approves the plugins through the API, updates (merging a new setting
and installing a harness an agent uses), rolls back, and checks that a second install onto the same
project's volumes is refused. CI runs it after the smoke.

Before opening a PR that touches the core pin, also run `bash scripts/check-pins.sh` — it is the
first step of CI and fails fast if `KYOUBE_CORE_VERSION` and the plugin SDK pins disagree.

## Running from source

The installer and the updater work on your checkout too. `./install.sh --edge` stays on the branch you
are on and builds the image from source (10–25 minutes the first time) instead of downloading a
release; `./update.sh --edge` later fast-forwards that branch, merges new settings into `.env`, keeps
`KYOUBE_CORE_VERSION` in step with `.env.example` and rebuilds:

```bash
./install.sh --edge
./update.sh --edge
```

`./install.sh --help` lists the install options; `--name <project>` and `--port <n>` run a second
instance beside another. `./update.sh` takes a backup first and refuses to run while tracked files
have local changes, so stash or commit them first. `--edge` needs a branch with an upstream, and
`./update.sh --rollback` goes back to the code and data from before the last update.

## Branch and commit conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, optionally scoped —
  `feat(apps): …`, `fix(terminal): …`). `CHANGELOG.md` is written in these terms.
- **LF line endings** everywhere (`.gitattributes` sets `eol=lf`; `.editorconfig` matches). Watch for this
  especially on Windows — some tools (e.g. certain `jq` builds) write CRLF when redirected to a file.
- **One task per PR.** Keep a PR reviewable: one logical change, its tests, and any doc updates it makes
  necessary.
- **Maintainers merge by pushing, not with the merge button.** With the branch rebased on `main` and its CI
  green, `git push origin <branch>:main`; GitHub marks the PR merged. The button records whoever clicks it
  as the committer of every commit.

## Where things live

The workspace is the private root and these build-time or deployable members:

| Path | Package | What it is |
|---|---|---|
| *(root)* | `kyoubeai` | Workspace root: `install.sh`, `update.sh`, `docker-compose.yml`, `docker/`, `docs/`, `scripts/`, `.github/`. |
| `docker/bootstrap/` | `@kyoube/bootstrap` | The `kyoube` CLI (`setup`, `ensure-plugins`, `agent-rules`, `license`, `users`, `doctor`, `harness`, `connect`). |
| `docker/system/` | *(not a package)* | What the image adds for the Terminal: passwordless `sudo`, the apt hook that keeps installed system packages (`apt-record`, `apt-restore`), `/etc/profile.d` and npm's prefix. |
| `docker/rebrand/` | `@kyoube/rebrand` | The build-time brand transform: names, logo and artwork (see `docs/branding.md`). |
| `docker/core-patches/` | `@kyoube/core-patches` | Build-time fixes to upstream bugs, held only until the upstream fix ships, plus the standing licensing, user-groups, agent-questions and work-object visibility entries (see "Never patch the core"). |
| `docker/theme/` | `@kyoube/theme` | The build-time Studio theme: brand tokens, a gated skin and display-text renames (see `docs/theme.md`). |
| `plugins/kyoube-terminal/` | `@kyoube/plugin-terminal` | The browser terminal plugin. |
| `plugins/kyoube-apps/` | `@kyoube/plugin-apps` | The organisation database and Apps plugin (one worker, two modules). |
| `plugins/kyoube-files/` | `@kyoube/plugin-files` | The project Files tab: a browser and editor for each project's working folder. |
| `plugins/kyoube-studio/` | `@kyoube/plugin-studio` | The Studio layout: Home, the sidebar's Build group and Team roster, the Workspace page, agent characters. |
| `plugins/kyoube-agent-rules/` | `@kyoube/plugin-agent-rules` | The agent working rules guardrail: protected manager agents and their own-team assign grants (no UI; `kyoube agent-rules` drives it, see `docs/agent-rules.md`). |
| `plugins/kyoube-license/` | `@kyoube/plugin-license` | The Licence settings page and the attention chip. It reads files on the home volume, never the core database (see `docs/licensing.md`). |
| `packages/kyoube-app-sdk/` | `@kyoube/app-sdk` | `window.kyoube`, injected into every app's iframe. |
| `packages/license/` | `@kyoube/license` | Licence keys: the `KYB1` format, signing and verifying, the licence status, and `enforce.mjs`, the seat check the core's sign-up hook calls (see `docs/licensing.md`). |

The `@kyoube/license` package is built first when you run `pnpm -r`. To run a dependent's script on its own (`docker/bootstrap`, `docker/core-patches`, `plugins/kyoube-license`), run `pnpm --filter @kyoube/license build` once first.

Within `plugins/kyoube-apps/src/`: `data/` is the schema/records/permissions/SQL-validation service,
`apps/` is the Apps module (manifest, store, service, tools, API routes) built on top of it, `db/` is the
company-scope and migration machinery, `ui/` is the plugin's React pages, and `skills/` holds the two
managed-skill Markdown files (`kyoube-data.md`, `kyoube-apps.md`) shipped in the plugin manifest.

Within `plugins/kyoube-files/src/`: `fs-service.ts` is `WorkspaceFiles`, every filesystem operation bound
to one project folder with the containment and no-symlink-following rules, `paths.ts` the pure path
validation it builds on, `plugin.ts` the actions and the role gate, and `ui/` the `ProjectFilesTab`
(`detailTab` on projects) and the `ProjectSidebarItem` link and the `GlobalFilesButton` top-bar icon with its docked task panel. It has no database, no REST routes and no
tools: agents already have the folder, and the plugin exists for people.

## Never patch the core

Nothing in this repository is core source, and the image is built `FROM` the pinned upstream release,
rebranded, themed and carrying a short list of build-time fixes (below). If something you need isn't
possible through `@paperclipai/plugin-sdk` (a capability that doesn't exist, a route the plugin host
doesn't expose), the answer is never to vendor or patch upstream code — propose it upstream (open an issue or PR on
[`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)) or find a way to build it as a
plugin. `docs/architecture.md`'s "Isolation from upstream" material and `docs/upgrading.md` explain why
this matters: it is what makes a core version bump a one-line change instead of a rebase. There are
two standing exceptions that change presentation only, one standing exception that changes behaviour
(licensing, user groups, agent questions and work-object visibility, below), and one temporary list that changes behaviour; all four are build-time transforms re-applied to the
pristine core on every build, and all four fail the build when upstream moves what they rely on.
The two presentation exceptions:

- `docker/rebrand/` changes the core's *user-facing text and artwork* to KyoubeAI; `docs/branding.md`
  lists what it leaves alone.
- `docker/theme/` applies the Studio design: it overrides the core's CSS tokens, adds a stylesheet
  aimed only at stable hooks (route links, ARIA labels, icon names, our own `data-kyoube-*`
  markers), inlines a small boot flag, and renames a few labels (Dashboard → Home, the core's last
  "Apps" breadcrumbs → Connectors) and the default theme (dark). Every rule declares how often it must match, and
  every rule that hides or moves core UI is gated on the Studio plugin being present, so a miss shows
  the stock layout. It may not change behaviour: anything that needs data or logic goes in
  `plugins/kyoube-studio`, on the public SDK. `docs/theme.md` has the details.

The standing behaviour exception has four parts. The first is licensing. Two entries in `docker/core-patches/patches.mjs`
marked `standing` register a Better Auth `user.create.before` hook in `server/dist/auth/better-auth.js`.
The hook only calls KyoubeAI code (`packages/license`, shipped as `/opt/kyoube/license/enforce.mjs`),
which enforces the user limit in `LICENSE` (`docs/licensing.md`). When a core release moves the code
it anchors on, the build fails naming the entry, and the fix is to redo it for that core, never to
delete it. `scripts/smoke.sh` proves the limit on every PR, after every core bump, and weekly against
the core's `:beta`.

The second is user groups (`docs/groups.md`). Two `standing` entries, `groups-chat-open-assign-check`
and `groups-chat-message-assign-check`, add the core's own `assertCanAssignTasks` check to the Agent
Chat routes in `server/dist/routes/issues.js`, for protected agents only. Those routes create and
continue a conversation assigned to an agent without any assignment check, and groups restrict who
may give an agent work, so the gap would let anyone outside a group chat with its agents. It is a
patch because the core offers no hook there. It calls only the core's own function and holds no
KyoubeAI logic. The same rule applies: when a core release moves an anchor, the build fails naming
the entry, and the fix is to redo it for that core, never to delete it.

The third is agent questions (`docs/agent-rules.md`). One `standing` entry, `agent-questions-ask-level`,
adds one line to the core's card creation in `server/dist/services/issue-thread-interactions.js`. For
an agent's question addressed to another agent, the line calls KyoubeAI code (`docker/core-patches/ask-level.mjs`,
shipped as `/opt/kyoube/core-patches/ask-level.mjs`), which refuses the question or makes it answerable
by that agent, depending on the asker's ask level. It runs after the core applies the company's
people-only cap, so without the patch every such card stays people-only. The same rule applies: when a
core release moves the anchor, the build fails naming the entry, and the fix is to redo it for that
core, never to delete it.

The fourth is work-object visibility (`docs/groups.md`, "Visibility"). Four `standing` entries,
`visibility-board-decide`, `visibility-live-events`, `visibility-search-scope` and
`visibility-search-filter`, call KyoubeAI code (`packages/visibility`, shipped as
`/opt/kyoube/visibility/decide.mjs`) in the board branch of the core's authorization decision
(`server/dist/services/authorization.js`), its live-events socket (`server/dist/realtime/live-events-ws.js`)
and its company search (`server/dist/routes/issues.js`), for people in a need-to-know company. The core
has no visibility setting of its own, so without the patches everyone in a company sees all of its
tasks and projects. A module that can't load refuses the covered actions to operators and viewers, so
a failure closes rather than opens. The exit: when upstream ships a company visibility mode with the
same rules, the four entries, the module and the policy files go, and the Groups page writes the
upstream setting instead. Until then the same rule applies: when a core release moves an anchor, the
build fails naming the entry, and the fix is to redo it for that core, never to delete it.

The one narrow, temporary way to change behaviour is `docker/core-patches/patches.mjs`, a list whose
temporary entries are meant to go away; only the standing licensing, user-groups, agent-questions and work-object visibility entries stay. The temporary
entries are fixes in the served UI and in the compiled server (`server/dist`), for example the command
the Claude subscription sign-in presents and the agent Test route on an unsaved harness switch. A
temporary entry is a fix to an upstream bug that had to ship here first, applied to the
pristine core layer at image build time (`docker/core-patches/apply.mjs`, the Dockerfile step right
before the rebrand) **while the same fix is on its way upstream** — every temporary entry names its upstream
issue or pull request, and opening that PR is part of adding the entry, not an afterthought. The rules
that keep this from turning into a fork: a pattern anchors on the compiled bundle's string literals
and code shape, never on minifier-chosen identifier names; it must match **exactly** the declared
number of times or the build fails with the patch's id; and the tests in `docker/core-patches/tests`
pin the patch to a fixture of the real minified code *and run the patched code* to prove the
behaviour. A core bump that changes that code — or that already carries the upstream fix — therefore
fails at the patch step, and the answer is to delete the entry (or, if upstream still has the bug in
a new shape, redo it), never to loosen the pattern. An entry may also declare the upstream fix's own
shape (`upstreamFix`): on a core where its pattern matches nothing and that marker matches exactly once,
the entry is skipped with `<id>: already fixed upstream` in the build log, so the weekly build against
the core's pre-releases does not fail on a fix that has landed upstream. The marker must match only the
upstream code, never the entry's own output, and the tests pin it to an excerpt of that code.

## How to add a tool

Both the `data_*` tools (`plugins/kyoube-apps/src/tools.ts`) and the `apps_*` tools
(`plugins/kyoube-apps/src/apps/tools.ts`) share one runtime (`src/tool-runtime.ts`), so adding either
follows the same shape:

1. **Add the definition.** Append a `ToolDefinition` to `TOOL_DEFINITIONS` (data) or
   `APP_TOOL_DEFINITIONS` (apps): a `name`, `displayName`, `description`, a Zod `schema` for its
   parameters, and a `run(service, companyId, actor, params)` that calls the corresponding method on
   `DataService`/`AppService`. Both `toolDeclarations()`/`appToolDeclarations()` and the plugin manifest
   (`src/manifest.ts`) derive from these arrays automatically — there is no separate manifest list to
   keep in sync by hand.
2. **Add a unit test.** `tests/unit/tools.spec.ts` and `tests/unit/apps-tools.spec.ts` each assert the
   *exact, ordered* list of declared tool names and that the manifest's `tools` array matches it — so a
   new tool that isn't added to that expected-names list fails the test immediately, which is what keeps
   the manifest and the code from drifting apart. Add a case exercising the new tool's happy path and its
   validation/permission failures, following the existing tests in that file as a template.
3. **Update the skill.** Add the tool to the relevant managed skill (`src/skills/kyoube-data.md` or
   `src/skills/kyoube-apps.md`) so an agent is told it exists, what it does, and any access level it
   requires — the skill text is what an agent actually reads; the tool description alone is not enough
   guidance for a workflow.
4. **Verify.** `pnpm --filter @kyoube/plugin-apps test` and `pnpm --filter @kyoube/plugin-apps build` (the
   skill Markdown is bundled into the built manifest, so a build after a skill edit is part of verifying
   it, not optional).

## Review checklist

- Tests, typecheck, and (for a change under `plugins/kyoube-apps/`) the integration suite pass.
- Conventional Commit message; LF line endings; docs updated where the change makes them stale.
- No new code imports from the core's own source or calls an undocumented route (see "Never patch
  the core" above).
- For anything touching the terminal gate, a data/company boundary, or the apps sandbox, run
  [`.github/ISSUE_TEMPLATE/security-review.md`](.github/ISSUE_TEMPLATE/security-review.md)'s checklist
  against your change before requesting review.

## Release checklist

1. `CHANGELOG.md` has the release's entry with its date, and the root `package.json` `version` matches.
   A plugin whose code changed has its version bumped in both its `package.json` and `src/manifest.ts`.
   `.github/release-notes/vX.Y.Z.md` has the GitHub Release's notes: a one-line lead, `## What's in X.Y.Z`
   with a bold-led paragraph per change, then `## Update` with how to update and a link to `CHANGELOG.md`.
2. `bash scripts/check-pins.sh`, `pnpm typecheck`, `pnpm test`, `pnpm test:sh` and `pnpm build` pass.
3. `pnpm smoke` and `bash scripts/install-e2e.sh` pass.
4. Tag `vX.Y.Z` and push the tag. The release workflow publishes the multi-architecture image
   `ghcr.io/kyoubeai/kyoubeai:X.Y.Z` and `latest`, and copies both to the image releases were published
   to before the repository moved to the KyoubeAI organization (that step needs the `GHCR_LEGACY_TOKEN`
   secret; see `.github/workflows/release.yml`). Then it makes the GitHub Release from the notes file
   (`.github/workflows/github-release.yml`), marked Latest; a tag with a `-` gets a pre-release. If the
   notes file was missing, add it on `main` and run **github-release** for the tag from the Actions tab.
   `install.sh` and `update.sh` only consider tags without a `-`, from 1.1.0 on, so a pre-release tag such
   as `v1.2.0-rc1` is never offered to users.
5. Once the release workflow has finished, update a real install of the previous release on Linux and
   on macOS (Docker Desktop), then run `./update.sh --rollback` on it. For 1.1.0 that is a 1.0.x install:
   `git fetch --tags`, `git checkout v1.1.0` and `./update.sh` ([`docs/upgrading.md`](docs/upgrading.md),
   "Moving to 1.1"); for later releases, `./update.sh` alone. Run `./install.sh` once in WSL2. If any
   of this fails after the tag is pushed, fix it forward with the next patch release (X.Y.Z+1); never
   delete or re-point a pushed tag, because installs may already have fetched it.

## Licensing and contributor agreement

KyoubeAI is source-available under the Business Source License 1.1 (`LICENSE`), and each version
becomes available under the Apache License, Version 2.0 four years after it is published. Commercial
licences fund the project's development, so every contribution needs the Contributor License
Agreement in [`CLA.md`](CLA.md). It licenses your contribution to the project under the BSL, under the
Change License named in `LICENSE` and under any other terms the maintainer chooses, and it leaves
every right you have to your own work untouched. Agree to it once, in the description of your
first pull request, with the sentence it names. Do not add licence headers to individual files; the
repository-level `LICENSE` and `NOTICE.md` cover them.
