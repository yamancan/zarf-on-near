#!/usr/bin/env bash
# Publishes an explicitly reviewed commit to a NEW, EMPTY repo as main and hackathon-submission.
# The full expected SHA must match HEAD; no branch name selects an older release implicitly.
# Refuses local changes, a nonempty target, a failed scan, or changes made while scanning.
#   scripts/publish.sh --expected-commit <full-sha> <owner/repo>
#   scripts/publish.sh --expected-commit <full-sha> --url <git-url>
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
usage() { echo "usage: scripts/publish.sh --expected-commit <full-sha> <owner/repo> | --expected-commit <full-sha> --url <git-url>" >&2; exit 1; }
[[ ${1:-} == --expected-commit && ${2:-} =~ ^[0-9a-f]{40}$ ]] || usage
expected=$2
shift 2
sha=$(git rev-parse HEAD)
[[ $sha == "$expected" ]] || { echo "refused: HEAD does not match the expected commit" >&2; exit 1; }
TAG=hackathon-submission
case "${1:-}" in
  --url) [[ $# == 2 && -n $2 ]] || usage; url=$2 ;;
  */*)   [[ $# == 1 ]] || usage
         gh repo view "$1" --json name >/dev/null || { echo "refused: GitHub repository does not exist or is inaccessible" >&2; exit 1; }
         url="https://github.com/$1.git" ;;
  *)     usage ;;
esac
empty_target() {
  local refs
  refs=$(git ls-remote -- "$url") || { echo "refused: cannot read target" >&2; exit 1; }
  [[ -z $refs ]] || { echo "refused: target is not empty" >&2; exit 1; }
}
clean_tree() {
  local status
  status=$(git status --porcelain --untracked-files=all) || { echo "refused: cannot inspect local changes" >&2; exit 1; }
  [[ -z $status ]] || { echo "refused: commit or remove local changes first" >&2; exit 1; }
}
clean_tree
empty_target
scripts/secret-scan.sh
[[ $(git rev-parse HEAD) == "$sha" ]] || { echo "refused: HEAD changed during the scan" >&2; exit 1; }
clean_tree
empty_target
# Empty leases mean these refs must still be absent; --atomic prevents a partial main/tag release.
# Override push.followTags so local Git config cannot add unrelated annotated tags.
git push --atomic --no-follow-tags --force-with-lease=refs/heads/main: --force-with-lease="refs/tags/$TAG:" -- "$url" "$sha:refs/heads/main" "$sha:refs/tags/$TAG"
echo "pushed $sha as main and tag $TAG"
