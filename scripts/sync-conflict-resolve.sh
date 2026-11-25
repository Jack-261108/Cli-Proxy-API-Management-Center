#!/usr/bin/env bash
# Resolve a Sync Upstream conflict branch mechanically and safely.
#
# Scope: only src/i18n/locales/*.json may be auto-resolved. The resolution
# is a deterministic three-way JSON merge: keys come from the fork
# (handoff^1), values follow upstream unless the fork changed them since
# base_sha. No model edits and no code from the conflict branch are
# executed here; the PR's CI runs `bun run verify` on GitHub's runner.
#
# Run a copy extracted from origin/main:
#   git show origin/main:scripts/sync-conflict-resolve.sh > /tmp/sync-resolve.sh
#   bash /tmp/sync-resolve.sh resolve --run-id <id> [--branch <branch>]
#
# Exit codes:
#   0  PR_CREATED / DRY_RUN_OK
#   2  NEEDS_HUMAN
#   3  NO_BRANCH / STALE_UPSTREAM / STALE_PR_MERGED / PR_EXISTS
#
# Env overrides: REPO, WORKDIR, LOCK_FILE, DRY_RUN.

set -euo pipefail

REPO="${REPO:-Jack-261108/Cli-Proxy-API-Management-Center}"
WORKDIR="${WORKDIR:-$(pwd)}"
LOCK_FILE="${LOCK_FILE:-/tmp/mgmt-sync-conflict.lock}"
DRY_RUN="${DRY_RUN:-0}"
GIT_NAME="${GIT_NAME:-mgmt-ci-autofix}"
GIT_EMAIL="${GIT_EMAIL:--mgmt-ci-autofix@users.noreply.github.com}"
ALLOW_RE='^src/i18n/locales/[A-Za-z0-9._-]+\.json$'
BRANCH_RE='^sync-conflict/[0-9a-f]{12}-[0-9a-f]{8}$'
MANIFEST='.sync-conflict.json'
RISKY_RE='(^|/)(\.gitattributes|\.gitignore|\.gitmodules|AGENTS\.md|CLAUDE\.md|package\.json|bun\.lock|bunfig\.toml|\.npmrc|scripts/|tests/|patches/|eslint\.config\.|vite\.config\.|postcss\.config\.|tailwind\.config\.|vitest\.config\.|tsconfig)|(^|/)\.github/|(^|/)[^/]*(\.|_)(test|spec)\.[cm]?[jt]sx?$'

TMPD=""
TARGET_TIP=""
SUCCESS=0
die() { printf 'NEEDS_HUMAN: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }

cleanup() {
  local rc=$?
  if [ "${SUCCESS:-0}" != "1" ] && [ -n "${TARGET_TIP:-}" ]; then
    git reset --hard "$TARGET_TIP" >/dev/null 2>&1 || true
  fi
  if [ -n "${TMPD:-}" ]; then rm -rf "$TMPD" 2>/dev/null || true; fi
  return $rc
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
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
  dirty="$(git status --porcelain --untracked-files=no)" || die "git status failed"
  [ -z "$dirty" ] || die "workdir is not clean; refusing to reset or overwrite it:
$dirty"
}

require_script_from_main() {
  local origin_sha own_sha
  origin_sha="$(git show origin/main:scripts/sync-conflict-resolve.sh 2>/dev/null | sha256_stdin)" \
    || die "cannot read scripts/sync-conflict-resolve.sh from origin/main"
  own_sha="$(sha256_file "$0")"
  [ "$origin_sha" = "$own_sha" ] \
    || die "running script does not match origin/main; re-extract it from origin/main"
}

find_branch_by_run_id() {
  local run_id="$1" refs b found="" ref
  refs="$(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin/sync-conflict/ 2>/dev/null)" \
    || die "cannot enumerate origin/sync-conflict/*"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    [[ "$b" =~ $BRANCH_RE ]] || continue
    for ref in "origin/$b" "origin/$b^"; do
      if git show "$ref:$MANIFEST" 2>/dev/null \
           | jq -e --arg r "$run_id" '(.run_id | tostring) == $r' >/dev/null 2>&1; then
        found="$b"; break 2
      fi
    done
  done <<< "$refs"
  printf '%s' "$found"
}

# Print "<state>\t<url>" for the best PR on $1 (OPEN > MERGED > CLOSED).
# Only same-repo PRs targeting main are considered; cross-fork PRs with a
# colliding branch name are ignored.
pr_lookup() {
  local branch="$1" owner="${REPO%%/*}" out
  out="$(gh api "repos/$REPO/pulls?state=all&head=$owner:$branch&per_page=100" --paginate \
      --jq '.[] | select(.base.ref == "main") | [(if .state=="open" then 0 elif .merged_at != null then 1 else 2 end), (if .state=="open" then "OPEN" elif .merged_at != null then "MERGED" else "CLOSED" end), .html_url] | @tsv' 2>/dev/null)" \
    || return 1
  [ -n "$out" ] || return 0
  printf '%s\n' "$out" | sort -n -k1,1 | awk -F '\t' 'NR==1 { print $2 "\t" $3 }'
}

check_pr_or_die() {
  local branch="$1" line st url
  line="$(pr_lookup "$branch")" || die "gh pr list failed; refusing to touch the branch"
  [ -n "$line" ] || return 0
  st="${line%%$'\t'*}"; url="${line#*$'\t'}"
  case "$st" in
    OPEN)   note "PR_EXISTS: $url"; exit 3 ;;
    MERGED) note "STALE_PR_MERGED: $url"; exit 3 ;;
    CLOSED) die "existing PR was closed unmerged: $url" ;;
    *)      die "unexpected PR state: $st" ;;
  esac
}

