#!/usr/bin/env bash
# Resolve a Sync Upstream conflict branch mechanically and safely.
#
# Scope: only src/i18n/locales/*.json may be auto-resolved. Any other
# conflict file stops the run for a human. No code from the conflict
# branch is executed here; the PR's CI runs `bun run verify`.
#
# Usage:
#   scripts/sync-conflict-resolve.sh prepare --run-id <id>
#   scripts/sync-conflict-resolve.sh finish
#
# Exit codes:
#   0  ready / done / nothing to do (see stdout)
#   2  needs human (unsafe or unverifiable state)
#   3  stale / no matching branch (informational; do not open a PR)
#
# Env overrides: REPO, WORKDIR, STATE_FILE, LOCK_FILE, DRY_RUN.

set -euo pipefail

REPO="${REPO:-Jack-261108/Cli-Proxy-API-Management-Center}"
WORKDIR="${WORKDIR:-$(pwd)}"
STATE_FILE="${STATE_FILE:-/tmp/mgmt-sync-conflict.state}"
LOCK_FILE="${LOCK_FILE:-/tmp/mgmt-sync-conflict.lock}"
DRY_RUN="${DRY_RUN:-0}"
GIT_NAME="${GIT_NAME:-mgmt-ci-autofix}"
GIT_EMAIL="${GIT_EMAIL:--mgmt-ci-autofix@users.noreply.github.com}"
ALLOW_RE='^src/i18n/locales/[A-Za-z0-9._-]+\.json$'

die() { printf 'NEEDS_HUMAN: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"
}

acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock -w 900 9 || die "another sync-conflict run holds the lock"
  else
    note "WARN: flock not found; proceeding without a lock (the target host has flock)"
  fi
}

require_clean_workdir() {
  local dirty
  dirty="$(git status --porcelain)" || die "git status failed"
  [ -z "$dirty" ] || die "workdir is not clean; refusing to reset or overwrite it:
$dirty"
}

find_branch() {
  local run_id="$1" b found=""
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    if git show "origin/$b:.sync-conflict.json" 2>/dev/null \
         | jq -e --arg r "$run_id" '(.run_id | tostring) == $r' >/dev/null 2>&1; then
      found="$b"
      break
    fi
  done < <(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin/sync-conflict/ 2>/dev/null)
  printf '%s' "$found"
}

state_get() {
  local key="$1"
  sed -n "s/^${key}=//p" "$STATE_FILE" | head -n 1
}

state_files() {
  awk '/^CONFLICT_FILES_BEGIN$/{on=1;next} /^CONFLICT_FILES_END$/{on=0} on' "$STATE_FILE"
}

