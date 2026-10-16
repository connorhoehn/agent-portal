#!/usr/bin/env bash
# runtime: bash >=3.2
# deps: git, node >=20 (reads package.json); no network unless --fetch
# Before bumping a library release: is the tree clean, is the branch behind origin (another session may
# have released while you worked), which version is next, and does the CHANGELOG already carry it.
# Read-only apart from `git fetch` when asked.
#
#   scripts/release-preflight.sh "$LIB" [--fetch] [--bump patch|minor|major] [--print-next]
#
# --print-next prints only the next version (for NEXT=$(…)). Exit: 0 ready, 1 not ready (the report
# says why), 2 bad arguments.
set -u
LIB=${1:-}; shift || true
[ -n "$LIB" ] && [ -d "$LIB/.git" ] || { echo "usage: $0 <library repo> [--fetch] [--bump patch|minor|major] [--print-next]" >&2; exit 2; }
FETCH=0; BUMP=patch; PRINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fetch) FETCH=1 ;;
    --bump) BUMP=${2:-}; shift ;;
    --print-next) PRINT=1 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
case "$BUMP" in patch|minor|major) ;; *) echo "--bump is patch, minor or major" >&2; exit 2 ;; esac

g() { git -C "$LIB" "$@"; }
[ "$FETCH" = 1 ] && g fetch -q origin main
BRANCH=$(g rev-parse --abbrev-ref HEAD)
LOCAL=$(node -p "require(process.argv[1]).version" "$LIB/package.json")
REMOTE=$(g show origin/main:package.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')
read -r BEHIND AHEAD < <(g rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo "? ?")

# The next version bumps the HIGHER of local and origin, so a release another session pushed is never reused.
NEXT=$(node -e '
const [a, b, bump] = process.argv.slice(1);
const p = (v) => (v || "0.0.0").split(/[.-]/).slice(0, 3).map(Number);
const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const base = [p(a), p(b)].sort(cmp).pop();
const n = bump === "major" ? [base[0] + 1, 0, 0] : bump === "minor" ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1];
console.log(n.join("."));' "$LOCAL" "$REMOTE" "$BUMP")
if [ "$PRINT" = 1 ]; then echo "$NEXT"; exit 0; fi

READY=0
say() { printf '%s\n' "$1"; }
not() { printf 'NOT READY: %s\n' "$1"; READY=1; }
say "library: $LIB on $BRANCH ($(g rev-parse --short HEAD)), version $LOCAL; origin/main is ${REMOTE:-unknown}"
say "behind $BEHIND, ahead $AHEAD of origin/main$([ "$FETCH" = 1 ] || echo ' (not fetched: pass --fetch for the truth)')"
[ "$BRANCH" = main ] || not "on $BRANCH, not main"
DIRTY=$(g status --porcelain --untracked-files=no)
[ -z "$DIRTY" ] || not "uncommitted changes: $(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ') path(s); commit the feature first (without dist/)"
if [ "$BEHIND" != 0 ] && [ "$BEHIND" != '?' ]; then not "behind origin/main by $BEHIND: git -C \"$LIB\" pull --rebase origin main, then rerun"; fi
if g diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^dist/'; then say "note: unpushed commits already touch dist/ (only the release commit should)"; fi
if grep -Eq "^## ${NEXT//./\\.}( |$)" "$LIB/CHANGELOG.md" 2>/dev/null; then say "CHANGELOG: has a ## $NEXT section"; else say "CHANGELOG: add a ## $NEXT section (what a consumer can now do)"; fi
say "next: $NEXT ($BUMP over the higher of local $LOCAL and origin ${REMOTE:-unknown})"
[ "$READY" = 0 ] && say "ready: bump to $NEXT, build, test, commit, push, pack"
exit $READY
