#!/usr/bin/env bash
# End-to-end smoke test: builds the image, starts the stack on port 3199,
# creates the first admin, installs the Kyoube plugins through `kyoube`, and
# creates one agent per harness (stand-in pi and Hermes CLIs in ~/.local/bin), and proves installs survive a restore. Requires docker compose v2, curl, jq.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${SMOKE_PROJECT:-kyoube-smoke}"
ENV_FILE="$ROOT/scripts/smoke.env"
BASE_URL="http://localhost:3199"
KEEP="${KEEP:-0}"
TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/docker-compose.yml" "$@"; }

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    echo "--- smoke failed (exit $code); last app logs ---" >&2
    compose logs --tail 200 app >&2 || true
  fi
  if [[ "$KEEP" != "1" ]]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  # The migration rehearsal creates the 0.1.x home volume outside compose, so
  # `down -v` (which only knows the volumes the compose file declares) leaves it.
  if [[ "$KEEP" != "1" ]]; then docker volume rm -f "${PROJECT}_paperclip-home" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

post_json() { # url body -> prints body, stores status in HTTP_STATUS
  local url="$1" body="$2"
  HTTP_STATUS="$(curl -sS -o "$TMP/resp.json" -w '%{http_code}' -c "$COOKIES" -b "$COOKIES" \
    -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -X POST "$url" --data "$body")"
  cat "$TMP/resp.json"
}

echo "==> build + up"
compose up -d --build

echo "==> wait for health"
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "health never came up" >&2; exit 1; fi
done
curl -fsS "$BASE_URL/api/health" | jq -e '.deploymentMode == "authenticated"' >/dev/null

echo "==> the served UI is branded"
# The rebrand ran at image build (docker/rebrand); this proves the server serves
# its output: title, PWA manifest, the renamed loading icon, and no stale name.
curl -fsS "$BASE_URL/" >"$TMP/index.html"
grep -q '<title>KyoubeAI</title>' "$TMP/index.html" || { echo "index.html title is not KyoubeAI:" >&2; grep -o '<title>[^<]*</title>' "$TMP/index.html" >&2; exit 1; }
curl -fsS "$BASE_URL/site.webmanifest" | jq -e '.name == "KyoubeAI" and .short_name == "KyoubeAI"' >/dev/null \
  || { echo "site.webmanifest is not branded" >&2; exit 1; }
# The content type, not just the status: the SPA catch-all below answers 200 for
# any path, so a bare status check would pass with the icon deleted.
NEW_ICON="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/kyoubeai-thinking.svg")"
[[ "$NEW_ICON" == "200 image/svg+xml"* ]] || { echo "/kyoubeai-thinking.svg is not served as an SVG ($NEW_ICON)" >&2; exit 1; }
# The old name cannot 404: upstream's SPA catch-all answers every unmatched path
# with index.html (200, text/html), so "gone" means "no longer an SVG".
OLD_ICON_TYPE="$(curl -sS -o /dev/null -w '%{content_type}' "$BASE_URL/paperclip-thinking.svg")"
[[ "$OLD_ICON_TYPE" != image/svg+xml* ]] || { echo "/paperclip-thinking.svg is still served ($OLD_ICON_TYPE)" >&2; exit 1; }
MAIN_JS="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$TMP/index.html" | head -1)"
[[ "$MAIN_JS" =~ -[0-9a-f]{8}\.js$ ]] || { echo "the main bundle was not re-hashed: $MAIN_JS" >&2; exit 1; }
curl -fsS "$BASE_URL$MAIN_JS" >"$TMP/main.js"
grep -q 'Welcome to KyoubeAI' "$TMP/main.js" || { echo "the main bundle does not say 'Welcome to KyoubeAI'" >&2; exit 1; }
! grep -qE '(^|[^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]|$)' "$TMP/main.js" \
  || { echo "the main bundle still contains a display-text Paperclip:" >&2; grep -oE '.{30}([^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]).{30}' "$TMP/main.js" | head -5 >&2; exit 1; }
# Exit 2 means "no Chrome": a real skip, not a pass. It fails the smoke unless
# the operator opts out, so the one check that sees the rendered DOM cannot go
# quiet on a CI runner whose Chrome disappeared.
BRAND_LIVE_RC=0
node "$ROOT/scripts/brand-live-check.mjs" "$BASE_URL" || BRAND_LIVE_RC=$?
if [[ "$BRAND_LIVE_RC" == "2" ]]; then
  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]]     || { echo "brand-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
  echo "    brand-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
elif [[ "$BRAND_LIVE_RC" != "0" ]]; then
  exit "$BRAND_LIVE_RC"
fi
echo "    title, manifest, loading icon, bundle text and the sign-in page are branded"

echo "==> the app installs as a standalone PWA with KyoubeAI's push handlers"
# docker/pwa ran at image build; this proves the server serves its output.
curl -fsS "$BASE_URL/site.webmanifest" | jq -e '.display == "standalone"' >/dev/null \
  || { echo "site.webmanifest is not standalone" >&2; exit 1; }
grep -q 'name="apple-mobile-web-app-capable"' "$TMP/index.html" || { echo "index.html lacks the iOS Home Screen tag" >&2; exit 1; }
curl -fsS -o "$TMP/sw.js" "$BASE_URL/sw.js"
grep -q 'importScripts("/kyoube-push-sw.js")' "$TMP/sw.js" || { echo "/sw.js does not import the push handlers" >&2; exit 1; }
# The content type, not just the status: the SPA catch-all answers 200 with index.html for any path.
PUSH_SW_STATUS="$(curl -sS -o "$TMP/push-sw.js" -w '%{http_code} %{content_type}' "$BASE_URL/kyoube-push-sw.js")"
if [[ "$PUSH_SW_STATUS" != "200 "*javascript* ]] || ! grep -q 'addEventListener("push"' "$TMP/push-sw.js"; then
  echo "/kyoube-push-sw.js is not served as JavaScript ($PUSH_SW_STATUS)" >&2; exit 1
fi

echo "==> the served UI carries the Studio theme"
# docker/theme ran at image build before the rebrand: the stylesheet is linked
# after the core's under a re-hashed name, the boot flag is inlined, the fonts
# are served, and the display-text renames are in the bundle.
THEME_CSS="$(grep -oE '/assets/kyoube-theme-[0-9a-f]{8}\.css' "$TMP/index.html" | head -1)"
[[ -n "$THEME_CSS" ]] || { echo "index.html does not link a re-hashed kyoube-theme stylesheet" >&2; exit 1; }
CORE_CSS_AT="$(grep -bo '/assets/index-[A-Za-z0-9_-]*\.css' "$TMP/index.html" | head -1 | cut -d: -f1)"
THEME_CSS_AT="$(grep -bo "$THEME_CSS" "$TMP/index.html" | head -1 | cut -d: -f1)"
(( THEME_CSS_AT > CORE_CSS_AT )) || { echo "the theme stylesheet is not linked after the core's" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL$THEME_CSS")" == "200 text/css"* ]] || { echo "$THEME_CSS is not served as CSS" >&2; exit 1; }
grep -q 'data-kyoube-shell' "$TMP/index.html" || { echo "index.html lacks the Studio boot flag" >&2; exit 1; }
grep -q 'const fallback = "dark";' "$TMP/index.html" || { echo "index.html does not default to the dark theme" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/fonts/kyoube/InstrumentSerif-Regular-latin.woff2")" == "200 font/woff2"* ]] || { echo "the Instrument Serif font is not served" >&2; exit 1; }
grep -q 'to:"/dashboard",label:"Home"' "$TMP/main.js" || { echo "the sidebar does not call the dashboard Home" >&2; exit 1; }
grep -q '{label:"Connectors",href:"/apps"}' "$TMP/main.js" || { echo "the core's last Apps breadcrumbs were not renamed Connectors" >&2; exit 1; }
! grep -q '{label:"Apps",href:"/apps"}' "$TMP/main.js" || { echo "a core breadcrumb still calls the Connectors area Apps" >&2; exit 1; }
echo "    $THEME_CSS is linked after the core stylesheet; fonts, dark default and renames are in place"

echo "==> home and database names"
# shellcheck disable=SC2016  # expanded by the shell inside the container
APP_HOME="$(compose exec -T app sh -c 'echo "$HOME:$PAPERCLIP_HOME:$HERMES_HOME"; getent passwd node | cut -d: -f6; test -e /paperclip && echo LEGACY_PATH_PRESENT || echo no-legacy-path' | tr -d '\r')"
[[ "$APP_HOME" == $'/kyoubeai:/kyoubeai:/kyoubeai/.hermes\n/kyoubeai\nno-legacy-path' ]] \
  || { echo "unexpected home layout in app:" >&2; echo "$APP_HOME" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
grep -qx kyoubeai <<<"$DBS" || { echo "no kyoubeai database: $DBS" >&2; exit 1; }
! grep -qx paperclip <<<"$DBS" || { echo "a paperclip database still exists: $DBS" >&2; exit 1; }
docker volume ls --format '{{.Name}}' | grep -qx "${PROJECT}_kyoubeai-home" || { echo "volume ${PROJECT}_kyoubeai-home missing" >&2; exit 1; }
echo "    HOME=/kyoubeai, database kyoubeai, volume ${PROJECT}_kyoubeai-home"

echo "==> sign up first admin and claim the instance"
post_json "$BASE_URL/api/auth/sign-up/email" '{"name":"Smoke Admin","email":"smoke@kyoube.local","password":"smoke-password-123"}' >/dev/null
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "sign-up failed: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
post_json "$BASE_URL/api/bootstrap/claim" '{}' | jq -e '.claimed == true' >/dev/null
curl -fsS "$BASE_URL/api/health" | jq -e '.bootstrapStatus == "ready"' >/dev/null

echo "==> create a board API key"
TOKEN="$(post_json "$BASE_URL/api/board-api-keys" '{"name":"kyoube-smoke"}' | jq -r '.token')"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "no board token" >&2; exit 1; }

echo "==> the plugin catalogue is branded"
# Settings → Plugins lists the example plugins from their package.json /
# manifest.ts descriptions, which live under packages/plugins (source, not
# dist) — the one surface the acceptance pass found unbranded.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins/examples" >"$TMP/plugin-examples.json"
! grep -qE '(^|[^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]|$)' "$TMP/plugin-examples.json" \
  || { echo "GET /api/plugins/examples still carries display-text Paperclip:" >&2; grep -oE '.{0,40}Paperclip.{0,40}' "$TMP/plugin-examples.json" | head -5 >&2 || true; exit 1; }
echo "    /api/plugins/examples carries no display-text Paperclip"

wait_for_plugin() { # plugin-key version — poll until the core reports it ready
  # Worker (re)activation is asynchronous. kyoube.apps in particular only flips
  # to `ready` once its worker has read /kyoubeai/kyoube/config.json, opened a
  # pool against the `kyoube` database and applied the kyoube_meta migrations,
  # so sampling /api/plugins once right after the install would be a race.
  local key="$1" want="$2" i
  for i in $(seq 1 60); do
    curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" >"$TMP/plugins.json" 2>/dev/null || true
    if jq -e --arg k "$key" --arg v "$want" \
      'map(select(.pluginKey == $k)) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
      "$TMP/plugins.json" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$key never reached $want/ready: $(jq -c --arg k "$key" 'map(select(.pluginKey == $k)) | .[0] | {version, status}' "$TMP/plugins.json")" >&2
  return 1
}

wait_for_plugin_api() { # poll until both plugin workers answer a route of their own
  # /api/plugins reports each plugin record's *stored* status. After a restore
  # (or any start against an existing database) that record already says
  # `ready` while the plugin loader is still starting the worker processes, so
  # wait_for_plugin returns at once and the next plugin route can still meet a
  # 503 for a few hundred milliseconds. CI run 35113684280 lost that race:
  # status `ready` at +0 ms, GET /tables/smoke_contacts 503 at +60 ms, the
  # kyoube.apps worker up at +430 ms. Readiness here therefore means the worker
  # answered: a cheap apps route and the terminal's own data read, both 200.
  local i apps="" term=""
  for i in $(seq 1 60); do
    apps="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
      "$API/access/me?companyId=$COMPANY_ID" 2>/dev/null || true)"
    term="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
      --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" 2>/dev/null || true)"
    [[ "$apps" == "200" && "$term" == "200" ]] && return 0
    sleep 1
  done
  echo "the plugin workers never answered after the warm start: kyoube.apps=$apps kyoube.terminal=$term" >&2
  return 1
}

