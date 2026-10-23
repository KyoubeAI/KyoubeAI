#!/usr/bin/env bats
# install.sh on an install that already has data, against a scratch git repo (tags made here) and a docker stub that
# logs every call. It repairs the version the install runs and never changes it.

setup() {
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  export STUB_LOG="$BATS_TEST_TMPDIR/docker-calls"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  # Answers the preflight questions and logs everything. The database volume exists when STUB_VOLUME is set; the app
  # container ($STUB_APP_CID, none by default) runs $STUB_CONTAINER_IMAGE; every image is there with the id sha256:stub;
  # the instance is claimed and its plugins are set up. `kyoube agent-rules` fails when $STUB_FAIL_AGENT_RULES is set.
  cat > "$STUB_BIN/docker" <<'EOF'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$*" in
  "info --format {{.Architecture}}") echo x86_64 ;;
  "info --format {{.MemTotal}}") echo 8000000000 ;;
  "version --format {{.Server.Version}}") echo 27.0.0 ;;
  "volume inspect "*) [ -n "${STUB_VOLUME:-}" ] || exit 1 ;;
  "compose config") exit 1 ;;
  "compose ps -aq app") [ -z "${STUB_APP_CID:-}" ] || echo "$STUB_APP_CID" ;;
  "inspect -f {{.Image}} "*) echo "${STUB_CONTAINER_IMAGE:-sha256:stub}" ;;
  "image inspect -f {{.Id}} "*) echo sha256:stub ;;
  "compose exec -T app curl "*) echo '{"status":"ok","bootstrapStatus":"ready"}' ;;
  "compose exec -T -u node app kyoube agent-rules "*) [ -z "${STUB_FAIL_AGENT_RULES:-}" ] || exit 1 ;;
esac
exit 0
EOF
  chmod +x "$STUB_BIN/docker"

  # origin: v1.1.0, v1.2.0, then an untagged commit main sits on.
  SEED="$BATS_TEST_TMPDIR/seed"; INST="$BATS_TEST_TMPDIR/inst"
  mkdir -p "$SEED/scripts/lib"
  cp "$BATS_TEST_DIRNAME/../../install.sh" "$SEED/"
  cp "$BATS_TEST_DIRNAME/../lib/host.sh" "$SEED/scripts/lib/"
  printf 'KYOUBE_CORE_VERSION=2026.916.1\nKYOUBE_VERSION=dev\n' > "$SEED/.env.example"
  git -C "$SEED" init -q
  git -C "$SEED" symbolic-ref HEAD refs/heads/main
  git -C "$SEED" add -A
  git -C "$SEED" commit -qm one && git -C "$SEED" tag v1.1.0
  git -C "$SEED" commit -q --allow-empty -m two && git -C "$SEED" tag v1.2.0
  git -C "$SEED" commit -q --allow-empty -m after-1.2.0
  git clone -q "$SEED" "$INST"
  printf '.env\n.kyoube/\n' > "$INST/.git/info/exclude"
}

run_install() { run env PATH="$STUB_BIN:$PATH" "$INST/install.sh" "$@"; }

# call_line CALL: the line of STUB_LOG where docker was first run with exactly CALL (empty when it never was).
call_line() { grep -nFx -- "$1" "$STUB_LOG" | head -1 | cut -d: -f1 || true; }

# installed_at VERSION [IMAGE]: an install with data that runs the published VERSION, its checkout on that release.
installed_at() {
  git -C "$INST" -c advice.detachedHead=false checkout -q "v$1"
  printf 'KYOUBE_VERSION=%s\nKYOUBE_IMAGE=%s\nCOMPOSE_PROJECT_NAME=inst\nKYOUBE_PUBLIC_URL=http://localhost:3100\nKYOUBE_CORE_VERSION=2026.916.1\n' \
    "$1" "${2:-ghcr.io/kyoubeai/kyoubeai}" > "$INST/.env"
  export STUB_VOLUME=1
}

