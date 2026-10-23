# syntax=docker/dockerfile:1.7
ARG KYOUBE_CORE_VERSION=2026.1012.0

# ---------------------------------------------------------------------------
# Stage 1: build the Kyoube bootstrap CLI and plugins with pnpm.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS kyoube-build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY docker/bootstrap/package.json docker/bootstrap/
COPY plugins/kyoube-terminal/package.json plugins/kyoube-terminal/
COPY plugins/kyoube-apps/package.json plugins/kyoube-apps/
COPY plugins/kyoube-files/package.json plugins/kyoube-files/
COPY plugins/kyoube-studio/package.json plugins/kyoube-studio/
COPY plugins/kyoube-agent-rules/package.json plugins/kyoube-agent-rules/
COPY plugins/kyoube-license/package.json plugins/kyoube-license/
COPY plugins/kyoube-notify/package.json plugins/kyoube-notify/
COPY packages/kyoube-app-sdk/package.json packages/kyoube-app-sdk/
COPY packages/license/package.json packages/license/
COPY packages/visibility/package.json packages/visibility/
RUN pnpm install --frozen-lockfile
COPY docker/bootstrap docker/bootstrap
COPY plugins plugins
# .dockerignore excludes **/dist, so the app SDK bundle the apps plugin inlines
# into its UI is built here from source by `pnpm -r build` (topologically
# ordered by the plugin's workspace:* devDependency on it).
COPY packages packages
RUN pnpm -r build \
 && pnpm --filter @kyoube/bootstrap deploy --prod /out/bootstrap \
 && pnpm --filter @kyoube/plugin-terminal deploy --prod /out/plugins/terminal \
 && pnpm --filter @kyoube/plugin-apps deploy --prod /out/plugins/apps \
 && pnpm --filter @kyoube/plugin-files deploy --prod /out/plugins/files \
 && pnpm --filter @kyoube/plugin-studio deploy --prod /out/plugins/studio \
 && pnpm --filter @kyoube/plugin-agent-rules deploy --prod /out/plugins/agent-rules \
 && pnpm --filter @kyoube/plugin-license deploy --prod /out/plugins/license \
 && pnpm --filter @kyoube/plugin-notify deploy --prod /out/plugins/notify \
 && mkdir -p /out/license && cp packages/license/dist/enforce.mjs /out/license/enforce.mjs \
 && mkdir -p /out/visibility && cp packages/visibility/dist/decide.mjs /out/visibility/decide.mjs \
 && test -f /out/visibility/decide.mjs \
 && test -f /out/license/enforce.mjs \
 && test -f /out/bootstrap/dist/kyoube.mjs \
 && test -f /out/plugins/terminal/dist/manifest.js \
 && test -f /out/plugins/apps/dist/manifest.js \
 && test -f /out/plugins/files/dist/manifest.js \
 && test -f /out/plugins/studio/dist/manifest.js \
 && test -f /out/plugins/agent-rules/dist/manifest.js \
 && test -f /out/plugins/license/dist/manifest.js \
 && test -f /out/plugins/notify/dist/manifest.js

# ---------------------------------------------------------------------------
# Stage 2: the runtime image = the upstream core image + KyoubeAI.
#
# No agent harness is baked in. People install the ones they want from the
# Terminal page (`kyoube harness install <name>`, or any installer) into
# /kyoubeai/.local on the home volume. That directory is first on PATH for the
# server, every agent run and every shell, so an install survives down/up,
# image updates and core bumps. The core image's own CLIs (claude, codex,
# gemini, kimi, opencode in /usr/local/bin) stay as fallbacks a user install
# shadows. See README.md, "Harnesses", and SECURITY.md, "Terminal".
# ---------------------------------------------------------------------------
FROM ghcr.io/paperclipai/paperclip:${KYOUBE_CORE_VERSION}
USER root

