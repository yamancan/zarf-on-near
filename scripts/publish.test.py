#!/usr/bin/env python3
"""Exercise publishing safeguards with real local Git state and mocked remote operations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='zarf-publish-test-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        (self.repo / 'scripts').mkdir()
        shutil.copyfile(Path(__file__).with_name('publish.sh'), self.repo / 'scripts/publish.sh')
        scanner = self.repo / 'scripts/secret-scan.sh'
        scanner.write_text('''#!/usr/bin/env bash
set -eu
touch "$AUDIT_TEST_STATE/scanned"
case "${AUDIT_TEST_GATE:-}" in
  fail) exit 1 ;;
  head) git commit --allow-empty -qm changed ;;
  dirty) echo changed >> tracked ;;
  staged) echo changed >> tracked; git add tracked ;;
  untracked) echo changed > added ;;
  remote) touch "$AUDIT_TEST_STATE/remote-filled" ;;
esac
''')
        scanner.chmod(0o755)
        (self.repo / 'tracked').write_text('original\n')
        self.real_git = shutil.which('git')
        for args in [('init', '-q'), ('config', 'user.name', 'Synthetic Auditor'),
                     ('config', 'user.email', 'audit@example.invalid'), ('add', '.'),
                     ('commit', '-qm', 'fixture')]:
            subprocess.run([self.real_git, *args], cwd=self.repo, check=True, capture_output=True)
        self.sha = subprocess.check_output([self.real_git, 'rev-parse', 'HEAD'], cwd=self.repo, text=True).strip()
        bindir = self.base / 'bin'
        bindir.mkdir()
        wrapper = bindir / 'git'
        wrapper.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
s = pathlib.Path(os.environ['AUDIT_TEST_STATE'])
a = sys.argv[1:]
if a and a[0] == 'status' and os.environ.get('AUDIT_TEST_STATUS_FAIL'):
    sys.exit(2)
if a and a[0] == 'ls-remote':
    if os.environ.get('AUDIT_TEST_REMOTE') == 'unreadable': sys.exit(2)
    if os.environ.get('AUDIT_TEST_REMOTE') == 'filled' or (s / 'remote-filled').exists():
        print('1' * 40 + '\\trefs/heads/existing')
    sys.exit(0)
if a and a[0] == 'push':
    (s / 'push.json').write_text(json.dumps(a))
    sys.exit(int(os.environ.get('AUDIT_TEST_PUSH_EXIT', '0')))
os.execv(os.environ['AUDIT_TEST_GIT'], [os.environ['AUDIT_TEST_GIT'], *a])
''')
        wrapper.chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bindir}:{os.environ["PATH"]}',
                    'AUDIT_TEST_STATE': str(self.base), 'AUDIT_TEST_GIT': self.real_git}

    def run_publish(self, *args, **env):
        return subprocess.run(['bash', 'scripts/publish.sh', *args], cwd=self.repo,
                              env={**self.env, **env}, capture_output=True, text=True)

    def command(self, **env):
        return self.run_publish('--expected-commit', self.sha, '--url', 'https://example.invalid/new.git', **env)

    def refused(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / 'push.json').exists(), result.stderr)

    def test_exact_head_is_pushed_atomically_with_create_only_leases(self):
        r = self.command()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.base / 'scanned').exists())
        a = json.loads((self.base / 'push.json').read_text())
        self.assertIn('--atomic', a)
        self.assertIn('--no-follow-tags', a)
        self.assertIn('--force-with-lease=refs/heads/main:', a)
        self.assertIn('--force-with-lease=refs/tags/hackathon-submission:', a)
        self.assertEqual(a[-2:], [f'{self.sha}:refs/heads/main', f'{self.sha}:refs/tags/hackathon-submission'])
        self.assertNotIn('--all', a)
        self.assertNotIn('--mirror', a)

    def test_pin_required(self):
        self.refused(self.run_publish('--url', 'https://example.invalid/new.git'))

    def test_wrong_or_abbreviated_pin(self):
        for pin in ['0' * 40, self.sha[:12]]:
            self.refused(self.run_publish('--expected-commit', pin, '--url', 'https://example.invalid/new.git'))

    def test_dirty_or_untracked_worktree_refused_before_scan(self):
        for name in ['tracked', 'untracked']:
            with self.subTest(name=name):
                (self.repo / name).write_text('changed\n')
                self.refused(self.command())
                self.assertFalse((self.base / 'scanned').exists())
                if name == 'tracked':
                    (self.repo / name).write_text('original\n')

    def test_nonempty_or_unreadable_remote_refused(self):
        for state in ['filled', 'unreadable']:
            self.refused(self.command(AUDIT_TEST_REMOTE=state))

    def test_scan_failure_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='fail'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_status_failure_refused_before_scan(self):
        self.refused(self.command(AUDIT_TEST_STATUS_FAIL='1'))
        self.assertFalse((self.base / 'scanned').exists())

    def test_head_move_during_scan_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='head'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_worktree_change_during_scan_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='dirty'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_index_change_during_scan_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='staged'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_untracked_change_during_scan_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='untracked'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_remote_filled_during_scan_refused(self):
        self.refused(self.command(AUDIT_TEST_GATE='remote'))
        self.assertTrue((self.base / 'scanned').exists())

    def test_push_failure_is_not_reported_as_success(self):
        r = self.command(AUDIT_TEST_PUSH_EXIT='1')
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue((self.base / 'push.json').exists())
        self.assertNotIn('published', r.stdout)


if __name__ == '__main__':
    unittest.main()