# source_build_of COMMIT: an install with data that runs a source build this checkout recorded as built from COMMIT.
source_build_of() {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\nKYOUBE_PUBLIC_URL=http://localhost:3100\nKYOUBE_CORE_VERSION=2026.916.1\n' > "$INST/.env"
  mkdir -p "$INST/.kyoube"
  printf 'commit=%s\nimage=sha256:stub\n' "$(git -C "$INST" rev-parse "$1")" > "$INST/.kyoube/built-commit"
  export STUB_VOLUME=1
}

# changed_nothing: .env and the checkout are as they were (snapshot), and nothing was pulled, built or started.
snapshot() {
  cp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
  HEAD_BEFORE="$(git -C "$INST" rev-parse HEAD)"
  SYMBOLIC_BEFORE="$(git -C "$INST" symbolic-ref -q HEAD || true)"
}
changed_nothing() {
  cmp "$INST/.env" "$BATS_TEST_TMPDIR/env-before" || { echo ".env changed"; return 1; }
  [ "$(git -C "$INST" rev-parse HEAD)" = "$HEAD_BEFORE" ] || { echo "the checkout moved"; return 1; }
  [ "$(git -C "$INST" symbolic-ref -q HEAD || true)" = "$SYMBOLIC_BEFORE" ] || { echo "the branch changed"; return 1; }
  if grep -E '^(pull|compose (up|build|exec))' "$STUB_LOG"; then echo "docker was changed"; return 1; fi
}

@test "an install that runs 1.2.0 refuses --version 1.1.0 and changes nothing" {
  installed_at 1.2.0
  snapshot
  run_install --version 1.1.0 --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs v1.2.0 (KYOUBE_VERSION in .env), and ./install.sh would put v1.1.0 on its data; nothing was changed"* ]]
  [[ "$output" == *"Re-running ./install.sh repairs the version you have; moving to another version is ./update.sh"* ]]
  changed_nothing
}

@test "an install that runs 1.1.0 refuses --version 1.2.0 too: moving forward is ./update.sh, which backs up" {
  installed_at 1.1.0
  snapshot
  run_install --version 1.2.0 --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs v1.1.0"* ]]
  [[ "$output" == *"./update.sh"* ]]
  changed_nothing
}

@test "a source build refuses a plain ./install.sh, from its branch or from a release's checkout" {
  source_build_of HEAD
  snapshot
  run_install --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs a source build (kyoubeai:dev), and ./install.sh would put v1.2.0 on its data; nothing was changed"* ]]
  [[ "$output" == *"./update.sh --edge"* ]]
  changed_nothing
  git -C "$INST" -c advice.detachedHead=false checkout -q v1.2.0
  snapshot
  run_install --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs a source build"* ]]
  changed_nothing
}

@test "a re-run on the release the install runs repairs it, keeping .env's image, core pin and project" {
  installed_at 1.2.0 registry.example.com/mirror/kyoubeai
  sed 's/^KYOUBE_CORE_VERSION=.*/KYOUBE_CORE_VERSION=2026.831.1/' "$INST/.env" > "$INST/.env.new" && mv "$INST/.env.new" "$INST/.env"
  run_install --yes --name other
  [ "$status" -eq 0 ]
  [[ "$output" == *"keeping the existing .env"* ]]
  [[ "$output" == *"--name (COMPOSE_PROJECT_NAME) ignored because the existing .env is kept"* ]]
  [[ "$output" == *"Do not change COMPOSE_PROJECT_NAME in .env on an existing install"* ]]
  [[ "$output" == *"the Kyoube plugins are already set up"* ]]
  [[ "$output" == *"KyoubeAI is running at http://localhost:3100"* ]]
  [[ "$output" == *"Skip for now"* ]]
  [ "$(git -C "$INST" describe --tags --exact-match HEAD)" = v1.2.0 ]
  grep -Fx "KYOUBE_VERSION=1.2.0" "$INST/.env"
  grep -Fx "KYOUBE_IMAGE=registry.example.com/mirror/kyoubeai" "$INST/.env"
  grep -Fx "COMPOSE_PROJECT_NAME=inst" "$INST/.env"
  grep -Fx "KYOUBE_CORE_VERSION=2026.831.1" "$INST/.env"
  grep -Fx "image inspect registry.example.com/mirror/kyoubeai:1.2.0" "$STUB_LOG"
  grep -F "compose up -d --no-build --wait" "$STUB_LOG"
  grep -Fx "compose exec -T -u node app kyoube doctor" "$STUB_LOG"
  ! grep -E '^(pull|compose build)' "$STUB_LOG" || false
}

