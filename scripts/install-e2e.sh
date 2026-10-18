#!/usr/bin/env bash
# End to end for install.sh and update.sh: a throwaway clone of this checkout,
# two local releases (v9.9.0, v9.9.1) pointing at the image scripts/smoke.sh
# built, an install with the claim and plugin approval done through the API,
# an update that merges a new setting and installs a harness agents use (as
# node), a rollback, install.sh refusing to change the version of an install
# that has data, and the volume-collision refusal. Needs docker, git, curl and jq.
set -euo pipefail
IMAGE="${KYOUBE_E2E_IMAGE:-kyoubeai:smoke}"
PROJECT=kyoube-e2e
# Nothing the caller exported may point this run at another stack: compose lets
# COMPOSE_* and the variables docker-compose.yml interpolates beat .env, and
# host.sh's resolve_project_name trusts an exported COMPOSE_PROJECT_NAME. Drop
# them all (KYOUBE_E2E_IMAGE was read above), then pin the one project this
# script owns.
while IFS= read -r name; do unset "$name"; done < <(
  env | sed -nE 's/^((COMPOSE|KYOUBE|PAPERCLIP|BETTER_AUTH|POSTGRES)_[A-Za-z0-9_]*)=.*/\1/p'
  printf '%s\n' TRUST_PROXY ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY
)
export COMPOSE_PROJECT_NAME="$PROJECT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=3197
BASE_URL="http://localhost:$PORT"
WORK="$(mktemp -d)"
CLONE="$WORK/clone"
COOKIES="$WORK/cookies.txt"
REPO=ghcr.io/kyoubeai/kyoubeai
INSTALL_PID=""

cleanup() {
  local code=$?
  [ -z "$INSTALL_PID" ] || kill "$INSTALL_PID" 2>/dev/null || true
  if [ -f "$CLONE/.env" ]; then
    if [ "$code" -ne 0 ]; then (cd "$CLONE" && docker compose -p "$PROJECT" logs --tail 100 app >&2) || true; fi
    (cd "$CLONE" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1) || true
  fi
  docker rmi "$REPO:9.9.0" "$REPO:9.9.1" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "install-e2e: $*" >&2; exit 1; }

# show FILE PATTERN: the lines of a script's output that prove a step, indented.
show() { grep -E "$2" "$1" | sed 's/^[[:space:]]*/    /' || true; }

# companies_have ID: true when the instance lists the company.
companies_have() {
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies" | jq -e --arg id "$1" 'any(.[]; .id == $id)' >/dev/null
}

post_json() {
  curl -fsS -c "$COOKIES" -b "$COOKIES" -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -X POST "$1" --data "$2"
}

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "build $IMAGE first (bash scripts/smoke.sh)"
docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1 \
  && fail "the volumes of an earlier run (${PROJECT}_pgdata, ${PROJECT}_kyoubeai-home) are still here; remove that stack's containers and volumes, then run again"
echo "==> a clone of this checkout with two releases"
git clone --quiet "$ROOT" "$CLONE"
# The working tree's tracked files, so uncommitted work is what gets tested.
(cd "$ROOT" && git ls-files -z | tar --null -T - -cf -) | tar -C "$CLONE" -xf -
cd "$CLONE"
git -c user.name=e2e -c user.email=e2e@kyoube.local commit --quiet -am "e2e snapshot" >/dev/null || true
git tag v9.9.0
printf '\n# ---- e2e ----\n# Added in the 9.9.1 test release, for update.sh to merge.\nKYOUBE_E2E_MARKER=merged\n' >> .env.example
git -c user.name=e2e -c user.email=e2e@kyoube.local commit --quiet -am "e2e: 9.9.1"
git tag v9.9.1
git -c advice.detachedHead=false checkout --quiet v9.9.0
docker tag "$IMAGE" "$REPO:9.9.0"
docker tag "$IMAGE" "$REPO:9.9.1"

echo "==> ./install.sh --version 9.9.0, claiming and approving through the API"
./install.sh --version 9.9.0 --name "$PROJECT" --port "$PORT" --url "$BASE_URL" --yes >"$WORK/install.log" 2>&1 &
INSTALL_PID=$!
# Longer than install.sh's own 300 second wait for the first start.
for i in $(seq 1 360); do
  grep -q "Open $BASE_URL in your browser" "$WORK/install.log" && break
  kill -0 "$INSTALL_PID" 2>/dev/null || { cat "$WORK/install.log" >&2; fail "install.sh stopped before the claim"; }
  sleep 1
  [ "$i" -lt 360 ] || { cat "$WORK/install.log" >&2; fail "install.sh never asked for the claim"; }
