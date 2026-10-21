# Operating KyoubeAI

Everything below assumes you are in the repository root, where `docker-compose.yml` lives, and
that your `.env` holds the same secrets the stack was started with. The scripts use plain
`docker compose`, so they act on the default project — the one `docker compose up -d` created. See
[Targeting a non-default stack](#targeting-a-non-default-stack) to point them somewhere else.

## The published image on GHCR

Only for deployments that run the prebuilt image (`KYOUBE_IMAGE=ghcr.io/kyoubeai/kyoubeai`)
rather than building from source.

**After the first release run, make the package public.** A package first published by a workflow's
`secrets.GITHUB_TOKEN` is **private**, so `docker compose pull` answers `denied` for everyone —
the author included. Fix it once, in the owner's **Packages** list (for this repository, the KyoubeAI
organization's): open the `kyoubeai` package → **Package settings** → **Change visibility** → *Public*.

To keep it private instead, every machine that pulls must authenticate first, with a token that
carries `read:packages`:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

**Pull as its own step, and read the result.** `docker-compose.yml` keeps a `build:` block next to
`image:`, so a `docker compose up -d` after a failed pull quietly builds the image from source and
tags the result with the GHCR name — the deployment comes up, but it is not the published image.
Run the pull on its own so a `denied` is visible:

```bash
docker compose pull        # must succeed on its own
docker compose up -d
```

## Reaching KyoubeAI from other machines

KyoubeAI listens on every network interface, so other machines can already reach it on port 3100.
Tell it the address people will use:

1. Set `KYOUBE_PUBLIC_URL` in `.env` to the exact address people type, such as
   `http://192.168.1.10:3100` or `https://kyoube.example.com`. Sign-in and the `kyoube setup` link are
   built from it, so a wrong value sends people to the wrong host.
2. Behind a reverse proxy or tunnel on the same Docker network (Caddy, Traefik, nginx or cloudflared),
   also set `TRUST_PROXY=uniquelocal`.
3. For an instance on the internet, put TLS in front and set `KYOUBE_DEPLOYMENT_EXPOSURE=public`.
   `kyoube doctor` fails a public instance whose address does not start with `https://`.
4. Apply the changes with `docker compose up -d`.

To use a port other than 3100, set `KYOUBE_PORT` and put the same port in `KYOUBE_PUBLIC_URL`. On a
`localhost` or `127.0.0.1` address, also set `BETTER_AUTH_TRUSTED_ORIGINS` to that origin (for
example `http://localhost:3199`). The core maps a loopback address back to its internal port and
would otherwise reject sign-ins from the new one.

## Volumes and what lives where

Two named volumes hold every piece of state that is not in the image. Losing either one loses real
data; losing both is the disaster the backup script exists for.

| Where | What is in it |
|---|---|
| `pgdata` (the `db` service) | The whole PostgreSQL cluster: the `kyoubeai` database (the core's), the `kyoube` database, and the cluster-level roles. |
| `kyoubeai-home` (mounted at `/kyoubeai` in `app`, which is also `HOME`) | The board API key, every agent harness's credentials, and agent workspaces. |

Inside the cluster:

- **`kyoubeai`** — the upstream core's database: users, sessions, companies, agents, projects,
  the activity log, board API keys, and the installed-plugin registry. Owned by the `kyoubeai`
  superuser, which is also the compose `POSTGRES_USER`.
- **`kyoube`** — the Kyoube organisation database, owned by the `kyoube` login role. It holds
  `kyoube_meta` (the plugin's own migrations, company registry, settings, apps, and the `audit`
  table) plus one schema per company, `c_<hex>`, where `<hex>` is the company UUID without dashes.
- **Cluster roles** — the `kyoube` login role (created by `docker/postgres-init/01-kyoube.sh` on the
  first start of a fresh `pgdata` volume) and one `NOLOGIN` role per company, `kyoube_c_<hex>`,
  created by the apps plugin at runtime. Each `c_<hex>` schema and every table in it is **owned by
  its `kyoube_c_<hex>` role**; the plugin does all company DDL and DML under `SET ROLE`, which is
  what keeps one company's data out of another's reach.

  Roles are cluster-level, so they are in **neither** per-database dump. That is why
  `scripts/backup.sh` writes a separate `roles.sql` — see [Restore](#restore).

Inside `/kyoubeai` (the `kyoubeai-home` volume):

| Path | What is in it |
|---|---|
| `kyoube/board-key.json` | The instance-admin board API key `kyoube setup` stored, mode `600`, owned by `node`. Plugin installs and upgrades use it. |
| `kyoube/rules-token` | The agent rules loop's secret, mode `600`, owned by `node`, created by `kyoube agent-rules`. It proves the loop's calls to the agent-rules and group routes and to Studio's `/ask-levels` (`docs/agent-rules.md`). Delete it to rotate; the next pass creates a new one. |
| `kyoube/license.key` | The licence key, if one is applied, mode `600` (`docs/licensing.md`). |
| `kyoube/instance-id` | This instance's ID, created once. Send it to KyoubeAI for a key that works on this instance only. |
| `kyoube/license-users.json` | The Licence page's user list, mode `600`, refreshed every minute. |
| `kyoube/config.json` | Rendered from the container environment by the entrypoint on every start. Disposable. |
| `.claude/.credentials.json` | Claude Code login. |
| `.codex/` | Codex's configuration and login. |
| `.pi/` | pi's configuration and login. |
| `.hermes/` | Hermes Agent's configuration, sessions and memory (`HERMES_HOME=/kyoubeai/.hermes`), and the program itself once you install it. |
| `.local/` | Harnesses and other programs you install (`.local/bin` is first on the `PATH` of the server, every agent run and every Terminal shell), and what their installers keep beside them. |
| `.kyoube/apt-packages.txt` | The system packages kept across recreates; `apt-restore.log` and `apt-restore.status` beside it say how the last restore at start-up went. |
| `.cache/` | Download caches: apt's packages and index, so kept packages can come back without a network. Not backed up, and neither is `.npm/`, npm's cache. |
| `instances/default/projects/<companyId>/<projectId>/` | Each project's managed working folder (`_default`, or the repository name for a cloned repo): what its agents have written, and what the project's **Files** tab shows and edits. |
| `instances/default/workspaces/<agentId>/` | An agent's own default working directory, used for runs with no project folder. |

## Backups

```bash
bash scripts/backup.sh
```

Writes `backups/<UTC timestamp>/` (override the parent with `BACKUP_DIR=/mnt/backups`) containing:

| File | What it is |
|---|---|
| `kyoubeai.dump` | `pg_dump -Fc` of the `kyoubeai` database |
| `kyoube.dump` | `pg_dump -Fc` of the `kyoube` database |
| `roles.sql` | The `kyoube` login role and every `kyoube_c_<hex>` company role |
| `kyoubeai-home.tgz` | The `/kyoubeai` volume, ownership and modes preserved, without the download caches (`.cache`, `.npm`) |
| `SHA256SUMS` | Checksums of the four files above, by relative name |

`roles.sql` is `pg_dumpall --roles-only --no-role-passwords` filtered down to the statements that
mention only Kyoube roles — the `CREATE ROLE` / `ALTER ROLE` lines for `kyoube` and each
`kyoube_c_<hex>`, and the `GRANT <company role> TO kyoube` memberships that let the login role
`SET ROLE` into them. The `kyoubeai` superuser and the built-in `pg_*` roles are dropped: a restore
must never redefine the cluster's superuser. **No password is in the file** —
`--no-role-passwords` leaves the hash out, and `scripts/restore.sh` re-applies the password from the
`db` container's own `KYOUBE_DB_PASSWORD` instead.

The backup runs with the stack up. Each dump is internally consistent (`pg_dump` uses a
repeatable-read snapshot), but the two are taken one after the other, seconds apart, and `/kyoubeai`
is archived live afterwards — so the three pieces are not a single point in time. In practice the one
thing that can fall between the two dumps is a company created in `kyoubeai` whose `c_<hex>` schema
does not yet exist in `kyoube`; that self-heals, because the plugin provisions the schema and its
role on first use (`ensureCompany`). If you want the whole set to be point-in-time consistent —
worth it before an upgrade, unnecessary for a nightly — stop the app first:

```bash
docker compose stop app && bash scripts/backup.sh && docker compose start app
```

`backups/` is git-ignored. The dumps contain everything: user records, agent credentials and the
board API key. Treat a backup directory as being as sensitive as `.env`.

### A nightly cron entry

Cron runs with a nearly empty environment and from `$HOME`, so give it the absolute path to the
repository and to `docker`, and keep a log:

```cron
# m h  dom mon dow  command
17 3 * * *  cd /srv/kyoubeai && PATH=/usr/bin:/bin BACKUP_DIR=/var/backups/kyoubeai \
  /bin/bash scripts/backup.sh >> /var/log/kyoubeai-backup.log 2>&1
```

Verify it once by hand, as the user cron will run it as, before trusting it:

```bash
sudo -u <that user> env BACKUP_DIR=/var/backups/kyoubeai bash /srv/kyoubeai/scripts/backup.sh
```

That user needs to be in the `docker` group. Prune old directories separately, for example
`find /var/backups/kyoubeai -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +`.

### Off-site copies

A backup on the same disk as `pgdata` does not survive the failure it exists for. Copy each
directory somewhere else — another machine, object storage, an external disk — and verify it there:

```bash
rsync -a --delete /var/backups/kyoubeai/ backup-host:/srv/kyoubeai-backups/
# on the other side, before you trust it:
cd /srv/kyoubeai-backups/20260906T031700Z && sha256sum -c SHA256SUMS   # on macOS: shasum -a 256 -c SHA256SUMS
```

`SHA256SUMS` uses relative names precisely so it still verifies after the directory has been moved.
Encrypt at rest if the destination is not yours (`age`, `gpg`, or your object store's SSE).

## Restore

```bash
bash scripts/restore.sh backups/20260906T031700Z
```

**The app is stopped for the duration** and both databases and the home volume are replaced
wholesale. Anything written since the backup is gone. The script prints the compose project it is
about to overwrite before it touches anything.

It runs in this order, and the order matters:

1. `sha256sum -c SHA256SUMS` (`shasum -a 256 -c` where there is no `sha256sum`, as on macOS), then
   `docker compose stop app`.
2. **Roles first.** `roles.sql` is applied with `ON_ERROR_STOP=0`, because a role that already
   exists is expected — `kyoube` is recreated by `docker/postgres-init/01-kyoube.sh` on any fresh
   volume, and on a same-cluster restore every company role is still there. Then
   `ALTER ROLE kyoube PASSWORD …` re-applies the password, read inside the `db` container from its
   own `KYOUBE_DB_PASSWORD` and passed as a psql variable — the same mechanism the init script
   uses, so the secret never reaches the host's process list or the script's output. The app's
   `KYOUBE_DATABASE_URL` therefore keeps working after a restore onto a brand-new cluster.
3. **`kyoubeai`**, restored `--no-owner`: everything in that database belongs to the superuser.
4. **`kyoube`**, restored **with** its owners, so each `c_<hex>` schema and all its tables go back to
   their `kyoube_c_<hex>` role; then `ALTER DATABASE kyoube OWNER TO kyoube`.
5. `REVOKE CONNECT ON DATABASE kyoubeai FROM PUBLIC` and the same for `kyoube`. `CREATE DATABASE`
   grants `CONNECT` to `PUBLIC` by default and these two ACLs are set by the init script, so they
   are in neither dump.
6. The `/kyoubeai` volume is emptied and the tarball unpacked into it, then
   `docker compose start app`. The download caches are not in a backup, so on a new machine the kept
   system packages are downloaded again at the first start; without a network they stay listed and the
   next start tries again (`kyoube doctor` reports it).

Each database is restored into a `<name>_restore_tmp` database first and only swapped in once
`pg_restore` has succeeded (`--exit-on-error`), so a failed restore leaves that database untouched.
The swap is per database rather than across both: if the `kyoube` restore fails after `kyoubeai`
has been swapped in, fix the cause and re-run the script with the same directory.

A restore that fails part-way leaves the app **stopped**, deliberately — starting it against
half-replaced state is worse than an outage. Fix the cause, re-run the same command, and only
`docker compose start app` by hand if you have decided to abandon the restore.

**Same-cluster vs fresh-cluster.** Restoring over a running deployment (an operator mistake, a bad
migration) and restoring onto an empty machine are the same command, and steps 2, 4 and 5 are what
makes that true. On the same cluster the roles are still present and the `roles.sql` errors are
harmless noise. On a fresh cluster — a new host, a destroyed `pgdata` volume — the company roles do
not exist: without step 2 every `GRANT` in `kyoube.dump` fails, and without step 4 the schemas come
back owned by the `kyoubeai` superuser. The plugin would then re-create the roles on its next
request but they would own nothing, and the first `SET ROLE` DDL would fail. `scripts/smoke.sh`
rehearses exactly this: it takes a backup, runs `docker compose down -v` to destroy both volumes,
brings the stack back up empty, restores, and then asserts the pre-disaster board token still works
and that a company role can still create a table.

**On a fresh host, bring the stack up before restoring.** `restore.sh` acts on containers that
already exist — it stops the app, runs `psql` and `pg_restore` inside the `db` container, and refills
the home volume through the app container — so there is a step 0:

```bash
git clone <your fork> kyoubeai && cd kyoubeai
cp .env.example .env         # the SAME secrets as the backed-up deployment,
                             # above all BETTER_AUTH_SECRET and KYOUBE_DB_PASSWORD
docker compose up -d --build
docker compose ps            # wait until `db` reads healthy
bash scripts/restore.sh /path/to/backups/20260906T031700Z
```

Let the first `up` finish before restoring: `db` must be **healthy**, which is when
`docker/postgres-init/01-kyoube.sh` has run and created the `kyoube` role and database. The app
comes up empty and unclaimed — leave it that way, do not sign up, the restore is about to replace it
wholesale. Restoring against a stack that was never brought up stops before it touches anything,
with `restore: the 'db' service is not running; start it before restoring`.

`BETTER_AUTH_SECRET` matters as much as the backup does: sessions and board API keys in the restored
`kyoubeai` database were issued under the old secret, and a new one invalidates them all.

After the restore, check it:

```bash
docker compose exec app kyoube doctor
curl -fsS http://localhost:3100/api/health
```

### Targeting a non-default stack

Neither script takes a `-p` or `--env-file` flag; both run plain `docker compose` and inherit
`COMPOSE_PROJECT_NAME` and `COMPOSE_ENV_FILES` from the environment. To act on a second deployment
side by side with your own:

```bash
COMPOSE_PROJECT_NAME=kyoube-staging COMPOSE_ENV_FILES=./staging.env bash scripts/backup.sh
COMPOSE_PROJECT_NAME=kyoube-staging COMPOSE_ENV_FILES=./staging.env \
  bash scripts/restore.sh backups/20260906T031700Z
```

Both variables must be right: the project name selects the containers and volumes, and the env
files supply `POSTGRES_PASSWORD`, `KYOUBE_DB_PASSWORD` and the rest that `docker-compose.yml`
requires. Getting them wrong is how you restore a backup over the wrong instance, so read the
`project '<name>'` line the scripts print.

Both scripts also honour `KYOUBE_BACKUP_IMAGE` (default `alpine:3.20`), the throwaway image used to
`tar` the home volume. Set it if your host cannot reach Docker Hub.

## Logs

```bash
docker compose logs -f app          # core server, the Kyoube entrypoint, the plugin watcher
docker compose logs -f db           # PostgreSQL
docker compose logs --tail 200 app  # the last 200 lines, for a bug report
```

Plugin workers log through the host, so their output is in the `app` log too, prefixed by the
plugin. The per-plugin view under **Settings → Plugins** is the better place to read one plugin's
own errors, and it is what to check first when a plugin sits in a status other than `ready`.

Two audit trails are not in the container logs at all:

- The core's **activity log** per company (`/api/companies/<id>/activity`, or the company's
  Activity page) records terminal sessions opening and closing and a summary of every data mutation
   — never keystrokes, terminal output, or row contents.
- `kyoube_meta.audit` in the `kyoube` database records every data and apps mutation:

  ```bash
  docker compose exec -T db psql -U kyoubeai -d kyoube -c \
    "select created_at, company_id, actor_kind, operation, table_name
       from kyoube_meta.audit order by created_at desc limit 20"
  ```

## Health

```bash
docker compose exec app kyoube doctor
```

`kyoube doctor` prints one line per check and exits non-zero if any of them failed: the rendered
config, the deployment's `exposure` (it fails when `KYOUBE_DEPLOYMENT_EXPOSURE=public` and
`KYOUBE_PUBLIC_URL` is not an `https://` address — put TLS in front before exposing an instance;
a `private` deployment always passes), the core's `/api/health`, TCP reachability of the `kyoube`
database, whether a board key is present, where it came from and when it expires (see
[The board key expires](#the-board-key-expires)), every `kyoube.*` plugin as
`key@version=status`, the Kyoube skills in every company, and the harness and system-package checks
below. The credential lines at the end (Claude Code, pi, Hermes) are informational — they report
"not found" until someone authenticates — so a non-zero exit always comes from one of the checks above
them. A line can also read `WARN`: the licence needs attention (a key close to expiry or expired, or the
user limit reached). A `WARN` doesn't fail `kyoube doctor`. The `licence enforcement` line fails when the
user limit isn't being enforced.

The image carries no harness of its own, so the harness checks look at what is on the `PATH`:

- **Harnesses.** One line per harness found, with its `--version` and where it comes from: `yours` (in
  `/kyoubeai/.local/bin`), `core image` (`/usr/local/bin`) or `other`. One that is found but does not
  run says so and gives its reinstall command. These lines are informational.
- **`harnesses in use`.** It reads the agents from the core and fails when an agent that is not
  terminated uses a harness that is not installed or does not run. The line names the fix, for example
  `kyoube harness install pi`.
- **`system packages`.** The packages `sudo apt install` kept, put back at every start. It fails when
  that did not work at the last start; `/kyoubeai/.kyoube/apt-restore.log` says why. A package that
  could not be reinstalled stays on the list and is tried again at the next start. The reinstall has
  three minutes at most, so a network that does not answer delays a start by that much and no more;
  what is left is tried again at the next start.

`GET /api/health` is the core's own probe and needs no authentication. It is what the compose
healthcheck polls, and `.bootstrapStatus == "ready"` is what tells you the instance has been
claimed:

```bash
curl -fsS http://localhost:3100/api/health | jq
docker compose ps          # per-service health from the compose healthchecks
```

## Licence commands

Run these in the container or from the Terminal page; `docs/licensing.md` has the whole picture.

```bash
kyoube license [show|set <key>|clear|refresh]   # show the licence; apply, remove or refresh the user list
kyoube users list|remove <email> [--yes]        # list users; remove one to free a seat
```

## The board key expires

The core gives a board key from `kyoube setup` 30 days. An expired key stops every `kyoube` call
that needs it: plugin updates, the agent working rules and user groups. The app itself keeps
running, so the only signs are in `kyoube doctor` and the app log. From 1.12.1, the agent rules loop
renews the stored key a week before it expires (it does with `KYOUBE_AGENT_RULES=off` too). It asks
the core for a new key for the same person, checks that the core takes it and stores it in place of
the old one. It revokes the old key an hour later, so nothing that read it just before is refused
mid-call (if the container restarts within that hour, the old key stays live until it expires, at
most a week later). It checks at start and then every hour, and logs `kyoube: board key renewed` or
`kyoube: could not renew the board key` with the reason, retrying hourly. If `kyoube setup` stores a
key while a renewal runs, setup's key is kept. The person sees the new key, named `kyoube
(renewed)`, under **Settings → API keys**.

`kyoube doctor`'s `board key` line shows the expiry date. It warns when less than six days are left,
which means renewal is failing. It fails once the core no longer takes the key. A key that has
already expired cannot renew itself: issue a new one with `kyoube setup` (step 2 below; the old key
needs no revoking).

A key set in `KYOUBE_BOARD_API_KEY` is never renewed. `kyoube doctor` warns a week before it
expires, and you replace it yourself.

The stored key can still lapse while nothing renews it: a stack stopped for longer than the key has
left, a rollback to a release before 1.12.1, or a restore of a backup whose key has since expired
(one older than about 30 days). In each case the `board key` line fails, and `kyoube setup` issues a
new key.

## Rotating the board API key

The board key is an instance-admin API key. Anyone holding it can install plugins and read every
company through the board API, so rotate it if it may have leaked, and after anyone with access to
the container leaves. Renewal does not replace rotation: a renewed key is new, but whoever held the
old one can have minted keys of their own with it.

1. Revoke the old key in the UI, under **Settings → API keys** — deleting the file alone does not
   invalidate the key. After a leak, revoke every key listed for that person, since whoever held
   the key could have minted more; a renewed key is named `kyoube (renewed)`.
2. Delete the stored copy and issue a new one:

   ```bash
   docker compose exec app rm -f /kyoubeai/kyoube/board-key.json
   docker compose exec app kyoube setup
   ```

   `kyoube setup` prints an approval URL, waits for a signed-in instance admin to approve it, writes
   the new key to `/kyoubeai/kyoube/board-key.json` with mode `600`, and finishes by running
   `kyoube ensure-plugins` with it.
3. Confirm with `docker compose exec app kyoube doctor` — the `board key` line should read
   `stored (user …)` and the `plugins` line should list both bundles as `ready`.

If you set `KYOUBE_BOARD_API_KEY` in `.env` instead of storing a key, rotate it there and
`docker compose up -d app`; the environment variable takes precedence over the stored file.

## Resetting harness credentials

Each harness keeps its login under `/kyoubeai`. Removing its state logs it out; the next login
happens from the Terminal page (**Terminal** in the company sidebar, for owners and admins).

Run `docker compose exec app kyoube harness list` first, to see which harnesses are installed and
whether each is yours (in `/kyoubeai/.local/bin`) or the core image's copy.

```bash
docker compose exec app rm -rf /kyoubeai/.claude/.credentials.json   # Claude Code
docker compose exec app rm -rf /kyoubeai/.pi                          # pi
docker compose exec app mv /kyoubeai/.hermes /kyoubeai/.hermes.bak    # Hermes Agent
```

Hermes is different: `/kyoubeai/.hermes` holds its settings, sessions and memory as well as its login, and
the installer puts the program under it too, so deleting it would lose all of that. The `mv` above keeps it
as `.hermes.bak`: copy back what you want to keep, and delete `.hermes.bak` yourself when you no longer
need it. Every start recreates an empty `/kyoubeai/.hermes`, so a plain `mv` back would land the backup
inside it. To undo the reset, remove that new folder first, if there is one:

```bash
docker compose exec app rmdir /kyoubeai/.hermes     # rmdir refuses a folder that is not empty
docker compose exec app mv /kyoubeai/.hermes.bak /kyoubeai/.hermes
```

If `rmdir` refuses, Hermes has been set up again since the reset; copy what you want from `.hermes.bak`
instead.

Run `kyoube harness list` again, and reinstall anything that is missing with
`kyoube harness install <name>`. Then, from the Terminal page, sign in again as
[README → Harnesses](../README.md#harnesses) describes for each one. `HOME` is `/kyoubeai` there, so the
new credentials land back on the volume and survive restarts.

The alternative to interactive logins is provider API keys in `.env` (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`), which need `docker compose up -d app` to take effect. Note
that a key in `.env` is visible to anyone who can open the Terminal — which is the same set of
people who could read the credential files anyway.

## Two source installs on one machine

An install built from source (`./install.sh --edge`, `KYOUBE_VERSION=dev` in `.env`) runs the image
`${KYOUBE_IMAGE:-kyoubeai}:dev`, and `docker compose build` tags its build with that name. Two source
installs on one machine that both leave `KYOUBE_IMAGE` unset share the tag `kyoubeai:dev`: a build in
one replaces the image the other's tag names, and the other's next `docker compose up -d` starts that
build, of the first install's code, on its own data, with no backup.

Give each source install its own local name in `.env`, before its first build:

```bash
KYOUBE_IMAGE=kyoubeai-staging     # no '/': a local image, which install.sh and update.sh treat as a source build
```

An install that already shares the tag can switch the same way: set the name, then run
`./update.sh --edge`, which finds no image under the new name and builds it, after a backup.

`./update.sh --edge` compares the image the stack's app container runs with the one its tag names, and
rebuilds (after a backup) when another install has replaced the tag, so a shared tag is caught there;
a separate name avoids the problem. A published-image install (`KYOUBE_IMAGE=ghcr.io/…`) is not
affected: its tags are release versions, the same image for everyone.

## Resource limits

The `app` service ships with `pids_limit: 2048`. That is a backstop, not a tuning knob: `tini` is
PID 1 in the image, agents spawn real processes, and the terminal plugin spawns a shell per session,
so a runaway agent would otherwise be able to fork until the host runs out of process slots. Raise
it only if you see `fork: Resource temporarily unavailable` in the app log with a genuinely busy
instance.

There is no memory or CPU limit by default, because a limit that is too low makes agent runs fail in
ways that are hard to diagnose. Add them in `docker-compose.override.yml` (untracked, so `./update.sh`
is not blocked by local edits) when the instance shares a host:

```yaml
services:
  app:
    mem_limit: 6g
    cpus: 4.0
```

Compose v2 honours both forms on `docker compose up`: the short `mem_limit`/`cpus` keys above, and
the longer `deploy.resources.limits.memory` / `.cpus`, which is also the form a Swarm deployment
reads. Use whichever you find clearer. Give the app at least 4 GB, and remember the container is
killed outright, with exit code 137, when it exceeds `mem_limit`. Postgres is usually happy without a
limit; if you set one, keep it well above `shared_buffers`.

Disk is the limit people actually hit: the `pgdata` volume grows with the activity log and company
data, and `kyoubeai-home` grows with project folders and agent workspaces. Both live under Docker's data root, so watch
that filesystem, not the repository's.

```bash
docker system df -v | grep -E 'kyoubeai-home|pgdata'
docker compose exec app du -sh /kyoubeai/instances/default/projects /kyoubeai/instances/default/workspaces
```