@test "install.sh runs one fresh agent-rules pass just before doctor, and a failing pass does not stop it or raise the doctor warning" {
  installed_at 1.2.0
  STUB_FAIL_AGENT_RULES=1 run_install --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"KyoubeAI is running at http://localhost:3100"* ]]
  [[ "$output" != *"kyoube doctor reported a problem"* ]]
  [ "$(grep -cFx "compose exec -T -u node app kyoube agent-rules --once" "$STUB_LOG")" = 1 ]
  pass="$(call_line "compose exec -T -u node app kyoube agent-rules --once")"
  doctor="$(call_line "compose exec -T -u node app kyoube doctor")"
  [ -n "$pass" ] && [ -n "$doctor" ]
  [ "$pass" -lt "$doctor" ]
}

@test "an install whose checkout is not on the release it runs is told to check it out; install.sh does not switch it" {
  installed_at 1.2.0
  git -C "$INST" checkout -q main
  snapshot
  run_install --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs v1.2.0 (KYOUBE_VERSION in .env), but this checkout is at $(git -C "$INST" rev-parse --short HEAD)"* ]]
  [[ "$output" == *"git checkout v1.2.0, then ./install.sh"* ]]
  changed_nothing
}

@test "--edge on a source build of this very commit repairs it by building the same commit" {
  source_build_of HEAD
  run_install --edge --yes
  [ "$status" -eq 0 ]
  grep -Fx "compose build app" "$STUB_LOG"
  grep -Fx "KYOUBE_VERSION=dev" "$INST/.env"
  [ "$(sed -n 's/^commit=//p' "$INST/.kyoube/built-commit")" = "$(git -C "$INST" rev-parse HEAD)" ]
}

@test "--edge refuses a source build of other code, one with no record, and a published release" {
  source_build_of v1.2.0
  snapshot
  run_install --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"its image was built from $(git -C "$INST" rev-parse --short v1.2.0), and this checkout is at $(git -C "$INST" rev-parse --short HEAD)"* ]]
  [[ "$output" == *"./update.sh --edge"* ]]
  changed_nothing
  rm "$INST/.kyoube/built-commit"
  run_install --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"nothing records which commit its image was built from"* ]]
  changed_nothing
  # the record has to describe the image the app container runs, not only the tag
  source_build_of HEAD
  snapshot
  STUB_APP_CID=app1 STUB_CONTAINER_IMAGE=sha256:other run_install --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"nothing records which commit its image was built from"* ]]
  changed_nothing
  installed_at 1.2.0
  git -C "$INST" checkout -q main
  snapshot
  run_install --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"this install runs v1.2.0 (KYOUBE_VERSION in .env), and ./install.sh would put a build of this checkout on its data"* ]]
  [[ "$output" == *"./update.sh --edge"* ]]
  changed_nothing
}

@test "an existing .env without data is still an install to finish, not one to keep" {
  installed_at 1.1.0
  unset STUB_VOLUME
  run_install --version 1.2.0 --yes
  [ "$status" -eq 0 ]
  [ "$(git -C "$INST" describe --tags --exact-match HEAD)" = v1.2.0 ]
  grep -Fx "KYOUBE_VERSION=1.2.0" "$INST/.env"
}

@test "a --url that is not an address is refused before anything is written" {
  run_install --url 3300 --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"not an address: 3300"* ]]
  [ ! -f "$INST/.env" ]
  [ ! -s "$STUB_LOG" ]
}