done
grep -qx "BETTER_AUTH_TRUSTED_ORIGINS=$BASE_URL" .env || fail "install.sh did not set BETTER_AUTH_TRUSTED_ORIGINS for port $PORT"
post_json "$BASE_URL/api/auth/sign-up/email" '{"name":"E2E Admin","email":"e2e@kyoube.local","password":"e2e-password-123"}' >/dev/null
post_json "$BASE_URL/api/bootstrap/claim" '{}' | jq -e '.claimed == true' >/dev/null
APPROVAL=""
for i in $(seq 1 180); do
  APPROVAL="$(grep -oE '/cli-auth/[0-9a-f-]{36}\?token=pcp_cli_auth_[0-9a-f]+' "$WORK/install.log" | head -1 || true)"
  [ -n "$APPROVAL" ] && break
  sleep 1
done
[ -n "$APPROVAL" ] || { cat "$WORK/install.log" >&2; fail "install.sh never printed the plugin approval link"; }
CHALLENGE_ID="${APPROVAL#/cli-auth/}"; CHALLENGE_ID="${CHALLENGE_ID%%\?*}"
post_json "$BASE_URL/api/cli-auth/challenges/$CHALLENGE_ID/approve" "{\"token\":\"${APPROVAL#*token=}\"}" | jq -e '.approved == true' >/dev/null
wait "$INSTALL_PID" || { INSTALL_PID=""; cat "$WORK/install.log" >&2; fail "install.sh failed"; }
INSTALL_PID=""
grep -q "KyoubeAI is running at $BASE_URL" "$WORK/install.log" || fail "install.sh did not finish with its summary"
show "$WORK/install.log" '^(    wrote \.env|    claimed|KyoubeAI is running)'
[ "$(git describe --tags --exact-match HEAD)" = v9.9.0 ] || fail "install.sh did not stay on v9.9.0"

echo "==> re-running install.sh is a no-op"
./install.sh --name "$PROJECT" --yes >"$WORK/install2.log" 2>&1 || { cat "$WORK/install2.log" >&2; fail "a second install.sh run failed"; }
grep -q "the Kyoube plugins are already set up" "$WORK/install2.log" || fail "the second run did not see the finished setup"
grep -q "ignored because the existing .env is kept" "$WORK/install2.log" || fail "the second run did not say that --name is ignored"
show "$WORK/install2.log" 'already set up|ignored because'
[ "$(git describe --tags --exact-match HEAD)" = v9.9.0 ] || fail "the second install.sh run left v9.9.0"

echo "==> an agent on pi, which is not installed"
TOKEN="$(post_json "$BASE_URL/api/board-api-keys" '{"name":"e2e"}' | jq -r .token)"
COMPANY_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies" --data '{"name":"E2E Co"}' | jq -r .id)"
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies/$COMPANY_ID/agents" \
  --data '{"name":"e2e-pi","adapterType":"pi_local","adapterConfig":{"cwd":"/kyoubeai/workspaces/e2e"}}' >/dev/null

! docker compose exec -T -u node app sh -c 'command -v pi' >/dev/null 2>&1 || fail "pi is already installed before the update, so the test would prove nothing"

