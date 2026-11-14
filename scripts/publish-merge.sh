#!/usr/bin/env bash
# Builds the integration branch: merges each finished head into the current branch (main) in
# order, stops at the first conflict for a hand resolution, then runs the secret scan and `make test`.
# Rerunnable: a head already merged is a no-op. Nothing is pushed here.
#   Last head, once the judges' README is final: scripts/publish-merge.sh origin/t-018-submission
#   (a README conflict takes that branch's README: git checkout --theirs README.md).
#   scripts/publish-merge.sh <head> [<head> ...]      e.g. origin/main <feature-branch>
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "commit or stash local changes first" >&2; exit 1; }
for head in "$@"; do
  sha=$(git rev-parse --short "$head")
  if git merge-base --is-ancestor "$head" HEAD; then echo "= $head @ $sha already merged"; continue; fi
  echo "+ merging $head @ $sha"
  git merge --no-edit -m "Merge $head @ $sha" "$head" || {
    echo "conflict merging $head: resolve, 'git commit', then rerun with the remaining heads" >&2; exit 1; }
done
scripts/secret-scan.sh
make test