is_ancestor() {
  local rc=0
  git merge-base --is-ancestor "$1" "$2" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) die "git merge-base --is-ancestor failed (rc=$rc)" ;;
  esac
}

# Validate a JSON locale file: no markers, valid JSON, every leaf a string.
validate_content() {
  local file="$1"
  if grep -qE '^(<{7,}|={7,}|>{7,})( |$)' "$file"; then
    die "conflict markers remain in $file"
  fi
  jq empty "$file" >/dev/null 2>&1 || die "invalid JSON in $file"
  jq -e '[.. | select(type != "object" and type != "array") | type] | all(. == "string")' "$file" \
    >/dev/null 2>&1 || die "non-string leaf in $file"
}

# Compare the full path+type structure of $file with the fork version.
validate_key_structure() {
  local file="$1" fork_ref="$2" rel="$3" fork_json
  fork_json="$TMPD/fork.json"
  git show "$fork_ref:$rel" > "$fork_json" 2>/dev/null \
    || die "cannot read fork version of $rel at $fork_ref"
  jq -S '[paths as $p | [$p, (getpath($p)|type)]] | sort' "$fork_json" > "$TMPD/keys.fork" \
    || die "cannot read fork key structure of $rel"
  jq -S '[paths as $p | [$p, (getpath($p)|type)]] | sort' "$file" > "$TMPD/keys.resolved" \
    || die "cannot read resolved key structure of $rel"
  if ! diff -q "$TMPD/keys.fork" "$TMPD/keys.resolved" >/dev/null; then
    diff -u "$TMPD/keys.fork" "$TMPD/keys.resolved" > "$TMPD/keys.diff" 2>&1 || true
    die "$rel key structure differs from fork:
$(sed -n '1,20p' "$TMPD/keys.diff")"
  fi
}