wait_core_ready() { # poll until /api/health reports status ok and bootstrapStatus ready
  # bootstrapStatus turns ready before the core's startup recovery ends;
  # /api/health reports status "starting" until then, and doctor's `core` line
  # fails on it. Run this before any `kyoube doctor` that follows a restart.
  local i
  for i in $(seq 1 300); do
    if curl -fsS "$BASE_URL/api/health" 2>/dev/null | jq -e '.status == "ok" and .bootstrapStatus == "ready"' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "the app never reported status ok with bootstrapStatus ready: $(curl -sS "$BASE_URL/api/health" || true)" >&2
  return 1
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

wait_agent_rules_pass() { # since (now_utc) — poll until the agent-rules loop records a pass after it
  # doctor's `agent rules` line reads the loop's last pass from its state file.
  # After a restart that pass may still be the one before it, and a restore
  # brings back the backup's, so doctor waits for the loop's first new pass.
  # Any pass will do: doctor itself asserts that it was clean.
  local since="$1" i
  for i in $(seq 1 90); do
    compose exec -T app cat /kyoubeai/.kyoube/agent-rules.json >"$TMP/agent-rules-state.json" 2>/dev/null || true
    jq -e --arg s "$since" '.lastPass.at > $s' "$TMP/agent-rules-state.json" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "the agent-rules loop recorded no pass after $since (last: $(jq -r '.lastPass.at' "$TMP/agent-rules-state.json" 2>/dev/null))" >&2
  return 1
}

APPS_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-apps/package.json")"
[[ "$APPS_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.apps version '$APPS_SHIPPED' in package.json" >&2; exit 1; }
FILES_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-files/package.json")"
[[ "$FILES_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.files version '$FILES_SHIPPED' in package.json" >&2; exit 1; }
STUDIO_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-studio/package.json")"
[[ "$STUDIO_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.studio version '$STUDIO_SHIPPED' in package.json" >&2; exit 1; }
AGENT_RULES_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-agent-rules/package.json")"
[[ "$AGENT_RULES_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.agent-rules version '$AGENT_RULES_SHIPPED' in package.json" >&2; exit 1; }
LICENSE_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-license/package.json")"
[[ "$LICENSE_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.license version '$LICENSE_SHIPPED' in package.json" >&2; exit 1; }
NOTIFY_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-notify/package.json")"
[[ "$NOTIFY_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.notify version '$NOTIFY_SHIPPED' in package.json" >&2; exit 1; }

echo "==> install plugins via kyoube ensure-plugins"
# Seven plugins ship in the image (/opt/kyoube/plugins/{terminal,apps,files,studio,agent-rules,license,notify}),
# so the first pass installs all seven — `installed 7`, nothing upgraded or
# skipped.
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN" | tee "$TMP/ensure-first.log"
grep -q 'installed 7, upgraded 0, skipped 0' "$TMP/ensure-first.log" \
  || { echo "expected all seven bundled plugins to install on the first pass:" >&2; cat "$TMP/ensure-first.log" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].status == "ready"' >/dev/null
wait_for_plugin kyoube.apps "$APPS_SHIPPED"
wait_for_plugin kyoube.files "$FILES_SHIPPED"
wait_for_plugin kyoube.studio "$STUDIO_SHIPPED"
wait_for_plugin kyoube.agent-rules "$AGENT_RULES_SHIPPED"
wait_for_plugin kyoube.license "$LICENSE_SHIPPED"
wait_for_plugin kyoube.notify "$NOTIFY_SHIPPED"
echo "    kyoube.terminal, kyoube.apps ${APPS_SHIPPED}, kyoube.files ${FILES_SHIPPED}, kyoube.studio ${STUDIO_SHIPPED}, kyoube.agent-rules ${AGENT_RULES_SHIPPED}, kyoube.license ${LICENSE_SHIPPED} and kyoube.notify ${NOTIFY_SHIPPED} are installed and ready"

echo "==> kyoube setup (real browser-approval onboarding)"
# Run setup detached inside the container; it prints an approval URL and then
# polls until a signed-in instance admin approves the challenge.
compose exec -T app sh -c \
  'rm -f /tmp/setup.log /tmp/setup.exit; { kyoube setup > /tmp/setup.log 2>&1; echo $? > /tmp/setup.exit; } & echo started' >/dev/null
APPROVAL=""
for i in $(seq 1 90); do
  APPROVAL="$(compose exec -T app sh -c 'cat /tmp/setup.log 2>/dev/null' \
    | grep -oE '/cli-auth/[0-9a-f-]{36}\?token=pcp_cli_auth_[0-9a-f]+' | head -1 || true)"
  [[ -n "$APPROVAL" ]] && break
  sleep 1
done
[[ -n "$APPROVAL" ]] || { echo "kyoube setup never printed an approval URL:" >&2; compose exec -T app sh -c 'cat /tmp/setup.log' >&2; exit 1; }
CHALLENGE_ID="${APPROVAL#/cli-auth/}"; CHALLENGE_ID="${CHALLENGE_ID%%\?*}"
CHALLENGE_TOKEN="${APPROVAL#*token=}"
echo "    approving challenge $CHALLENGE_ID as the instance admin"
post_json "$BASE_URL/api/cli-auth/challenges/$CHALLENGE_ID/approve" "{\"token\":\"$CHALLENGE_TOKEN\"}" \
  | jq -e '.approved == true' >/dev/null
SETUP_EXIT=""
for i in $(seq 1 120); do
  SETUP_EXIT="$(compose exec -T app sh -c 'cat /tmp/setup.exit 2>/dev/null' | tr -dc '0-9' || true)"
  [[ -n "$SETUP_EXIT" ]] && break
  sleep 1
done
compose exec -T app sh -c 'sed "s/^/    setup| /" /tmp/setup.log'
[[ "$SETUP_EXIT" == "0" ]] || { echo "kyoube setup exited '${SETUP_EXIT:-<timeout>}'" >&2; exit 1; }
# setup ends by running ensure-plugins with the key it just stored; the bundled
# plugins are already installed at the on-disk version, so it skips all seven.
compose exec -T app sh -c 'cat /tmp/setup.log' >"$TMP/setup.log"
grep -q 'installed 0, upgraded 0, skipped 7' "$TMP/setup.log" \
  || { echo "expected setup's ensure-plugins to skip the seven bundled plugins:" >&2; cat "$TMP/setup.log" >&2; exit 1; }
# No company exists at this point, so setup has nothing to verify and says so
# rather than waiting for skills that cannot appear yet.
grep -q 'no company exists yet' "$TMP/setup.log" \
  || { echo "expected setup to report that no company exists yet:" >&2; cat "$TMP/setup.log" >&2; exit 1; }

echo "==> the stored board key is usable without --api-key"
KEY_STAT="$(compose exec -T app sh -c 'stat -c "%a %U" /kyoubeai/kyoube/board-key.json')"
KEY_STAT="$(echo "$KEY_STAT" | tr -d '\r')"
[[ "$KEY_STAT" == "600 node" ]] || { echo "board-key.json is '$KEY_STAT', expected '600 node'" >&2; exit 1; }
echo "    /kyoubeai/kyoube/board-key.json $KEY_STAT"
compose exec -T app kyoube ensure-plugins >"$TMP/ensure-stored.log" 2>&1 \
  || { echo "ensure-plugins with the stored key failed:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.terminal skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.terminal to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.apps skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.apps to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.files skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.files to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.studio skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.studio to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.agent-rules skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.agent-rules to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.license skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.license to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
# All bundled plugins are already at the on-disk version by now, so the whole
# run is a no-op: seven skips, nothing installed or upgraded.
grep -q 'installed 0, upgraded 0, skipped 7' "$TMP/ensure-stored.log" \
  || { echo "expected 'installed 0, upgraded 0, skipped 7' in the summary:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
sed 's/^/    /' "$TMP/ensure-stored.log"

echo "==> licensing: five users free, the sixth refused, removing a user frees a seat, a key raises the limit"
# Every sign-up comes from a fresh cookie jar, so the admin's session in
# $COOKIES stays as it is.
signup() { # name email -> prints the HTTP status; the body lands in $TMP/signup.json
  # The core rate-limits sign-ups (429, x-retry-after 10), so wait and retry on a 429.
  local code _
  for _ in 1 2 3 4 5 6; do
    code="$(curl -sS -o "$TMP/signup.json" -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: $BASE_URL" \
      -X POST "$BASE_URL/api/auth/sign-up/email" --data "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"smoke-password-123\"}")"
    [[ "$code" == "429" ]] || break
    sleep 11
  done
  printf '%s' "$code"
}
expect_refused() { # status limit-text
  if [[ "$1" != "400" ]] || ! jq -e --arg t "$2" '.code == "SEAT_LIMIT_REACHED" and (.message | contains($t))' "$TMP/signup.json" >/dev/null; then
    echo "the sign-up was not refused with SEAT_LIMIT_REACHED ($2): $1 $(cat "$TMP/signup.json")" >&2
    exit 1
  fi
}
compose exec -T app kyoube doctor >"$TMP/doctor-licence.log" || true
grep -Eq '^ok +licence enforcement +active' "$TMP/doctor-licence.log" || { echo "doctor does not report the licence enforcement active:" >&2; cat "$TMP/doctor-licence.log" >&2; exit 1; }
for n in 2 3 4 5; do
  STATUS="$(signup "Seat $n" "seat$n@kyoube.local")"
  [[ "$STATUS" =~ ^2 ]] || { echo "sign-up $n of 5 failed: $STATUS $(cat "$TMP/signup.json")" >&2; exit 1; }
done
expect_refused "$(signup "Seat 6" "seat6@kyoube.local")" "(5 of 5)"
compose exec -T app kyoube license refresh >/dev/null
[[ "$(compose exec -T app sh -c 'jq ".users | length" /kyoubeai/kyoube/license-users.json' | tr -d '\r')" == "5" ]] \
  || { echo "the user snapshot does not hold 5 users" >&2; exit 1; }
compose exec -T app kyoube doctor >"$TMP/doctor-licence.log" || true
grep -Eq '^WARN +licence +Free: 5 of 5 users' "$TMP/doctor-licence.log" || { echo "doctor does not WARN at the free limit:" >&2; cat "$TMP/doctor-licence.log" >&2; exit 1; }
# The only admin (who also owns the board key) can't be removed. The last-admin
# guard fires before the board-key-owner guard, so that is the text to expect.
if compose exec -T app kyoube users remove smoke@kyoube.local --yes >"$TMP/remove-owner.log" 2>&1; then
  echo "kyoube users remove deleted the board key's owner" >&2; exit 1
fi
grep -q "is the last instance admin" "$TMP/remove-owner.log" || { echo "unexpected refusal text:" >&2; cat "$TMP/remove-owner.log" >&2; exit 1; }
compose exec -T app kyoube users remove seat5@kyoube.local --yes | tee "$TMP/remove.log"
grep -q 'removed seat5@kyoube.local. 4 of 5 users.' "$TMP/remove.log" || { echo "kyoube users remove did not report 4 of 5:" >&2; cat "$TMP/remove.log" >&2; exit 1; }
STATUS="$(signup "Seat 6" "seat6@kyoube.local")"
[[ "$STATUS" =~ ^2 ]] || { echo "the sign-up after a removal failed: $STATUS $(cat "$TMP/signup.json")" >&2; exit 1; }
SEATS=(seat2 seat3 seat4 seat6)
if [[ -n "${KYOUBE_SMOKE_LICENSE:-}" ]]; then
  # Take only the token: a pasted secret can carry a trailing newline, quotes or a banner line.
  SMOKE_KEY="$(grep -oE 'KYB1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' <<<"${KYOUBE_SMOKE_LICENSE}" | head -1 || true)"
  [[ -n "$SMOKE_KEY" ]] || { echo "KYOUBE_SMOKE_LICENSE is set but holds no KYB1.<payload>.<signature> token; fix the secret (never printed here)" >&2; exit 1; }
  # A real key, signed with the production signing key: 7 users, any instance.
  compose exec -T app kyoube license set "$SMOKE_KEY" | tee "$TMP/license-set.log"
  grep -q ': 5 of 7 users' "$TMP/license-set.log" || { echo "the smoke licence did not apply as 7 users:" >&2; cat "$TMP/license-set.log" >&2; exit 1; }
  for n in 7 8; do
    STATUS="$(signup "Seat $n" "seat$n@kyoube.local")"
    [[ "$STATUS" =~ ^2 ]] || { echo "licensed sign-up seat$n failed: $STATUS $(cat "$TMP/signup.json")" >&2; exit 1; }
  done
  SEATS+=(seat7 seat8)
  expect_refused "$(signup "Seat 9" "seat9@kyoube.local")" "(7 of 7)"
  MID=$(( ${#SMOKE_KEY} / 2 ))
  SWAP="A"; [[ "${SMOKE_KEY:$MID:1}" == "A" ]] && SWAP="B"
  TAMPERED="${SMOKE_KEY:0:$MID}${SWAP}${SMOKE_KEY:$((MID + 1))}"
  # The key is never printed: the output goes to a file that is only searched.
  if compose exec -T app kyoube license set "$TAMPERED" >"$TMP/license-tamper.log" 2>&1; then echo "a tampered licence key was accepted" >&2; exit 1; fi
  grep -q 'licence key not applied' "$TMP/license-tamper.log" || { echo "a tampered licence key failed, but not with 'licence key not applied' (output withheld: it may echo the key)" >&2; exit 1; }
  compose exec -T app kyoube license clear >/dev/null
  echo "    licensed: 7 users allowed, the 8th account refused, a one-character change rejected"
else
  echo "    licensed path SKIPPED: KYOUBE_SMOKE_LICENSE is not set (a fork's PR, or a local run without the secret)"
fi
# Back to the one admin, so the rest of the smoke (and its backup and restore) is unchanged.
for seat in "${SEATS[@]}"; do compose exec -T app kyoube users remove "$seat@kyoube.local" --yes >/dev/null; done
compose exec -T app kyoube users list | tee "$TMP/users.log"
grep -q '^1 of 5 users$' "$TMP/users.log" || { echo "expected 1 of 5 users after the licensing checks:" >&2; cat "$TMP/users.log" >&2; exit 1; }
echo "    5 free, the 6th refused with SEAT_LIMIT_REACHED, a removal frees a seat, doctor WARNs at the limit"

echo "==> the entrypoint plugin watcher finishes and exits"
# Until a board key exists the watcher retries on a 60s cycle; once it succeeds
# runEnsurePlugins returns 0 and the process exits. Waiting for that here both
# asserts the entrypoint path works end to end and removes a 60s window in
# which the watcher could race the version-bump rehearsals below.
# `--w[a]tch` keeps the probe from matching its own command line.
WATCHER="busy"
for i in $(seq 1 90); do
  # shellcheck disable=SC2016  # expanded by the shell inside the container
  WATCHER="$(compose exec -T app sh -c \
    'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "ensure-plugins --w[a]tch" && echo busy; done' \
    | tr -d '\r\n ' || true)"
  [[ -z "$WATCHER" ]] && break
  sleep 1
done
[[ -z "$WATCHER" ]] || { echo "ensure-plugins --watch is still running 90s after the board key was stored" >&2; exit 1; }
echo "    watcher is done"

# Assert the terminal plugin's version/status/capabilities as the core stores them.
# Usage: assert_plugin <version> [required-capability]
assert_plugin() {
  local want_version="$1" want_capability="${2:-}" i
  # Worker (re)activation after install/upgrade is asynchronous, so poll briefly
  # for the row to settle on `ready` rather than sampling once.
  for i in $(seq 1 30); do
    curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" >"$TMP/plugins.json"
    if jq -e --arg v "$want_version" \
      'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
      "$TMP/plugins.json" >/dev/null; then break; fi
    sleep 1
  done
  jq -e --arg v "$want_version" \
    'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
    "$TMP/plugins.json" >/dev/null \
    || { echo "expected kyoube.terminal $want_version/ready, got: $(jq -c 'map(select(.pluginKey=="kyoube.terminal"))|.[0]|{version,status}' "$TMP/plugins.json")" >&2; exit 1; }
  if [[ -n "$want_capability" ]]; then
    jq -e --arg c "$want_capability" \
      'map(select(.pluginKey == "kyoube.terminal")) | .[0].manifestJson.capabilities | index($c) != null' \
      "$TMP/plugins.json" >/dev/null \
      || { echo "stored manifest is missing capability $want_capability: $(jq -c 'map(select(.pluginKey=="kyoube.terminal"))|.[0].manifestJson.capabilities' "$TMP/plugins.json")" >&2; exit 1; }
  fi
}

# The manifest is node-owned inside the container; edit it as node so the
# plugin loader re-reads the bumped bundle from the same packagePath.
edit_manifest() { compose exec -T -u node app sh -c "$1"; }
MANIFEST=/opt/kyoube/plugins/terminal/dist/manifest.js
# The rehearsals bump the shipped kyoube.terminal version twice. Derive all three
# from the plugin's package.json (what the image was just built from) so a real
# bump of the plugin never has to touch this script. The escaped forms are for
# sed/grep patterns, where a bare dot would match any character.
SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-terminal/package.json")"
[[ "$SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.terminal version '$SHIPPED' in package.json" >&2; exit 1; }
BUMP1="${SHIPPED%.*}.$(( ${SHIPPED##*.} + 1 ))"
BUMP2="${SHIPPED%.*}.$(( ${SHIPPED##*.} + 2 ))"
escape_dots() { printf '%s' "$1" | sed 's/\./\\./g'; }
SHIPPED_RE="$(escape_dots "$SHIPPED")"; BUMP1_RE="$(escape_dots "$BUMP1")"; BUMP2_RE="$(escape_dots "$BUMP2")"

echo "==> rehearse a plugin version bump (upgrade route)"
edit_manifest "sed -i 's/${SHIPPED_RE}/${BUMP1}/' $MANIFEST && grep -q '${BUMP1_RE}' $MANIFEST"
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN"
assert_plugin "$BUMP1"
echo "    kyoube.terminal upgraded in place to $BUMP1"

# The escalated capability must be one the shipped manifest does NOT declare:
# upstream compares the new manifest's capabilities against the installed one
# and only diverts to the approval path for genuinely added entries, so
# re-adding any of the five kyoube.terminal already declares would quietly take
# the plain upgrade route and stop exercising the uninstall+reinstall fallback.
echo "==> rehearse a capability escalation (uninstall + reinstall fallback)"
edit_manifest "sed -i 's/${BUMP1_RE}/${BUMP2}/; s/\"ui\.page\.register\",/\"plugin.state.read\", \"ui.page.register\",/' $MANIFEST && grep -q 'plugin.state.read' $MANIFEST"
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN"
assert_plugin "$BUMP2" plugin.state.read
echo "    kyoube.terminal reinstalled at $BUMP2 with the new capability"

echo "==> create a company and one agent per harness"
COMPANY_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies" --data '{"name":"Smoke Co"}' | jq -r '.id')"
[[ -n "$COMPANY_ID" && "$COMPANY_ID" != "null" ]] || { echo "company create failed" >&2; exit 1; }
for ADAPTER in claude_local pi_local hermes_local; do
  STATUS="$(curl -sS -o "$TMP/agent.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/companies/$COMPANY_ID/agents" \
    --data "{\"name\":\"smoke-$ADAPTER\",\"adapterType\":\"$ADAPTER\",\"adapterConfig\":{\"cwd\":\"/kyoubeai/workspaces/smoke\"}}")"
  [[ "$STATUS" =~ ^2 ]] || { echo "agent create for $ADAPTER failed: $STATUS $(cat "$TMP/agent.json")" >&2; exit 1; }
  echo "    created agent for $ADAPTER"
done

echo "==> the agent Test route still refuses an agent of another company"
# Core 2026.1001 changed the agent Test route (upstream 9335b7d, which KyoubeAI
# carried as a core patch before) only after the route has found the agent: an
# agent of another company is still refused (404 "Agent not found" from the
# company check, or 403 from the access check). The second company is made here,
# before the backup, so the restore and doctor's company counts include it.
OTHER_COMPANY_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies" --data '{"name":"Smoke Other Co"}' | jq -r '.id')"
[[ -n "$OTHER_COMPANY_ID" && "$OTHER_COMPANY_ID" != "null" ]] || { echo "could not create the second company" >&2; exit 1; }
OTHER_AGENT_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies/$OTHER_COMPANY_ID/agents" \
  --data '{"name":"smoke-other-claude","adapterType":"claude_local","adapterConfig":{"cwd":"/kyoubeai/workspaces/smoke-other"}}' | jq -r '.id')"
[[ -n "$OTHER_AGENT_ID" && "$OTHER_AGENT_ID" != "null" ]] || { echo "could not create the second company's agent" >&2; exit 1; }
for TEST_TYPE in claude_local codex_local; do
  STATUS="$(curl -sS -o "$TMP/cross-company-test.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST \
    "$BASE_URL/api/companies/$COMPANY_ID/adapters/$TEST_TYPE/test-environment" \
    --data "{\"agentId\":\"$OTHER_AGENT_ID\",\"adapterConfig\":{\"cwd\":\"/kyoubeai/workspaces/smoke\"}}")"
  [[ "$STATUS" == "403" || "$STATUS" == "404" ]] \
    || { echo "Test on $TEST_TYPE in one company with another company's agent answered $STATUS, expected 403 or 404: $(cat "$TMP/cross-company-test.json")" >&2; exit 1; }
done
echo "    an agent of another company is still refused ($STATUS)"

echo "==> the Studio design renders, signed in, and falls back without its plugin"
# docker/theme proved its hooks exist in the bundle at build time; this asks a
# real browser whether the design lands on this core: dark by default, the
# Studio sidebar and Home in place, the Workspace page, and the stock sidebar
# back when kyoube.studio is disabled. Screenshots go to STUDIO_SHOTS_DIR (CI
# uploads them) for a person to look at after a core bump.
COMPANY_PREFIX="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID" | jq -r '.issuePrefix')"
STUDIO_LIVE_RC=0
node "$ROOT/scripts/studio-live-check.mjs" "$BASE_URL" smoke@kyoube.local smoke-password-123 "$COMPANY_PREFIX" "$TOKEN" || STUDIO_LIVE_RC=$?
if [[ "$STUDIO_LIVE_RC" == "2" ]]; then
  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]] || { echo "studio-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
  echo "    studio-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
elif [[ "$STUDIO_LIVE_RC" != "0" ]]; then
  exit "$STUDIO_LIVE_RC"
fi

echo "==> the first-run wizard can skip the harness sign-in"
# docker/core-patches adds "Skip for now" under an error on the wizard's
# Connect step. This stack has no harness signed in, so Connect fails and the
# skip must still hire the agent. The check creates its own agentless company.
ONBOARDING_LIVE_RC=0
node "$ROOT/scripts/onboarding-live-check.mjs" "$BASE_URL" smoke@kyoube.local smoke-password-123 "$TOKEN" || ONBOARDING_LIVE_RC=$?
if [[ "$ONBOARDING_LIVE_RC" == "2" ]]; then
  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]] || { echo "onboarding-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
  echo "    onboarding-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
elif [[ "$ONBOARDING_LIVE_RC" != "0" ]]; then
  exit "$ONBOARDING_LIVE_RC"
fi

echo "==> the worker installs the Kyoube skills into the new company by itself (company.created)"
# The company was created after `kyoube setup`, so nothing but the worker's
# event subscription can have put the skills there. The import is asynchronous.
for i in $(seq 1 60); do
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/skills" >"$TMP/skills.json" 2>/dev/null || true
  if jq -e 'map(.slug) | (index("kyoube-data") != null) and (index("kyoube-apps") != null)' "$TMP/skills.json" >/dev/null 2>&1; then break; fi
  sleep 1
  [[ $i -eq 60 ]] && { echo "the Kyoube skills never appeared in the company's skill library: $(cat "$TMP/skills.json")" >&2; exit 1; }
done
echo "    kyoube-data and kyoube-apps are in the company's skill library"

echo "==> terminal: the UI bundle is served and the sidebar gate answers"
# Upstream serves plugin UI bundles from `GET /_plugins/:pluginId/ui/*` — mounted
# at the app root (server/src/app.ts), NOT under /api, whose catch-all would 404
# it. `index.js` is the entry named by `entrypoints.ui`; the frontend slot host
# imports exactly this URL, so a 200 with the page export in it is the closest
# check to "the browser can mount the page" that needs no browser.
#
# :pluginId must be the row UUID here, which is also what the frontend uses
# (`PluginUiContribution.pluginId`). Unlike the bridge routes, this route is not
# key-tolerant: it calls registry.getById() first and only swallows the failure
# when the thrown error exposes Postgres code 22P02 at the top level, which the
# Drizzle wrapper does not — so passing "kyoube.terminal" here 500s.
PLUGIN_UUID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -r 'map(select(.pluginKey == "kyoube.terminal")) | .[0].id')"
[[ -n "$PLUGIN_UUID" && "$PLUGIN_UUID" != "null" ]] || { echo "could not resolve the kyoube.terminal plugin id" >&2; exit 1; }
UI_STATUS="$(curl -sS -o "$TMP/ui-bundle.js" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/_plugins/$PLUGIN_UUID/ui/index.js")"
[[ "$UI_STATUS" == "200" ]] \
  || { echo "GET /_plugins/$PLUGIN_UUID/ui/index.js returned $UI_STATUS: $(head -c 300 "$TMP/ui-bundle.js")" >&2; exit 1; }
grep -q 'TerminalPage' "$TMP/ui-bundle.js" \
  || { echo "the served UI bundle does not contain TerminalPage" >&2; exit 1; }
echo "    ui bundle 200, $(wc -c <"$TMP/ui-bundle.js" | tr -d ' ') bytes, contains TerminalPage"

ADMIN_USER_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/cli-auth/me" | jq -r '.userId')"
[[ -n "$ADMIN_USER_ID" && "$ADMIN_USER_ID" != "null" ]] || { echo "could not resolve the board key's user id" >&2; exit 1; }
# terminal.can_open backs the sidebar entry: the entry renders only when the
# signed-in user's company role is in allowedRoles.
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
  --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" \
  >"$TMP/can-open.json"
jq -e '.data.allowed == true' "$TMP/can-open.json" >/dev/null \
  || { echo "terminal.can_open did not allow the admin: $(cat "$TMP/can-open.json")" >&2; exit 1; }
echo "    terminal.can_open allowed=true role=$(jq -r '.data.role' "$TMP/can-open.json") for the admin"

echo "==> terminal: open, run a command, read its output back, close"
bridge() { # action-key body-json
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/plugins/kyoube.terminal/actions/$1" --data "$2"
}
# What is typed must differ from what a *running* shell prints, because the tty
# line discipline echoes the typed bytes back to the master read side whether or
# not the child ever reads them — the plugin records that echo as an `output`
# event too. So type the arithmetic unevaluated (`\$((6*7))` keeps bash on this
# side from expanding it) and assert on the evaluated result: only a live shell
# turns "<mark>-$((6*7))" into "<mark>-42".
MARK="kyoube-smoke-$RANDOM"
EXPECTED="$MARK-42"
SESSION_ID="$(bridge terminal.open "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"cols\":100,\"rows\":30}}" | jq -r '.data.sessionId')"
[[ -n "$SESSION_ID" && "$SESSION_ID" != "null" ]] || { echo "terminal.open failed" >&2; exit 1; }
bridge terminal.input "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"data\":\"echo $MARK-\$((6*7))\\n\"}}" >/dev/null
# bash has to start, read the line, evaluate it and write the result back
# through the pty; how long that takes depends on the host's load. Read it
# back the way the page does: `terminal.wait` long-polls answer as soon as
# there is output past `afterSeq` (else park up to `timeoutMs`), so chain
# them from the last seq seen and accumulate the text until the mark shows
# up or ~20s pass. Upstream's SSE stream bridge is not wired (it answers
# 501), which is exactly why the page pulls instead.
MARK_SEEN=""
AFTER_SEQ=0
: >"$TMP/wait-output.txt"
WAIT_STARTED=$(date +%s)
# Bounded by wall time, not by a count: a login shell's profile output, prompt and tty echo
# each answer a wait of their own, so a fixed number of polls could run out in well under 20s.
while (( $(date +%s) - WAIT_STARTED < 20 )); do
  bridge terminal.wait "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"afterSeq\":$AFTER_SEQ,\"timeoutMs\":2000}}" >"$TMP/wait.json"
  jq -r '[.data.events[] | select(.type == "output") | .data] | join("")' "$TMP/wait.json" | tr -d '\n' >>"$TMP/wait-output.txt"
  AFTER_SEQ="$(jq --argjson after "$AFTER_SEQ" '[.data.events[].seq] | max // $after' "$TMP/wait.json")"
  if grep -q -- "$EXPECTED" "$TMP/wait-output.txt"; then MARK_SEEN=1; break; fi
done
[[ -n "$MARK_SEEN" ]] || {
  echo "the shell never printed '$EXPECTED' within ~20s (typed: echo $MARK-\$((6*7))); output seen so far:" >&2
  cat "$TMP/wait-output.txt" >&2
  echo "last wait payload:" >&2
  cat "$TMP/wait.json" >&2
  exit 1
}
# An idle session's wait must answer empty when its timeout elapses, not hang.
IDLE_STARTED=$(date +%s)
bridge terminal.wait "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"afterSeq\":$AFTER_SEQ,\"timeoutMs\":1000}}" >"$TMP/wait-idle.json"
jq -e '.data.events == [] and .data.session.alive == true' "$TMP/wait-idle.json" >/dev/null \
  || { echo "an idle terminal.wait did not answer empty: $(cat "$TMP/wait-idle.json")" >&2; exit 1; }
(( $(date +%s) - IDLE_STARTED <= 10 )) || { echo "an idle terminal.wait took longer than its timeout" >&2; exit 1; }
bridge terminal.close "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}" >/dev/null
echo "    terminal round-trip ok (shell evaluated the command, not just echoed it)"

echo "==> the activity log records the session but never its content"
# `ctx.activity.log({ message })` lands in activity_log.action with
# actorType=plugin (server/src/services/plugin-host-services.ts), and
# GET /api/companies/:companyId/activity returns those rows to a board key.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  >"$TMP/activity.json"
jq -e 'map(select((.action // "") | startswith("Terminal session opened"))) | length >= 1' "$TMP/activity.json" >/dev/null \
  || { echo "no 'Terminal session opened' entry in the activity log: $(jq -c 'map(.action)' "$TMP/activity.json")" >&2; exit 1; }
jq -e 'map(select((.action // "") | startswith("Terminal session closed"))) | length >= 1' "$TMP/activity.json" >/dev/null \
  || { echo "no 'Terminal session closed' entry in the activity log: $(jq -c 'map(.action)' "$TMP/activity.json")" >&2; exit 1; }
jq -e --arg mark "$MARK" 'tostring | contains($mark) | not' "$TMP/activity.json" >/dev/null \
  || { echo "the activity log leaked terminal content ('$MARK')" >&2; exit 1; }
echo "    open/close audited, keystrokes and output are not"

echo "==> data: plugin ready, create a table, insert, query, sql"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.apps")) | length == 1 and .[0].status == "ready"' >/dev/null
# Upstream dispatches these from `router.use("/plugins/:pluginId/api", …)` in
# server/src/routes/plugins.ts: JSON only, `resolvePlugin` accepts the plugin
# key as well as the row UUID (unlike /_plugins/:pluginId/ui/*), and the company
# is resolved from `?companyId=` for GET and `body.companyId` for POST — exactly
# what this plugin's manifest declares. COMPANY_ID is a UUID, so the query
# string needs no escaping.
API="$BASE_URL/api/plugins/kyoube.apps/api"
api_post() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API$1" --data "$2"; }
api_get() { curl -fsS -H "Authorization: Bearer $TOKEN" "$API$1?companyId=$COMPANY_ID"; }
# The board key authenticates as the instance admin, who owns Smoke Co, and
# owner/admin maps to the `schema` level (data/permissions.ts roleToLevel).
api_get "/access/me" | jq -e '.level == "schema"' >/dev/null
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_contacts\",\"fields\":[{\"name\":\"name\",\"kind\":\"text\",\"required\":true},{\"name\":\"stage\",\"kind\":\"select\",\"options\":{\"choices\":[\"lead\",\"customer\"]}}]}" \
  | jq -e '.name == "smoke_contacts"' >/dev/null
api_get "/tables/smoke_contacts" >"$TMP/table.json"
jq -e '.name == "smoke_contacts"
  and ([.fields[] | select(.name == "name" and .kind == "text" and .required == true)] | length == 1)
  and ([.fields[] | select(.name == "stage" and .kind == "select" and (.options.choices == ["lead", "customer"]))] | length == 1)' \
  "$TMP/table.json" >/dev/null \
  || { echo "GET /tables/smoke_contacts did not describe both fields: $(cat "$TMP/table.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows" "{\"companyId\":\"$COMPANY_ID\",\"rows\":[{\"name\":\"Ada\",\"stage\":\"lead\"},{\"name\":\"Grace\",\"stage\":\"customer\"}]}" \
  >"$TMP/inserted.json"
jq -e 'length == 2' "$TMP/inserted.json" >/dev/null
api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\",\"where\":{\"field\":\"stage\",\"op\":\"eq\",\"value\":\"customer\"}}" \
  | jq -e '.rows | length == 1 and .[0].name == "Grace"' >/dev/null
api_post "/sql" "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"select count(*)::int as n from smoke_contacts\"}" | jq -e '.rows[0].n == 2' >/dev/null
# A non-SELECT never reaches Postgres: the read-only validator raises
# DataError("invalid"), which api-routes.ts maps to HTTP 400.
STATUS="$(curl -sS -o "$TMP/sql-write.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/sql" --data "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"delete from smoke_contacts\"}")"
[[ "$STATUS" == "400" ]] || { echo "expected 400 for a non-SELECT, got $STATUS $(cat "$TMP/sql-write.json")" >&2; exit 1; }
api_get "/tables" | jq -e 'map(.name) | index("smoke_contacts") != null' >/dev/null
# Round out the write path (and the audit trail) with an update and a delete.
ADA_ID="$(jq -r '.[] | select(.name == "Ada") | .id' "$TMP/inserted.json")"
[[ -n "$ADA_ID" && "$ADA_ID" != "null" ]] || { echo "the insert response carried no row id: $(cat "$TMP/inserted.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/update" "{\"companyId\":\"$COMPANY_ID\",\"ids\":[\"$ADA_ID\"],\"patch\":{\"stage\":\"customer\"}}" \
  | jq -e '.affected == 1 and .rows[0].stage == "customer"' >/dev/null
api_post "/tables/smoke_contacts/rows/delete" "{\"companyId\":\"$COMPANY_ID\",\"ids\":[\"$ADA_ID\"]}" | jq -e '.affected == 1' >/dev/null
api_post "/tables/smoke_contacts/rows/count" "{\"companyId\":\"$COMPANY_ID\"}" | jq -e '.count == 1' >/dev/null
echo "    data round-trip ok"

# The 18 data_*, 7 apps_*, 2 decisions_* and 2 connections_* tools (all registered under the "kyoube.apps:"
# prefix, since Phase 3 added the Apps tools to the same plugin) are what an
# agent actually calls, through the core's tool gateway. Executing one from
# here is not possible without a live agent run: POST
# /api/plugins/tools/execute validates runContext against the agents,
# heartbeat_runs and projects tables (validateToolRunContextScope in
# server/src/routes/plugins.ts) and heartbeat runs are only ever created by the
# heartbeat service, never over HTTP. Discovery is board-callable, so assert
# that the host registered the whole tool surface (Step 3 of the task brief
# covers real agent execution manually).
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins/tools" >"$TMP/tools.json"
jq -e '[.[] | select(.name | startswith("kyoube.apps:"))] | length == 29' "$TMP/tools.json" >/dev/null \
  || { echo "expected 29 kyoube.apps tools (18 data_* + 7 apps_* + 2 decisions_* + 2 connections_*), got: $(jq -c '[.[] | select(.name | startswith("kyoube.apps:")) | .name]' "$TMP/tools.json")" >&2; exit 1; }
jq -e 'map(.name) | index("kyoube.apps:data_sql_select") != null and index("kyoube.apps:data_insert") != null and index("kyoube.apps:apps_create") != null and index("kyoube.apps:apps_publish") != null and index("kyoube.apps:decisions_decide") != null and index("kyoube.apps:data_list_review") != null and index("kyoube.apps:connections_list") != null and index("kyoube.apps:connections_call") != null' "$TMP/tools.json" >/dev/null
echo "    29 kyoube.apps:data_*/apps_*/decisions_*/connections_* tools registered with the host tool dispatcher"

echo "==> the activity log summarises the data mutations but never the rows"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  >"$TMP/data-activity.json"
jq -e 'map(select((.action // "") == "Kyoube data: inserted 2 row(s) into smoke_contacts")) | length >= 1' \
  "$TMP/data-activity.json" >/dev/null \
  || { echo "no 'Kyoube data: inserted 2 row(s) into smoke_contacts' entry: $(jq -c 'map(.action)' "$TMP/data-activity.json")" >&2; exit 1; }
# Delimited, not a bare substring: a leaked cell value appears as its own token
# ("name":"Ada"), while "Ada" inside a longer word — upstream writes adapter
# names and agent names into its own activity details — is not a leak. jq 1.8's
# Oniguruma build does not honour \b here, hence the explicit classes.
jq -e 'tostring | test("[^A-Za-z]Ada[^A-Za-z]|[^A-Za-z]Grace[^A-Za-z]") | not' "$TMP/data-activity.json" >/dev/null \
  || { echo "the activity log leaked row contents (Ada/Grace)" >&2; exit 1; }
# Every mutation is also written to kyoube_meta.audit in the `kyoube` database
# (create_table, insert, update, delete = 4 so far). `kyoubeai` is the compose
# superuser (docker-compose.yml POSTGRES_USER); the unix socket is trusted.
AUDIT_ROWS="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ -n "$AUDIT_ROWS" && "$AUDIT_ROWS" -ge 4 ]] \
  || { echo "expected >= 4 rows in kyoube_meta.audit, got '${AUDIT_ROWS:-<none>}'" >&2; exit 1; }
echo "    activity summarised without row contents, kyoube_meta.audit has $AUDIT_ROWS rows"

echo "==> apps: create, publish, runtime, data proxy"
APP_SOURCE='<!doctype html><html><body><h1>smoke-app</h1><script>kyoube.ready().then(c=>console.log(c.app.slug))</script></body></html>'
api_post "/apps" "$(jq -cn --arg c "$COMPANY_ID" --arg s "$APP_SOURCE" '{companyId:$c, manifest:{name:"Smoke App", slug:"smoke-app", tables:[{name:"smoke_contacts", access:"readwrite"}]}, source:$s}')" \
  | jq -e '.app.status == "draft"' >/dev/null
api_post "/apps/smoke-app/publish" "{\"companyId\":\"$COMPANY_ID\"}" | jq -e '.status == "published" and .currentVersion == 1' >/dev/null
api_get "/apps/smoke-app" | jq -e '.app.slug == "smoke-app" and .version.version == 1' >/dev/null
# `apps.*` are UI actions, not board-API routes, so they go through the action
# bridge (like `bridge` above for kyoube.terminal) rather than api_post/api_get.
apps_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/$1" --data "$2"; }
apps_bridge apps.runtime "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\"}}" | jq -e '.data.source | contains("smoke-app")' >/dev/null
# smoke_contacts holds exactly one row here (Grace): the data block above
# inserted Ada and Grace, then deleted Ada to exercise the delete path, and
# nothing has inserted into it since.
apps_bridge apps.data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\",\"method\":\"query\",\"params\":{\"table\":\"smoke_contacts\"}}}" \
  | jq -e '.data.rows | length == 1 and .[0].name == "Grace"' >/dev/null
# An undeclared table is rejected inside the worker (DataError("forbidden", ...)).
# The host's action bridge cannot distinguish that from any other worker throw,
# so it passes it through as a generic HTTP 502 `{ code: "WORKER_ERROR", message }`
# whose message carries the worker's own "<code>: <text>" — assert both the
# transport status and that the message really is the forbidden-table
# rejection, not some other failure wearing the same status code.
STATUS="$(curl -sS -o "$TMP/apps-undeclared.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/apps.data" --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\",\"method\":\"query\",\"params\":{\"table\":\"undeclared\"}}}")"
[[ "$STATUS" == "502" ]] || { echo "expected a bridge error for an undeclared table, got $STATUS: $(cat "$TMP/apps-undeclared.json")" >&2; exit 1; }
jq -e '.code == "WORKER_ERROR" and (.message | contains("forbidden"))' "$TMP/apps-undeclared.json" >/dev/null \
  || { echo "expected a WORKER_ERROR with a 'forbidden' message, got: $(cat "$TMP/apps-undeclared.json")" >&2; exit 1; }
echo "    apps round-trip ok"

echo "==> decisions: off by default, provider config with a secret, budget kept on a failed call"
api_get "/decisions/status" | jq -e '.available == false and .enabled == false and .configured == false' >/dev/null
STATUS="$(curl -sS -o "$TMP/decide-off.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/decisions/decide" --data "{\"companyId\":\"$COMPANY_ID\",\"state\":\"hello\",\"questions\":{\"q\":{\"type\":\"check\",\"statement\":\"It says hello.\"}}}")"
if [[ "$STATUS" != "403" ]] || ! jq -e '.code == "disabled"' "$TMP/decide-off.json" >/dev/null; then
  echo "expected 403 disabled before setup, got $STATUS $(cat "$TMP/decide-off.json")" >&2; exit 1
fi
# A real provider only when the operator gives a key; otherwise an unreachable https host proves
# config, secret binding, the switch and the budget release without any outside call.
DECISIONS_PROVIDER="custom"; DECISIONS_MODEL="jev-1.13.0"; DECISIONS_BASE="https://decisions.invalid"
DECISIONS_KEY="${KYOUBE_SMOKE_DECISIONS_KEY:-smoke-not-a-real-key}"
if [[ -n "${KYOUBE_SMOKE_DECISIONS_KEY:-}" ]]; then DECISIONS_PROVIDER="openrouter"; DECISIONS_MODEL="${KYOUBE_SMOKE_DECISIONS_MODEL:-typesafe/jev-1.13}"; fi
SECRET_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/secrets" \
  --data "$(jq -cn --arg v "$DECISIONS_KEY" '{name:"smoke-decisions-key", value:$v}')" | jq -r '.id')"
[[ -n "$SECRET_ID" && "$SECRET_ID" != "null" ]] || { echo "could not create the decisions key secret" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.apps/config" \
  --data "$(jq -cn --arg c "$COMPANY_ID" --arg p "$DECISIONS_PROVIDER" --arg m "$DECISIONS_MODEL" --arg b "$DECISIONS_BASE" --arg s "$SECRET_ID" \
    '{companyId:$c, configJson:{decisionsProvider:$p, decisionsModel:$m, decisionsBaseUrl:$b, decisionsApiKey:{type:"secret_ref", secretId:$s, version:"latest"}}}')" >/dev/null
apps_bridge decisions.set_settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"agents\":true}}" | jq -e '.data.agents == true' >/dev/null
apps_bridge decisions.settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{}}" >"$TMP/decision-settings.json"
jq -e --arg p "$DECISIONS_PROVIDER" '.data.provider.configured == true and .data.provider.provider == $p and .data.provider.keyResolves == true' "$TMP/decision-settings.json" >/dev/null \
  || { echo "decision settings did not resolve the key: $(cat "$TMP/decision-settings.json")" >&2; exit 1; }
STATUS="$(curl -sS -o "$TMP/decide.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/decisions/decide" --data "{\"companyId\":\"$COMPANY_ID\",\"state\":\"hello\",\"questions\":{\"q\":{\"type\":\"check\",\"statement\":\"It says hello.\"}}}")"
if [[ -n "${KYOUBE_SMOKE_DECISIONS_KEY:-}" ]]; then
  if [[ "$STATUS" != "200" ]] || ! jq -e '.answers.q.type == "check" and (.answers.q.value | type) == "boolean"' "$TMP/decide.json" >/dev/null; then
    echo "expected a real decision, got $STATUS $(cat "$TMP/decide.json")" >&2; exit 1
  fi
  api_get "/decisions/status" | jq -e '.budget.used >= 1' >/dev/null
else
  if [[ "$STATUS" != "503" ]] || ! jq -e '.code == "provider_unavailable"' "$TMP/decide.json" >/dev/null; then
    echo "expected 503 provider_unavailable from an unreachable provider, got $STATUS $(cat "$TMP/decide.json")" >&2; exit 1
  fi
  api_get "/decisions/status" | jq -e '.available == true and .budget.used == 0' >/dev/null \
    || { echo "a failed provider call must not use budget" >&2; exit 1; }
fi
# The key actually in use, the operator's real one included; an empty key would match everything.
[[ -n "$DECISIONS_KEY" ]] || { echo "the decisions key is empty" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  | jq -e --arg key "$DECISIONS_KEY" 'tostring | contains($key) | not' >/dev/null || { echo "the activity log leaked the decisions key" >&2; exit 1; }
echo "    decisions: config, secret, switch and budget release ok"

echo "==> decisions in apps: declared sets, a person confirms them at publish, the runtime reports them"
TRIAGE_SOURCE='<!doctype html><html><body><script>kyoube.ready().then(c=>console.log(c.decisions.sets))</script></body></html>'
TRIAGE_MANIFEST='{"name":"Smoke Triage","slug":"smoke-triage","tables":[{"name":"smoke_contacts"}],"decisions":{"triage":{"table":"smoke_contacts","fields":["name","stage"],"questions":{"customer":{"type":"check","statement":"This contact is a customer."}}}}}'
api_post "/apps" "$(jq -cn --arg c "$COMPANY_ID" --arg s "$TRIAGE_SOURCE" --argjson m "$TRIAGE_MANIFEST" '{companyId:$c, manifest:$m, source:$s}')" \
  | jq -e '.app.status == "draft"' >/dev/null
STATUS="$(curl -sS -o "$TMP/publish-unconfirmed.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/apps/smoke-triage/publish" --data "{\"companyId\":\"$COMPANY_ID\"}")"
if ! { [[ "$STATUS" == "400" ]] && jq -e '.code == "invalid" and (.error | contains("decisionsConfirmed"))' "$TMP/publish-unconfirmed.json" >/dev/null; }; then echo "publishing new decision sets without the confirmation must fail, got $STATUS $(cat "$TMP/publish-unconfirmed.json")" >&2; exit 1; fi
api_post "/apps/smoke-triage/publish" "{\"companyId\":\"$COMPANY_ID\",\"decisionsConfirmed\":true}" | jq -e '.status == "published"' >/dev/null
apps_bridge apps.runtime "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-triage\"}}" \
  | jq -e '.data.context.decisions == {"available": false, "sets": ["triage"]}' >/dev/null \
  || { echo "the runtime context did not report the decision set as unavailable" >&2; exit 1; }
# smoke_contacts still holds exactly one row here (Grace): the AI-columns block below uses smoke_tickets.
GRACE_ID="$(api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\"}" | jq -r '.rows[0].id')"
DECIDE_PARAMS="{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-triage\",\"set\":\"triage\",\"input\":{\"rowId\":\"$GRACE_ID\"}}}"
# Worker errors reach the action bridge as HTTP 502 WORKER_ERROR carrying "<code>: <text>" (see the apps block above).
STATUS="$(curl -sS -o "$TMP/app-decide-off.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/apps.decide" --data "$DECIDE_PARAMS")"
if ! { [[ "$STATUS" == "502" ]] && jq -e '.message | contains("disabled")' "$TMP/app-decide-off.json" >/dev/null; }; then echo "expected disabled while apps are switched off, got $STATUS $(cat "$TMP/app-decide-off.json")" >&2; exit 1; fi
apps_bridge decisions.set_settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"apps\":true}}" | jq -e '.data.apps == true' >/dev/null
apps_bridge apps.runtime "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-triage\"}}" | jq -e '.data.context.decisions.available == true' >/dev/null
if [[ -n "${KYOUBE_SMOKE_DECISIONS_KEY:-}" ]]; then
  apps_bridge apps.decide "$DECIDE_PARAMS" | jq -e '.data.answers.customer.type == "check" and (.data.answers.customer.value | type) == "boolean"' >/dev/null \
    || { echo "expected a real app decision" >&2; exit 1; }
else
  STATUS="$(curl -sS -o "$TMP/app-decide.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/apps.decide" --data "$DECIDE_PARAMS")"
  if ! { [[ "$STATUS" == "502" ]] && jq -e '.message | contains("provider_unavailable")' "$TMP/app-decide.json" >/dev/null; }; then echo "expected provider_unavailable from the unreachable provider, got $STATUS $(cat "$TMP/app-decide.json")" >&2; exit 1; fi
fi
echo "    decisions in apps: publish confirmation, runtime context and app decide ok"

echo "==> AI columns: off until switched on, sources checked, fill runs without spending budget on failures"
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_tickets\",\"fields\":[{\"name\":\"subject\",\"kind\":\"text\"}]}" >/dev/null
api_post "/tables/smoke_tickets/rows" "{\"companyId\":\"$COMPANY_ID\",\"rows\":[{\"subject\":\"Please refund my order\"},{\"subject\":\"Thanks for the quick fix\"}]}" >/dev/null
AI_FIELD='{"name":"refund","kind":"boolean","options":{"decision":{"question":{"type":"check","statement":"The ticket asks for a refund."},"sourceFields":["subject"]}}}'
STATUS="$(curl -sS -o "$TMP/ai-off.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/tables/smoke_tickets/fields" --data "{\"companyId\":\"$COMPANY_ID\",\"field\":$AI_FIELD}")"
if [[ "$STATUS" != "403" ]] || ! jq -e '.code == "disabled"' "$TMP/ai-off.json" >/dev/null; then
  echo "expected 403 disabled for an AI column before the switch, got $STATUS $(cat "$TMP/ai-off.json")" >&2; exit 1
fi
apps_bridge decisions.set_settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"columns\":true}}" | jq -e '.data.columns == true' >/dev/null
api_post "/tables/smoke_tickets/fields" "{\"companyId\":\"$COMPANY_ID\",\"field\":$AI_FIELD}" \
  | jq -e '[.fields[] | select(.name == "refund" and .kind == "boolean" and .options.decision.sourceFields == ["subject"])] | length == 1' >/dev/null
STATUS="$(curl -sS -o "$TMP/ai-source.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/tables/smoke_tickets/fields/subject/remove" --data "{\"companyId\":\"$COMPANY_ID\"}")"
if [[ "$STATUS" != "400" ]] || ! jq -e '.error | contains("feeds AI column \"refund\"")' "$TMP/ai-source.json" >/dev/null; then
  echo "removing an AI column's source must be refused, got $STATUS $(cat "$TMP/ai-source.json")" >&2; exit 1
fi
# The column fills in the background straight after it is created.
AI_DONE=""
for _ in $(seq 1 30); do
  api_get "/tables/smoke_tickets" >"$TMP/ai-table.json"
  if [[ -n "${KYOUBE_SMOKE_DECISIONS_KEY:-}" ]]; then
    jq -e '(.aiColumns.refund.auto + .aiColumns.refund.review) == 2' "$TMP/ai-table.json" >/dev/null && { AI_DONE=1; break; }
  else
    jq -e '.aiColumns.refund.error >= 1' "$TMP/ai-table.json" >/dev/null && { AI_DONE=1; break; }
  fi
  sleep 1
done
[[ -n "$AI_DONE" ]] || { echo "the AI column did not fill: $(cat "$TMP/ai-table.json")" >&2; exit 1; }
# The review lane holds exactly the cells counted as review; each entry has the documented shape.
api_get "/tables/smoke_tickets/review" >"$TMP/ai-review.json"
jq -e --slurpfile table "$TMP/ai-table.json" '
  (.rows | length) == $table[0].aiColumns.refund.review
  and (.rows | all(.field == "refund" and (.rowId | type) == "string" and has("suggestion") and has("confidence") and has("decisionId") and has("updatedAt")))' "$TMP/ai-review.json" >/dev/null \
  || { echo "the review lane does not match the cell counts: $(cat "$TMP/ai-review.json") vs $(jq -c .aiColumns "$TMP/ai-table.json")" >&2; exit 1; }
if [[ -z "${KYOUBE_SMOKE_DECISIONS_KEY:-}" ]]; then
  jq -e '.rows == []' "$TMP/ai-review.json" >/dev/null || { echo "an unreachable provider must leave nothing to review" >&2; exit 1; }
  api_post "/tables/smoke_tickets/rows/query" "{\"companyId\":\"$COMPANY_ID\"}" | jq -e '[.rows[] | select(.refund != null)] | length == 0' >/dev/null \
    || { echo "an unreachable provider must leave AI cells empty" >&2; exit 1; }
  api_get "/decisions/status" | jq -e '.budget.used == 0' >/dev/null || { echo "failed AI fills must not use budget" >&2; exit 1; }
fi
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  | jq -e 'tostring | test("Please refund my order") | not' >/dev/null || { echo "the activity log leaked an AI column's source value" >&2; exit 1; }
echo "    AI columns: switch, source check, background fill and budget ok"

echo "==> files: a project's folder is browsable and editable from the action bridge"
# kyoube.files adds a Files tab to the project page. It has no board-API routes
# of its own — everything is a UI action, host-authenticated like `apps.*`
# above — so this drives the same bridge the tab does. The project has no
# configured workspace, so the folder it exposes is the managed one the core
# would start an agent in: <instance>/projects/<companyId>/<projectId>/_default.
FILES_PROJECT_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies/$COMPANY_ID/projects" --data '{"name":"Smoke Files"}' | jq -r '.id')"
[[ -n "$FILES_PROJECT_ID" && "$FILES_PROJECT_ID" != "null" ]] || { echo "could not create the files smoke project" >&2; exit 1; }
files_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.files/actions/$1" --data "$2"; }
files_bridge files.workspaces "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\"}}" >"$TMP/files-ws.json"
jq -e '.data.canRead == true and .data.canWrite == true and (.data.workspaces | length == 1) and .data.workspaces[0].source == "managed"' "$TMP/files-ws.json" >/dev/null \
  || { echo "files.workspaces did not report a writable managed folder: $(cat "$TMP/files-ws.json")" >&2; exit 1; }
FILES_ROOT="$(jq -r '.data.workspaces[0].path' "$TMP/files-ws.json")"
[[ "$FILES_ROOT" == "/kyoubeai/instances/default/projects/$COMPANY_ID/$FILES_PROJECT_ID/_default" ]] \
  || { echo "unexpected managed project folder '$FILES_ROOT'" >&2; exit 1; }
# The folder does not exist until an agent runs (or someone writes into it).
files_bridge files.list "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"\"}}" \
  | jq -e '.data.exists == false and .data.entries == []' >/dev/null
files_bridge files.create "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"dir\":\"\",\"name\":\"docs\",\"kind\":\"dir\"}}" | jq -e '.data.kind == "dir"' >/dev/null
files_bridge files.create "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"dir\":\"docs\",\"name\":\"plan.md\",\"kind\":\"file\"}}" | jq -e '.data.kind == "file"' >/dev/null
files_bridge files.write "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs/plan.md\",\"content\":\"# smoke plan\\n\",\"mustExist\":true}}" | jq -e '.data.size == 13' >/dev/null
# What the bridge wrote is what an agent in that folder would read.
compose exec -T app sh -c "cat '$FILES_ROOT/docs/plan.md'" | grep -qx '# smoke plan' \
  || { echo "the file written through kyoube.files is not on disk at $FILES_ROOT/docs/plan.md" >&2; exit 1; }
# And what an agent writes is what the bridge reads back.
compose exec -T app sh -c "printf 'from-the-shell' > '$FILES_ROOT/docs/agent.txt'"
files_bridge files.read "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs/agent.txt\"}}" \
  | jq -e '.data.encoding == "utf8" and .data.content == "from-the-shell"' >/dev/null
files_bridge files.list "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs\"}}" \
  | jq -e '[.data.entries[].name] == ["agent.txt", "plan.md"]' >/dev/null
# A path that tries to leave the folder is refused inside the worker (invalid),
# which the bridge surfaces as a 502 WORKER_ERROR like the apps case above.
STATUS="$(curl -sS -o "$TMP/files-escape.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.files/actions/files.read" --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"../../../../kyoube/board-key.json\"}}")"
[[ "$STATUS" == "502" ]] || { echo "expected a bridge error for a path outside the folder, got $STATUS: $(cat "$TMP/files-escape.json")" >&2; exit 1; }
jq -e '.code == "WORKER_ERROR" and (.message | contains("invalid"))' "$TMP/files-escape.json" >/dev/null \
  || { echo "expected a WORKER_ERROR with an 'invalid' message, got: $(cat "$TMP/files-escape.json")" >&2; exit 1; }
files_bridge files.delete "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs\",\"recursive\":true}}" | jq -e '.data.ok == true' >/dev/null
# The activity log names each change and its path (the message lands in
# `.action`, as for the terminal and data entries above), never file content.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" >"$TMP/files-activity.json"
for want in 'Kyoube files: created folder docs in' 'Kyoube files: created file docs/plan.md in' 'Kyoube files: saved docs/plan.md in' 'Kyoube files: deleted folder docs in'; do
  jq -e --arg w "$want" 'map(select((.action // "") | startswith($w))) | length >= 1' "$TMP/files-activity.json" >/dev/null \
    || { echo "no '$want' entry in the activity log: $(jq -c 'map(.action)' "$TMP/files-activity.json")" >&2; exit 1; }
done
jq -e 'tostring | contains("smoke plan") | not' "$TMP/files-activity.json" >/dev/null \
  || { echo "the activity log leaked file content ('smoke plan')" >&2; exit 1; }
echo "    files round-trip ok at $FILES_ROOT"

echo "==> agent rules: the rules block, protected managers, people-only cards and escalation"
# The entrypoint starts `kyoube agent-rules --watch`; it must be running.
# shellcheck disable=SC2016  # expanded by the shell inside the container
RULES_WATCH="$(compose exec -T app sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "agent-rules --w[a]tch" && echo running; done' | tr -d '\r\n ' || true)"
[[ "$RULES_WATCH" == running* ]] || { echo "kyoube agent-rules --watch is not running" >&2; exit 1; }

OWNER_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/members" \
  | jq -r '[(.members // .)[] | select(.principalType == "user" and .membershipRole == "owner")][0].principalId')"
[[ -n "$OWNER_ID" && "$OWNER_ID" != "null" ]] || { echo "could not find the company owner" >&2; exit 1; }

make_agent() { # name adapterType reportsTo(may be empty) adapterConfigJson -> agent id
  local body
  body="$(jq -nc --arg n "$1" --arg t "$2" --arg r "$3" --argjson c "$4" \
    '{name: $n, adapterType: $t, adapterConfig: $c} + (if $r == "" then {} else {reportsTo: $r} end)')"
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/companies/$COMPANY_ID/agents" --data "$body" | jq -r '.id'
}
agent_key() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/agents/$1/keys" --data '{"name":"smoke"}' | jq -r '.token'; }
as_agent() { # key method path [body] [run-id] -> HTTP_STATUS, body in $TMP/resp.json
  local args=(-sS -o "$TMP/resp.json" -w '%{http_code}' -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -X "$2" "$BASE_URL$3")
  if [[ -n "${4:-}" ]]; then args+=(--data "$4"); fi
  if [[ -n "${5:-}" ]]; then args+=(-H "X-Paperclip-Run-Id: $5"); fi
  HTTP_STATUS="$(curl "${args[@]}")"
}

# M manages R; P has neither manager nor reports. R and P run the core's
# `process` adapter, so no model is needed: R's script stands in for an agent.
M_ID="$(make_agent smoke-manager claude_local "" '{"cwd":"/kyoubeai/workspaces/smoke"}')"
P_ID="$(make_agent smoke-peer process "" '{"cwd":"/kyoubeai/workspaces/smoke","command":"node","args":["-e",""]}')"
R_ID="$(make_agent smoke-report process "$M_ID" '{"cwd":"/kyoubeai/workspaces/smoke","command":"node","args":["/kyoubeai/workspaces/smoke/escalate.mjs"]}')"
for ID in "$M_ID" "$P_ID" "$R_ID"; do [[ -n "$ID" && "$ID" != "null" ]] || { echo "agent create failed" >&2; exit 1; }; done

compose exec -T app kyoube agent-rules --once | tee "$TMP/rules-once.log"
grep -q 'self-test pass' "$TMP/rules-once.log" || { echo "the guard self-test did not pass on this core:" >&2; cat "$TMP/rules-once.log" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$M_ID/instructions-bundle/file?path=AGENTS.md" | jq -r '.content' >"$TMP/agents-md.txt"
head -1 "$TMP/agents-md.txt" | grep -q '^<!-- kyoube:working-rules v2' || { echo "the manager's AGENTS.md does not start with the rules block:" >&2; head -5 "$TMP/agents-md.txt" >&2; exit 1; }
grep -q 'Your ask level: \*\*your line\*\*' "$TMP/agents-md.txt" || { echo "the manager's rules block has no ask-level line for its line" >&2; exit 1; }
[[ "$(grep -c '^## Handoffs' "$TMP/agents-md.txt")" == 1 ]] || { echo "expected exactly one Handoffs section" >&2; exit 1; }
if grep -q 'If you need QA to review it, ask them' "$TMP/agents-md.txt"; then echo "the core's handoff sentences are still there" >&2; exit 1; fi
echo "    rules block in place, self-test passed"

M_KEY="$(agent_key "$M_ID")"; R_KEY="$(agent_key "$R_ID")"
as_agent "$R_KEY" POST "/api/companies/$COMPANY_ID/issues" "{\"title\":\"smoke: up to the manager\",\"assigneeAgentId\":\"$M_ID\"}"
if [[ "$HTTP_STATUS" != 403 ]] || ! grep -qi 'protected' "$TMP/resp.json"; then echo "a report could create a task for its manager: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
as_agent "$R_KEY" POST "/api/companies/$COMPANY_ID/issues" '{"title":"smoke: will try to move up"}'
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "a report could not create its own task: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
UP_ID="$(jq -r '.id' "$TMP/resp.json")"
as_agent "$R_KEY" POST "/api/companies/$COMPANY_ID/issues" "{\"title\":\"smoke: to a peer\",\"assigneeAgentId\":\"$P_ID\"}"
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "a handoff to an agent without reports was refused: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }

echo "==> push: subscribe a test device, send a test, and opt in to failures"
# kyoube.notify accepts this one non-push-service endpoint only while the file below
# names it (kyoube doctor fails a public instance that has it). The receiver runs
# inside the container on 127.0.0.1.
PUSH_ENDPOINT="http://127.0.0.1:39123/push"
compose exec -T -u node app sh -c 'cat > /tmp/push-live-check.mjs' <"$ROOT/scripts/push-live-check.mjs"
compose exec -T -u node app sh -c ': > /tmp/kyoube-push.jsonl'
compose exec -d -u node app node /tmp/push-live-check.mjs receiver 39123 /tmp/kyoube-push.jsonl
compose exec -T -u node app sh -c "printf '%s\n' '$PUSH_ENDPOINT' > /kyoubeai/kyoube/push-test-endpoint"
node "$ROOT/scripts/push-live-check.mjs" keys >"$TMP/push-keys.json"
notify_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.notify/actions/$1" --data "$2"; }
PUSH_DEVICE_ID="$(notify_bridge notify.subscribe "$(jq -nc --arg c "$COMPANY_ID" --arg e "$PUSH_ENDPOINT" --slurpfile k "$TMP/push-keys.json" \
  '{companyId: $c, params: {label: "smoke", subscription: {endpoint: $e, keys: {p256dh: $k[0].p256dh, auth: $k[0].auth}}}}')" | jq -r '.data.id')"
[[ "$PUSH_DEVICE_ID" =~ ^[0-9a-f]{16}$ ]] || { echo "notify.subscribe did not return a device id" >&2; exit 1; }
notify_bridge notify.prefs "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"failures\":true}}" >/dev/null
notify_bridge notify.test "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"deviceId\":\"$PUSH_DEVICE_ID\"}}" | jq -e '.data.result == "delivered"' >/dev/null \
  || { echo "notify.test was not delivered to the receiver" >&2; exit 1; }
push_payloads() { # decrypts every push the receiver has had so far, one JSON object per line
  compose exec -T -u node app cat /tmp/kyoube-push.jsonl >"$TMP/push-requests.jsonl"
  node "$ROOT/scripts/push-live-check.mjs" decrypt "$TMP/push-requests.jsonl" "$TMP/push-keys.json" "$PUSH_ENDPOINT"
}
wait_push() { # jq-filter description — poll up to 90 s for a decrypted push matching the filter
  for _ in $(seq 1 45); do
    if push_payloads 2>"$TMP/push-errors.txt" | jq -e -s "map(select($1)) | length > 0" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "no push for $2 within 90 s; received:" >&2; push_payloads >&2 || true; cat "$TMP/push-errors.txt" >&2; return 1
}
wait_push '.title == "KyoubeAI test" and .url == "/"' "the test notification"
echo "    test push delivered, decrypted and VAPID-signed"

# Escalation: R's script creates a confirmation card and the escalation
# decision, then hands the task to the person, as rule 3 says.
TASK_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/issues" \
  --data '{"title":"smoke: needs the manager","status":"todo"}' | jq -r '.id')"
compose exec -T -u node app sh -c 'mkdir -p /kyoubeai/workspaces/smoke && cat > /kyoubeai/workspaces/smoke/escalate.mjs' <<'JS'
const base = String(process.env.PAPERCLIP_API_URL || "").replace(/\/+$/, "").replace(/\/api$/, "");
const headers = { authorization: "Bearer " + process.env.PAPERCLIP_API_KEY, "content-type": "application/json", "x-paperclip-run-id": String(process.env.PAPERCLIP_RUN_ID || "") };
const me = process.env.PAPERCLIP_AGENT_ID;
const company = process.env.PAPERCLIP_COMPANY_ID;
const task = "TASK_ID_VALUE";
async function call(method, path, body) {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  console.log(method + " " + path + " -> " + response.status + " " + text.slice(0, 300));
  if (!response.ok) throw new Error(method + " " + path + " failed with " + response.status);
  return text ? JSON.parse(text) : null;
}
const current = await call("GET", "/api/issues/" + task);
if (current.assigneeAgentId !== me) { console.log("not my task any more; nothing to do"); process.exit(0); }
await call("POST", "/api/issues/" + task + "/checkout", { agentId: me, expectedStatuses: ["todo", "backlog", "in_progress"] });
await call("POST", "/api/issues/" + task + "/interactions", { kind: "request_confirmation", idempotencyKey: "smoke:" + task + ":confirm", title: "Smoke confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Smoke: is this fine?" } });
await call("POST", "/api/companies/" + company + "/decisions", {
  title: "Escalate the smoke task?",
  body: "smoke-report cannot do this task.",
  idempotencyKey: "smoke:" + task + ":escalate",
  continuationPolicy: "none",
  options: [
    { id: "escalate", label: "Escalate to smoke-manager", effects: [{ type: "assign_issue", targetIssueId: task, staleness: "lenient", assigneeAgentId: "MANAGER_ID_VALUE" }] },
    { id: "keep", label: "Keep it with smoke-report", effects: [{ type: "assign_issue", targetIssueId: task, staleness: "lenient", assigneeAgentId: me }] },
  ],
});
await call("PATCH", "/api/issues/" + task, { assigneeAgentId: null, assigneeUserId: "OWNER_ID_VALUE", status: "in_review", comment: "This needs smoke-manager; I posted an escalation decision." });
JS
compose exec -T -u node app sed -i "s/TASK_ID_VALUE/$TASK_ID/; s/MANAGER_ID_VALUE/$M_ID/; s/OWNER_ID_VALUE/$OWNER_ID/" /kyoubeai/workspaces/smoke/escalate.mjs
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X PATCH "$BASE_URL/api/issues/$TASK_ID" --data "{\"assigneeAgentId\":\"$R_ID\"}" >/dev/null
for i in $(seq 1 90); do
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/issues/$TASK_ID" >"$TMP/task.json"
  if jq -e --arg o "$OWNER_ID" '.assigneeUserId == $o and .status == "in_review"' "$TMP/task.json" >/dev/null; then break; fi
  sleep 2
  [[ $i -eq 90 ]] && { echo "smoke-report never handed the task back to the person:" >&2; jq -c '{status, assigneeAgentId, assigneeUserId}' "$TMP/task.json" >&2; compose logs --no-color --tail 80 app >&2; exit 1; }
done

# smoke-report's script asked a question on a task the admin created (the
# confirmation card above). The core sends no event for that; kyoube.notify finds
# it when smoke-report's run ends and tells the task's creator.
wait_push '.title == "smoke-report is asking: Smoke confirmation" and (.url | test("/issues/"))' "smoke-report's question"
echo "    the agent's question reached the task's creator as a push"

# An agent's update to another task, and its answer to a card, count only
# inside one of its own runs: without X-Paperclip-Run-Id the core refuses them
# before it looks at the assignee or the card's resolver policy
# (cross_issue_influence_run_context_required, interaction_run_attribution_required).
# So R reassigns with the run it just had on its task, and M answers the card
# with a run that a board wakeup starts (it fails at once: no model signed in).
R_RUN_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$R_ID" \
  | jq -r --arg t "$TASK_ID" '[.[] | select(.contextSnapshot.issueId == $t)][0].id')"
[[ -n "$R_RUN_ID" && "$R_RUN_ID" != "null" ]] || { echo "smoke-report has no run on its task" >&2; exit 1; }
as_agent "$R_KEY" PATCH "/api/issues/$UP_ID" "{\"assigneeAgentId\":\"$M_ID\"}" "$R_RUN_ID"
if [[ "$HTTP_STATUS" != 403 ]] || ! grep -qi 'protected' "$TMP/resp.json"; then echo "a report could hand a task to its manager: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
echo "    nothing moves up to a manager; a handoff to an agent without reports still works"

CARD_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/issues/$TASK_ID/interactions" | jq -r '[(.interactions? // .)[] | select(.kind == "request_confirmation")][0].id')"
M_RUN_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/agents/$M_ID/wakeup" --data '{"reason":"smoke: a run to answer the card from"}' | jq -r '.id')"
[[ -n "$M_RUN_ID" && "$M_RUN_ID" != "null" ]] || { echo "a board wakeup started no run for smoke-manager" >&2; exit 1; }
# That run fails at once (no model signed in), and the admin opted in to failures above.
wait_push '.title == "smoke-manager'"'"'s run failed"' "smoke-manager's failed run"
echo "    a failed run reached an opted-in owner as a push"
as_agent "$M_KEY" POST "/api/issues/$TASK_ID/interactions/$CARD_ID/accept" '{}' "$M_RUN_ID"
if [[ "$HTTP_STATUS" != 403 ]] || ! jq -e '.code == "interaction_human_only"' "$TMP/resp.json" >/dev/null; then echo "an agent could answer a people-only card: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
DECISION_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/decisions" | jq -r '[(.decisions? // .items? // .)[] | select(.title == "Escalate the smoke task?")][0].id')"
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/decisions/$DECISION_ID/decide" --data '{"optionId":"escalate"}' >/dev/null
for i in $(seq 1 30); do
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/issues/$TASK_ID" >"$TMP/task.json"
  if jq -e --arg m "$M_ID" '.assigneeAgentId == $m' "$TMP/task.json" >/dev/null; then break; fi
  sleep 1
  [[ $i -eq 30 ]] && { echo "the escalation decision did not move the task to the manager:" >&2; jq -c '{status, assigneeAgentId, assigneeUserId}' "$TMP/task.json" >&2; exit 1; }
done
as_agent "$M_KEY" POST "/api/companies/$COMPANY_ID/issues" "{\"title\":\"smoke: down to the report\",\"assigneeAgentId\":\"$R_ID\"}"
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "a manager could not assign to its own report: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
echo "    only a person answers the card; the person's decision moves the task up; the manager still assigns down"

echo "==> agent questions: a report asks its manager; refusals outside its line, at no agents, and past the limits"
# A asks questions from inside its own run, as an agent would: the core checks
# a card against the run that creates it. A runs the core's `process` adapter
# with ask.mjs, which reads its plan from ask-plan.json, so no model is needed.
# A reports to M, so M is in A's line and P (no manager, no reports) is not.
A_ID="$(make_agent smoke-asker process "$M_ID" '{"cwd":"/kyoubeai/workspaces/smoke","command":"node","args":["/kyoubeai/workspaces/smoke/ask.mjs"]}')"
[[ -n "$A_ID" && "$A_ID" != "null" ]] || { echo "agent create failed (smoke-asker)" >&2; exit 1; }
compose exec -T -u node app sh -c 'mkdir -p /kyoubeai/workspaces/smoke && cat > /kyoubeai/workspaces/smoke/ask.mjs' <<'JS'
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
const base = String(process.env.PAPERCLIP_API_URL || "").replace(/\/+$/, "").replace(/\/api$/, "");
const headers = { authorization: "Bearer " + process.env.PAPERCLIP_API_KEY, "content-type": "application/json", "x-paperclip-run-id": String(process.env.PAPERCLIP_RUN_ID || "") };
const me = process.env.PAPERCLIP_AGENT_ID;
const plan = JSON.parse(await readFile("/kyoubeai/workspaces/smoke/ask-plan.json", "utf8"));
// The core can wake this agent again (a deferred answer, a task left in progress), and a late run
// would ask from the wrong run and overwrite the results; only the first run that does the plan counts.
const resultsPath = "/kyoubeai/workspaces/smoke/ask-results-" + plan.mode + ".json";
if (existsSync(resultsPath)) { console.log("this plan is done; nothing to do"); process.exit(0); }
async function attempt(method, path, body) {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  console.log(method + " " + path + " -> " + response.status + " " + text.slice(0, 300));
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, body: parsed };
}
const brief = (r) => ({ status: r.status, code: r.body?.code ?? null, id: r.body?.id ?? null, effectiveResolverPolicy: r.body?.effectiveResolverPolicy ?? null });
const current = await attempt("GET", "/api/issues/" + plan.task);
if (current.body?.assigneeAgentId !== me) { console.log("not the planned task; nothing to do"); process.exit(0); }
const checkout = await attempt("POST", "/api/issues/" + plan.task + "/checkout", { agentId: me, expectedStatuses: ["todo", "backlog", "in_progress"] });
if (checkout.status < 200 || checkout.status >= 300) { console.log("another run has the task; nothing to do"); process.exit(0); }
const ask = async (key, addresseeAgentId) => brief(await attempt("POST", "/api/issues/" + plan.task + "/interactions", {
  kind: "ask_user_questions",
  idempotencyKey: "smoke:" + plan.task + ":" + key,
  title: "Smoke question " + key,
  continuationPolicy: "none",
  ...(addresseeAgentId ? { addresseeAgentId } : {}),
  payload: { version: 1, questions: [{ id: "q", prompt: "Smoke: which one?", selectionMode: "single", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] },
}));
const results = {};
if (plan.mode === "single") {
  results.ask = await ask("single", plan.manager);
} else {
  results.q1 = await ask("q1", plan.manager);
  results.again = await ask("again", plan.manager);
  results.outside = await ask("outside", plan.outsider);
  // The smoke answers q1 as the manager; wait for that before going on.
  for (let i = 0; i < 90 && results.q1.id; i += 1) {
    const list = await attempt("GET", "/api/issues/" + plan.task + "/interactions");
    const cards = Array.isArray(list.body) ? list.body : (list.body?.interactions ?? []);
    const q1 = cards.find((card) => card.id === results.q1.id);
    if (q1 && q1.status !== "pending") { results.q1After = q1.status; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // A question to the person supersedes the agent's pending question (the core's own rule),
  // so each one closes the open question to M and lets the next count toward the limit.
  results.q2 = await ask("q2", plan.manager);
  results.person1 = await ask("person1", null);
  results.q3 = await ask("q3", plan.manager);
  results.person2 = await ask("person2", null);
  results.q4 = await ask("q4", plan.manager);
}
await writeFile(resultsPath, JSON.stringify(results), { flag: "wx" }).catch(() => console.log("another run wrote the results first"));
// A run that leaves its task assigned and in progress makes the core wake the agent again to finish it,
// so hand the task back to the person, as rule 4 says (the smoke also takes it back as the board).
const handBack = await attempt("PATCH", "/api/issues/" + plan.task, { assigneeAgentId: null, assigneeUserId: plan.owner, status: "in_review", comment: "The smoke's questions are done; handing the task back to the person." });
if (handBack.status < 200 || handBack.status >= 300) await attempt("PATCH", "/api/issues/" + plan.task, { status: "in_review" });
JS

wait_file() { # path seconds -> the file's content on stdout
  for _ in $(seq 1 "$2"); do
    if compose exec -T app test -s "$1"; then compose exec -T app cat "$1"; return 0; fi
    sleep 1
  done
  echo "no $1 within $2 s" >&2; compose logs --no-color --tail 80 app >&2; return 1
}
take_back() { # task-id — as the board, so no later wake of smoke-asker finds the task still its own
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X PATCH "$BASE_URL/api/issues/$1" \
    --data "{\"assigneeAgentId\":null,\"assigneeUserId\":\"$OWNER_ID\",\"status\":\"in_review\"}" >/dev/null
}
wait_idle() { # agent-id — until it has no run queued, retrying or running, five checks in a row
  local quiet=0
  for _ in $(seq 1 120); do
    if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$1" \
      | jq -e '[.[] | select(.status == "queued" or .status == "scheduled_retry" or .status == "running")] | length == 0' >/dev/null; then
      quiet=$((quiet + 1)); [[ $quiet -ge 5 ]] && return 0
    else
      quiet=0
    fi
    sleep 1
  done
  echo "agent $1 still has a run after 120 s" >&2; return 1
}
check_result() { # jq-filter description
  jq -e "$1" "$TMP/ask-results.json" >/dev/null || { echo "$2: $(cat "$TMP/ask-results.json")" >&2; exit 1; }
}
studio_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.studio/actions/$1" --data "$2"; }
set_ask_level() { # agent-id level — Studio's action, as the signed-in owner
  studio_bridge agent.change-ask-level "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"agentId\":\"$1\",\"level\":\"$2\"}}" | jq -e --arg l "$2" '.data.askLevel == $l' >/dev/null \
    || { echo "Studio did not take the ask level $2 for agent $1" >&2; exit 1; }
}

# smoke-asker is a `process` agent, which the core gives no instructions bundle, so its AGENTS.md
# (the rules block, and the level in it) is checked on smoke-claude_local, which has one like M.
NA_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/agents" | jq -r '.[] | select(.name == "smoke-claude_local") | .id')"
[[ -n "$NA_ID" && "$NA_ID" != "null" ]] || { echo "the smoke-claude_local agent is gone" >&2; exit 1; }

# M answers from a run of its own. The core counts an agent's answer on another task against its
# run, so the run must belong to some task: a task assigned to M gives it one (it fails at once, with
# no model signed in, but the run is there). M's wake for the question itself waits behind A's run,
# which waits for the answer.
MTASK_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/issues" \
  --data "$(jq -cn --arg m "$M_ID" '{title:"smoke: a run to answer a question from", assigneeAgentId:$m, status:"todo"}')" | jq -r '.id')"
[[ -n "$MTASK_ID" && "$MTASK_ID" != "null" ]] || { echo "could not create the task that gives smoke-manager a run" >&2; exit 1; }
for i in $(seq 1 60); do
  M_ASK_RUN_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$M_ID" \
    | jq -r --arg t "$MTASK_ID" '[.[] | select(.contextSnapshot.issueId == $t)][0].id // empty')"
  [[ -n "$M_ASK_RUN_ID" ]] && break
  sleep 1
  [[ $i -eq 60 ]] && { echo "smoke-manager has no run on its task" >&2; compose logs --no-color --tail 80 app >&2; exit 1; }
done

QTASK_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/issues" \
  --data '{"title":"smoke: questions","status":"todo"}' | jq -r '.id')"
[[ -n "$QTASK_ID" && "$QTASK_ID" != "null" ]] || { echo "could not create the questions task" >&2; exit 1; }
jq -nc --arg t "$QTASK_ID" --arg m "$M_ID" --arg p "$P_ID" --arg o "$OWNER_ID" '{task: $t, mode: "sequence", manager: $m, outsider: $p, owner: $o}' \
  | compose exec -T -u node app sh -c 'cat > /kyoubeai/workspaces/smoke/ask-plan.json'
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X PATCH "$BASE_URL/api/issues/$QTASK_ID" --data "{\"assigneeAgentId\":\"$A_ID\"}" >/dev/null

# Answer q1 as M (an agent's answer counts only inside one of its runs).
for i in $(seq 1 60); do
  Q1_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/issues/$QTASK_ID/interactions" \
    | jq -r --arg m "$M_ID" '[(.interactions? // .)[] | select(.kind == "ask_user_questions" and .addresseeAgentId == $m and .status == "pending")][0].id // empty')"
  [[ -n "$Q1_ID" ]] && break
  sleep 1
  [[ $i -eq 60 ]] && { echo "smoke-asker never asked smoke-manager a question" >&2; compose logs --no-color --tail 80 app >&2; exit 1; }
done
as_agent "$M_KEY" POST "/api/issues/$QTASK_ID/interactions/$Q1_ID/respond" '{"answers":[{"questionId":"q","optionIds":["a"]}]}' "$M_ASK_RUN_ID"
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "the manager could not answer the question addressed to it: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }

wait_file /kyoubeai/workspaces/smoke/ask-results-sequence.json 120 >"$TMP/ask-results.json"
take_back "$QTASK_ID"
check_result '(.q1.status | tostring | test("^2")) and .q1.effectiveResolverPolicy == "not_creator"' "a question to the manager was not let through, answerable by the manager"
check_result '.again.status == 422 and .again.code == "kyoube_ask_open_question"' "a second open question to an agent was not refused"
check_result '.outside.status == 422 and .outside.code == "kyoube_ask_outside_line"' "a question outside the asker's line was not refused"
check_result '.q1After != null and .q1After != "pending" and .q1After != "expired"' "the manager's answer did not close the question"
check_result '(.q2.status | tostring | test("^2")) and (.q3.status | tostring | test("^2"))' "the second and third questions were refused"
check_result '(.person1.status | tostring | test("^2")) and .person1.effectiveResolverPolicy == "human_only"' "a question to the person was not people-only"
check_result '.q4.status == 422 and .q4.code == "kyoube_ask_limit"' "a fourth question to an agent was not refused"
echo "    the manager answers its report's question; outside the line, a second open one and a fourth are refused; a question to the person stays people-only"

# No agents: set through Studio as the owner, copied by the loop, refused by the core.
set_ask_level "$A_ID" none
set_ask_level "$NA_ID" none
compose exec -T app kyoube agent-rules --once >/dev/null
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$A_ID" | jq -e '.metadata.kyoubeAskLevel == "none"' >/dev/null \
  || { echo "the loop did not copy the ask level into the agent's metadata" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$NA_ID/instructions-bundle/file?path=AGENTS.md" | jq -r '.content' >"$TMP/agents-md-none.txt"
grep -q 'Your ask level: \*\*no agents\*\*' "$TMP/agents-md-none.txt" \
  || { echo "the rules block of an agent set to no agents does not say so" >&2; head -12 "$TMP/agents-md-none.txt" >&2; exit 1; }
# The next plan goes out only once no wake left over from the first task can pick it up.
wait_idle "$A_ID"
Q2TASK_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/issues" \
  --data '{"title":"smoke: no agents","status":"todo"}' | jq -r '.id')"
[[ -n "$Q2TASK_ID" && "$Q2TASK_ID" != "null" ]] || { echo "could not create the no-agents task" >&2; exit 1; }
jq -nc --arg t "$Q2TASK_ID" --arg m "$M_ID" --arg o "$OWNER_ID" '{task: $t, mode: "single", manager: $m, owner: $o}' \
  | compose exec -T -u node app sh -c 'cat > /kyoubeai/workspaces/smoke/ask-plan.json'
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X PATCH "$BASE_URL/api/issues/$Q2TASK_ID" --data "{\"assigneeAgentId\":\"$A_ID\"}" >/dev/null
wait_file /kyoubeai/workspaces/smoke/ask-results-single.json 90 >"$TMP/ask-results.json"
take_back "$Q2TASK_ID"
check_result '.ask.status == 422 and .ask.code == "kyoube_ask_level_none"' "an agent at no agents could ask its manager"

# Back to its line, and the key leaves the metadata.
set_ask_level "$A_ID" line
set_ask_level "$NA_ID" line
compose exec -T app kyoube agent-rules --once >/dev/null
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$A_ID" | jq -e '.metadata | (. == null or (has("kyoubeAskLevel") | not))' >/dev/null \
  || { echo "setting the level back to its line left the key in the agent's metadata" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$NA_ID/instructions-bundle/file?path=AGENTS.md" | jq -r '.content' >"$TMP/agents-md-line.txt"
grep -q 'Your ask level: \*\*your line\*\*' "$TMP/agents-md-line.txt" \
  || { echo "the rules block did not go back to the agent's line" >&2; head -12 "$TMP/agents-md-line.txt" >&2; exit 1; }

compose exec -T app kyoube doctor >"$TMP/doctor-questions.log" || true
grep -Eq '^ok +agent questions +active; last 7 days: .*[0-9]+ questions? by [0-9]+ agents?' "$TMP/doctor-questions.log" \
  || { echo "doctor does not report agent questions active with a count:" >&2; grep 'agent questions' "$TMP/doctor-questions.log" >&2; exit 1; }
echo "    no agents is set in Studio, copied by the loop and refused by the core; doctor counts the questions"

compose exec -T app kyoube agent-rules --once | tee "$TMP/rules-again.log"
grep -q ' 0 changes,' "$TMP/rules-again.log" || { echo "a second pass made changes:" >&2; cat "$TMP/rules-again.log" >&2; exit 1; }

# `off` does not stop a running loop, so stop it first, as the docs say.
# shellcheck disable=SC2016  # expanded by the shell inside the container
compose exec -T app sh -c 'for p in /proc/[0-9]*; do if tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "agent-rules --w[a]tch"; then kill "${p#/proc/}"; fi; done'
compose exec -T app kyoube agent-rules off | tee "$TMP/rules-off.log"
as_agent "$R_KEY" POST "/api/companies/$COMPANY_ID/issues" "{\"title\":\"smoke: up after off\",\"assigneeAgentId\":\"$M_ID\"}"
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "off did not lift the manager's protection: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/agents/$M_ID/instructions-bundle/file?path=AGENTS.md" | jq -r '.content' >"$TMP/agents-md-off.txt"
if grep -q 'kyoube:working-rules' "$TMP/agents-md-off.txt"; then echo "off left the rules block in place" >&2; exit 1; fi
# Back on, so the restore and doctor below see the rules in force.
compose exec -T app kyoube agent-rules --once >/dev/null
echo "    off takes the rules back out; a pass puts them back"

echo "==> guardrail: an agent's risky call waits on a people-only card and runs once when a person allows it"
# The provider set up in the decisions step is unreachable unless KYOUBE_SMOKE_DECISIONS_KEY is set.
# Either way the drop below is held: the check cannot run, or the task says not to change any data.
apps_bridge decisions.set_settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"guardrail\":true}}" | jq -e '.data.guardrail == true' >/dev/null
apps_bridge data.set_agent_grant "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"agentId\":\"$M_ID\",\"level\":\"schema\"}}" >/dev/null
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_guard\",\"fields\":[{\"name\":\"note\",\"kind\":\"text\"}]}" >/dev/null
GUARD_ISSUE="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/issues" \
  --data "$(jq -cn --arg m "$M_ID" '{title:"smoke: summarise last week (read only)", description:"Read the tables and write a summary. Do not change or delete any data.", assigneeAgentId:$m, status:"todo"}')" | jq -r '.id')"
[[ -n "$GUARD_ISSUE" && "$GUARD_ISSUE" != "null" ]] || { echo "could not create the guardrail task" >&2; exit 1; }
GUARD_DROP="/api/plugins/kyoube.apps/api/tables/smoke_guard/drop"
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\"}"
if [[ "$HTTP_STATUS" != 428 ]] || ! jq -e '.code == "guardrail_context_required"' "$TMP/resp.json" >/dev/null; then echo "expected 428 without issueId, got $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\"}"
if [[ "$HTTP_STATUS" != 409 ]] || ! jq -e '.code == "held" and (.confirmationId | type) == "string"' "$TMP/resp.json" >/dev/null; then echo "expected 409 held, got $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
GUARD_CARD="$(jq -r '.confirmationId' "$TMP/resp.json")"
api_get "/tables" | jq -e 'map(.name) | index("smoke_guard") != null' >/dev/null || { echo "a held drop dropped the table" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/issues/$GUARD_ISSUE/interactions" >"$TMP/guard-cards.json"
jq -e --arg id "$GUARD_CARD" '[(.interactions? // .)[] | select(.id == $id and .kind == "request_confirmation" and .status == "pending" and .effectiveResolverPolicy == "human_only")] | length == 1' "$TMP/guard-cards.json" >/dev/null \
  || { echo "no pending human-only card $GUARD_CARD on the task: $(jq -c '[(.interactions? // .)[] | {id, kind, status, effectiveResolverPolicy}]' "$TMP/guard-cards.json")" >&2; exit 1; }
# The same call again, before anyone answers, gets the same card rather than a second one.
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\"}"
if [[ "$HTTP_STATUS" != 409 ]] || ! jq -e --arg id "$GUARD_CARD" '.code == "held" and .confirmationId == $id' "$TMP/resp.json" >/dev/null; then echo "a repeated call did not get the same card: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
# The agent cannot answer the card, even from a run of its own (the core needs a run to attribute
# an agent's answer; without one it refuses earlier, for a different reason).
GUARD_RUN_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/agents/$M_ID/wakeup" --data '{"reason":"smoke: a run to try the guardrail card from"}' | jq -r '.id')"
[[ -n "$GUARD_RUN_ID" && "$GUARD_RUN_ID" != "null" ]] || { echo "a board wakeup started no run for smoke-manager" >&2; exit 1; }
as_agent "$M_KEY" POST "/api/issues/$GUARD_ISSUE/interactions/$GUARD_CARD/accept" '{}' "$GUARD_RUN_ID"
if [[ "$HTTP_STATUS" != 403 ]] || ! jq -e '.code == "interaction_human_only"' "$TMP/resp.json" >/dev/null; then echo "an agent could answer the guardrail card: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\",\"confirmationId\":\"$GUARD_CARD\"}"
if [[ "$HTTP_STATUS" != 409 ]] || ! jq -e '.code == "held"' "$TMP/resp.json" >/dev/null; then echo "a retry before the person answered was not held: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
# The person allows it once.
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/issues/$GUARD_ISSUE/interactions/$GUARD_CARD/accept" --data '{}' >/dev/null
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\",\"confirmationId\":\"$GUARD_CARD\"}"
[[ "$HTTP_STATUS" == 200 ]] || { echo "the allowed drop did not run: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
api_get "/tables" | jq -e 'map(.name) | index("smoke_guard") == null' >/dev/null || { echo "the allowed drop left the table in place" >&2; exit 1; }
# A missing table answers not_found before the guardrail looks at the confirmation.
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\",\"confirmationId\":\"$GUARD_CARD\"}"
if [[ "$HTTP_STATUS" != 404 ]] || ! jq -e '.code == "not_found"' "$TMP/resp.json" >/dev/null; then echo "a drop of a missing table was not not_found: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
# A hold binds to the table the person was shown: one made again under the same name is another
# table, so the (used) confirmation for the old one does not match it at all.
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_guard\",\"fields\":[{\"name\":\"note\",\"kind\":\"text\"}]}" >/dev/null
as_agent "$M_KEY" POST "$GUARD_DROP" "{\"companyId\":\"$COMPANY_ID\",\"issueId\":\"$GUARD_ISSUE\",\"confirmationId\":\"$GUARD_CARD\"}"
if [[ "$HTTP_STATUS" != 400 ]] || ! jq -e '.code == "invalid"' "$TMP/resp.json" >/dev/null; then echo "a confirmation for the dropped table matched the one made again: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; fi
api_get "/tables" | jq -e 'map(.name) | index("smoke_guard") != null' >/dev/null || { echo "an old confirmation dropped the new table" >&2; exit 1; }
# A table dropped twice within one second would collide on its recycle-bin name, so wait.
sleep 2
api_post "/tables/smoke_guard/drop" "{\"companyId\":\"$COMPANY_ID\"}" >/dev/null
GUARD_HOLDS="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc "select count(*) from kyoube_meta.guardrail_holds where card_id = '$GUARD_CARD' and consumed_at is not null" | tr -dc '0-9')"
[[ "$GUARD_HOLDS" == 1 ]] || { echo "expected the guardrail hold to be used exactly once, got '${GUARD_HOLDS:-<none>}'" >&2; exit 1; }
# Off again, and the agent back to no data access, so the rest of the smoke runs as before.
apps_bridge decisions.set_settings "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"guardrail\":false}}" >/dev/null
apps_bridge data.set_agent_grant "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"agentId\":\"$M_ID\",\"level\":\"none\"}}" >/dev/null
echo "    held without a person, the agent cannot answer the card, a person allows it once"

echo "==> installs land on the home volume: stand-in harnesses, npm -g, sudo apt"
# The image ships no pi or Hermes. Stand-ins in ~/.local/bin let the agents
# created above resolve their harness (doctor checks that below), and the
# restore further down proves they, npm globals and kept apt packages come back.
# shellcheck disable=SC2016  # expanded by the shell inside the container
compose exec -T -u node app sh -c '
  set -e
  mkdir -p "$HOME/.local/bin"
  for name in pi hermes; do
    printf "#!/bin/sh\necho \"%s 0.0.0-smoke\"\n" "$name" > "$HOME/.local/bin/$name"
    chmod +x "$HOME/.local/bin/$name"
  done
  npm install -g --no-audit --no-fund semver@7.6.3 >/dev/null
  sudo apt-get update -qq >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tree >/dev/null
'
[[ "$(compose exec -T app cat /kyoubeai/.kyoube/apt-packages.txt | tr -d '\r')" == *tree* ]] \
  || { echo "apt-record did not keep tree in /kyoubeai/.kyoube/apt-packages.txt" >&2; exit 1; }
compose exec -T app sh -c 'ls /kyoubeai/.cache/apt/archives/tree_*.deb >/dev/null' \
  || { echo "the tree .deb was not kept in the apt cache on the volume" >&2; exit 1; }
[[ "$(compose exec -T -u node app sh -c 'command -v semver' | tr -d '\r')" == /kyoubeai/.local/bin/semver ]] \
  || { echo "npm install -g did not land in /kyoubeai/.local/bin" >&2; exit 1; }

echo "==> a terminal session finds what was installed in ~/.local/bin"
PATH_MARK="kyoube-path-$RANDOM"
PATH_EXPECTED="$PATH_MARK:/kyoubeai/.local/bin/semver"
PATH_SESSION="$(bridge terminal.open "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"cols\":100,\"rows\":30}}" | jq -r '.data.sessionId')"
[[ -n "$PATH_SESSION" && "$PATH_SESSION" != "null" ]] || { echo "terminal.open failed" >&2; exit 1; }
# Typed unevaluated, so only a live shell can print the resolved path.
bridge terminal.input "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$PATH_SESSION\",\"data\":\"echo $PATH_MARK:\$(command -v semver)\\n\"}}" >/dev/null
PATH_AFTER=0; : >"$TMP/path-output.txt"; PATH_STARTED=$(date +%s); PATH_SEEN=""
while (( $(date +%s) - PATH_STARTED < 20 )); do
  bridge terminal.wait "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$PATH_SESSION\",\"afterSeq\":$PATH_AFTER,\"timeoutMs\":2000}}" >"$TMP/path-wait.json"
  jq -r '[.data.events[] | select(.type == "output") | .data] | join("")' "$TMP/path-wait.json" | tr -d '\n\r' >>"$TMP/path-output.txt"
  PATH_AFTER="$(jq --argjson after "$PATH_AFTER" '[.data.events[].seq] | max // $after' "$TMP/path-wait.json")"
  if grep -q -- "$PATH_EXPECTED" "$TMP/path-output.txt"; then PATH_SEEN=1; break; fi
done
bridge terminal.close "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$PATH_SESSION\"}}" >/dev/null
[[ -n "$PATH_SEEN" ]] || { echo "a terminal shell did not resolve semver to /kyoubeai/.local/bin; output:" >&2; cat "$TMP/path-output.txt" >&2; exit 1; }
echo "    ~/.local/bin is first in a Terminal login shell"

echo "==> disaster recovery: back up, destroy the stack, restore it, and prove the restore"
# Ruling P4-R5: the round trip is never rehearsed against the default compose
# project — that is the operator's own stack and data. scripts/backup.sh and
# scripts/restore.sh take their target from COMPOSE_PROJECT_NAME and
# COMPOSE_ENV_FILES (they run plain `docker compose`), so the smoke points them
# at its own throwaway project and env file, exactly as docs/operations.md
# documents for any non-default deployment.
AUDIT_BEFORE="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ -n "$AUDIT_BEFORE" && "$AUDIT_BEFORE" -ge 4 ]] \
  || { echo "could not read kyoube_meta.audit before the backup: '${AUDIT_BEFORE:-<none>}'" >&2; exit 1; }
# The company schema is c_<hex> owned by kyoube_c_<hex>, hex being the company
# uuid without dashes (plugins/kyoube-apps/src/db/company-scope.ts).
COMPANY_HEX="$(echo "$COMPANY_ID" | tr -d '-' | tr '[:upper:]' '[:lower:]')"

INSTANCE_ID_BEFORE="$(compose exec -T app cat /kyoubeai/kyoube/instance-id | tr -d '\r')"
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" BACKUP_DIR="$TMP/backups" \
  bash "$ROOT/scripts/backup.sh" | tee "$TMP/backup.log"
BACKUP_PATH="$(sed -n 's/^backup written to //p' "$TMP/backup.log" | tail -1)"
tar tzf "$BACKUP_PATH/kyoubeai-home.tgz" >"$TMP/home-listing.txt"
grep -qx './.local/bin/semver' "$TMP/home-listing.txt" || { echo "the backup does not carry ~/.local/bin/semver" >&2; exit 1; }
grep -qx './.kyoube/apt-packages.txt' "$TMP/home-listing.txt" || { echo "the backup does not carry the kept apt list" >&2; exit 1; }
! grep -q '^\./\.cache/' "$TMP/home-listing.txt" || { echo "the backup includes ~/.cache, which it must leave out" >&2; exit 1; }
! grep -q '^\./\.npm/' "$TMP/home-listing.txt" || { echo "the backup includes ~/.npm, which it must leave out" >&2; exit 1; }
[[ -n "$BACKUP_PATH" && -d "$BACKUP_PATH" ]] \
  || { echo "backup.sh did not print a backup directory:" >&2; cat "$TMP/backup.log" >&2; exit 1; }
for FILE in kyoubeai.dump kyoube.dump roles.sql kyoubeai-home.tgz SHA256SUMS; do
  [[ -s "$BACKUP_PATH/$FILE" ]] || { echo "backup is missing or empty: $BACKUP_PATH/$FILE" >&2; ls -l "$BACKUP_PATH" >&2; exit 1; }
done
# Company roles are cluster-level state: they are in neither per-database dump,
# and without them a fresh-cluster restore cannot give the c_<hex> schema back
# to its owner (ruling P4-R6).
grep -q "kyoube_c_$COMPANY_HEX" "$BACKUP_PATH/roles.sql" \
  || { echo "roles.sql does not carry the smoke company's role kyoube_c_$COMPANY_HEX:" >&2; cat "$BACKUP_PATH/roles.sql" >&2; exit 1; }
echo "    backup at $BACKUP_PATH ($(wc -c <"$BACKUP_PATH/kyoubeai-home.tgz" | tr -d ' ') bytes of home volume, roles.sql carries kyoube_c_$COMPANY_HEX)"

echo "==> simulating total loss: down -v destroys pgdata and kyoubeai-home"
compose down -v --remove-orphans
compose up -d
DB_CID="$(compose ps -aq db | tr -d '\r' | head -1)"
[[ -n "$DB_CID" ]] || { echo "no db container after the fresh up" >&2; exit 1; }
DB_HEALTH=""
for i in $(seq 1 120); do
  DB_HEALTH="$(docker inspect -f '{{.State.Health.Status}}' "$DB_CID" | tr -d '\r')"
  [[ "$DB_HEALTH" == "healthy" ]] && break
  sleep 1
done
[[ "$DB_HEALTH" == "healthy" ]] || { echo "the rebuilt db never became healthy (state '$DB_HEALTH')" >&2; exit 1; }
for i in $(seq 1 300); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 300 ]]; then echo "the rebuilt app never came up after the simulated disaster" >&2; exit 1; fi
done
# Prove the loss was real: the board key row lived in the kyoubeai database,
# which the fresh init just recreated empty, so the token must no longer work.
STATUS="$(curl -sS -o "$TMP/post-disaster-plugins.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ ! "$STATUS" =~ ^2 ]] \
  || { echo "the board token still worked after down -v, so the disaster was not real: $STATUS $(cat "$TMP/post-disaster-plugins.json")" >&2; exit 1; }
echo "    stack rebuilt from empty volumes; the pre-disaster board token now gets $STATUS"

# `down -v` also removed the app *container*, so the rebuilt one carries the
# pristine image manifest (the shipped kyoube.terminal version). The backup was
# taken against a container whose on-disk manifest the version-bump rehearsals
# above had edited to the second bump with plugin.state.read. A backup restores
# state, not the image, so put the container back into the state the backup was
# taken from -- otherwise the entrypoint's ensure-plugins watcher would
# legitimately "upgrade" the restored row down to the version it finds on disk
# (planPluginInstalls compares versions for difference, not for newer).
edit_manifest "sed -i 's/${SHIPPED_RE}/${BUMP2}/; s/\"ui\.page\.register\",/\"plugin.state.read\", \"ui.page.register\",/' $MANIFEST && grep -q '${BUMP2_RE}' $MANIFEST && grep -q 'plugin.state.read' $MANIFEST"

echo "==> restore"
RESTORE_AT="$(now_utc)"
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" \
  bash "$ROOT/scripts/restore.sh" "$BACKUP_PATH"

wait_core_ready || { echo "the restored app is not ready" >&2; exit 1; }
# The original board token is back: it lives in the restored core database,
# and the board key file `kyoube setup` wrote is back on the restored volume.
STATUS="$(curl -sS -o "$TMP/post-restore-plugins.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] \
  || { echo "the pre-disaster board token did not work after the restore: $STATUS $(cat "$TMP/post-restore-plugins.json")" >&2; exit 1; }
KEY_STAT="$(compose exec -T app sh -c 'stat -c "%a %U" /kyoubeai/kyoube/board-key.json' | tr -d '\r')"
[[ "$KEY_STAT" == "600 node" ]] || { echo "restored board-key.json is '$KEY_STAT', expected '600 node'" >&2; exit 1; }
echo "==> installs came back with the restore: ~/.local/bin on the server's PATH, kept apt packages reinstalled"
server_env() { # the running server process's environment, one VAR=value per line
  # As node: root in the container lacks CAP_SYS_PTRACE, so it cannot read another user's /proc/<pid>/environ.
  # shellcheck disable=SC2016  # expanded by the shell inside the container
  compose exec -T -u node app sh -c 'for p in /proc/[0-9]*; do if tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -Eq "^(/usr/local/bin/)?node .*server/dist/[i]ndex.js"; then tr "\0" "\n" < "$p/environ"; break; fi; done' | tr -d '\r'
}
SERVER_PATH="$(server_env | sed -n 's/^PATH=//p')"
[[ "$SERVER_PATH" == /kyoubeai/.local/bin:* ]] || { echo "the server's PATH does not start with /kyoubeai/.local/bin: '$SERVER_PATH'" >&2; exit 1; }
for name in pi hermes semver; do
  FOUND="$(compose exec -T -u node app env PATH="$SERVER_PATH" sh -c "command -v $name" | tr -d '\r')"
  [[ "$FOUND" == "/kyoubeai/.local/bin/$name" ]] || { echo "$name resolves to '$FOUND' on the server's PATH after the restore" >&2; exit 1; }
done
for i in $(seq 1 60); do
  [[ "$(compose exec -T app sh -c 'cat /kyoubeai/.kyoube/apt-restore.status 2>/dev/null' | tr -d '\r')" == "ok 1" ]] && break
  sleep 2
done
compose exec -T app sh -c 'command -v tree >/dev/null && grep -qx "ok 1" /kyoubeai/.kyoube/apt-restore.status' \
  || { echo "apt-restore did not reinstall tree:" >&2; compose exec -T app cat /kyoubeai/.kyoube/apt-restore.log >&2 || true; exit 1; }
TRUSTED="$(server_env | sed -n 's/^PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST=//p')"
CONTAINER_HOST="$(server_env | sed -n 's/^HOSTNAME=//p')"
[[ -n "$TRUSTED" && "$TRUSTED" == "$CONTAINER_HOST" ]] || { echo "trusted runtime host is '$TRUSTED', expected the container hostname '$CONTAINER_HOST'" >&2; exit 1; }
echo "    pi, hermes and semver on the server's PATH; tree reinstalled; trusted runtime host = $TRUSTED"

echo "==> Connections shows 'kyoube connect claude', which writes a one-year token into that sign-in's folder"
ATTEMPT="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST \
  "$BASE_URL/api/companies/$COMPANY_ID/ai-connections/local/attempts" \
  --data '{"provider":"anthropic","method":"subscription","name":"smoke claude","ownership":"personal"}')"
ATTEMPT_CMD="$(jq -r .command <<<"$ATTEMPT")"; ATTEMPT_ID="$(jq -r .sessionId <<<"$ATTEMPT")"
[[ "$ATTEMPT_CMD" == *"&& kyoube connect claude)" ]] || { echo "the Claude sign-in command is not patched: $ATTEMPT_CMD" >&2; exit 1; }
SMOKE_SETUP_TOKEN="sk-ant-oat01-SMOKEsmokeSMOKEsmokeSMOKEsmoke_-0123456789"
compose exec -T -u node app sh -c 'mkdir -p /tmp/claude-stub && cat > /tmp/claude-stub/claude && chmod +x /tmp/claude-stub/claude' <<STUB
#!/bin/sh
# Stands in for 'claude setup-token': prints the success screen the real one ends with.
[ "\$1" = setup-token ] || exit 64
printf 'Login successful\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n%s\r\n\r\nStore this token securely. You won'"'"'t be able to see it again.\r\n' "$SMOKE_SETUP_TOKEN"
STUB
compose exec -T -u node app env PATH="/tmp/claude-stub:$SERVER_PATH" bash -c "$ATTEMPT_CMD" \
  || { echo "running the Connections command failed" >&2; exit 1; }
ATTEMPT_DIR="$(sed -n "s/.*CLAUDE_CONFIG_DIR='\([^']*\)'.*/\1/p" <<<"$ATTEMPT_CMD")"
compose exec -T -u node app sh -c "test \"\$(stat -c %a '$ATTEMPT_DIR/.credentials.json')\" = 600 && jq -r .claudeAiOauth.accessToken '$ATTEMPT_DIR/.credentials.json'" \
  | tr -d '\r' | grep -qx "$SMOKE_SETUP_TOKEN" || { echo "kyoube connect claude did not write the token (mode 600) into $ATTEMPT_DIR" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" -X DELETE "$BASE_URL/api/companies/$COMPANY_ID/ai-connections/local/attempts/$ATTEMPT_ID" >/dev/null
compose exec -T -u node app rm -rf /tmp/claude-stub
echo "    the command Connections shows ran kyoube connect claude, which wrote a one-year token"

echo "==> Test works on a harness switch that is not saved yet"
CLAUDE_AGENT_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/agents" | jq -r '.[] | select(.name == "smoke-claude_local") | .id')"
[[ -n "$CLAUDE_AGENT_ID" ]] || { echo "the smoke-claude_local agent is gone" >&2; exit 1; }
STATUS="$(curl -sS -o "$TMP/switch-test.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST \
  "$BASE_URL/api/companies/$COMPANY_ID/adapters/codex_local/test-environment" \
  --data "{\"agentId\":\"$CLAUDE_AGENT_ID\",\"adapterConfig\":{\"cwd\":\"/kyoubeai/workspaces/smoke\",\"dangerouslyBypassApprovalsAndSandbox\":true}}")"
