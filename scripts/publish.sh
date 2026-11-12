#!/usr/bin/env bash
# Publishes a reviewed commit to a NEW, EMPTY repo as `main`, plus the tag
# `hackathon-submission` at the same commit. Nothing else is pushed (no other branch or tag).
# Refuses unless the target exists and has no refs, the worktree is clean, and the secret scan passes.
#   scripts/publish.sh <owner/repo>       GitHub; create it first: gh repo create <owner/repo> --public
#   scripts/publish.sh --url <git-url>    any remote (the dry run uses a local bare repo)
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
BRANCH=main TAG=hackathon-submission
case "${1:-}" in
  --url) url=${2:?usage: scripts/publish.sh --url <git-url>} ;;
  */*)   gh repo view "$1" --json name >/dev/null || { echo "refused: $1 does not exist (gh repo create $1 --public)" >&2; exit 1; }
         url="https://github.com/$1.git" ;;
  *)     echo "usage: scripts/publish.sh <owner/repo> | --url <git-url>" >&2; exit 1 ;;
esac
refs=$(git ls-remote "$url") || { echo "refused: cannot read $url" >&2; exit 1; }
[[ -z $refs ]] || { echo "refused: $url is not empty:" >&2; echo "$refs" >&2; exit 1; }
[[ $(git rev-parse --abbrev-ref HEAD) == "$BRANCH" ]] || { echo "refused: check out $BRANCH first" >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "refused: commit local changes first" >&2; exit 1; }
scripts/secret-scan.sh
sha=$(git rev-parse "$BRANCH")
git push "$url" "$sha:refs/heads/main" "$sha:refs/tags/$TAG"
echo "pushed $sha as main and tag $TAG to $url"