# Deterministic 3-way merge: keys from ours, values from theirs unless ours != base.
# A type change on either side is a human decision (fail closed).
merge_locale() {
  local f="$1" base="$2" ours="$3" theirs="$4"
  git show "$base:$f" > "$TMPD/base.json" 2>/dev/null || die "cannot read base $f"
  git show "$ours:$f" > "$TMPD/ours.json" 2>/dev/null || die "cannot read ours $f"
  git show "$theirs:$f" > "$TMPD/theirs.json" 2>/dev/null || die "cannot read theirs $f"
  jq -n --slurpfile b "$TMPD/base.json" --slurpfile o "$TMPD/ours.json" --slurpfile t "$TMPD/theirs.json" '
    def merge3($b; $o; $t):
      if ($o | type) == "object" then
        if ($t | type) == "object" then
          reduce ($o | keys_unsorted[]) as $k
            ({}; .[$k] = (if ($t | has($k)) then merge3($b[$k]; $o[$k]; $t[$k]) else $o[$k] end))
        elif $t == null then $o
        else error("type change: object -> \($t | type)")
        end
      elif ($t != null and (($t | type) != ($o | type))) then
        error("type change: \($o | type) -> \($t | type)")
      elif $o == $b then
        (if $t == null then $o else $t end)
      else $o end;
    merge3($b[0]; $o[0]; $t[0])
  ' > "$TMPD/merged.json" 2>"$TMPD/jq.err" \
    || die "jq merge failed for $f: $(tail -n 3 "$TMPD/jq.err" | tr '\n' ' ')"
  validate_content "$TMPD/merged.json"
  validate_key_structure "$TMPD/merged.json" "$ours" "$f"
  mv "$TMPD/merged.json" "$f"
}

cmd_resolve() {
  local run_id="" branch=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --run-id) run_id="${2:-}"; shift 2 ;;
      --branch) branch="${2:-}"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$run_id" ] || die "--run-id is required"
  [[ "$run_id" =~ ^[0-9]+$ ]] || die "run-id must be numeric"
  if [ -n "$branch" ] && ! [[ "$branch" =~ $BRANCH_RE ]]; then
    die "invalid --branch: $branch"
  fi

  need git; need jq; need gh
  TMPD="$(mktemp -d)"
  cd "$WORKDIR" || die "cannot cd to $WORKDIR"
  acquire_lock
  require_clean_workdir
  git fetch origin --prune --quiet || die "git fetch origin failed"
  git fetch origin main --quiet || die "git fetch origin main failed"
  if [ "$DRY_RUN" != "1" ]; then require_script_from_main; fi

  local target="$branch"
  if [ -n "$target" ]; then
    git rev-parse --verify -q "origin/$target" >/dev/null \
      || { note "NO_BRANCH: $target does not exist on origin"; exit 3; }
  else
    target="$(find_branch_by_run_id "$run_id")"
    if [ -z "$target" ]; then
      note "NO_BRANCH: no sync-conflict branch matches run_id=$run_id"
      exit 3
    fi
  fi
  [[ "$target" =~ $BRANCH_RE ]] || die "unexpected branch name: $target"

  if [ "$DRY_RUN" != "1" ]; then check_pr_or_die "$target"; fi

  git checkout -B "$target" "origin/$target" --quiet || die "checkout $target failed"

  local head handoff_tip already=0
  head="$(git rev-parse HEAD)"
  if git cat-file -e "HEAD:$MANIFEST" 2>/dev/null; then
    handoff_tip="$head"
  elif git cat-file -e "HEAD^:$MANIFEST" 2>/dev/null; then
    handoff_tip="$(git rev-parse HEAD^)"
    already=1
    [ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" -eq 2 ] \
      || die "resolution tip is not a single commit"
  else
    die "branch tip is neither the handoff merge nor a resolution commit"
  fi
  TARGET_TIP="$handoff_tip"

  local manifest upstream_sha base_sha repo_before manifest_branch
  manifest="$(git show "$handoff_tip:$MANIFEST" 2>/dev/null)" \
    || die "cannot read $MANIFEST from $handoff_tip"
  printf '%s' "$manifest" | jq -e . >/dev/null 2>&1 || die "manifest is not valid JSON"
  upstream_sha="$(printf '%s' "$manifest" | jq -r '.upstream_sha // empty')"
  base_sha="$(printf '%s' "$manifest" | jq -r '.base_sha // empty')"
  repo_before="$(printf '%s' "$manifest" | jq -r '.repo_sha_before // empty')"
  manifest_branch="$(printf '%s' "$manifest" | jq -r '.branch // empty')"
  [[ "$upstream_sha" =~ ^[0-9a-f]{40}$ ]] || die "bad upstream_sha in manifest"
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || die "bad base_sha in manifest"
  [[ "$repo_before" =~ ^[0-9a-f]{40}$ ]] || die "bad repo_sha_before in manifest"
  [ "$manifest_branch" = "$target" ] || die "manifest branch ($manifest_branch) != $target"

  local hp
  hp="$(git rev-list --parents -n 1 "$handoff_tip" | wc -w | tr -d ' ')"
  [ "$hp" -ge 3 ] || die "handoff tip is not a merge commit"
  [ "$(git rev-parse "$handoff_tip^1")" = "$repo_before" ] \
    || die "manifest repo_sha_before ($repo_before) != handoff first parent"
  [ "$(git rev-parse "$handoff_tip^2")" = "$upstream_sha" ] \
    || die "handoff second parent != upstream_sha"

  if is_ancestor "$upstream_sha" origin/main; then
    note "STALE_UPSTREAM: upstream $upstream_sha is already in origin/main"
    exit 3
  fi

  if [ "$DRY_RUN" != "1" ]; then
    local a b ci
    a="$(git show "$repo_before:.github/workflows/ci.yml" 2>/dev/null | sha256_stdin)" \
      || die "cannot read ci.yml from fork main"
    b="$(git show "$handoff_tip:.github/workflows/ci.yml" 2>/dev/null | sha256_stdin)" \
      || die "cannot read ci.yml from handoff branch"
    [ "$a" = "$b" ] || die "ci.yml differs from fork main; merge the hardening PR first"
    ci="$(git show "$handoff_tip:.github/workflows/ci.yml" 2>/dev/null || true)"
    grep -q 'contents: read' <<< "$ci" || die "ci.yml is missing contents: read"
    grep -q 'persist-credentials: false' <<< "$ci" || die "ci.yml is missing persist-credentials: false"
  fi

  local diffz risky grc=0
  diffz="$TMPD/risky.nul"
  git -c core.quotePath=false diff --name-only -z --no-renames "$repo_before" "$handoff_tip" > "$diffz" \
    || die "git diff for executable-surface check failed"
  risky="$(tr '\0' '\n' < "$diffz" | grep -E "$RISKY_RE")" || grc=$?
  case "$grc" in
    0) ;;
    1) risky="" ;;
    *) die "executable-surface grep failed (rc=$grc)" ;;
  esac
  if [ -n "$risky" ]; then
    die "upstream changed executable/CI surface (human must decide):
