# Repository security checks

Use a fresh, complete clone of the intended repository. Keep deployment credentials
outside the checkout and supply them through the provider's secret bindings or the
operator's environment. Publishing starts from a reviewed commit, never from a working tree.

With Python 3.11+, Git and gitleaks installed, run:

```sh
make security
bash scripts/secret-scan.sh
```

The gate scans all reachable commits, trees and blobs, ref names and the index.
It uses neutral filenames so lockfile and vendor exclusions cannot hide content,
normalizes UTF text and literal concatenation, and scans bounded ZIP, gzip and tar
contents plus encoded values. Credential paths, agent instruction files and chat
exports are rejected, including names found inside archives. Findings and parser
errors never print the underlying values.

An incomplete clone, replacement refs, grafts, changed refs/index, unsupported input
or exceeded resource limits cannot produce a passing result. A successful scan is
bounded evidence: it does not perform OCR, prove that every obfuscation is detectable,
inspect unstaged files, or remove old GitHub objects and third-party copies. Media,
hosting metadata and live deployments require their own review.

To publish a reviewed commit to a new, empty repository:

```sh
scripts/publish.sh --expected-commit FULL_REVIEWED_COMMIT OWNER/REPOSITORY
```

Replace the placeholders with the independently reviewed full commit ID and intended
destination. The command refuses a different HEAD, local changes, a nonempty target,
failed scans or changes during scanning. It creates only `main` and
`hackathon-submission`, atomically, with conditional creation and automatic tag
following disabled. Repository visibility is not changed. Existing repositories
require a separately reviewed update; this command will refuse them.
