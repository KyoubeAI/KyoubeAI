#!/usr/bin/env bats

setup() {
  # shellcheck source=../lib/host.sh
  . "$BATS_TEST_DIRNAME/../lib/host.sh"
  cd "$BATS_TEST_TMPDIR"
}

@test "version_ge compares dotted versions numerically" {
  version_ge 1.1.0 1.1.0
  version_ge 1.10.0 1.9.9
  version_ge 2 1.99.99
  ! version_ge 1.0.9 1.1.0 || false
  ! version_ge 1.1 1.1.1 || false
}

@test "is_release_version accepts exactly three dot-separated numbers" {
  is_release_version 1.2.3
  is_release_version 10.0.1
  ! is_release_version 1.2 || false
  ! is_release_version v1.2.3 || false
  ! is_release_version 1.2.3-rc1 || false
  ! is_release_version 1.2.3.4 || false
  ! is_release_version abc || false
  ! is_release_version "" || false
}

@test "latest_release picks the newest vX.Y.Z at or above the minimum, ignoring pre-releases and junk" {
  run latest_release 1.1.0 <<< $'v1.0.0\nv1.1.0\nv1.2.0-beta.1\nv1.10.0\nv1.9.3\nnightly\nv1.2.3.4\r'
  [ "$output" = "v1.10.0" ]
  run latest_release 1.1.0 <<< $'v1.0.0\nv1.0.1'
  [ -z "$output" ]
}

@test "env_get reads the last uncommented value, keeps '=' in values and drops CR" {
  printf 'A=1\r\n# B=commented\nC=x=y==\nA=2\r\n' > .env
  [ "$(env_get .env A)" = "2" ]
  [ "$(env_get .env B)" = "" ]
  [ "$(env_get .env C)" = "x=y==" ]
  [ "$(env_get missing.env A)" = "" ]
}

@test "env_set replaces the first line, drops later duplicates, keeps comments, appends when absent, normalises CRLF" {
  printf '# KYOUBE_VERSION=1.0.0\r\nKYOUBE_VERSION=dev\r\nOTHER=1\r\nKYOUBE_VERSION=stale\r\n' > .env
  env_set .env KYOUBE_VERSION 1.1.0
  env_set .env NEW 'a=b c'
  [ "$(cat .env)" = "$(printf '# KYOUBE_VERSION=1.0.0\nKYOUBE_VERSION=1.1.0\nOTHER=1\nNEW=a=b c')" ]
  [ "$(stat -c %a .env 2>/dev/null || stat -f %Lp .env)" = "600" ]
}

@test "env_set on a missing file fails and leaves no temp file behind" {
  run env_set nope.env A 1
  [ "$status" -ne 0 ]
  [ ! -e nope.env ]
  [ -z "$(ls -A)" ]
}

@test "env_keys lists keys, commented or not" {
  printf 'A=1\n# B=2\n  #  C=3\n# prose line, not a key\nlower=4\n' > f
  [ "$(env_keys f)" = "$(printf 'A\nB\nC')" ]
}

@test "env_merge appends only missing keys, each paragraph's comments once, and is idempotent" {
  cat > example <<'EXAMPLE'
# ---- Secrets ----
A=
B=

# Trusted host: explained here.
KYOUBE_TRUSTED_RUNTIME_HOST=auto

# ---- Optional ----
# OPT=value
EXAMPLE
  printf 'A=secret\nB=secret\n' > .env
  run env_merge example .env 1.1.0
  [ "$output" = "$(printf 'KYOUBE_TRUSTED_RUNTIME_HOST\nOPT')" ]
  [ "$(env_get .env KYOUBE_TRUSTED_RUNTIME_HOST)" = "auto" ]
  grep -qx '# Added by update to 1.1.0' .env
  [ "$(grep -c '# Trusted host: explained here.' .env)" -eq 1 ]
  grep -qx '# OPT=value' .env
  [ "$(env_get .env A)" = "secret" ]
  run env_merge example .env 1.1.0
  [ -z "$output" ]
  [ "$(grep -c 'Added by update' .env)" -eq 1 ]
}

@test "env_merge never re-adds a key the user only has commented out" {
  printf '# ---- x ----\nFOO=1\n' > example
  printf '# FOO=my note\n' > .env
  run env_merge example .env 1.1.0
  [ -z "$output" ]
}

@test "env_unused lists keys the new example no longer mentions" {
  printf 'A=\n# B=\n' > example
  printf 'A=1\nB=2\nOLD=3\n' > .env
  [ "$(env_unused example .env)" = "OLD" ]
}

@test "normalize_project_name follows compose's rules" {
  [ "$(normalize_project_name 'KyoubeAI')" = "kyoubeai" ]
  [ "$(normalize_project_name 'My-AI-Stack')" = "my-ai-stack" ]
  [ "$(normalize_project_name '_My App.v2')" = "myappv2" ]
}

# fake_docker SCRIPT: a docker on PATH that runs SCRIPT (sh) with its arguments.
fake_docker() {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\n%s\n' "$1" > "$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "resolve_project_name without a docker that answers: shell variable, then .env, then the folder name" {
  fake_docker 'exit 1'
  mkdir -p "My-Stack"; printf 'X=1\n' > My-Stack/.env
  [ "$(COMPOSE_PROJECT_NAME= resolve_project_name "$PWD/My-Stack")" = "my-stack" ]
  printf 'COMPOSE_PROJECT_NAME=pinned\n' >> My-Stack/.env
  [ "$(COMPOSE_PROJECT_NAME= resolve_project_name "$PWD/My-Stack")" = "pinned" ]
  [ "$(COMPOSE_PROJECT_NAME=fromshell resolve_project_name "$PWD/My-Stack")" = "fromshell" ]
}