$risky"
  fi

  local files bad="" f
  files="$(printf '%s' "$manifest" | jq -r '.conflict_files[]?' | sort -u)"
  [ -n "$files" ] || die "manifest has no conflict_files"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in /*|*..*) die "unsafe conflict path: $f" ;; esac
    [[ "$f" =~ $ALLOW_RE ]] || bad="$bad $f"
  done <<< "$files"
  [ -z "$bad" ] || die "non-locale conflict files (human must resolve):$bad"

  local tmpf
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    tmpf="$TMPD/conflict.json"
    git show "$handoff_tip:$f" > "$tmpf" 2>/dev/null || die "cannot read $f from handoff tip"
    if ! grep -qE '^<{7,}( |$)' "$tmpf" \
       || ! grep -qE '^={7,}$' "$tmpf" \
       || ! grep -qE '^>{7,}( |$)' "$tmpf"; then
      die "$f is not a content conflict; human must decide (modify/delete or typechange)"
    fi
  done <<< "$files"

  if [ "$already" -eq 0 ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      merge_locale "$f" "$base_sha" "$handoff_tip^1" "$upstream_sha"
    done <<< "$files"

    local changed extra=""
    changed="$(git status --porcelain --untracked-files=no)" || die "git status failed"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        ' M '*) ;;
        *) die "unexpected worktree status: $line" ;;
      esac
      local p="${line:3}"
      local allowed=0
      for f in $files; do if [ "$p" = "$f" ]; then allowed=1; break; fi; done
      [ "$allowed" -eq 1 ] || extra="$extra $p"
    done <<< "$changed"
    [ -z "$extra" ] || die "unexpected worktree changes:$extra"

    git rm -f --ignore-unmatch "$MANIFEST" >/dev/null || die "git rm $MANIFEST failed"
    git add -- $files || die "git add failed"

    local staged bad3="" mode
    staged="$(git -c core.quotePath=false diff --cached --name-only -z --no-renames | tr '\0' '\n')"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      [ "$p" = "$MANIFEST" ] && continue
      local allowed=0
      for f in $files; do if [ "$p" = "$f" ]; then allowed=1; break; fi; done
      [ "$allowed" -eq 1 ] || bad3="$bad3 $p"
    done <<< "$staged"
    [ -z "$bad3" ] || die "staged files outside the allowlist:$bad3"
    for f in $files; do
      mode="$(git ls-files -s --cached -- "$f" | awk '{print $1}')"
      [ "$mode" = "100644" ] || die "staged mode for $f is $mode, expected 100644"
    done

    git -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" \
      commit -m "fix(sync): resolve $target locale conflicts (run $run_id)" >/dev/null \
      || die "git commit failed"
  fi

  local final_diff bad4=""
  final_diff="$(git -c core.quotePath=false diff --name-only -z --no-renames "$handoff_tip" HEAD | tr '\0' '\n')"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ "$p" = "$MANIFEST" ] && continue
    local allowed=0
    for f in $files; do if [ "$p" = "$f" ]; then allowed=1; break; fi; done
    [ "$allowed" -eq 1 ] || bad4="$bad4 $p"
  done <<< "$final_diff"
  [ -z "$bad4" ] || die "resolution touches files outside the allowlist:$bad4"
  if git cat-file -e "HEAD:$MANIFEST" 2>/dev/null; then
    die "$MANIFEST is still present at HEAD"
  fi

  local blob
  for f in $files; do
    blob="$TMPD/blob.json"
    git show "HEAD:$f" > "$blob" 2>/dev/null || die "cannot read $f at HEAD"
    validate_content "$blob"
    validate_key_structure "$blob" "$handoff_tip^1" "$f"
  done

  if [ "$DRY_RUN" = "1" ]; then
    note "DRY_RUN_OK: committed $(git rev-parse --short HEAD); skipped push/PR"
    SUCCESS=1
    exit 0
  fi

  if [ "$already" -eq 0 ]; then
    git push --force-with-lease="refs/heads/$target:$handoff_tip" origin "$target" \
      || die "git push failed"
    local post_push
    post_push="$(git ls-remote --heads origin "refs/heads/$target" | awk '{print $1}')"
    [ "$post_push" = "$(git rev-parse HEAD)" ] || die "push verification failed"
  fi

  local line st url
  line="$(pr_lookup "$target")" || die "push succeeded but gh pr list failed; create the PR manually"
  if [ -n "$line" ]; then
    st="${line%%$'\t'*}"; url="${line#*$'\t'}"
    if [ "$st" = "OPEN" ]; then
      note "PR_EXISTS: $url"; SUCCESS=1; exit 3
    fi
    die "PR exists in state $st after push: $url"
  fi

  local body
  body="$(cat <<EOF
## Sync Upstream 冲突自动解决

- Run ID: \`$run_id\`
- Upstream SHA: \`$upstream_sha\`
- Base SHA: \`$base_sha\`
- Repo SHA before: \`$repo_before\`
- 分支: \`$target\`
- 冲突文件: \`$(printf '%s, ' $files | sed 's/, $//')\`

解析方式：确定性三路 JSON 合并（键集合与 fork 一致；fork 自 base 起改过的值保留，
其余采用上游）。上游新增的键会被丢弃，请人工确认是否需要补翻译。
未在本地执行 \`bun run verify\`，验证由本 PR 的 CI 执行。请人工 review 后再合并。
EOF
)"

  url="$(gh pr create --repo "$REPO" --base main --head "$target" --draft \
    --title "fix(sync): 解 $target 的 locale 冲突" --body "$body" 2>/dev/null)" \
    || die "push succeeded but gh pr create failed; create the draft PR manually"
  note "PR_CREATED: $url"
  SUCCESS=1
}

usage() {
  printf 'usage: %s resolve --run-id <id> [--branch <branch>]\n' "$0" >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  resolve) cmd_resolve "$@" ;;
  *) usage ;;
esac
