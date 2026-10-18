#!/usr/bin/env bash
# Updates KyoubeAI in this checkout: backs up, moves to the newest release (or
# --version), keeps your settings, restarts and checks. --rollback undoes the
# last update; --edge follows the current branch and rebuilds from source.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./update.sh [options]

  (no option)         Update to the newest release, after a backup
  --version <x.y.z>   Update to this release (never older than the current one)
  --rollback          Go back to the release and data from before the last update
  --edge              Follow the current branch: git pull and rebuild from source
  --yes               Answer yes to every question

An update that stopped before it finished is continued by running the same
command again (no second backup); --rollback undoes it instead. A rollback
that stopped part way is finished with ./update.sh --rollback. Without a
terminal, --rollback needs --yes.
EOF
}

STATE=.kyoube/update-state
ENV_BEFORE=.kyoube/env.before-update
# The .env a rollback replaced (settings changed after the update are in it).
ENV_REPLACED=.kyoube/env.before-rollback
# The branch an --edge update followed, kept after a rollback leaves the checkout detached.
LAST_BRANCH=.kyoube/last-branch

main() {
  KYOUBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$KYOUBE_DIR"
  # shellcheck source=scripts/lib/host.sh
  . "$KYOUBE_DIR/scripts/lib/host.sh"
  local want="" mode=release rollback=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) want="${2:?--version needs a value}"; shift ;;
      --edge) mode=edge ;;
      --rollback) rollback=1 ;;
      --yes|-y) YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see ./update.sh --help)" ;;
    esac
    shift
  done
  if [ -n "$want" ]; then
    is_release_version "${want#v}" || die "not a release version: $want (use e.g. --version 1.1.0)"
    want="${want#v}"
    version_ge "$want" "$KYOUBE_MIN_RELEASE" || die "update.sh moves to $KYOUBE_MIN_RELEASE or later (use e.g. --version $KYOUBE_MIN_RELEASE)"
  fi
  if [ "$rollback" = 1 ] && { [ "$mode" = edge ] || [ -n "$want" ]; }; then
    die "--rollback returns to the state before the last update and takes no --edge or --version"
  fi
  if [ "$mode" = edge ] && [ -n "$want" ]; then
    die "--edge follows the current branch and --version picks a release; use one of them"
  fi
  if [ ! -t 0 ]; then
    # Nobody can be asked. An update is undone by --rollback; a rollback replaces data and is undone by nothing.
    [ "$rollback" = 0 ] || [ "$YES" = 1 ] \
      || die "--rollback replaces everything written since the update's backup, and there is no terminal to ask; run ./update.sh --rollback --yes to confirm"
    YES=1
  fi
  [ -f .env ] || die "no .env here; install first with ./install.sh"
  if [ "$rollback" = 0 ] && [ "$(env_get "$STATE" rollback)" = 1 ]; then
    die "a rollback did not finish: run ./update.sh --rollback"
  fi
  docker_preflight
  pin_project_name
  if [ "$rollback" = 1 ]; then do_rollback; return; fi
  git diff --quiet HEAD -- || die "tracked files have local changes; stash them (git stash) and run again"
  if [ -n "$(env_get "$STATE" to)" ] && [ "$(env_get "$STATE" "done")" != 1 ]; then resume_update "$mode" "$want"; return; fi
  if [ "$mode" = edge ]; then update_edge; else update_release "$want"; fi
}

pin_project_name() {
  local project
  if [ -z "$(env_get .env COMPOSE_PROJECT_NAME)" ]; then
    project="$(resolve_project_name "$KYOUBE_DIR")"
    env_set .env COMPOSE_PROJECT_NAME "$project"
    say "    pinned COMPOSE_PROJECT_NAME=$project in .env (the name this install already uses)"
  fi
}

# harness_types_in_use: one "adapter_type count" line per kind of agent that is not terminated; nothing when the database cannot be read.
harness_types_in_use() {
  docker compose exec -T db psql -U kyoubeai -d kyoubeai -Atc \
    "select adapter_type || ' ' || count(*) from agents where status <> 'terminated' group by adapter_type order by 1" </dev/null 2>/dev/null | tr -d '\r' || true
}

# run_backup: sets BACKUP to the directory scripts/backup.sh wrote.
run_backup() {
  local log
  log="$(mktemp)"
  say "==> backing up (scripts/backup.sh)"
  if ! bash scripts/backup.sh | tee "$log"; then
    rm -f "$log"
    die "the backup failed; nothing was changed. Fix what the lines above report (the stack must be running: docker compose up -d), then run ./update.sh again"
  fi
  BACKUP="$(sed -n 's/^backup written to //p' "$log" | tail -1)"
  rm -f "$log"
  [ -n "$BACKUP" ] || die "the backup did not say where it wrote; nothing was changed. Run bash scripts/backup.sh and check its output, then run ./update.sh again"
}