@test "resolve_project_name takes the name docker compose config resolves, a top-level name: included" {
  # compose prints the resolved project first; a `name:` in an override file is part of what it resolves
  fake_docker '[ "$*" = "compose config" ] || exit 1; printf "name: from-override\r\nservices:\n  app:\n    image: x\n"'
  mkdir -p "My-Stack"; printf 'X=1\n' > My-Stack/.env
  [ "$(COMPOSE_PROJECT_NAME= resolve_project_name "$PWD/My-Stack")" = "from-override" ]
}

@test "env helpers read and write export KEY=value lines, keeping the export" {
  printf 'export KYOUBE_PORT=3200\nexport  A=1\n# export B=2\n' > .env
  [ "$(env_get .env KYOUBE_PORT)" = "3200" ]
  [ "$(env_get .env A)" = "1" ]
  [ "$(env_get .env B)" = "" ]
  [ "$(env_keys .env)" = "$(printf 'A\nB\nKYOUBE_PORT')" ]
  env_set .env KYOUBE_PORT 3300
  [ "$(cat .env)" = "$(printf 'export KYOUBE_PORT=3300\nexport  A=1\n# export B=2')" ]
  # env_merge sees the exported key as present, so it never appends the example's default after it
  printf 'KYOUBE_PORT=3100\nNEW=1\n' > example
  run env_merge example .env 1.1.0
  [ "$output" = "NEW" ]
  [ "$(env_get .env KYOUBE_PORT)" = "3300" ]
  [ -z "$(env_unused example .env | grep -x KYOUBE_PORT || true)" ]
}

@test "sha256_sums and sha256_check work with shasum alone, as on macOS" {
  command -v shasum >/dev/null || skip "shasum needed"
  mkdir -p only bk
  for tool in shasum perl; do ln -s "$(command -v "$tool")" "only/$tool"; done
  printf 'data\n' > bk/a.dump
  (cd bk && PATH="$BATS_TEST_TMPDIR/only" sha256_sums a.dump > SHA256SUMS)
  [ "$(cut -d' ' -f1 bk/SHA256SUMS)" = "$(sha256sum bk/a.dump | cut -d' ' -f1)" ]
  PATH="$BATS_TEST_TMPDIR/only" sha256_check bk
  # sha256sum checks what shasum wrote, and a changed file fails both
  sha256_check bk
  echo more >> bk/a.dump
  ! PATH="$BATS_TEST_TMPDIR/only" sha256_check bk || false
  ! sha256_check bk || false
}

@test "gen_secret is 64 lowercase hex characters" {
  [[ "$(gen_secret)" =~ ^[0-9a-f]{64}$ ]]
}

@test "url helpers" {
  [ "$(url_set_port http://localhost:3100 3198)" = "http://localhost:3198" ]
  [ "$(url_set_port http://localhost/app 3198)" = "http://localhost:3198/app" ]
  [ "$(url_origin https://kyoube.example.com:8443/x/y)" = "https://kyoube.example.com:8443" ]
  is_loopback_url http://localhost:3100
  is_loopback_url http://127.0.0.1
  ! is_loopback_url https://kyoube.example.com || false
}

@test "valid_url accepts http(s) addresses and refuses a bare port or host" {
  valid_url http://localhost:3300
  valid_url http://127.0.0.1
  valid_url https://kyoube.example.com
  valid_url https://kyoube.example.com:8443/app
  ! valid_url 3300 || false
  ! valid_url localhost:3300 || false
  ! valid_url kyoube.example.com || false
  ! valid_url ftp://kyoube.example.com || false
  ! valid_url http:// || false
  ! valid_url http://:3300 || false
  ! valid_url http://localhost:99999 || false
  ! valid_url http://localhost:abc || false
  ! valid_url "http://local host" || false
  ! valid_url "" || false
}

@test "split_image_ref splits at the tag, not a registry port" {
  [ "$(split_image_ref kyoubeai:smoke)" = "kyoubeai smoke" ]
  [ "$(split_image_ref localhost:5000/kyoube/app:9.9.0)" = "localhost:5000/kyoube/app 9.9.0" ]
}

@test "port_in_use sees a listening port" {
  command -v python3 >/dev/null || skip "python3 needed to open a port"
  python3 -c 'import socket,time; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); print(s.getsockname()[1], flush=True); time.sleep(5)' > port.txt &
  sleep 1
  port_in_use "$(cat port.txt)"
  kill $!
}

@test "confirm says yes under YES=1 without reading" {
  YES=1 confirm "Proceed?"
}

@test "record_source_build notes the commit and the image id of a source build, and survives a missing docker" {
  git init -q repo && cd repo
  git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\necho "sha256:built"\n' > "$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" record_source_build kyoubeai:dev
  [ "$(env_get "$KYOUBE_BUILT" commit)" = "$(git rev-parse HEAD)" ]
  [ "$(env_get "$KYOUBE_BUILT" image)" = "sha256:built" ]
  # a second build replaces the record
  git -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" record_source_build kyoubeai:dev
  [ "$(env_get "$KYOUBE_BUILT" commit)" = "$(git rev-parse HEAD)" ]
  [ "$(grep -c '^commit=' "$KYOUBE_BUILT")" = 1 ]
  # no docker answer: the commit is still recorded, the image id is empty (update.sh then compares times)
  printf '#!/bin/sh\nexit 1\n' > "$BATS_TEST_TMPDIR/bin/docker"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" record_source_build kyoubeai:dev
  [ "$(env_get "$KYOUBE_BUILT" commit)" = "$(git rev-parse HEAD)" ]
  [ -z "$(env_get "$KYOUBE_BUILT" image)" ]
}
