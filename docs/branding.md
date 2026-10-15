# Branding

KyoubeAI runs on an upstream engine (Paperclip) whose own UI, server messages, agent skills and
artwork say "Paperclip". Nothing upstream makes that configurable, so KyoubeAI applies a **build-time
transform**: `docker/rebrand/rebrand.mjs` runs inside `docker/Dockerfile` right after the core layer
and rewrites the served surfaces in place. It runs on every build, on the pristine core layer, so a
core bump is re-branded by construction, and it exits non-zero — failing the build — when an upstream
change slips past its rules.
The Studio design (colours, sidebar, Home, label renames such as Dashboard → Home) is a separate step,
`docker/theme/`, which runs just before this one: see [`theme.md`](theme.md).

## What the transform does

1. **Text.** In the compiled UI (`ui/dist`), the server (`server/dist`), **all of the workspace
   packages** (`packages/**`), the built-in skills including the scripts they ship, the CLI's `dist`
   and the shipped docs, it applies three rules in order:
   exact phrase overrides (`docker/brand/brand.json` → `phrases`), a map of upstream URLs to ours
   (`urls`), and the generic name rule — `Paperclip`, case-sensitive, not preceded by
   `[A-Za-z0-9_$-]` and not followed by `[A-Za-z0-9_$]`, becomes the brand name. Capitalised
   `Paperclip` is display text; lowercase and camelCase forms are identifiers the core compares
   against, and they are left alone.

   `packages/**` is admitted whole — not just its `dist` output — because the image runs the
   packages from **source**: the CMD is `node --import tsx/dist/loader.mjs server/dist/index.js`, and
   every `@paperclipai/*` package's `exports` map points at `./src/*.ts` (three packages ship no
   `dist` at all). That source is where the agent prompts, the adapter config labels, the Skills-tab
   origin labels and the `[paperclip]` log prefixes live. Code files there (`.ts .tsx .js .mjs .cjs`)
   go through a code-aware path: the phrase and URL rules apply unconditionally, and the name rule is
   held back only where a match is both outside any string or comment on its line *and*
   identifier-shaped (`import { Paperclip }`, `<Paperclip …>`, `icon: Paperclip`). Those are printed
   as `code-shaped matches left alone` rather than rewritten; on core 2026.916.1 there are **none**.
   `.sql` is deliberately excluded — see the residual record below.
2. **Artwork.** Favicons and PWA icons come from `docker/brand/icons/`; `favicon.svg` and the
   loading animation (`/kyoubeai-thinking.svg`) are rendered from `docker/brand/mark.svg`; the
   sign-in lockup inside the JS bundle is replaced with `docker/brand/lockup.svg`; `site.webmanifest`
   is regenerated from `brand.json`.
3. **Asset names.** Everything under `/assets` is served immutable for a year, so each file is
   renamed `name-<upstream hash>-<8 hex>.ext` and every reference is rewritten. A browser that
   cached an unbranded bundle fetches the branded one.
4. **Verification.** After rewriting, the name rule must match nothing in the files it touched, the
   two SVG anchors must have matched exactly once, `index.html` must carry the brand title and keep
   upstream's runtime-branding marker block, `site.webmanifest` must carry the brand name, every
   file must survive a UTF-8 round trip, and every asset reference must resolve.
