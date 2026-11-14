"""Isolated regression tests for the public-release gate (requires Git and gitleaks)."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parent.parent


class SecretScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='zarf-secret-scan-')
        self.addCleanup(self.tmp.cleanup)
        self.repo = pathlib.Path(self.tmp.name)
        (self.repo / 'scripts').mkdir()
        for name in ['scripts/secret-scan.sh', 'scripts/secret-scan.py', '.gitleaks.toml']:
            shutil.copyfile(SOURCE / name, self.repo / name)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Security gate test')
        self.commit()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def scan(self, env=None):
        return subprocess.run(['bash', str(self.repo / 'scripts/secret-scan.sh')],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)

    def test_clean_template(self):
        (self.repo / '.env.example').write_text('API_KEY=\n')
        self.commit()
        self.assertEqual(self.scan().returncode, 0)

    def test_deleted_env_on_other_branch(self):
        self.git('checkout', '-qb', 'other')
        (self.repo / '.env.production').touch()
        self.commit()
        self.git('rm', '-q', '.env.production')
        self.commit()
        self.git('checkout', '-q', 'main')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_staged_key_path(self):
        (self.repo / 'private.seed').touch()
        self.git('add', 'private.seed')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_secret_only_on_other_branch(self):
        import secrets
        import string
        self.git('checkout', '-qb', 'other')
        # Generate a synthetic provider-shaped canary; never a usable credential.
        value = 'gh' + 'p_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        (self.repo / 'config.txt').write_text('token=' + value + '\n')
        self.commit()
        self.git('checkout', '-q', 'main')
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(value.encode(), result.stdout + result.stderr)

    def test_staged_secret_cannot_use_inline_suppression(self):
        import secrets
        import string
        value = 'gh' + 'p_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        (self.repo / 'config.txt').write_text('token=' + value + ' # gitleaks:allow\n')
        self.git('add', 'config.txt')
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(value.encode(), result.stdout + result.stderr)

    def test_public_account_substring_does_not_allow_secret(self):
        import re
        config = (self.repo / '.gitleaks.toml').read_text()
        for account in re.findall(r'[a-f0-9]{64}', config):
            with self.subTest(account_suffix=account[-4:]):
                (self.repo / 'config.txt').write_text('api_key="prefix' + account + 'suffix"\n')
                self.git('add', 'config.txt')
                self.assertNotEqual(self.scan().returncode, 0)

    def test_exact_public_account_is_allowed(self):
        import re
        for account in re.findall(r'[a-f0-9]{64}', (self.repo / '.gitleaks.toml').read_text()):
            with self.subTest(account_suffix=account[-4:]):
                (self.repo / 'config.txt').write_text('api_key="' + account + '"\n')
                self.commit()
                self.assertEqual(self.scan().returncode, 0)

    def test_credential_file_added_only_by_merge(self):
        self.git('checkout', '-qb', 'other')
        (self.repo / 'other.txt').write_text('other branch\n')
        self.commit()
        self.git('checkout', '-q', 'main')
        (self.repo / 'main.txt').write_text('main branch\n')
        self.commit()
        self.git('merge', '--no-commit', 'other')
        (self.repo / '.env.local').touch()
        self.commit()
        self.assertNotEqual(self.scan().returncode, 0)

    def test_template_with_trailing_newline_is_not_allowlisted(self):
        (self.repo / '.env.example\n').touch()
        self.commit()
        self.assertNotEqual(self.scan().returncode, 0)

    def test_uppercase_template_is_not_allowlisted(self):
        (self.repo / '.ENV.EXAMPLE').touch()
        self.commit()
        self.assertNotEqual(self.scan().returncode, 0)

    def test_commit_message_secret(self):
        import secrets
        import string
        value = 'gh' + 'p_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        self.git('commit', '--allow-empty', '-qm', 'token=' + value)
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(value.encode(), result.stdout + result.stderr)

    def test_annotated_tag_secret(self):
        import secrets
        import string
        value = 'gh' + 'p_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        self.git('tag', '-a', 'fixture-tag', '-m', 'token=' + value)
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(value.encode(), result.stdout + result.stderr)

    def test_deleted_agent_instruction_blocked(self):
        (self.repo / 'CLAUDE.md').write_text('Private assistant context\n')
        self.commit()
        self.git('rm', '-q', 'CLAUDE.md')
        self.commit()
        self.assertNotEqual(self.scan().returncode, 0)

    def test_staged_conversation_export_blocked(self):
        (self.repo / 'conversations').mkdir()
        (self.repo / 'conversations/chat.json').write_text('{}\n')
        self.git('add', 'conversations/chat.json')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_shallow_checkout_refused(self):
        # A shallow marker models incomplete local history without network access.
        head = self.git('rev-parse', 'HEAD').stdout
        (self.repo / '.git/shallow').write_bytes(head)
        self.assertEqual(self.scan().returncode, 2)

    def canary(self):
        import secrets
        import string
        return 'gh' + 'p_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))

    def assert_blocked_without_disclosure(self, value):
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(value.encode() in result.stdout + result.stderr, 'canary leaked in scanner output')

    def test_default_excluded_paths_are_scanned(self):
        for name in ['package-lock.json', 'pnpm-lock.yaml', 'node_modules/config.txt']:
            with self.subTest(path=name):
                value = self.canary()
                path = self.repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('token=' + value + '\n')
                self.commit()
                self.assert_blocked_without_disclosure(value)

    def test_binary_diff_cannot_hide_a_secret(self):
        value = self.canary()
        (self.repo / 'payload.dat').write_bytes(b'\0token=' + value.encode())
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_utf16_secret_is_scanned(self):
        value = self.canary()
        (self.repo / 'config.txt').write_bytes(('token=' + value).encode('utf-16-le'))
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_zip_member_with_excluded_name_is_scanned(self):
        import zipfile
        value = self.canary()
        with zipfile.ZipFile(self.repo / 'bundle.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('node_modules/package-lock.json', 'token=' + value)
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_secret_in_deleted_filename_is_scanned_and_redacted(self):
        value = self.canary()
        name = value + '.txt'
        (self.repo / name).write_text('ordinary contents\n')
        self.commit()
        self.git('rm', '-q', '--', name)
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_unstaged_config_cannot_suppress_staged_secret(self):
        value = self.canary()
        (self.repo / 'config.txt').write_text('token=' + value)
        self.git('add', 'config.txt')
        (self.repo / '.gitleaks.toml').write_text('[extend]\nuseDefault=true\n[allowlist]\nregexes=[".*"]\n')
        self.assert_blocked_without_disclosure(value)

    def test_replace_refs_refused(self):
        original = self.git('rev-parse', 'HEAD').stdout.decode().strip()
        self.git('commit', '--allow-empty', '-qm', 'replacement fixture')
        replacement = self.git('rev-parse', 'HEAD').stdout.decode().strip()
        self.git('replace', original, replacement)
        self.assertEqual(self.scan().returncode, 2)

    def test_grafts_refused(self):
        head = self.git('rev-parse', 'HEAD').stdout
        (self.repo / '.git/info/grafts').write_bytes(head)
        self.assertEqual(self.scan().returncode, 2)

    def test_partial_clone_refused(self):
        self.git('config', 'extensions.partialClone', 'fixture-promisor')
        self.git('config', 'remote.fixture-promisor.promisor', 'true')
        self.assertEqual(self.scan().returncode, 2)

    def test_zip_credential_filename_rejected_even_without_token_pattern(self):
        import zipfile
        with zipfile.ZipFile(self.repo / 'bundle.zip', 'w') as archive:
            archive.writestr('nested/.env.production', 'ordinary local configuration')
        self.commit()
        self.assertEqual(self.scan().returncode, 1)

    def test_gzip_secret_is_scanned(self):
        import gzip
        value = self.canary()
        (self.repo / 'bundle.gz').write_bytes(gzip.compress(('token=' + value).encode()))
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_six_layers_of_base64_are_scanned(self):
        import base64
        value = self.canary()
        encoded = ('token=' + value).encode()
        for _ in range(6):
            encoded = base64.b64encode(encoded)
        (self.repo / 'data.txt').write_bytes(encoded)
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_split_literal_secret_is_scanned(self):
        value = self.canary()
        pieces = [value[n:n + 5] for n in range(0, len(value), 5)]
        (self.repo / 'config.js').write_text('const token = ' + ' + '.join(repr(x) for x in pieces) + ';\n')
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_prefixed_zip_secret_is_scanned(self):
        import io
        import zipfile
        value = self.canary()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('data.txt', 'token=' + value)
        (self.repo / 'bundle.dat').write_bytes(b'executable-stub\n' + buffer.getvalue())
        self.commit()
        self.assert_blocked_without_disclosure(value)

    def test_git_environment_cannot_redirect_audit(self):
        import os
        value = self.canary()
        (self.repo / 'config.txt').write_text('token=' + value)
        self.commit()
        foreign = self.repo / 'foreign'
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(foreign)], check=True)
        for args in [('config', 'user.name', 'Synthetic fixture'),
                     ('config', 'user.email', 'fixture@example.invalid'),
                     ('commit', '--allow-empty', '-qm', 'clean')]:
            subprocess.run(['git', '-C', str(foreign), *args], check=True)
        result = self.scan(env=dict(os.environ, GIT_DIR=str(foreign / '.git'), GIT_WORK_TREE=str(foreign)))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(value.encode() in result.stdout + result.stderr)

    def test_detached_head_change_during_scan_refused(self):
        import os
        value = self.canary()
        self.git('checkout', '--detach', '-q')
        fake = self.repo / 'bin'
        fake.mkdir()
        real = shutil.which('gitleaks')
        script = fake / 'gitleaks'
        script.write_text('#!/usr/bin/env python3\nimport os,subprocess,sys\n'
                          'p=subprocess.run([os.environ["REAL_GITLEAKS"],*sys.argv[1:]])\n'
                          'if p.returncode == 0:\n'
                          ' subprocess.run(["git","-C",os.environ["AUDIT_REPO"],"commit","--allow-empty","-qm","token="+os.environ["SYNTHETIC_CANARY"]],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n'
                          'sys.exit(p.returncode)\n')
        script.chmod(0o755)
        result = self.scan(env=dict(os.environ, PATH=str(fake) + os.pathsep + os.environ['PATH'],
                                   REAL_GITLEAKS=real, AUDIT_REPO=str(self.repo), SYNTHETIC_CANARY=value))
        self.assertEqual(result.returncode, 2)
        self.assertFalse(value.encode() in result.stdout + result.stderr)

    def test_literal_parser_does_not_echo_source_warnings(self):
        (self.repo / 'config.js').write_text(r'const text = "escaped\q" + "ordinary";' + '\n')
        self.commit()
        result = self.scan()
        self.assertEqual(result.returncode, 0)
        self.assertNotIn(b'SyntaxWarning', result.stderr)


if __name__ == '__main__':
    unittest.main()
