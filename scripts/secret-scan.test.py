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
        for name in ['scripts/secret-scan.sh', '.gitleaks.toml']:
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

    def scan(self):
        return subprocess.run(['bash', str(self.repo / 'scripts/secret-scan.sh')],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

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


if __name__ == '__main__':
    unittest.main()
