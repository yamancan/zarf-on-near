#!/usr/bin/env bash
# Scans every commit of this repository (not only the tree) for secrets with gitleaks and the
# allowlist in .gitleaks.toml. Run before the repository is made public. Exit 1 on any finding.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v gitleaks >/dev/null || { echo "install gitleaks (https://github.com/gitleaks/gitleaks)" >&2; exit 2; }
gitleaks git --no-banner --redact --config "$root/.gitleaks.toml" "$root"
# Key files that must never be committed, whatever their content.
if git -C "$root" log --all --name-only --format= | grep -E '(\.key|\.seed|\.dev\.vars|credentials.*\.json)$' | sort -u | grep .; then
  echo "key-like files appear in history (above)" >&2; exit 1
fi
echo "secret scan: clean"