# KyoubeAI's home. The base image sets HOME=PAPERCLIP_HOME=/paperclip and gives
# the node user that passwd entry. Everything upstream derives from
# PAPERCLIP_HOME (its packages/shared home-paths module) and its own entrypoint
# chowns `${PAPERCLIP_HOME:-/paperclip}`, so moving the three variables moves
# the whole tree without patching a file. /paperclip is removed outright: on an
# install migrated from 0.1.x, docker/entrypoint.sh recreates it as a symlink
# for as long as the migration marker exists (spec §5); a fresh install never
# has it.
ENV HOME=/kyoubeai \
    PAPERCLIP_HOME=/kyoubeai \
    PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json
RUN mkdir -p /kyoubeai && chown node:node /kyoubeai && usermod -d /kyoubeai node && rmdir /paperclip

# The Terminal can install anything: `node`, the user the server, its agents
# and every Terminal shell run as, gets passwordless sudo. That is a small step
# from the existing trust (`node` already owns /app and can read the server's
# environment), and the container stays the boundary (SECURITY.md, Terminal).
# The extra packages are what harness installers commonly assume.
#
# System packages someone adds later are kept: apt-record (a DPkg hook) writes
# their names to the home volume and apt-restore (docker/entrypoint.sh) puts
# them back after a recreate. The baseline it compares against is every
# package chosen up to here, so this must stay the last apt step in the file.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo unzip xz-utils python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/kyoube \
 && apt-mark showmanual | LC_ALL=C sort -u > /opt/kyoube/apt-baseline.txt
COPY docker/system/sudoers /etc/sudoers.d/kyoube
COPY docker/system/90kyoube /etc/apt/apt.conf.d/90kyoube
COPY docker/system/kyoube-profile.sh /etc/profile.d/kyoube.sh
COPY docker/system/npmrc /usr/local/etc/npmrc
COPY docker/system/apt-record docker/system/apt-restore /usr/local/lib/kyoube/
RUN chmod 0440 /etc/sudoers.d/kyoube \
 && visudo -cf /etc/sudoers.d/kyoube \
 && chmod 0644 /etc/apt/apt.conf.d/90kyoube /etc/profile.d/kyoube.sh /usr/local/etc/npmrc /opt/kyoube/apt-baseline.txt \
 && chmod 0755 /usr/local/lib/kyoube/apt-record /usr/local/lib/kyoube/apt-restore \
 && gosu node sudo -n true \
 && mkdir -p /tmp/npm-check && chown node:node /tmp/npm-check \
 && test "$(gosu node env HOME=/tmp/npm-check npm_config_cache=/tmp/npm-check sh -c 'cd /tmp && npm config get prefix')" = /kyoubeai/.local \
 && rm -rf /tmp/npm-check \
 && test -x /usr/local/bin/claude \
 && ! command -v pi && ! command -v hermes \
 && test -z "$(ls -A /kyoubeai)"
ENV PATH=/kyoubeai/.local/bin:${PATH} \
    NPM_CONFIG_PREFIX=/kyoubeai/.local

# ---------------------------------------------------------------------------
# Core patches: fixes to upstream bugs applied to the pristine core layer while
# the same fix is on its way upstream (docker/core-patches/patches.mjs, one
# documented entry per patch, each naming its upstream issue or PR). Every
# pattern must match exactly as declared or this build fails — so a core bump
# that changes the code, or that already carries the fix, stops here with the
# patch's id, which is the cue to delete it. An entry that declares the
# upstream fix's own shape (upstreamFix) is skipped instead, with
# "<id>: already fixed upstream", on a core that carries that fix exactly once
# (a pre-release, in the weekly beta build). Runs before the rebrand so the
# asset renaming below hashes the patched bundle. See CONTRIBUTING.md,
# "Never patch the core", for the rule this is the narrow exception to.
# --core-version is the core this build is FROM; when it is not the one the
# patches are written for (usually a KYOUBE_CORE_VERSION left in .env by an
# earlier release), a failure says so before naming the patch.
# ---------------------------------------------------------------------------
ARG KYOUBE_CORE_VERSION
COPY docker/core-patches/apply.mjs docker/core-patches/lib.mjs docker/core-patches/patches.mjs docker/core-patches/ask-level.mjs /opt/kyoube/core-patches/
RUN gosu node node /opt/kyoube/core-patches/apply.mjs --root /app --report --core-version "${KYOUBE_CORE_VERSION}"
# The licensing hook (a standing core patch above) imports Better Auth's APIError.
# Check the hook marker is in the served auth module, that the module has exactly
# one databaseHooks block (a second one could override the hook), that it still
# parses, and that APIError resolves for the runtime user. The seat check bundle
# itself is copied in below with the rest of /opt/kyoube.
RUN grep -q 'kyoube-license-seat-limit' /app/server/dist/auth/better-auth.js \
 && test "$(grep -c 'databaseHooks' /app/server/dist/auth/better-auth.js)" -eq 1 \
 && cd /app/server && node --check dist/auth/better-auth.js \
 && cd /app/server && gosu node node --input-type=module -e 'const { APIError } = await import("better-auth/api"); if (new APIError("BAD_REQUEST", { code: "X", message: "x" }).statusCode !== 400) process.exit(1)'

