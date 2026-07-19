#!/usr/bin/env bash
#
# Merge upstream/master into the current branch, auto-resolving the one
# conflict class this fork produces on every pull: upstream keeps maintaining
# portal skills this fork intentionally deleted (the Danish demo portals —
# jobnet/jobindex/jobbank/jobdanmark-search), so each of their files comes back
# as a modify/delete conflict.
#
# Rule: a conflicted path under .agents/skills/<portal>/ where <portal> no
# longer exists in THIS branch is a retired portal — resolve it as a delete.
# This is derived from the tree, not a hardcoded list, so it keeps working as
# the fork adds or removes portals. Any OTHER conflict is left for a human:
# methodology files (apply.md, README.md, the skill templates) carry Norwegian
# retargeting and must be read, not auto-merged.
#
# Usage:  tools/merge_upstream.sh          # merge upstream/master
#         tools/merge_upstream.sh <ref>    # merge a specific ref
#
# On a tree with no upstream changes this is a clean no-op.

set -euo pipefail

REMOTE_REF="${1:-upstream/master}"
SKILLS_DIR=".agents/skills"

cd "$(git rev-parse --show-toplevel)"

# Portals present in our tree right now. A conflicted path under a portal NOT in
# this set is a portal we deleted -> safe to resolve as a delete.
our_portals="$(git ls-tree -d --name-only "HEAD:${SKILLS_DIR}" 2>/dev/null || true)"

is_retired_portal_path() {
  # $1 = repo-relative path. True only for .agents/skills/<portal>/... where
  # <portal> is absent from our tree.
  case "$1" in
    "${SKILLS_DIR}/"*)
      local rest="${1#${SKILLS_DIR}/}"
      local portal="${rest%%/*}"
      [ "$portal" != "$rest" ] || return 1   # a file directly in skills/, not a portal dir
      ! grep -qxF "$portal" <<<"$our_portals"
      ;;
    *) return 1 ;;
  esac
}

echo ">> Fetching upstream..."
git fetch upstream --quiet

echo ">> Merging ${REMOTE_REF}..."
if git merge --no-edit "$REMOTE_REF"; then
  echo ">> Merge completed with no conflicts."
  exit 0
fi

# Merge stopped on conflicts. Triage them.
resolved=()
manual=()

# Unmerged paths, NUL-delimited to survive spaces.
while IFS= read -r -d '' path; do
  if is_retired_portal_path "$path"; then
    git rm -f --quiet "$path"
    resolved+=("$path")
  else
    manual+=("$path")
  fi
done < <(git diff --name-only --diff-filter=U -z)

# Upstream also ADDS new files to portals we deleted (e.g. new test files for a
# Danish portal). Those arrive as clean adds — no conflict — so they slip past
# the loop above and resurrect a retired portal dir. Sweep them out too.
while IFS= read -r -d '' path; do
  if is_retired_portal_path "$path"; then
    git rm -f --quiet "$path"
    resolved+=("$path")
  fi
done < <(git diff --cached --name-only --diff-filter=A -z)

echo
echo ">> Auto-resolved ${#resolved[@]} retired-portal conflict(s) as deletions:"
printf '     %s\n' "${resolved[@]:-（none）}"

if [ "${#manual[@]}" -gt 0 ]; then
  echo
  echo ">> ${#manual[@]} conflict(s) need a human — these carry fork customization:"
  printf '     %s\n' "${manual[@]}"
  echo
  echo "   Resolve them (keep the Norwegian retargeting, adopt upstream's"
  echo "   methodology change around it), 'git add' each, then 'git commit'."
  exit 1
fi

echo
echo ">> All conflicts were retired-portal deletions. Review the staged tree, then:"
echo "     git commit --no-edit"
echo "   (left uncommitted so you can eyeball the merge before sealing it)."
exit 0