! grep -q 'Saved agent is not compatible' "$TMP/switch-test.json" || { echo "Test on an unsaved harness switch still answers 'Saved agent is not compatible'" >&2; exit 1; }
[[ "$STATUS" =~ ^2 ]] || { echo "Test on an unsaved harness switch answered $STATUS: $(cat "$TMP/switch-test.json")" >&2; exit 1; }
echo "    a claude_local agent can test codex_local before saving"

wait_for_plugin kyoube.apps "$APPS_SHIPPED"
wait_for_plugin kyoube.terminal "$BUMP2"
wait_for_plugin_api
echo "    app is ready again, the pre-disaster token authenticates, both plugin workers answer"

# Data: the table definition, and the one row that survived the delete above.
api_get "/tables/smoke_contacts" >"$TMP/table-restored.json"
jq -e '.name == "smoke_contacts"
  and ([.fields[] | select(.name == "name" and .kind == "text" and .required == true)] | length == 1)
  and ([.fields[] | select(.name == "stage" and .kind == "select" and (.options.choices == ["lead", "customer"]))] | length == 1)' \
  "$TMP/table-restored.json" >/dev/null \
  || { echo "the restored smoke_contacts does not describe both fields: $(cat "$TMP/table-restored.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/count" "{\"companyId\":\"$COMPANY_ID\"}" >"$TMP/count-restored.json"