# The agent-questions check (a standing core patch above) imports
# /opt/kyoube/core-patches/ask-level.mjs. Check the marker is in the served
# interactions service, that the service still parses, and that the module
# loads for the runtime user and exports applyAskLevel. Without it every
# question from an agent to an agent is refused (kyoube_ask_check_failed).
RUN grep -q 'kyoube-ask-level' /app/server/dist/services/issue-thread-interactions.js \
 && cd /app/server && node --check dist/services/issue-thread-interactions.js \
 && gosu node node --input-type=module -e 'const m = await import("/opt/kyoube/core-patches/ask-level.mjs"); if (typeof m.applyAskLevel !== "function") process.exit(1); console.log("ask-level ok")'

# Work-object visibility (eight standing core patches above) imports
# /opt/kyoube/visibility/decide.mjs, copied in below with the rest of
# /opt/kyoube and checked there. Check each marker is in the served code the
# expected number of times (routes/issues.js has five: the search route's scope
# check and result filter, and the check on a person's unassigned task in the
# create, child and plan routes; app.js has the gate in front of the task and
# project routes) and that the four files still parse. Without the module every
# covered read is refused for operators and viewers.
RUN test "$(grep -c 'kyoube-visibility' /app/server/dist/services/authorization.js)" -eq 1 \
 && test "$(grep -c 'kyoube-visibility' /app/server/dist/realtime/live-events-ws.js)" -eq 1 \
 && test "$(grep -c 'kyoube-visibility' /app/server/dist/routes/issues.js)" -eq 5 \
 && test "$(grep -c 'kyoube-visibility' /app/server/dist/app.js)" -eq 1 \
 && cd /app/server && node --check dist/services/authorization.js \
 && node --check dist/realtime/live-events-ws.js \
 && node --check dist/routes/issues.js \
 && node --check dist/app.js

# ---------------------------------------------------------------------------
# KyoubeAI theme ("Studio"): brand tokens, a skin aimed only at stable hooks
# (route links, ARIA labels, and the data-kyoube-* markers the Studio plugin
# renders), and a few display-text renames (Dashboard -> Home, the core's Apps
# area -> Connections, dark by default). docker/theme/theme.mjs checks every
# rule, hook and token against this core before writing anything and fails
# the build naming what moved, so a core bump either keeps the design or stops
# here. It runs before the rebrand so the rebrand's asset re-hashing covers
# the theme's stylesheet. It is the second standing exception to "Never patch
# the core" (CONTRIBUTING.md): presentation only, re-applied on every build.
# Spec: docs/theme.md.
# ---------------------------------------------------------------------------
COPY docker/theme/theme.mjs docker/theme/rules.mjs docker/theme/anchors.mjs docker/theme/theme.css docker/theme/boot.js /opt/kyoube/theme/
COPY docker/theme/fonts /opt/kyoube/theme/fonts
RUN gosu node node /opt/kyoube/theme/theme.mjs --root /app --theme /opt/kyoube/theme --report \
 && grep -q '/assets/kyoube-theme.css' /app/ui/dist/index.html \
 && grep -q 'data-kyoube-shell' /app/ui/dist/index.html \
 && test -f /app/ui/dist/fonts/kyoube/InstrumentSerif-Regular-latin.woff2