# save_state MODE FROM_LABEL TO_LABEL [REF]: the rollback point (REF, default the current commit); done=0 until the
# update has restarted on the new version. STATE and its .env copy are written whole to temp files first; the old
# STATE goes before either is renamed into place, so a run killed half way leaves no state that pairs one update's
# rollback point with another's .env. Later changes to STATE go through env_set, which also renames a whole file.
save_state() {
  local ref="${4:-}" state_tmp env_tmp
  [ -n "$ref" ] || ref="$(git rev-parse HEAD)"
  mkdir -p .kyoube
  env_tmp="$(mktemp "$ENV_BEFORE.XXXXXX")"
  state_tmp="$(mktemp "$STATE.XXXXXX")"
  cp .env "$env_tmp"
  {
    printf 'mode=%s\n' "$1"
    printf 'from=%s\n' "$2"
    printf 'to=%s\n' "$3"
    printf 'done=0\n'
    printf 'ref=%s\n' "$ref"
    printf 'head=%s\n' "$(git rev-parse HEAD)"
    printf 'branch=%s\n' "$(git symbolic-ref --quiet --short HEAD || true)"
    printf 'image=%s\n' "$(env_get .env KYOUBE_IMAGE)"
    printf 'version=%s\n' "$(env_get .env KYOUBE_VERSION)"
    printf 'backup=%s\n' "$BACKUP"
  } > "$state_tmp"
  rm -f "$STATE"
  mv -f "$env_tmp" "$ENV_BEFORE"
  mv -f "$state_tmp" "$STATE"
}

# short COMMIT: the abbreviated id git prints for COMMIT.
short() { git rev-parse --short "$1" 2>/dev/null || printf '%s\n' "$1"; }

merge_settings() { # LABEL
  local added unused example_core
  added="$(env_merge .env.example .env "$1")"
  # shellcheck disable=SC2086  # word splitting turns the newline-separated keys into one line
  [ -z "$added" ] || say "    added to .env: $(printf '%s ' $added)"
  example_core="$(env_get .env.example KYOUBE_CORE_VERSION)"
  if [ -n "$example_core" ] && [ "$(env_get .env KYOUBE_CORE_VERSION)" != "$example_core" ]; then
    env_set .env KYOUBE_CORE_VERSION "$example_core"
    say "    KYOUBE_CORE_VERSION=$example_core (the core this code is built for)"
  fi
  unused="$(env_unused .env.example .env | grep -vx COMPOSE_PROJECT_NAME || true)"
  # shellcheck disable=SC2086
  [ -z "$unused" ] || say "    not used by this version (left in .env): $(printf '%s ' $unused)"
}

restart_and_check() { # TARGET_LABEL
  local log bad
  say "==> restarting on $1"
  if ! docker compose up -d --no-build --wait --wait-timeout 300; then
    docker compose logs --tail 50 app >&2 || true
    die "KyoubeAI did not come back healthy on $1. To return to the version and data from before this update: ./update.sh --rollback"
  fi
  offer_harnesses
  log="$(mktemp)"
  # A fresh agent-rules pass first, so doctor's `agent rules` line reads it rather than a pass from
  # before this restart (the background loop makes its first pass up to a minute later).
  dc_exec_node app kyoube agent-rules --once >/dev/null 2>&1 || true
  dc_exec_node app kyoube doctor | tee "$log" || true
  bad="$(grep '^FAIL' "$log" | grep -v '^FAIL harnesses in use' || true)"
  rm -f "$log"
  [ -z "$bad" ] || warn "kyoube doctor reports a problem after the update. If it does not clear up, ./update.sh --rollback returns to the version and data from before it."
}

# offer_harnesses: for each harness the agents here use (USED) that the updated image lacks, offer to install it.
offer_harnesses() {
  local types missing name
  types="$(printf '%s\n' "${USED:-}" | awk 'NF { print $1 }')"
  [ -n "$types" ] || return 0
  # shellcheck disable=SC2086  # $types is one adapter type per line; splitting makes them arguments
  missing="$(dc_exec_node app kyoube harness missing $types </dev/null | tr -d '\r')" \
    || { warn "could not check which harnesses the agents here need; run kyoube doctor in the Terminal to see them"; return 0; }
  # shellcheck disable=SC2086
  for name in $missing; do
    if confirm "Agents here use $name, which is not installed. Install it now?"; then
      dc_exec_node app kyoube harness install "$name" || warn "installing $name failed; later, from the Terminal: kyoube harness install $name"
    else
      say "    later, from the Terminal: kyoube harness install $name"
    fi
  done
}