echo "==> ./update.sh --yes"
./update.sh --yes >"$WORK/update.log" 2>&1 || { cat "$WORK/update.log" >&2; fail "update.sh failed"; }
grep -q 'Update KyoubeAI v9.9.0 -> v9.9.1' "$WORK/update.log" || fail "update.sh did not announce 9.9.0 -> 9.9.1"
[ "$(git describe --tags --exact-match HEAD)" = v9.9.1 ] || fail "not on v9.9.1 after the update"
grep -qx 'KYOUBE_E2E_MARKER=merged' .env || fail "the new setting was not merged into .env"
grep -qx 'KYOUBE_VERSION=9.9.1' .env || fail "KYOUBE_VERSION was not moved to 9.9.1"
grep -q 'agents use: pi_local 1' "$WORK/update.log" || { cat "$WORK/update.log" >&2; fail "update.sh did not find the pi agent in the database"; }
# update.sh runs a fresh agent-rules pass just before its kyoube doctor, so the rules are in force.
! grep -q '^FAIL agent rules' "$WORK/update.log" || { cat "$WORK/update.log" >&2; fail "kyoube doctor reported FAIL agent rules after the update"; }
[ "$(docker compose exec -T -u node app sh -c 'command -v pi' | tr -d '\r')" = /kyoubeai/.local/bin/pi ] || fail "update.sh did not install pi for the pi agent"
# Installed as node, or the Terminal and the agents could not write there until the next restart.
PI_OWNERS="$(docker compose exec -T app stat -c %U /kyoubeai/.local/bin/pi /kyoubeai/.local/lib/node_modules | tr -d '\r' | sort -u)"
[ "$PI_OWNERS" = node ] || fail "pi and /kyoubeai/.local/lib/node_modules belong to '$PI_OWNERS', not node: update.sh installed it as another user"
[ -f .kyoube/update-state ] || fail "no rollback state was saved"
# Written after the backup, so only a real restore can take it away again.
AFTER_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/companies" --data '{"name":"E2E After Update"}' | jq -r .id)"
if [ -z "$AFTER_ID" ] || [ "$AFTER_ID" = null ]; then fail "could not create the company for after the update"; fi
companies_have "$AFTER_ID" || fail "the company made after the update is not listed"
show "$WORK/update.log" '^(Update KyoubeAI|    agents use|    added to \.env|==> npm install|pi: |updated to)'

echo "==> ./update.sh --rollback --yes"
./update.sh --rollback --yes >"$WORK/rollback.log" 2>&1 || { cat "$WORK/rollback.log" >&2; fail "rollback failed"; }
[ "$(git describe --tags --exact-match HEAD)" = v9.9.0 ] || fail "not on v9.9.0 after the rollback"
grep -qx 'KYOUBE_VERSION=9.9.0' .env || fail "KYOUBE_VERSION is not 9.9.0 after the rollback"
! grep -q KYOUBE_E2E_MARKER .env || fail "the rollback did not put the pre-update .env back"
grep -q '^restored from ' "$WORK/rollback.log" || fail "the rollback did not restore the backup"
companies_have "$COMPANY_ID" || fail "the data from before the update is not there after the rollback"
! companies_have "$AFTER_ID" || fail "the company made after the update is still there after the rollback, so the backup was not restored"
! docker compose exec -T -u node app sh -c 'command -v pi' >/dev/null 2>&1 || fail "pi, installed after the backup, is still there after the rollback, so the home volume was not restored"
[ ! -e .kyoube/update-state ] || fail "rollback state was not cleared"
show "$WORK/rollback.log" '^(Roll back to|rolled back|restored from)'

echo "==> install.sh on this install refuses another version and changes nothing"
cp .env "$WORK/env-before"
if ./install.sh --version 9.9.1 --yes >"$WORK/install3.log" 2>&1; then
  fail "install.sh --version 9.9.1 ran on an install that runs 9.9.0"
fi
grep -q 'this install runs v9.9.0 (KYOUBE_VERSION in .env), and ./install.sh would put v9.9.1 on its data; nothing was changed' "$WORK/install3.log" \
  || { cat "$WORK/install3.log" >&2; fail "the refusal did not explain itself"; }
cmp -s .env "$WORK/env-before" || fail "the refused install.sh changed .env"
[ "$(git describe --tags --exact-match HEAD)" = v9.9.0 ] || fail "the refused install.sh moved the checkout"
show "$WORK/install3.log" '^error:'

echo "==> a second install onto the same project is refused"
git -c advice.detachedHead=false clone --quiet "$CLONE" "$WORK/second"
if (cd "$WORK/second" && ./install.sh --edge --image "$REPO:9.9.0" --name "$PROJECT" --port 3196 --yes) >"$WORK/second.log" 2>&1; then
  fail "a second install onto an existing project's volumes was not refused"
fi
grep -q "already exists on this machine" "$WORK/second.log" || { cat "$WORK/second.log" >&2; fail "the refusal did not explain itself"; }
[ ! -e "$WORK/second/.env" ] || fail "the refused install still wrote a .env"
show "$WORK/second.log" '^error:'
echo "==> install-e2e passed"