# ---------------------------------------------------------------------------
# KyoubeAI branding. The upstream layer above says "Paperclip" in its UI
# bundle, server messages, agent skills and artwork; docker/rebrand/rebrand.mjs
# rewrites those surfaces in place (see docs/branding.md) and --verify fails
# this build if anything upstream changed shape: a moved lockup, a new display
# string the rule cannot classify, a dangling asset reference. It runs as `node` because /app is node-owned and
# nothing here should change ownership. --report leaves the counts in the log.
# ---------------------------------------------------------------------------
COPY docker/brand /opt/kyoube/brand
COPY docker/rebrand/rebrand.mjs /opt/kyoube/rebrand/rebrand.mjs
COPY docker/rebrand/lib /opt/kyoube/rebrand/lib
RUN gosu node node /opt/kyoube/rebrand/rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report \
 && grep -q '<title>KyoubeAI</title>' /app/ui/dist/index.html \
 && grep -qE '/assets/kyoube-theme-[0-9a-f]{8}\.css' /app/ui/dist/index.html \
 && test -f /app/ui/dist/kyoubeai-thinking.svg \
 && ! test -e /app/ui/dist/paperclip-thinking.svg \
 && ! ls /app/ui/dist/assets | grep -qE '^index-[A-Za-z0-9_-]{8}\.js$'

# ---------------------------------------------------------------------------
# Installable app and Web Push (docker/pwa, docs/mobile.md). Runs after the
# rebrand, on the built UI: the manifest becomes standalone (iOS only sends
# Web Push to a Home Screen app), the iOS meta tags are added, and one
# importScripts line loads KyoubeAI's push handlers into the core's own
# service worker. Every anchor is checked first; a core that changed sw.js,
# the manifest or the iOS title tag fails this build with the reason.
# ---------------------------------------------------------------------------
COPY docker/pwa/pwa.mjs docker/pwa/kyoube-push-sw.js /opt/kyoube/pwa/
RUN gosu node node /opt/kyoube/pwa/pwa.mjs --root /app --pwa /opt/kyoube/pwa --report \
 && grep -q '"display": "standalone"' /app/ui/dist/site.webmanifest \
 && grep -q 'importScripts("/kyoube-push-sw.js")' /app/ui/dist/sw.js \
 && test -f /app/ui/dist/kyoube-push-sw.js