cmd_prepare() {
  local run_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --run-id) run_id="${2:-}"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$run_id" ] || die "--run-id is required"
  [[ "$run_id" =~ ^[0-9]+$ ]] || die "run-id must be numeric"

  need git; need jq; need gh
  cd "$WORKDIR"
  acquire_lock

  if [ -f "$STATE_FILE" ]; then
    local old_token; old_token="$(state_get TOKEN || true)"
    if [ -n "$old_token" ] && [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)" = "$(state_get TARGET_BRANCH || true)" ]; then
      note "IN_PROGRESS: state file exists for branch $(state_get TARGET_BRANCH)."
      note "Finish it, or remove $STATE_FILE after confirming no run is active."
      exit 0
    fi
    die "stale state file $STATE_FILE; inspect and remove it before retrying"
  fi

  require_clean_workdir
  git fetch origin --prune --quiet || die "git fetch origin failed"
  git fetch origin main --quiet || die "git fetch origin main failed"

  local target; target="$(find_branch "$run_id")"
  if [ -z "$target" ]; then
    note "NO_BRANCH: no sync-conflict branch matches run_id=$run_id"
    exit 3
  fi
  case "$target" in sync-conflict/*) ;; *) die "unexpected branch name: $target" ;; esac

  local manifest upstream_sha base_sha repo_before
  manifest="$(git show "origin/$target:.sync-conflict.json" 2>/dev/null)" \
    || die "cannot read .sync-conflict.json from origin/$target"
  printf '%s' "$manifest" | jq -e . >/dev/null 2>&1 || die "manifest is not valid JSON"
  upstream_sha="$(printf '%s' "$manifest" | jq -r '.upstream_sha // empty')"
  base_sha="$(printf '%s' "$manifest" | jq -r '.base_sha // empty')"
  repo_before="$(printf '%s' "$manifest" | jq -r '.repo_sha_before // empty')"
  [[ "$upstream_sha" =~ ^[0-9a-f]{40}$ ]] || die "bad upstream_sha in manifest"
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || die "bad base_sha in manifest"
  [[ "$repo_before" =~ ^[0-9a-f]{40}$ ]] || die "bad repo_sha_before in manifest"

  if git merge-base --is-ancestor "$upstream_sha" origin/main; then
    note "STALE: upstream $upstream_sha is already in origin/main; nothing to resolve"
    exit 3
  fi

  local files bad=""
  files="$(printf '%s' "$manifest" | jq -r '.conflict_files[]?' | sort -u)"
  [ -n "$files" ] || die "manifest has no conflict_files"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in /*|*..*) die "unsafe conflict path: $f" ;; esac
    [[ "$f" =~ $ALLOW_RE ]] || bad="$bad $f"
  done <<< "$files"
  [ -z "$bad" ] || die "non-locale conflict files (human must resolve):$bad"

  if [ "$DRY_RUN" != "1" ]; then
    local pr_json
    if ! pr_json="$(gh pr list --repo "$REPO" --head "$target" --state all --limit 100 \
          --json number,url,state 2>/dev/null)"; then
      die "gh pr list failed; refusing to touch the branch"
    fi
    printf '%s' "$pr_json" | jq -e . >/dev/null 2>&1 || die "gh pr list returned invalid JSON"
    if [ -n "$pr_json" ] && [ "$pr_json" != "[]" ]; then
      local pr_state pr_url
      pr_state="$(printf '%s' "$pr_json" | jq -r '.[0].state')"
      pr_url="$(printf '%s' "$pr_json" | jq -r '.[0].url')"
      case "$pr_state" in
        OPEN)   note "PR_EXISTS: $pr_url"; exit 0 ;;
        MERGED) note "STALE: PR already merged: $pr_url"; exit 3 ;;
        *)      die "existing PR in state $pr_state: $pr_url" ;;
      esac
    fi
  fi

  git checkout -B "$target" "origin/$target" --quiet || die "checkout $target failed"
  local head_parents head_p2
  head_parents="$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')"
  [ "$head_parents" -ge 3 ] || die "branch tip is not the handoff merge commit (no HEAD^2)"
  head_p2="$(git rev-parse HEAD^2)"
  [ "$head_p2" = "$upstream_sha" ] || die "HEAD^2 ($head_p2) != upstream_sha ($upstream_sha)"

  local token; token="$(date +%s)-$$"
  {
    printf 'RUN_ID=%s\n' "$run_id"
    printf 'TARGET_BRANCH=%s\n' "$target"
    printf 'UPSTREAM_SHA=%s\n' "$upstream_sha"
    printf 'BASE_SHA=%s\n' "$base_sha"
    printf 'REPO_BEFORE=%s\n' "$repo_before"
    printf 'TOKEN=%s\n' "$token"
    printf 'CONFLICT_FILES_BEGIN\n'
    printf '%s\n' "$files"
    printf 'CONFLICT_FILES_END\n'
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE"

  note "READY: branch=$target"
  note "UPSTREAM_SHA=$upstream_sha"
  note "CONFLICT_FILES:"
  printf '%s\n' "$files"
  note ""
  note "Resolve ONLY these locale files, then run: scripts/sync-conflict-resolve.sh finish"
}

cmd_finish() {
  [ -f "$STATE_FILE" ] || die "no state file; run prepare first"
  need git; need jq; need gh
  cd "$WORKDIR"

  local target upstream_sha base_sha repo_before
  target="$(state_get TARGET_BRANCH)"
  upstream_sha="$(state_get UPSTREAM_SHA)"
  base_sha="$(state_get BASE_SHA)"
  repo_before="$(state_get REPO_BEFORE)"
  [ -n "$target" ] && [ -n "$upstream_sha" ] || die "state file is incomplete"

  local cur_branch
  cur_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ "$cur_branch" = "$target" ] || die "current branch '$cur_branch' is not '$target'"

  local files=()
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(state_files)
  [ "${#files[@]}" -gt 0 ] || die "state has no conflict files"

  local f
  for f in "${files[@]}"; do
    [ -f "$f" ] || die "resolved file is missing: $f"
    if grep -qE '^(<{7,}|={7,}|>{7,})( |$)' "$f"; then
      die "conflict markers remain in $f"
    fi
    jq empty "$f" >/dev/null 2>&1 || die "invalid JSON in $f"
  done

  # Reject edits to anything outside the allowlist, and untracked leftovers.
  local changed extra=""
  changed="$(git status --porcelain)" || die "git status failed"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      '?? '*) die "untracked file present: ${line#\?\? }" ;;
      ' D '*) die "deleted tracked file: ${line# D }" ;;
      'D  '*) die "staged deleted file: ${line#D  }" ;;
    esac
    local p="${line:3}"
    local allowed=0
    for f in "${files[@]}"; do [ "$p" = "$f" ] && allowed=1 && break; done
    [ "$allowed" -eq 1 ] || extra="$extra $p"
  done <<< "$changed"
  [ -z "$extra" ] || die "unexpected worktree changes:$extra"

  git rm -f .sync-conflict.json >/dev/null
  git add -- "${files[@]}"

  local staged bad=""
  staged="$(git -c core.quotePath=false diff --cached --name-only)"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ "$p" = ".sync-conflict.json" ]; then continue; fi
    local allowed=0
    for f in "${files[@]}"; do [ "$p" = "$f" ] && allowed=1 && break; done
    [ "$allowed" -eq 1 ] || bad="$bad $p"
  done <<< "$staged"
  [ -z "$bad" ] || die "staged files outside the allowlist:$bad"

  git -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
    commit -m "fix(sync): resolve $target locale conflicts" >/dev/null \
    || die "git commit failed"

  if [ "$DRY_RUN" = "1" ]; then
    note "DRY_RUN_OK: committed $(git rev-parse --short HEAD); skipped push/PR"
    rm -f "$STATE_FILE"
    exit 0
  fi

  git push origin "$target" || die "git push failed; branch not updated"

  local pr_json pr_url
  if ! pr_json="$(gh pr list --repo "$REPO" --head "$target" --state all --limit 100 \
        --json number,url,state 2>/dev/null)"; then
    die "push succeeded but gh pr list failed; a PR may need manual creation"
  fi
  if [ -n "$pr_json" ] && [ "$pr_json" != "[]" ]; then
    local pr_state
    pr_state="$(printf '%s' "$pr_json" | jq -r '.[0].state')"
    pr_url="$(printf '%s' "$pr_json" | jq -r '.[0].url')"
    [ "$pr_state" = "OPEN" ] || die "PR exists in state $pr_state after push: $pr_url"
    note "PR_EXISTS: $pr_url"
    rm -f "$STATE_FILE"
    exit 0
  fi

  local body
  body="$(cat <<EOF
## Sync Upstream 冲突自动解决

- Upstream SHA: \`$upstream_sha\`
- Base SHA: \`$base_sha\`
- Repo SHA before: \`$repo_before\`
- 分支: \`$target\`
- 冲突文件: \`$(printf '%s, ' "${files[@]}" | sed 's/, $//')\`

仅自动解决了 i18n locale 文案冲突；未在本地执行 \`bun run verify\`，
验证由本 PR 的 CI 在 GitHub 临时 runner 上执行。请人工 review 后再合并。
EOF
)"

  pr_url="$(gh pr create --repo "$REPO" --base main --head "$target" --draft \
    --title "fix(sync): 解 $target 的 locale 冲突" --body "$body" 2>/dev/null)" \
    || die "push succeeded but gh pr create failed; create the draft PR manually"
  note "PR_CREATED: $pr_url"
  rm -f "$STATE_FILE"
}

usage() {
  printf 'usage: %s prepare --run-id <id> | finish\n' "$0" >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  prepare) cmd_prepare "$@" ;;
  finish)  cmd_finish "$@" ;;
  *) usage ;;
esac
