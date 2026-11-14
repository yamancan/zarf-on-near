#!/usr/bin/env bash
# Scans all locally available refs and the index with gitleaks and .gitleaks.toml.
# Fetch remote refs before release; working files and hosting metadata need a separate audit.
# Exit 1 on findings; refuse incomplete (shallow) history.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v gitleaks >/dev/null || { echo "install gitleaks (https://github.com/gitleaks/gitleaks)" >&2; exit 2; }
[[ $(git -C "$root" rev-parse --is-shallow-repository) == false ]] || {
  echo "refused: fetch full history before scanning" >&2; exit 2;
}
gitleaks git --no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --log-opts="--all --full-history --diff-merges=separate" --config "$root/.gitleaks.toml" "$root"
# Patch scans omit commit messages and annotated tag text. Scan them explicitly.
git -C "$root" log --all --format=raw -z | gitleaks stdin --no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --config "$root/.gitleaks.toml"
git -C "$root" for-each-ref --format='%(refname)%0a%(taggername)%0a%(taggeremail)%0a%(contents)' | gitleaks stdin --no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --config "$root/.gitleaks.toml"
# Check every historical name (including deleted files), plus the current index.
# Only the exact .env.example template is permitted; its content is still scanned.
python3 - "$root" <<'PYTHON'
import pathlib, subprocess, sys
root = sys.argv[1]
def git(*args):
    return subprocess.check_output(['git', '-C', root, *args])
paths = set(git('log', '--all', '--full-history', '--diff-merges=separate', '--format=', '--name-only', '-z').split(b'\0'))
paths.update(git('ls-files', '-z').split(b'\0'))
blocked = []
for raw in paths:
    name = raw.decode('utf-8', 'surrogateescape')
    original_base = pathlib.PurePosixPath(name).name
    base = original_base.lower()
    parts = {part.lower() for part in pathlib.PurePosixPath(name).parts}
    if not base:
        continue
    if (parts & {'.claude', '.codex', '.agents', 'conversations', 'transcripts'}
        or base in {'claude.md', 'agents.md', 'codex.md', 'gemini.md', 'conversation.json', 'conversations.json', 'conversation.md', 'transcript.json', 'transcript.md', 'chat-export.json'}
        or base.endswith(('.jsonl', '.har'))
        or (base.startswith('.env') and original_base != '.env.example')
        or base.startswith('.dev.vars')
        or base.endswith(('.key', '.seed', '.pem', '.p12', '.pfx'))
        or (base.startswith('credentials') and base.endswith('.json'))
        or base in ('id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', '.npmrc', '.pypirc')):
        blocked.append(name)
if blocked:
    # Paths only, never file contents. repr prevents control characters in names.
    for name in sorted(blocked):
        print('forbidden private path:', repr(name), file=sys.stderr)
    sys.exit(1)
PYTHON
# Include staged content as well as committed history.
gitleaks git --staged --no-banner --redact --ignore-gitleaks-allow --gitleaks-ignore-path /dev/null --config "$root/.gitleaks.toml" "$root"
echo "secret scan: committed history and index clean (working files require a separate audit)"