# Kyoube bootstrap CLI and plugin bundles. The dependency load checks run as `node` (the runtime
# user), not root: they are there to prove the deployed bundles load for the account that will
# actually run the plugin workers, and root can load files the `node` user cannot read.
#
# node-pty is the terminal plugin's prebuilt native binding. `pg` and `pgsql-ast-parser` are the
# apps plugin's runtime dependencies: its worker bundle keeps them external (docker/../build.mjs
# uses `packages: "external"`), so they must arrive through `pnpm deploy --prod` rather than the
# bundle. `migrations/0001_meta.sql` and `0002_apps.sql` are shipped via `package.json.files` and
# read at worker start by `runMetaMigrations`; without them the plugin installs but never reaches
# `ready`. The `window,"kyoube"` grep proves the apps UI bundle actually inlines the built
# `@kyoube/app-sdk` output (build.mjs's `define: { __KYOUBE_APP_SDK__ }`), not just its own code —
# that string is `Object.defineProperty(window, "kyoube", ...)` from the SDK's own runtime,
# minified.
COPY --from=kyoube-build /out/bootstrap /opt/kyoube/bootstrap
COPY --from=kyoube-build /out/plugins /opt/kyoube/plugins
COPY --from=kyoube-build /out/license /opt/kyoube/license
COPY --from=kyoube-build /out/visibility /opt/kyoube/visibility
RUN gosu node node --input-type=module -e 'const m = await import("/opt/kyoube/visibility/decide.mjs"); for (const k of ["decideBoard", "liveEventFilter", "filterSearchResults", "routeGate", "coreLookups"]) if (typeof m[k] !== "function") process.exit(1); console.log("visibility ok")'
COPY docker/kyoube /usr/local/bin/kyoube
COPY docker/entrypoint.sh /usr/local/bin/kyoube-entrypoint.sh
RUN chmod +x /usr/local/bin/kyoube /usr/local/bin/kyoube-entrypoint.sh \
 && chown -R node:node /opt/kyoube \
 && test -f /opt/kyoube/plugins/terminal/dist/ui/index.js \
 && gosu node sh -c 'node -e "require(\"/opt/kyoube/plugins/terminal/node_modules/@lydell/node-pty\"); console.log(\"node-pty ok\")"' \
 && test -f /opt/kyoube/plugins/apps/dist/manifest.js \
 && test -f /opt/kyoube/plugins/apps/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/notify/dist/ui/index.js \
 && grep -q 'window,"kyoube"' /opt/kyoube/plugins/apps/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/apps/migrations/0001_meta.sql \
 && test -f /opt/kyoube/plugins/apps/migrations/0002_apps.sql \
 && gosu node sh -c 'node -e "require(\"/opt/kyoube/plugins/apps/node_modules/pg\"); require(\"/opt/kyoube/plugins/apps/node_modules/pgsql-ast-parser\"); console.log(\"apps deps ok\")"' \
 && test -f /opt/kyoube/plugins/files/dist/manifest.js \
 && test -f /opt/kyoube/plugins/files/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/studio/dist/manifest.js \
 && test -f /opt/kyoube/plugins/studio/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/agent-rules/dist/manifest.js \
 && test -f /opt/kyoube/plugins/agent-rules/dist/worker.js \
 && gosu node sh -c 'node -e "require.resolve(\"/opt/kyoube/plugins/agent-rules/node_modules/@paperclipai/plugin-sdk/package.json\"); console.log(\"agent-rules deps ok\")"' \
 && test -f /opt/kyoube/plugins/license/dist/manifest.js \
 && test -f /opt/kyoube/plugins/license/dist/worker.js \
 && test -f /opt/kyoube/plugins/license/dist/ui/index.js \
 && gosu node node --input-type=module -e 'const m = await import("/opt/kyoube/license/enforce.mjs"); const r = await m.checkSeat({ countUsers: async () => 0 }); if (!r.ok || r.limit !== 5) process.exit(1); console.log("licence check ok")' \
 && gosu node sh -c 'node -e "require(\"/opt/kyoube/bootstrap/node_modules/pg\"); console.log(\"bootstrap deps ok\")"' \
 && HOME=/tmp/build-home node /opt/kyoube/bootstrap/dist/kyoube.mjs --help >/dev/null \
 && rm -rf /tmp/build-home \
 && test -z "$(ls -A /kyoubeai)"

# Ruling P4-R39: telemetry off by default in the container environment: the
# server, the bootstrap CLI, agent runs and anything the entrypoint starts. A
# Terminal shell does not inherit this: the terminal plugin hands node-pty a
# closed environment it builds itself, so it sets the same two switches there
# (ruling P4-R42, plugins/kyoube-terminal/src/spawn-env.ts).
# Both are conventions rather than one product's switch: the upstream core's
# own telemetry client disables itself on DO_NOT_TRACK=1
# (packages/shared/src/telemetry/config.ts), and Claude Code reads
# DISABLE_TELEMETRY and DO_NOT_TRACK the same way. Harnesses people install are
# their own products; SECURITY.md's Telemetry section says what the core
# image's copies send. Nothing here claims the image is telemetry-free.
ENV DO_NOT_TRACK=1 \
    DISABLE_TELEMETRY=1

ARG KYOUBE_VERSION=dev
ENV KYOUBE_VERSION=${KYOUBE_VERSION} \
    KYOUBE_PLUGIN_ROOT=/opt/kyoube/plugins \
    HERMES_HOME=/kyoubeai/.hermes

# Absolute paths: /kyoubeai/.local/bin is first on PATH, and a node people
# install there (say, another version through npm) must not replace the
# server's own and stop it starting. docker/entrypoint.sh does the same for
# everything it runs before the server.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kyoube-entrypoint.sh"]
CMD ["/usr/local/bin/node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
