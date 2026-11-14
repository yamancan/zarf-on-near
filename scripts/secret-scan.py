#!/usr/bin/env python3
"""Fail-closed, path-independent scan of every reachable Git object and index blob."""
import ast
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import warnings
import zipfile

MAX_OBJECT = 64 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
PUBLIC_ACCOUNTS = (
    '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
)
LITERAL = re.compile(r'''"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*' ''', re.VERBOSE)


class Refused(Exception):
    pass


def forbidden(name):
    base = PurePosixPath(name).name
    lower = base.lower()
    parts = {part.lower() for part in PurePosixPath(name).parts}
    return (bool(parts & {'.claude', '.codex', '.agents', 'conversations', 'transcripts'})
            or lower in ('claude.md', 'agents.md', 'codex.md', 'gemini.md',
                         'conversation.json', 'conversations.json', 'conversation.md',
                         'transcript.json', 'transcript.md', 'chat-export.json')
            or lower.endswith(('.jsonl', '.har'))
            or (lower.startswith('.env') and base != '.env.example')
            or lower.startswith('.dev.vars')
            or lower.endswith(('.key', '.seed', '.pem', '.p12', '.pfx'))
            or (lower.startswith('credentials') and lower.endswith('.json'))
            or lower in ('id_rsa', 'id_ed25519', 'id_ecdsa', '.netrc', '.npmrc', '.pypirc'))


def static_strings(text):
    """Decode only literal strings; never evaluate repository expressions or code."""
    previous_end = None
    chain = []
    for match in LITERAL.finditer(text):
        try:
            # Compiler warnings can echo untrusted source fragments; never emit them.
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                value = ast.literal_eval(match.group())
        except (ValueError, SyntaxError):
            if len(chain) > 1:
                yield ''.join(chain)
            previous_end = None
            chain = []
            continue
        if not isinstance(value, str):
            continue
        if '\\' in match.group():
            yield value
        if previous_end is not None and re.fullmatch(r'\s*\+\s*', text[previous_end:match.start()]):
            chain.append(value)
        else:
            if len(chain) > 1:
                yield ''.join(chain)
            chain = [value]
        previous_end = match.end()
    if len(chain) > 1:
        yield ''.join(chain)