jq -e '.count == 1' "$TMP/count-restored.json" >/dev/null \
  || { echo "expected the pre-backup row count of 1 after the restore, got: $(cat "$TMP/count-restored.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\",\"where\":{\"field\":\"stage\",\"op\":\"eq\",\"value\":\"customer\"}}" \
  | jq -e '.rows | length == 1 and .[0].name == "Grace"' >/dev/null
# Apps: the published app and its version 1 came back with the database.
api_get "/apps/smoke-app" >"$TMP/app-restored.json"
jq -e '.app.slug == "smoke-app" and .app.status == "published" and .app.currentVersion == 1 and .version.version == 1' \
  "$TMP/app-restored.json" >/dev/null \
  || { echo "smoke-app did not come back published at version 1: $(jq -c '{app, version: .version.version}' "$TMP/app-restored.json")" >&2; exit 1; }
# Terminal: the plugin's data route still answers for the same admin/company.
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
  --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" \
  >"$TMP/can-open-restored.json"
jq -e '.data.allowed == true' "$TMP/can-open-restored.json" >/dev/null \
  || { echo "terminal.can_open did not allow the admin after the restore: $(cat "$TMP/can-open-restored.json")" >&2; exit 1; }
# The audit trail is in the kyoube database and must come back row for row.
AUDIT_RESTORED="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ "$AUDIT_RESTORED" == "$AUDIT_BEFORE" ]] \
  || { echo "kyoube_meta.audit has $AUDIT_RESTORED rows after the restore, expected $AUDIT_BEFORE" >&2; exit 1; }

# The ownership proof. Creating a table runs DDL under `SET LOCAL ROLE
# kyoube_c_<hex>` in the c_<hex> schema, which only succeeds if roles.sql
# recreated the role with a SET-able membership AND the kyoube dump restored
# *with* owners handed the schema back to it. A --no-owner restore leaves the
# schema owned by the kyoubeai superuser and this 200 becomes a 500.
STATUS="$(curl -sS -o "$TMP/table-after-restore.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/tables" --data "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_after_restore\",\"fields\":[{\"name\":\"note\",\"kind\":\"text\"}]}")"
[[ "$STATUS" == "200" ]] \
  || { echo "creating a table after the restore returned $STATUS — the c_$COMPANY_HEX schema did not come back owned by kyoube_c_$COMPANY_HEX: $(cat "$TMP/table-after-restore.json")" >&2; exit 1; }
