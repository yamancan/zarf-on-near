#!/usr/bin/env bash
# All reachable objects, index blobs, metadata, UTF text and bounded archives.
# No diff/path exclusions. Exit 1 on findings, 2 if the audit cannot be completed.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec python3 "$root/scripts/secret-scan.py" "$root"