def main(root):
    if not shutil.which('gitleaks'):
        raise Refused('gitleaks is required')
    # Repository-selecting Git environment must not redirect this audit to another repo.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1',
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)

    def git(*args, allowed=(0,)):
        result = subprocess.run(['git', '-C', str(root), *args], env=env, capture_output=True)
        if result.returncode not in allowed:
            raise Refused('Git could not provide complete audit input')
        return result.stdout

    if Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() != root:
        raise Refused('Git selected a different worktree')
    if git('rev-parse', '--is-shallow-repository').strip() != b'false':
        raise Refused('fetch complete history before scanning')
    if git('config', '--get-regexp', r'^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$', allowed=(0, 1)).strip():
        raise Refused('partial-clone configuration is not accepted')
    if git('for-each-ref', 'refs/replace', '--format=%(refname)').strip():
        raise Refused('replacement refs must be removed before release')
    grafts = Path(git('rev-parse', '--path-format=absolute', '--git-path', 'info/grafts').decode().strip())
    if grafts.exists() and grafts.stat().st_size:
        raise Refused('grafts must be removed before release')

    policy = tomllib.loads((root / '.gitleaks.toml').read_text())
    allow = policy.get('allowlist', {})
    if (set(policy) != {'extend', 'allowlist'} or policy.get('extend') != {'useDefault': True}
            or set(allow) - {'description', 'regexTarget', 'regexes'}
            or allow.get('regexTarget') != 'secret'
            or sorted(allow.get('regexes', [])) != sorted('^' + x + '$' for x in PUBLIC_ACCOUNTS)):
        raise Refused('scanner policy differs from the narrowly reviewed default policy')

    head_before = git('rev-parse', '--verify', 'HEAD')
    refs_before = git('for-each-ref', '--format=%(objectname) %(refname)')
    index_before = git('ls-files', '--stage', '-z')
    ids = set(git('rev-list', '--objects', '--all', '--no-object-names', '--missing=error').splitlines())
    blocked_paths = 0
    index_names = []
    for entry in index_before.split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t', 1)
        mode, oid, stage = meta.split()
        if stage != b'0' or mode in (b'160000', b'120000'):
            raise Refused('unmerged entries, submodules and symlinks require separate review')
        ids.add(oid)
        index_names.append(name)
        blocked_paths += forbidden(name.decode('utf-8', 'surrogateescape'))
    oid_bytes = {'sha1': 20, 'sha256': 32}.get(git('rev-parse', '--show-object-format').strip().decode())
    if not oid_bytes:
        raise Refused('unsupported Git object format')

    counts = {}
    total = 0
    expanded = 0
    serial = 0
    with tempfile.TemporaryDirectory(prefix='zarf-secret-corpus-') as directory:
        private = Path(directory)
        corpus = private / 'corpus'
        corpus.mkdir()
        # The actual detector config is generated from constants, not mutable worktree policy.
        config = private / 'scanner.toml'
        config.write_text('[extend]\nuseDefault=true\n[allowlist]\nregexTarget="secret"\nregexes=' + json.dumps(['^' + x + '$' for x in PUBLIC_ACCOUNTS]) + '\n')

        def write_data(data, depth=0):
            nonlocal expanded, serial, blocked_paths
            if depth > 5 or len(data) > MAX_OBJECT:
                raise Refused('archive depth or object-size audit budget exceeded')
            expanded += len(data)
            if expanded > MAX_EXPANDED:
                raise Refused('expanded audit budget exceeded')
            serial += 1
            # Neutral filenames eliminate built-in lockfile/vendor path exclusions.
            (corpus / f'{serial:07d}.raw').write_bytes(data)
            texts = [data.decode('utf-8', 'replace').replace('\0', ' ')]
            if b'\0' in data or data.startswith((b'\xff\xfe', b'\xfe\xff')):
                for codec in ('utf-16-le', 'utf-16-be', 'utf-32-le', 'utf-32-be'):
                    try:
                        texts.append(data.decode(codec).replace('\0', ' '))
                    except UnicodeError:
                        pass
            normalized = '\n'.join(texts)
            if '+' in normalized or '\\x' in normalized or '\\u' in normalized:
                normalized += '\n' + '\n'.join(static_strings(normalized))
            encoded = normalized.encode('utf-8', 'replace')
            expanded += len(encoded)
            if expanded > MAX_EXPANDED:
                raise Refused('normalized audit budget exceeded')
            (corpus / f'{serial:07d}.txt').write_bytes(encoded)
            # Never extract member paths onto disk. File names are also scanner input.
            if zipfile.is_zipfile(io.BytesIO(data)):
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    for entry in archive.infolist():
                        if entry.flag_bits & 1:
                            raise Refused('encrypted archive requires separate review')
                        blocked_paths += forbidden(entry.filename)
                        write_data(entry.filename.encode(), depth + 1)
                        if not entry.is_dir():
                            with archive.open(entry) as member:
                                write_data(member.read(MAX_OBJECT + 1), depth + 1)
            elif data.startswith(b'\x1f\x8b'):
                with gzip.GzipFile(fileobj=io.BytesIO(data)) as member:
                    write_data(member.read(MAX_OBJECT + 1), depth + 1)
            elif len(data) > 262 and data[257:262] == b'ustar':
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
                    for entry in archive:
                        blocked_paths += forbidden(entry.name)
                        write_data(entry.name.encode(), depth + 1)
                        if entry.isfile():
                            member = archive.extractfile(entry)
                            with member:
                                write_data(member.read(MAX_OBJECT + 1), depth + 1)

        write_data(refs_before + b'\n' + b'\n'.join(index_names))
        reader = subprocess.Popen(['git', '-C', str(root), 'cat-file', '--batch'], env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for oid in sorted(ids):
                reader.stdin.write(oid + b'\n')
                reader.stdin.flush()
                header = reader.stdout.readline().split()
                if len(header) != 3 or header[0] != oid:
                    raise Refused('missing or invalid Git object')
                kind = header[1].decode()
                size = int(header[2])
                if size > MAX_OBJECT:
                    raise Refused('object-size audit budget exceeded')
                data = reader.stdout.read(size)
                if len(data) != size or reader.stdout.read(1) != b'\n':
                    raise Refused('truncated Git object')
                counts[kind] = counts.get(kind, 0) + 1
                total += size
                if kind == 'tree':
                    offset = 0
                    names = []
                    while offset < len(data):
                        end = data.index(b'\0', offset)
                        mode, name = data[offset:end].split(b' ', 1)
                        if mode in (b'160000', b'120000'):
                            raise Refused('historical submodule or symlink requires separate review')
                        names.append(name)
                        blocked_paths += forbidden(name.decode('utf-8', 'surrogateescape'))
                        offset = end + 1 + oid_bytes
                    if offset != len(data):
                        raise Refused('malformed Git tree')
                    write_data(b'\n'.join(names))
                else:
                    write_data(data)
            reader.stdin.close()
            if reader.wait():
                raise Refused('Git object reader failed')
        finally:
            if reader.poll() is None:
                reader.terminate()
                reader.wait()
        # Capture all detector output: context/filenames can themselves hold unknown secrets.
        report = private / 'findings.json'
        scanned = subprocess.run(['gitleaks', 'dir', '--no-banner', '--no-color', '--redact=100',
            '--ignore-gitleaks-allow', '--gitleaks-ignore-path', '/dev/null', '--max-decode-depth', '8',
            '--config', str(config), '--report-format', 'json', '--report-path', str(report), str(corpus)], capture_output=True)
        if scanned.returncode not in (0, 1):
            raise Refused('secret detector failed; no clean result is available')
        if (head_before != git('rev-parse', '--verify', 'HEAD')
                or refs_before != git('for-each-ref', '--format=%(objectname) %(refname)')
                or index_before != git('ls-files', '--stage', '-z')):
            raise Refused('Git refs or index changed during audit')
        if not report.exists():
            raise Refused('detector did not produce an audit report')
        findings = json.loads(report.read_text())
        if not isinstance(findings, list):
            raise Refused('detector report has an unsupported format')
        if scanned.returncode or findings or blocked_paths:
            print(f'secret scan: REJECTED ({len(findings)} detector findings, {blocked_paths} forbidden path entries); values withheld')
            return 1
        print(f'secret scan: PASS; {counts.get("commit", 0)} commits, {counts.get("blob", 0)} blobs, '
              f'{counts.get("tree", 0)} trees; {total} raw bytes; index included; working files require separate review')
        return 0


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main(Path(sys.argv[1]).resolve()))
    except Exception:
        # Exceptions may quote credential-bearing data or names. Never echo them.
        print('secret scan: REFUSED; incomplete, unsupported or modified audit input (details withheld)', file=sys.stderr)
        sys.exit(2)