# release_image_repo: the image repository a release install runs; an install that built its own image (a local
# repository, with no '/') moves to the published one, and so does one on the repository releases used to be
# published to.
release_image_repo() {
  local repo
  repo="$(env_get .env KYOUBE_IMAGE)"
  case "$repo" in */*) ;; *) repo="$KYOUBE_IMAGE_DEFAULT" ;; esac
  [ "$repo" != "$KYOUBE_IMAGE_LEGACY" ] || repo="$KYOUBE_IMAGE_DEFAULT"
  printf '%s\n' "$repo"
}

# is_ancestor A B: true when commit A is part of B's history (or is B). The code a stack runs has to be, or the
# "update" would put older or unrelated code on data a newer release migrated.
is_ancestor() { git merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# earlier_commit: where HEAD was before it last moved, when that is an earlier commit of this checkout; else status 1.
earlier_commit() {
  local ref
  ref="$(git rev-parse -q --verify 'HEAD@{1}^{commit}' 2>/dev/null || true)"
  [ -n "$ref" ] && [ "$ref" != "$(git rev-parse HEAD)" ] && is_ancestor "$ref" HEAD || return 1
  printf '%s\n' "$ref"
}

# iso_epoch TIMESTAMP: seconds since the epoch of an RFC 3339 time (2026-09-30T12:34:56.789Z, 2026-09-30T14:34:56+02:00);
# prints nothing for anything else. awk does the arithmetic because GNU date -d and BSD date -j -f disagree.
iso_epoch() {
  printf '%s\n' "$1" | awk '
    function num(s) { return s + 0 }
    NR == 1 {
      if (!match($0, /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) exit
      y = num(substr($0, 1, 4)); m = num(substr($0, 6, 2)); d = num(substr($0, 9, 2))
      hh = num(substr($0, 12, 2)); mi = num(substr($0, 15, 2)); ss = num(substr($0, 18, 2))
      rest = substr($0, 20)
      sub(/^\.[0-9]+/, "", rest)
      off = 0
      if (rest ~ /^[+-][0-9][0-9]:?[0-9][0-9]$/) {
        off = num(substr(rest, 2, 2)) * 3600 + num(substr(rest, length(rest) - 1, 2)) * 60
        if (substr(rest, 1, 1) == "-") off = -off
      } else if (rest != "Z" && rest != "z") exit
      if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) exit
      if (m <= 2) y -= 1
      era = int((y >= 0 ? y : y - 399) / 400)
      yoe = y - era * 400
      doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
      days = era * 146097 + yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy - 719468
      printf "%.0f\n", days * 86400 + hh * 3600 + mi * 60 + ss - off
    }'
}

# tag_replaced: status 0, with BEHIND_WHY set, when the source image's tag is missing or names a different image than
# the stack's app container runs (another source install on this machine that uses the same tag rebuilt it, or a
# build by hand): the next `docker compose up` would start that image on this stack's data. Status 1 otherwise.
tag_replaced() {
  local ref tag_id stack_id
  ref="$(image_ref .env)"
  tag_id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null </dev/null)" \
    || { BEHIND_WHY="the image $ref is not on this machine; rebuilding"; return 0; }
  stack_id="$(stack_image_id)"
  [ -n "$stack_id" ] && [ "$stack_id" != "$tag_id" ] || return 1
  BEHIND_WHY="the image $ref has been rebuilt since this stack's app container was created (by another source install on this machine that uses the same tag, or by hand; give each install its own KYOUBE_IMAGE, docs/operations.md); rebuilding"
}

# source_image_behind: status 0 when the source image is missing, is not the one the app container runs (tag_replaced),
# or was built before this checkout's commit, with BEHIND_WHY set to the reason; status 1 when it is as new, or when
# the two times cannot be compared.
source_image_behind() {
  local ref built committed
  tag_replaced && return 0
  ref="$(image_ref .env)"
  built="$(docker image inspect -f '{{.Created}}' "$ref" 2>/dev/null </dev/null)" \
    || { BEHIND_WHY="the image $ref is not on this machine; rebuilding"; return 0; }
  built="$(iso_epoch "$built")"
  committed="$(iso_epoch "$(git log -1 --format=%cI HEAD 2>/dev/null || true)")"
  if [ -n "$built" ] && [ -n "$committed" ] && [ "$built" -lt "$committed" ]; then
    BEHIND_WHY="the image is older than this checkout; rebuilding"
    return 0
  fi
  return 1
}

# stack_position MODE [TARGET]: the commit the running stack's code came from, read once before anything changes (MODE is
# release or edge). What .env selects is what runs, whatever this checkout is on: a release's tag; the commit a source
# build was recorded as built from; failing that a guess from where this checkout was before. Sets POS_COMMIT, POS_LABEL
# and POS_KIND (release | record | guess); for a guess in edge mode POS_STALE=1 (with BEHIND_WHY) when the image is
# missing or older than the checkout. Dies when the code cannot be told.
stack_position() {
  local mode="$1" target="${2:-the release}" stack tag
  POS_KIND=""; POS_COMMIT=""; POS_LABEL=""; POS_STALE=0; BEHIND_WHY=""
  stack="$(env_get .env KYOUBE_VERSION)"
  if is_release_version "$stack"; then
    tag="v$stack"
    git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null 2>&1 || git fetch --tags --quiet origin 2>/dev/null || true
    POS_COMMIT="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null || true)"
    [ -n "$POS_COMMIT" ] \
      || die "this stack runs $tag (KYOUBE_VERSION in .env), but git has no tag $tag here, so the code it runs cannot be found; nothing was changed. Run git fetch --tags; if origin has no such tag, set KYOUBE_VERSION in .env to the release the stack really runs (docker compose images shows it), then run ./update.sh again"
    POS_KIND=release; POS_LABEL="$tag"
  elif runs_source_build .env; then
    POS_LABEL="source build"
    if POS_COMMIT="$(build_record)"; then
      POS_KIND=record
    else
      POS_KIND=guess
      if [ "$mode" = edge ]; then
        # An image at least as new as the checkout was built from it; an older one, from where this branch was before.
        if source_image_behind; then POS_STALE=1; POS_COMMIT="$(earlier_commit || true)"; fi
        [ -n "$POS_COMMIT" ] || POS_COMMIT="$(git rev-parse HEAD)"
      else
        POS_COMMIT="$(earlier_commit || true)"
        [ -n "$POS_COMMIT" ] \
          || die "this stack runs a source build, and nothing shows which code it was built from (there is no record of the image here in $KYOUBE_BUILT, and this checkout has no earlier position to go by), so there is no rollback point to record; nothing was changed. If it was built from older code, check out that commit (git checkout <commit>), then git checkout $target, then run ./update.sh again. To keep running from source instead: git checkout <your branch>, then ./update.sh --edge"
      fi
    fi
  else
    die "KYOUBE_VERSION=$stack and KYOUBE_IMAGE=$(env_get .env KYOUBE_IMAGE) in .env are neither a release (x.y.z) nor the source build (KYOUBE_VERSION=dev with a local KYOUBE_IMAGE such as kyoubeai), so update.sh cannot tell which code the stack runs; nothing was changed. Set KYOUBE_VERSION in .env to the release the stack runs (for example KYOUBE_VERSION=1.1.0 with KYOUBE_IMAGE=$KYOUBE_IMAGE_DEFAULT; docker compose images shows it), then run ./update.sh again"
  fi
}

# require_forward NEW_COMMIT NEW_LABEL MODE: databases only migrate forward, so the code the stack runs (stack_position)
# has to be part of the history of the code the update moves to. Dies, before anything is changed, when it is not.
require_forward() {
  local new="$1" label="$2" mode="$3" short fix
  is_ancestor "$POS_COMMIT" "$new" && return 0
  short="$(git rev-parse --short "$POS_COMMIT")"
  case "$POS_KIND" in
    release)
      if [ "$mode" = edge ]; then
        fix="Check out a branch that contains $POS_LABEL (git branch -a --contains $POS_LABEL lists them), then run ./update.sh --edge there"
      else
        fix="Check out $POS_LABEL (git checkout $POS_LABEL) and run ./update.sh --version <x.y.z> with a release that contains it (releases: https://github.com/KyoubeAI/KyoubeAI/releases)"
      fi ;;
    record) fix="Check out the branch the stack was built from (git branch --contains $short lists them), then run ./update.sh --edge there" ;;
    *) fix="Check out the commit the stack was built from (git checkout <commit>), then update again from there" ;;
  esac
  die "the code this stack runs ($POS_LABEL, $short) is not part of $label's history, so the update could put older or different code on data that newer code has migrated; nothing was changed. $fix"
}

update_release() {
  local want="$1" current target from image_repo new_ref point stack newcode here
  # A commit can carry several tags (v1.2.0 and v1.2.0-rc1); only a release tag counts.
  current="$(git tag --points-at HEAD 2>/dev/null | latest_release "$KYOUBE_MIN_RELEASE" || true)"
  git fetch --tags --quiet origin || die "could not fetch releases from origin; check the network and run ./update.sh again"
  if [ -n "$want" ]; then
    target="v$want"
    git rev-parse -q --verify "refs/tags/$target" >/dev/null || die "release $target does not exist (releases: https://github.com/KyoubeAI/KyoubeAI/releases)"
  else
    target="$(git tag -l 'v*' | latest_release "$KYOUBE_MIN_RELEASE" || true)"
    [ -n "$target" ] || die "no release ($KYOUBE_MIN_RELEASE or later) found; to follow the current code instead: ./update.sh --edge"
  fi
  # HEAD may carry more than one release tag; the one asked for is enough.
  if git tag --points-at HEAD 2>/dev/null | grep -Fx "$target" >/dev/null; then current="$target"; fi
  here="${current:-$(git rev-parse --short HEAD)}"
  if [ "$current" = "$target" ]; then
    :  # nothing to check out
  elif [ -n "$current" ]; then
    version_ge "${target#v}" "${current#v}" \
      || die "$target is older than $current; databases only migrate forward. To go back after an update: ./update.sh --rollback"
  else
    # On a branch or an untagged commit: the release has to contain this code, or it would be older.
    git merge-base --is-ancestor HEAD "refs/tags/$target" \
      || die "this checkout ($(git rev-parse --short HEAD)) is not part of $target's history, so $target may be older than the code here; databases only migrate forward. To keep following this branch: ./update.sh --edge. To go back after an update: ./update.sh --rollback"
  fi
  # What the stack runs is what .env selects, whatever this checkout is on (a 1.0 install gets update.sh by checking out
  # the new code, so the checkout is ahead of the stack).
  stack="$(env_get .env KYOUBE_VERSION)"
  if is_release_version "$stack"; then
    version_ge "${target#v}" "$stack" \
      || die "$target is older than v$stack, the release this stack runs; databases only migrate forward. Check out v$stack or a newer release (git fetch --tags, then git checkout v$stack) and run ./update.sh again"
  fi
  stack_position release "$target"
  newcode="$(git rev-parse "refs/tags/$target^{commit}")"
  if [ "$POS_COMMIT" = "$newcode" ]; then
    # The stack already runs this code: nothing to back up or restart; only the checkout may need to match.
    if ! git tag --points-at HEAD 2>/dev/null | grep -Fx "$target" >/dev/null; then
      git -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$target" \
        || die "the stack already runs $target, but this checkout could not be switched to it; nothing else was changed. Fix what git reported (git status), then run ./update.sh again"
      say "    moved this checkout to $target"
    fi
    say "already on $target"
    return
  fi
  require_forward "$newcode" "$target" release
  from="$POS_LABEL"; point="$POS_COMMIT"
  [ "$from" = "$current" ] || say "    the stack runs $from; this checkout is at $here"
  image_repo="$(release_image_repo)"
  if [ "$(env_get .env KYOUBE_IMAGE)" = "$KYOUBE_IMAGE_LEGACY" ]; then
    say "    the published image moved from $KYOUBE_IMAGE_LEGACY to $image_repo; this install switches to it"
  elif [ "$image_repo" != "$(env_get .env KYOUBE_IMAGE)" ]; then
    say "    this install built its own image; from now on it uses the published one (./update.sh --edge keeps building from source)"
  fi
  new_ref="$image_repo:${target#v}"
  say "Update KyoubeAI $from -> $target"
  say "Release notes: https://github.com/KyoubeAI/KyoubeAI/blob/$target/CHANGELOG.md"
  confirm "A backup is taken first. Continue?" || { say "Nothing was changed."; exit 1; }
  if ! docker image inspect "$new_ref" >/dev/null 2>&1; then
    say "==> downloading $new_ref before changing anything"
    docker pull "$new_ref" || die "could not download $new_ref; nothing was changed. If the error said 'denied', see docs/operations.md, 'The published image on GHCR'; otherwise check the network, then run ./update.sh again"
  fi
  USED="$(harness_types_in_use)"
  [ -z "$USED" ] || say "    agents use: $(printf '%s' "$USED" | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
  run_backup
  save_state release "$from" "$target" "$point"
  release_apply "$target" "$from"
}

# release_apply TARGET FROM: everything after the backup; safe to run again (resume_update does).
release_apply() {
  local target="$1" from="$2"
  # refs/tags/: a local branch with the release's name never takes the checkout.
  if ! git tag --points-at HEAD 2>/dev/null | grep -Fx "$target" >/dev/null; then
    git -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$target" \
      || die "could not switch this checkout to $target; nothing else was changed. Fix what git reported and run ./update.sh again to continue, or ./update.sh --rollback to undo"
  fi
  merge_settings "${target#v}"
  env_set .env KYOUBE_IMAGE "$(release_image_repo)"
  env_set .env KYOUBE_VERSION "${target#v}"
  restart_and_check "$target"
  env_set "$STATE" "done" 1
  say "updated to $target. The pre-update backup is $BACKUP; ./update.sh --rollback returns to $from."
}

update_edge() {
  local branch upstream behind from to newcode newlabel why="" recorded
  if ! branch="$(git symbolic-ref --quiet --short HEAD)"; then
    recorded="$(env_get "$STATE" branch)"; [ -n "$recorded" ] || recorded="$(env_get "$LAST_BRANCH" branch)"
    die "--edge follows a branch, but this checkout is not on one (a release tag or a commit is checked out); git checkout ${recorded:-<your branch>} first${recorded:+ (the branch the last --edge update followed)}"
  fi
  upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)" || die "branch $branch has no upstream to pull from; git branch --set-upstream-to origin/$branch"
  git fetch --quiet || die "could not fetch from origin; check the network and run ./update.sh --edge again"
  behind="$(git rev-list --count "HEAD..@{u}")" || die "could not compare $branch with $upstream; run git status"
  # The code the update moves to, and the code the stack runs; the first has to contain the second.
  if [ "$behind" != 0 ]; then newcode="$(git rev-parse '@{u}')"; newlabel="$upstream"; else newcode="$(git rev-parse HEAD)"; newlabel="this checkout"; fi
  stack_position edge
  case "$POS_KIND" in
    record)
      # The image is exactly as new as the checkout when it was built from the commit the update moves to, and is
      # still the one its tag names (the next `docker compose up` starts whatever the tag names).
      if [ "$behind" = 0 ]; then
        if [ "$POS_COMMIT" != "$newcode" ]; then
          why="the image was built from $(short "$POS_COMMIT"), not from this checkout; rebuilding"
        elif tag_replaced; then
          why="$BEHIND_WHY"
        else
          say "already up to date with $upstream"; return
        fi
      fi ;;
    guess)
      if [ "$behind" = 0 ]; then
        [ "$POS_STALE" = 1 ] || { say "already up to date with $upstream"; return; }
        why="$BEHIND_WHY"
      fi ;;
  esac
  # A published image gets one rebuild from source even when the branch has nothing new.
  from="$branch@$(git rev-parse --short "$POS_COMMIT")"
  [ "$POS_KIND" != release ] || from="$POS_LABEL"
  if [ "$behind" != 0 ]; then
    git merge-base --is-ancestor HEAD '@{u}' \
      || die "branch $branch has diverged from $upstream (it has commits $upstream lacks, and the other way round); nothing was changed. Rebase it onto $upstream or merge $upstream into it (git status), then run ./update.sh --edge again"
    to="$branch@$(git rev-parse --short '@{u}')"
  else
    to="$branch@$(git rev-parse --short HEAD)"
  fi
  require_forward "$newcode" "$newlabel" edge
  if [ "$behind" != 0 ]; then
    say "Update KyoubeAI $from -> $upstream ($behind new commits), then rebuild from source"
  elif [ -n "$why" ]; then
    say "Update KyoubeAI $from -> $to: no new commits, but $why"
  else
    say "Update KyoubeAI $from -> $to: no new commits, but this install runs a published image; it will be rebuilt from source"
  fi
  if [ "$POS_KIND" = guess ] && [ "$POS_STALE" = 1 ] && [ "$POS_COMMIT" = "$(git rev-parse HEAD)" ]; then
    say "    no earlier commit of this branch is known here, so ./update.sh --rollback returns the data but not older code"
  fi
  confirm "A backup is taken first. Continue?" || { say "Nothing was changed."; exit 1; }
  USED="$(harness_types_in_use)"
  run_backup
  save_state edge "$from" "$to" "$POS_COMMIT"
  edge_apply "$from"
}

# edge_apply FROM: everything after the backup; safe to run again (resume_update does).
edge_apply() {
  local from="$1" pending started branch
  # The fast-forward is still to do while the branch sits where the update started (ref is the rollback point, which can be earlier).
  started="$(env_get "$STATE" head)"; [ -n "$started" ] || started="$(env_get "$STATE" ref)"
  branch="$(env_get "$STATE" branch)"
  # A resume builds what is checked out, so the checkout must not have gone back past where the update started.
  is_ancestor "$started" HEAD \
    || die "this checkout ($(short HEAD)) does not contain $(short "$started"), where the unfinished update started, so resuming it would build older or different code; nothing was changed. Check out ${branch:-the branch} at $(short "$started") or later (git checkout ${branch:-<branch>}), then run ./update.sh --edge to resume, or ./update.sh --rollback to undo the update"
  if [ "$(git rev-parse HEAD)" = "$started" ]; then
    pending="$(git rev-list --count "HEAD..@{u}")" || die "could not compare this branch with its upstream; run git status"
    if [ "$pending" != 0 ]; then
      git merge --ff-only --quiet '@{u}' \
        || die "git merge --ff-only failed; the code was not changed. Fix what git reported (git status), then run ./update.sh --edge again to continue, or ./update.sh --rollback to undo"
    fi
  fi
  # Where the update left the branch: a rollback moves the branch back only while it is still here.
  [ -n "$(env_get "$STATE" after)" ] || env_set "$STATE" after "$(git rev-parse HEAD)"
  if ! runs_source_build .env; then
    say "    switching this install from the published image to a source build"
    env_set .env KYOUBE_IMAGE kyoubeai
    env_set .env KYOUBE_VERSION dev
  fi
  merge_settings "edge-$(git rev-parse --short HEAD)"
  say "==> building (10-25 minutes when the core changed)"
  docker compose build app || die "the build failed; the stack still runs the previous image. To try again: ./update.sh --edge. To go back to the previous code: ./update.sh --rollback"
  record_source_build "$(image_ref .env)"
  restart_and_check "$(git symbolic-ref --quiet --short HEAD || true)@$(git rev-parse --short HEAD)"
  env_set "$STATE" "done" 1
  say "updated. The pre-update backup is $BACKUP; ./update.sh --rollback returns to $from."
}

# resume_update MODE WANT: the last update stopped before it finished. Continue it when this run asks for the same
# update (no new backup, the rollback point stays); refuse anything else so the rollback point is not replaced.
resume_update() {
  local mode="$1" want="$2" smode to from resume="./update.sh"
  smode="$(env_get "$STATE" mode)"; to="$(env_get "$STATE" to)"; from="$(env_get "$STATE" from)"; BACKUP="$(env_get "$STATE" backup)"
  if [ "$smode" = edge ]; then resume="./update.sh --edge"; fi
  if [ "$mode" != "$smode" ] || { [ "$mode" = release ] && [ -n "$want" ] && [ "v$want" != "$to" ]; }; then
    die "an update to $to did not finish: run $resume to resume it, or ./update.sh --rollback to undo it"
  fi
  say "resuming the unfinished update to $to (the pre-update backup $BACKUP is kept for --rollback)"
  USED="$(harness_types_in_use)"
  if [ "$mode" = edge ]; then edge_apply "$from"; else release_apply "$to" "$from"; fi
}

do_rollback() {
  local mode ref branch backup from again previous sums notes=""
  [ -f "$STATE" ] || die "there is no update to roll back. To restore any backup: bash scripts/restore.sh backups/<timestamp>"
  mode="$(env_get "$STATE" mode)"; ref="$(env_get "$STATE" ref)"; branch="$(env_get "$STATE" branch)"
  backup="$(env_get "$STATE" backup)"; from="$(env_get "$STATE" from)"
  if [ -z "$ref" ] || [ -z "$backup" ] || [ ! -f "$ENV_BEFORE" ]; then
    die "$STATE is incomplete. To restore a backup by hand: bash scripts/restore.sh backups/<timestamp>"
  fi
  [ -d "$backup" ] || die "the backup taken before the update ($backup) is gone; restore another with bash scripts/restore.sh <backup dir>"
  from="${from:-$(short "$ref")}"
  git diff --quiet HEAD -- || die "tracked files have local changes; stash them (git stash) and run again"
  # Before anything stops: a backup that does not match its checksums would leave neither the update nor the data
  # from before it.
  sums="$(sha256_check "$backup" 2>&1)" || {
    printf '%s\n' "$sums" >&2
    die "the backup $backup does not match its SHA256SUMS (above), so it cannot be restored safely; nothing was changed. To restore another backup by hand: bash scripts/restore.sh <backup dir>"
  }
  say "Roll back to $from and restore $backup."
  say "Everything written since that backup (tasks, data, files) is replaced, and .env goes back to its copy from before the update."
  confirm "Roll back?" || { say "Nothing was changed."; exit 1; }
  # A published image is never rebuilt here (a build would tag source code with the release's name);
  # make sure it is on this machine before anything is stopped.
  if ! runs_source_build "$ENV_BEFORE"; then
    previous="$(image_ref "$ENV_BEFORE")"
    if ! docker image inspect "$previous" >/dev/null 2>&1; then
      say "==> downloading $previous before changing anything"
      docker pull "$previous" || die "could not download $previous, the image this rollback returns to; nothing was changed. Check the network, then run ./update.sh --rollback again"
    fi
  fi
  # A step that fails leaves $STATE in place, marked rollback=1: every run but --rollback then refuses, so nothing
  # resumes the update or backs up and boots the half-restored data; ./update.sh --rollback continues.
  again="Fix what is reported above, then run ./update.sh --rollback again."
  env_set "$STATE" rollback 1 || die "could not write $STATE; nothing was changed"
  docker compose stop app || die "could not stop the app. $again"
  if [ "$mode" = edge ] && [ -n "$branch" ]; then
    rollback_branch "$branch" "$ref" "$from"
  else
    git -c advice.detachedHead=false checkout --quiet --detach "$ref" || die "could not switch this checkout back to $(short "$ref"). $again"
  fi
  # .env goes back wholesale; the one it replaces keeps any setting changed after the update. A second run finds .env
  # already restored and leaves that copy alone.
  if ! cmp -s .env "$ENV_BEFORE"; then
    cp .env "$ENV_REPLACED" || die "could not keep a copy of .env as $ENV_REPLACED. $again"
    env_set "$STATE" env_replaced 1 || die "could not write $STATE. $again"
  fi
  cp "$ENV_BEFORE" .env || die "could not restore .env from $ENV_BEFORE. $again"
  if [ "$mode" = edge ] && runs_source_build .env; then
    docker compose build app || die "the build of the previous code failed. $again"
    record_source_build "$(image_ref .env)"
  fi
  # restore.sh needs the database running. Then the app container is recreated on the old image without starting it
  # (and without touching other services), so the new version never boots onto the restored data; restore.sh starts it.
  docker compose up -d --no-build --no-deps --wait --wait-timeout 120 db || die "could not start the database. $again"
  docker compose up -d --no-build --no-deps --no-start app || die "could not recreate the app on the previous image. $again"
  bash scripts/restore.sh "$backup" || die "the restore failed, so the data may be half restored. $again"
  docker compose up -d --no-build --wait --wait-timeout 300 \
    || die "KyoubeAI did not come back healthy after the rollback; see docker compose logs app. $again"
  dc_exec_node app kyoube doctor || true
  if [ "$(env_get "$STATE" env_replaced)" = 1 ]; then
    notes="${notes:+$notes
}    the .env this rollback replaced is kept as $ENV_REPLACED; copy back any setting you changed after the update"
  fi
  rm -f "$STATE" "$ENV_BEFORE"
  say "rolled back to $from"
  [ -z "$notes" ] || say "$notes"
}

# rollback_branch BRANCH REF FROM: puts the checkout of an --edge update back on REF, the code the stack ran before it.
# BRANCH goes back to where it stood before the update (head=) only while it is still where the update left it
# (after=): that undoes the update's own fast-forward, which may be nothing, and keeps every commit it had before.
# Commits made on it after the update are never dropped: then it is left alone. REF is checked out detached unless it
# is the branch's own tip; a release's tag is only its label. Sets `notes` (do_rollback's) to what to tell the user, and
# records BRANCH in LAST_BRANCH while the checkout is detached, so a later --edge refusal can name it.
rollback_branch() {
  local branch="$1" ref="$2" from="$3" head after tip label
  head="$(env_get "$STATE" head)"; [ -n "$head" ] || head="$ref"
  after="$(env_get "$STATE" after)"
  tip="$(git rev-parse -q --verify "refs/heads/$branch^{commit}" 2>/dev/null || true)"
  label="$(short "$ref")"
  if is_release_version "${from#v}" && [ "$(git rev-parse -q --verify "refs/tags/$from^{commit}" 2>/dev/null || true)" = "$ref" ]; then label="$from"; fi
  if [ -n "$tip" ] && { [ "$tip" = "$head" ] || [ "$tip" = "$after" ]; }; then
    if [ "$tip" != "$head" ]; then
      git checkout --quiet "$branch" || die "could not switch back to branch $branch. $again"
      git reset --quiet --keep "$head" || die "could not move $branch back to $(short "$head"). $again"
    fi
    if [ "$ref" = "$head" ]; then
      git checkout --quiet "$branch" || die "could not switch back to branch $branch. $again"
      return 0
    fi
    git -c advice.detachedHead=false checkout --quiet --detach "$ref" || die "could not switch this checkout to ${label}. $again"
    notes="    this checkout is at $label, not on a branch; $branch keeps its own commits. To follow it again: git checkout $branch"
  else
    git -c advice.detachedHead=false checkout --quiet --detach "$ref" || die "could not switch this checkout to ${label}. $again"
    if [ -z "$tip" ]; then
      notes="    branch $branch no longer exists; this checkout is at $label, not on a branch"
    elif [ -n "$after" ] && is_ancestor "$after" "$tip"; then
      notes="    $branch has commits made after the update; left it at $(short "$tip"); this checkout is at $label, not on a branch. To follow it again: git checkout $branch"
    else
      notes="    $branch has moved since the update; left it at $(short "$tip"); this checkout is at $label, not on a branch. To follow it again: git checkout $branch"
    fi
  fi
  [ -z "$tip" ] || printf 'branch=%s\n' "$branch" > "$LAST_BRANCH" || true
}

main "$@"