jq -e '.name == "smoke_after_restore"' "$TMP/table-after-restore.json" >/dev/null
SCHEMA_OWNER="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc \
  "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'c_$COMPANY_HEX'" | tr -d '\r\n ')"
[[ "$SCHEMA_OWNER" == "kyoube_c_$COMPANY_HEX" ]] \
  || { echo "schema c_$COMPANY_HEX is owned by '$SCHEMA_OWNER', expected kyoube_c_$COMPANY_HEX" >&2; exit 1; }
echo "    data, apps, terminal and audit restored; c_$COMPANY_HEX is owned by $SCHEMA_OWNER and still accepts DDL"
echo "backup/restore round-trip ok"

echo "==> kyoube doctor"
# The restored stack's own loop must have made a pass before doctor reads its state.
wait_agent_rules_pass "$RESTORE_AT"
# No KYOUBE_BOARD_API_KEY override: `kyoube setup` stored a real key above, so
# doctor's board-key and plugins checks must pass from the stored file alone.
compose exec -T app kyoube doctor | tee "$TMP/doctor.log"
# doctor's `plugins` line lists every kyoube.* plugin as key@version=status, so
# it must now name both bundles.
grep -q "kyoube.apps@${APPS_SHIPPED}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.apps@${APPS_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -q "kyoube.terminal@${BUMP2}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.terminal@${BUMP2}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -q "kyoube.files@${FILES_SHIPPED}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.files@${FILES_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -q "kyoube.agent-rules@${AGENT_RULES_SHIPPED}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.agent-rules@${AGENT_RULES_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +agent rules +in force in ' "$TMP/doctor.log" || { echo "doctor did not report the agent rules in force:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +licence enforcement +active' "$TMP/doctor.log" || { echo "doctor did not report the licence enforcement active after the restore:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +licence +Free: 1 of 5 users' "$TMP/doctor.log" || { echo "doctor did not report Free: 1 of 5 users after the restore:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
[[ "$(compose exec -T app cat /kyoubeai/kyoube/instance-id | tr -d '\r')" == "$INSTANCE_ID_BEFORE" ]] || { echo "the instance ID changed across backup and restore" >&2; exit 1; }
grep -Eq '^ok +harnesses in use .*pi_local \(1\)' "$TMP/doctor.log" || { echo "doctor did not pass 'harnesses in use':" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +pi cli +pi 0\.0\.0-smoke — yours \(/kyoubeai/\.local/bin/pi\)' "$TMP/doctor.log" || { echo "doctor did not list the stand-in pi as yours" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +claude cli .*core image \(/usr/local/bin/claude\)' "$TMP/doctor.log" || { echo "doctor did not list the core image's claude" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +system packages +1 kept: tree' "$TMP/doctor.log" || { echo "doctor did not report the kept tree package" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
# Every restored company: the smoke's own, and the one onboarding-live-check created.
COMPANY_COUNT="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies" | jq 'length')"
grep -Eq "^ok +skills .* ${COMPANY_COUNT}/${COMPANY_COUNT} companies" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report the Kyoube skills present in all ${COMPANY_COUNT} restored companies:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
# The restored stack started with a company already in place, which is the
# upgrade case: the entrypoint's ensure-plugins pass must have asked the worker
# to install the skills there (the worker cannot do it from its own start-up).
for i in $(seq 1 60); do
  # The whole log first: piped, `grep -q` stops reading at the line, `compose logs` dies of SIGPIPE
  # once the app has logged more after it, and pipefail then fails the check that just matched.
  grep -q "Kyoube skills ensured in ${COMPANY_COUNT}/${COMPANY_COUNT} companies" <<<"$(compose logs --no-color app 2>/dev/null)" && break
  sleep 2
  [[ $i -eq 60 ]] && { echo "the entrypoint's ensure-plugins never reported the Kyoube skills ensured after the restore:" >&2; compose logs --no-color app 2>/dev/null | grep 'kyoube:' >&2; exit 1; }
done
echo "    ensure-plugins installed the Kyoube skills into the pre-existing company at container start"

echo "==> migration rehearsal: turn the stack into the 0.1.x layout, then migrate it"
# A 0.1.x install has the role/database `paperclip`, its home on
# <project>_paperclip-home and PAPERCLIP_* keys in .env. A real 0.1.x image is a
# cold build away, so the rehearsal makes that layout out of the running stack —
# the inverse of the migration, through the same temporary-superuser trick — and
# runs scripts/migrate-from-0.1.sh against it. That proves the rename, the
# volume copy, the marker, the entrypoint's compatibility link, the .env rewrite
# and --check, against a database with a real company, agents and plugins.
LEGACY_ENV="$TMP/legacy.env"
sed -e 's/^KYOUBE_PUBLIC_URL=/PAPERCLIP_PUBLIC_URL=/' -e 's/^KYOUBE_DEPLOYMENT_EXPOSURE=/PAPERCLIP_DEPLOYMENT_EXPOSURE=/' -e 's/^KYOUBE_CORE_VERSION=/PAPERCLIP_VERSION=/' "$ENV_FILE" > "$LEGACY_ENV"
grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV" || { echo "could not derive a legacy env file" >&2; exit 1; }
compose stop app
MIGRATE_AT="$(now_utc)"
# One agent gets a 0.1.x-style absolute workspace path for --check to find.
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/paperclip/workspaces/legacy\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
compose exec -T db psql -U kyoubeai -d postgres -v ON_ERROR_STOP=1 -Atqc "CREATE ROLE kyoube_rehearsal LOGIN SUPERUSER" >/dev/null
compose exec -T db psql -U kyoube_rehearsal -d postgres -v ON_ERROR_STOP=1 -Atqc "ALTER ROLE kyoubeai RENAME TO paperclip; ALTER DATABASE kyoubeai RENAME TO paperclip" >/dev/null
compose exec -T db psql -U paperclip -d postgres -v ON_ERROR_STOP=1 -Atqc "DROP ROLE kyoube_rehearsal" >/dev/null
docker volume create "${PROJECT}_paperclip-home" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "${PROJECT}_kyoubeai-home:/from" -v "${PROJECT}_paperclip-home:/to" alpine:3.20 \
  sh -c 'cp -a /from/. /to/ && rm -rf /from/..?* /from/.[!.]* /from/* 2>/dev/null; ls -A /from | wc -l' | tr -d '\r' | grep -qx 0 \
  || { echo "could not move the home volume into the 0.1.x layout" >&2; exit 1; }
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --no-backup | tee "$TMP/migrate.log"
for LINE in 'PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL' 'PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION' 'renaming role paperclip -> kyoubeai' 'renaming database paperclip -> kyoubeai' "copying ${PROJECT}_paperclip-home -> ${PROJECT}_kyoubeai-home" '1 stored path(s) still start with /paperclip/'; do
  grep -qF "$LINE" "$TMP/migrate.log" || { echo "migration log lacks: $LINE" >&2; exit 1; }
done
{ grep -q '^KYOUBE_PUBLIC_URL=' "$LEGACY_ENV" && ! grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV"; } || { echo ".env keys were not renamed" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
{ grep -qx kyoubeai <<<"$DBS" && ! grep -qx paperclip <<<"$DBS"; } || { echo "databases after migration: $DBS" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d postgres -Atc "select count(*) from pg_roles where rolname in ('paperclip','kyoube_migrator')" | tr -d '\r' | grep -qx 0 \
  || { echo "legacy or temporary roles survived the migration" >&2; exit 1; }
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] || { echo "the board token stopped working after the migration: $STATUS" >&2; exit 1; }
compose exec -T app sh -c 'test -f /kyoubeai/kyoube/board-key.json && test -f /kyoubeai/.migrated-from-paperclip-home && test -L /paperclip && test -f /paperclip/kyoube/board-key.json' \
  || { echo "home volume, marker or compatibility link missing after the migration" >&2; exit 1; }
wait_core_ready || { echo "the migrated app is not ready" >&2; exit 1; }
wait_agent_rules_pass "$MIGRATE_AT"
compose exec -T app kyoube doctor | tee "$TMP/doctor-migrated.log"
grep -Eq '^ok +legacy home link .*compatibility link active' "$TMP/doctor-migrated.log" || { echo "doctor did not report the compatibility link" >&2; exit 1; }
grep -Eq '^ok +legacy env +none' "$TMP/doctor-migrated.log" || { echo "doctor still sees legacy env keys" >&2; exit 1; }
# `--check` is tee'd rather than piped straight into `grep -q`: grep would exit on
# the first match and the script's next log line would die of SIGPIPE, which
# `set -o pipefail` turns into a spurious failure. It also puts the count in the log.
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | tee "$TMP/check-legacy.log"
grep -q '1 stored path' "$TMP/check-legacy.log" || { echo "--check did not count the legacy agent path" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/kyoubeai/workspaces/smoke\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | tee "$TMP/check-clear.log"
grep -q '0 stored path' "$TMP/check-clear.log" || { echo "--check still counts a legacy path" >&2; exit 1; }
# Git Bash rewrites a bare POSIX path argument into a Windows one, so the marker
# path goes through `sh -c` (where it is part of a single non-path argument).
compose exec -T app sh -c 'rm -f /kyoubeai/.migrated-from-paperclip-home'
compose restart app
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "the app did not come back after removing the marker" >&2; exit 1; fi
done
compose exec -T app sh -c 'test ! -e /paperclip' || { echo "/paperclip still exists after the marker was removed" >&2; exit 1; }
echo "    0.1.x layout migrated: role/database renamed, home copied with the marker, link present, then gone with the marker"

echo "==> restore a 0.1.x-named backup"
# scripts/restore.sh has a second entry path: a backup directory written by a
# 0.1.x checkout, whose core dump and home archive carry the old names. Nothing
# else exercises it. A real 0.1.x backup is a cold build away, so this renames
# the 0.2.x backup taken in the disaster-recovery stage and re-checksums it.
#
# What that proves and what it does not: the *name* path — that restore.sh finds
# paperclip.dump / paperclip-home.tgz, restores both, and writes the migration
# marker so the entrypoint recreates /paperclip. The dump's own objects still
# belong to `kyoubeai` (pg_restore --no-owner ignores that anyway), so this is
# not a paperclip-owned cluster dump.
LEGACY_BACKUP="$TMP/legacy-backup"
rm -rf "$LEGACY_BACKUP"
cp -a "$BACKUP_PATH" "$LEGACY_BACKUP"
mv "$LEGACY_BACKUP/kyoubeai.dump" "$LEGACY_BACKUP/paperclip.dump"
mv "$LEGACY_BACKUP/kyoubeai-home.tgz" "$LEGACY_BACKUP/paperclip-home.tgz"
(cd "$LEGACY_BACKUP" && sha256sum paperclip.dump kyoube.dump roles.sql paperclip-home.tgz > SHA256SUMS)
LEGACY_RESTORE_AT="$(now_utc)"
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" \
  bash "$ROOT/scripts/restore.sh" "$LEGACY_BACKUP" | tee "$TMP/restore-legacy.log"
grep -q '0.1.x backup — leaving the migration marker' "$TMP/restore-legacy.log" \
  || { echo "restore.sh did not take its legacy-backup path" >&2; exit 1; }
wait_core_ready || { echo "the app never came back after the legacy-named restore" >&2; exit 1; }
compose exec -T app sh -c 'test -f /kyoubeai/.migrated-from-paperclip-home && test -L /paperclip && test -f /paperclip/kyoube/board-key.json' \
  || { echo "the legacy-named restore left no marker or no /paperclip link" >&2; exit 1; }
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] || { echo "the board token did not work after the legacy-named restore: $STATUS" >&2; exit 1; }
wait_for_plugin_api
wait_agent_rules_pass "$LEGACY_RESTORE_AT"
compose exec -T app kyoube doctor | tee "$TMP/doctor-legacy-restore.log"
grep -Eq '^ok +legacy home link .*compatibility link active' "$TMP/doctor-legacy-restore.log" \
  || { echo "doctor did not report the compatibility link after the legacy-named restore" >&2; exit 1; }
# Back to the clean 0.2.x state the stage above left behind.
compose exec -T app sh -c 'rm -f /kyoubeai/.migrated-from-paperclip-home'
compose restart app
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "the app did not come back after clearing the marker again" >&2; exit 1; fi
done
compose exec -T app sh -c 'test ! -e /paperclip' || { echo "/paperclip survived the marker removal" >&2; exit 1; }
echo "    restore.sh read a 0.1.x-named backup, wrote the marker, and the link came and went with it"

echo "==> smoke passed"