5. **A whole-image sweep.** Item 4's residual check only re-reads the files the rules just cleaned,
   so on its own it can never find the gap that matters: a tree the file set never entered — which
   is where every gap found in acceptance and review actually lived. So the transform also walks
   **all** of `/app` (skipping `node_modules`, `.git`, `*.map`, `*.d.ts`, tests), counts name matches
   per tree, prints the table, and **fails the build for any tree that is not allowlisted**. The
   allowlist (`SWEEP_ALLOWLIST` in `docker/rebrand/lib/files.mjs`, one documented reason per entry)
   is exactly the material shipped in the image that the running product never reads: `ui/src`,
   `ui/storybook`, `ui/public`, `ui/index.html`, `ui/README.md`, `ui/package.json`, `server/src`,
   `cli` (which ships no `dist` and is never exec'd), `doc/plans`, `docs/docs.json`, `docs/images`,
   `packages/paperclip-runner/runner` (Rust sources behind a prebuilt binary), `LICENSE`, and
   upstream's own development material (`.claude`, `.devin`, `.github`, `design`, `docker`, `evals`,
   `patches`, `releases`, `report`, `screenshots`, `scripts`, `tests`, `tools`, and
   `doc/connections/tool-method-permission-reviews.json`, which only upstream's tests read). `ui/dist`, `server/dist`,
   `packages`, `skills` and the rest must be **zero**. A handful of files that cannot be rewritten
   are listed as `known residual` with the reason (`SWEEP_KNOWN_RESIDUALS`) instead of failing.

The build log carries the counts, the code-shaped list and the sweep table as `rebrand:` lines.
`docker/rebrand/tests` pins every rule on fixtures; `scripts/brand-live-check.mjs` loads the sign-in
page of a running stack in headless Chrome and checks what a person sees (it exits 2 when no Chrome
is installed, which fails the smoke unless `KYOUBE_ALLOW_NO_CHROME=1`); `scripts/smoke.sh` checks the
served title, manifest, icon, bundle and plugin catalogue.

## What it leaves alone, on purpose

| Kept | Why |
|---|---|
| `PAPERCLIP_*` environment variables inside the container (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_HOME`, …) | The core's adapters, CLI, MCP server and skills read them. Operators never set them: `docker-compose.yml` maps the `KYOUBE_*` keys in `.env` onto them. |
| Skill keys and slugs (`paperclipai/paperclip/paperclip`, `paperclip-board`), enum values (`paperclip_runner`, `paperclip_managed`), CSS classes, localStorage keys, package names, the `X-Paperclip-Run-Id` header | Lookup keys, not display text. Their labels are rebranded; the keys show only in URLs, API JSON and the Skills library's key column. |
| The paperclip glyph used as an *attachment* icon | A generic icon in ~20 places; the brand instances (favicon, lockup, loading animation) are replaced. |
| `FROM ghcr.io/paperclipai/paperclip:<version>`, `renovate.json`, `scripts/bump-core.sh` | Build inputs. |
| `telemetry.paperclip.ing` endpoints | Off by default (`DO_NOT_TRACK=1`); pointing them at a host we do not run would only turn silence into errors. |
| The Paperclip copyright notice in `NOTICE.md` and the "Built on" line in the README | The MIT license the core is distributed under requires the notice. |
| Rows already stored in a database before the rebrand (old comments, run transcripts, agents' saved instructions, built-in agents created earlier) | Data, not code. New rows are branded. |

## Changing the brand

Edit `docker/brand/brand.json` (name, description, URLs, phrase overrides), replace `mark.svg`
(one stroked path in a 24×24 box — the loading animation draws it) and `lockup.svg`, run
`node scripts/render-brand-icons.mjs`, then `docker compose up -d --build`. The transform and its
tests read the kit and hard-code nothing.

Four places outside the kit do name the brand literally, and a rename has to change them too:

| Where | What |
|---|---|
| `docker/Dockerfile` | the post-transform greps: `<title>KyoubeAI</title>`, `kyoubeai-thinking.svg` |
| `scripts/smoke.sh` | the served title, `site.webmanifest`, `/kyoubeai-thinking.svg`, `Welcome to KyoubeAI` in the bundle |
| `scripts/brand-live-check.mjs` | the sign-in heading regex (`Sign in to KyoubeAI\|Create your KyoubeAI account`) |
| `docker/rebrand/tests/**` | the fixtures' expected output |

## After a core bump

Read the `rebrand:` block in the build log, in this order:

1. `residual 0` and `anchors lockup=1 thinking=1` — the text rules and the two SVG anchors held.
2. **The sweep table.** Every row must be one of the `*`-marked allowlisted trees. An unmarked row
   fails the build and names the files; decide whether the new tree is executed (extend the file set
   in `docker/rebrand/lib/files.mjs`) or is more upstream source (extend `SWEEP_ALLOWLIST`, with the
   reason). Rows growing is normal — upstream writes more source — only *new rows* matter.
3. **The code-shaped list.** Matches in `packages` code the transform left alone as identifiers.
   It is empty on 2026.916.1; anything appearing there is either a genuine new identifier (fine) or
   display text the classifier misread (add the exact string to `phrases` in `brand.json`).
4. **The `known residual` lines** — currently only the hash-pinned `packages/db` migrations.

A moved lockup or loading icon means updating the anchor in `docker/rebrand/lib/svg.mjs` (and its
fixture in `docker/rebrand/tests/svg.spec.mjs`).

## Residual identifiers

On core 2026.916.1 (KyoubeAI 1.0.0, checked 2026-09-24) the build's header lines are

```
rebrand: 1213 files rewritten (name 7432, phrase 336, url 269), 269 assets renamed, 1443 references rewritten
rebrand: anchors lockup=1 thinking=1; residual 0; binaries skipped 0; symlinks skipped 0
rebrand: code-shaped matches left alone: 0
```

and the sweep gained three allowlisted rows for upstream's new development material
(`announcements`, the `ui/connect-*-preview.html` pages and the root `.env.example`). The lists below
were compiled on 2026.831.1; the kinds of identifier are the same on 2026.916.1.

On core 2026.1005.0 the sweep gained two more allowlisted rows for upstream development material:
`.devin` (DeepWiki pages about upstream's repository) and
`doc/connections/tool-method-permission-reviews.json` (connector permission notes only upstream's
tests read). Nothing else in the image needed a new rule.

On core 2026.1012.0 it gained two more: `feature-map` (upstream's recipes for reproducing and
verifying each feature) and `integrations/assistant-plugins` (the source of upstream's own Claude and
OpenAI plugins for its "Assistant connections (MCP)" feature, which nothing in the image reads or
serves). Again nothing else needed a new rule: `residual 0` and code-shaped matches 0.

Verified against the built image on 2026-09-14, after the final review fix wave (the history at the
end of this section says what each round closed). That build's `rebrand:` header lines were

```
rebrand: 738 files rewritten (url 221, name 4187, phrase 320), 221 assets renamed, 954 references rewritten
rebrand: anchors lockup=1 thinking=1; residual 0; binaries skipped 0; symlinks skipped 0
rebrand: code-shaped matches left alone: 0
```

followed by the sweep table, in which every non-allowlisted tree is zero.

`residual 0` is the transform's own assertion that no *display text* survived in the files it
touched; the sweep is the assertion that none survived anywhere else either. Everything below is an
identifier — a name the core compares, stores or sends, never a label a person reads — and is kept by
design; see the table above. **Counts are distinct strings across `/app/ui/dist`, `/app/server/dist`
and all of `/app/packages`** (5,108 files) — a wider scope than the pre-fix-wave record, which
covered only the two `dist` trees, so most counts are larger without anything having changed.

- **camelCase and PascalCase identifiers** (326): `managedByPaperclip`, `resolvePaperclipHomeDir`,
  `resolvePaperclipConfigPath`, `mergePaperclipConfig`, `derivePaperclipViteHmrPort`,
  `MissingPaperclipSdkUiComponent`, and the server's exported types — `PaperclipConfig`,
  `PaperclipPluginManifestV1`, `PaperclipQuestion*`, `PaperclipRunner*`, `PaperclipSemantic*`.
- **HTTP headers** (36): `X-Paperclip-Run-Id`, `X-Paperclip-Route`, `X-Paperclip-Signature`,
  `X-Paperclip-Request-Cache`, `X-Paperclip-Tab-Visible`, `x-paperclip-advanced`,
  `x-paperclip-authorization`, `x-paperclip-group`, the `x-paperclip-cloud-*` family,
  `x-paperclip-tool-gateway-token`, `x-paperclip-workspace-readiness-*`.
- **Enum values and sentinels** (65): `paperclip_runner` (and its `paperclip_runner_*` error codes),
  `paperclip_managed`, `paperclip_plugin`, `paperclip_bundled`, `paperclip_block`, `paperclip_issue`,
  `paperclip_run`, `paperclip_run_events`, `paperclip_run_log`, `__paperclip_no_template__`,
  `__paperclip_unset__`, `__paperclip_other__`, `__paperclip_no_match__`.
- **Skill keys and package names**: `paperclipai/paperclip/paperclip`, `paperclipai/bundled/*`,
  `paperclipai/optional/*`, `paperclipai/teams-catalog`, `paperclipai/adapter-*`,
  `paperclipai/plugin-sdk/*`. These are the one place a user can still read the word: the Skills
  library's *key* column.
- **Browser storage keys** (190): `paperclip:inbox:*`, `paperclip:issues-view`, `paperclip:project-tab:*`,
  `paperclip:recent-*`, `paperclip:shared-poll:*`, `paperclip.sidebar.*`, `paperclip.theme`,
  `paperclip.agentOrder`, `paperclip.boardChat.*`.
- **CSS classes (52) and custom properties (12)**: `.paperclip-markdown*`, `.paperclip-mermaid*`,
  `.paperclip-doc-annotation-*`, `.paperclip-thinking-icon-path`, `.paperclip-worktree-*`,
  `.paperclip-wiki-link`, `--paperclip-code-*`, `--paperclip-doc-annotation-highlight-*`,
  `--paperclip-mention-*`.
- **Container environment variable names** (314 distinct `PAPERCLIP_*`): read by the core, its
  adapters, CLI, MCP server and skills. Operators set the `KYOUBE_*` keys; compose maps them.
- **Hosts left alone**: `telemetry.paperclip.ing` (off by default), `paperclip.invalid` (an example
  domain), and the `paperclip.dev/schemas/prp/v1/…` `$id`s of the runtime protocol's JSON schemas.

### Known residuals: text that cannot be rewritten

Three shipped Postgres migrations under `packages/db/src/migrations/` still say "Paperclip" and are
printed by every build as `known residual` lines:

| File | What it says |
|---|---|
| `0105_instance_scoped_environments.sql` | seeds the default execution environment's **description**: *"Default execution environment for Paperclip runs on this machine."* |
| `0102_managed_sandbox_dedup_index.sql` | a SQL comment |
| `0230_better_auth_account_issuer.sql` | a SQL comment |

Only the first is display text, visible on the default environment's row for an install created from
a fresh database. It is not rewritten because **migrations are content-hashed**:
`packages/db/src/client.ts`'s `loadAppliedMigrations` reads `SELECT hash FROM
drizzle.__drizzle_migrations` and resolves each row through `mapHashesToMigrationFiles`, which
sha256s the files on disk (the table has columns `id, hash, created_at` and no `name`, so the hash
branch is the one that runs). Changing a shipped migration's bytes would make an upgraded install
fail to recognise it as applied and replay it. Renaming that one row is a data edit, not a build-time
one: `update environments set description = replace(description, 'Paperclip', 'KyoubeAI')`.

### History

**Closed during acceptance (2026-09-14).** The acceptance sweep found two places the file set had
missed: the example plugins' `package.json`/`manifest.ts` descriptions that Settings → Plugins lists
(`GET /api/plugins/examples`), and the usage text of
`skills/paperclip/scripts/paperclip-upload-artifact.sh`. The file set now covers `packages/plugins/**`
sources and the scripts skills ship, and the smoke asserts the plugin catalogue is branded.

**Closed in the final review fix wave (2026-09-14).** The review found that the transform had never
touched the workspace packages the server actually runs. `packages/*/dist` is dead code in the image:
the CMD loads tsx and every `@paperclipai/*` `exports` map points at `./src/*.ts`. Hermes agents were
being told they work "in a Paperclip-managed company", adapter config labels and Skills-tab origin
labels said Paperclip, and the `[paperclip]` log-prefix emitters in `packages/adapter-utils/src` had
never been rewritten while the rebranded UI bundle already expected `[kyoubeai]` — so run-log lines
lost their system classification. The `packages` root now covers `packages/**` with the code-aware
rules, `--verify` gained the whole-image sweep, and 16 signed-in pages read over CDP (dashboard,
agents, a hermes agent's page/Configuration/Skills, Settings → Plugins/Experimental/Environments/root,
Activity, Timeline, Inbox, Terminal, Apps, Skills library) show **zero** occurrences of the old name.
