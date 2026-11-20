# Windows Client Pipeline Update Implementation Plan

> **For agentic workers:** Execute inline, task by task, with test checkpoints. Do not stage unrelated workspace files.

**Goal:** A successful merge to `main` deploys Linux and publishes a verified Windows package from the same commit; the existing Windows client installs that exact package at its next interactive logon before starting autopilot.

**Architecture:** GitHub Actions builds a deterministic commit-addressed ZIP from Git-tracked, allowlisted client sources, validates it before the Linux deployment job, then publishes it as a public GitHub Release after deployment succeeds. A Windows startup updater compares the current `main` SHA with its `win-client-<sha>` release, verifies hashes and frozen-core pins, backs up and atomically applies the package, and invokes the existing `start-pilot.cmd`. The one-time task bootstrap preserves the current disabled state.

**Tech Stack:** GitHub Actions, Python 3.11 standard library, PowerShell ScheduledTasks, pytest.

## Global Constraints

- Do not modify `agent/wecom_io_core/win.py`, `send.py`, `store.py`, or `crypto.py`; the package builder and client updater verify their pinned hashes.
- Do not package credentials, `config.json`, reply databases, logs, media, decrypted data, or the Win-only untracked `login_code.py`.
- Update existing clients only; abort if required local `login_code.py` is absent.
- If `agent/pyproject.toml` or `agent/uv.lock` changes, fail package validation before Linux deploy; dependency updates need a separate reviewed path.
- Do not change `CloudPilot` from Disabled during bootstrap or deployment. Do not start WeCom, autopilot, or send a synthetic message in this implementation.
- Keep global GitHub Actions contents permission read-only; grant release-write permission only to the post-deploy release job.
- Use explicit `git add` paths. Preserve all unrelated untracked/dirty files and the existing locally approved unread/unknown fixes.

---

## File Map

- Create `deploy/client/frozen-core-sha256.json`: four approved immutable core file hashes.
- Create `scripts/package_windows_client.py`: deterministic ZIP and manifest builder for an exact commit.
- Create `deploy/client/client_updater.py`: public release lookup, validation, backup, atomic apply, rollback, installed-version record, and guarded launch.
- Create `deploy/client/client-startup.cmd`: stable task entry that runs the updater and stops on error.
- Create `deploy/client/bootstrap-client-updater.ps1`: one-time installation and CloudPilot action/logon-trigger migration; supports dry-run and preserves Enabled state.
- Create `backend/tests/test_windows_client_distribution.py`: package allowlist, hashes, deterministic output, dependency gate.
- Create `backend/tests/test_windows_client_updater.py`: release selection, path safety, hashes, rollback, local-data preservation, missing prerequisite.
- Create `backend/tests/test_windows_bootstrap.py`: task-action and disabled-state-preservation checks.
- Modify `.github/workflows/deploy.yml`: package validation before Linux deploy and immutable release publication after deploy health checks.
- Modify `docs/Win端现场盘点-20261119.md` and `docs/superpowers/specs/2026-11-20-win-client-pipeline-update-design.md` with exact rollout facts.

## Task 1: Frozen Client Package Contract

**Interfaces:** `build_package(repo_root: Path, commit: str, base_commit: str, output: Path) -> dict` returns the commit SHA, archive SHA, and manifest. Package target paths are relative to `C:\agent`; the updater and startup command use reserved package paths `client_updater.py` and `client-startup.cmd`.

- [ ] Write tests proving the package contains only Git-tracked top-level `agent/*.py` except frozen modules, plus updater/bootstrap assets; it excludes `login_code.py`, config, logs, databases, media, and decrypted files.
- [ ] Write tests proving the four protected hashes match the pinned JSON and that dependency lock changes between base SHA and target SHA fail package generation.
- [ ] Run `uv run --project backend pytest backend/tests/test_windows_client_distribution.py -q`; confirm expected RED before implementation.
- [ ] Implement a Python standard-library package builder using `git ls-tree` and `git show <commit>:<path>`; never package from the dirty working tree.
- [ ] Generate a deterministic ZIP and manifest with full commit SHA, ordered file names, sizes, and SHA-256 hashes; exclude `agent/wecom_io_core/**` and assert the four pinned source hashes before writing any archive.
- [ ] Build the same commit twice in separate temporary paths and assert archive hashes match; run focused package tests and confirm GREEN.

## Task 2: Windows Release Updater

**Interfaces:** `main(argv: Sequence[str] | None = None) -> int`; pure helpers `validate_archive(path, expected_sha)`, `validate_manifest(root, manifest, protected_hashes)`, and `apply_files(staging, target, manifest) -> list[Path]` are directly testable. The scheduled command runs updater normal mode; tests call the helpers with temporary directories.

- [ ] Write tests for exact current-main SHA release selection, 404/not-yet-published release, checksum mismatch, path traversal, duplicate paths, unexpected files, missing `login_code.py`, changed frozen core, dependency mismatch, and already-installed no-op.
- [ ] Write a rollback test that injects failure after one file replacement and proves all modified files are restored; also prove `config.json`, `reply_log.db`, logs, media, `_decrypted/`, and extra local Python files remain byte-identical.
- [ ] Run `uv run --project backend pytest backend/tests/test_windows_client_updater.py -q`; confirm expected RED.
- [ ] Implement public GitHub REST lookups: request `main` SHA, request release tag `win-client-<full SHA>`, download its ZIP/checksum, and fail closed if the matching release is missing. Do not use any GitHub token or moving “latest” release.
- [ ] Validate the archive hash, manifest commit, each file SHA/size, allowlisted target path, protected core hash, unchanged dependency hash, and presence of Win-only `login_code.py` before touching installed files.
- [ ] Create timestamped backups of only changed installed files and the version manifest; atomically replace via same-volume temporary files; restore all replaced files on failure; leave the updater task enabled state untouched.
- [ ] If current autopilot is running, exit without replacing anything. If update succeeds, record installed commit and start the existing `start-pilot.cmd` exactly once; if validation or update fails, do not start it.
- [ ] Run updater unit tests and focused client regression tests; confirm GREEN.

## Task 3: One-Time Bootstrap

**Interfaces:** `bootstrap-client-updater.ps1 [-DryRun] -TargetRoot C:\agent` returns a proposed/current task configuration and, without `-DryRun`, installs reviewed bootstrap files and sets CloudPilot action to `client-startup.cmd` with one interactive logon trigger. It preserves the task's existing Enabled value.

- [ ] Write tests asserting the bootstrap action contains no broad `taskkill`, the trigger is AtLogOn, multiple-instance policy is IgnoreNew, and disabled remains disabled.
- [ ] Run `uv run --project backend pytest backend/tests/test_windows_bootstrap.py -q`; confirm expected RED.
- [ ] Implement backup/export of existing updater files and CloudPilot XML, install updater assets, update only the action/trigger, and restore prior files/XML if task registration fails.
- [ ] Implement `client-startup.cmd` to call the Python updater and return nonzero without launching autopilot on updater failure.
- [ ] Add a Windows CI dry-run check for PowerShell syntax and task XML generation; do not run the task or enable it.
- [ ] Run bootstrap tests and PowerShell syntax validation; confirm GREEN and unchanged disabled state in the validation fixture.

## Task 4: Main Pipeline Integration

- [ ] Add a package-validation job/step that runs after tests but before Linux deploy on main, branch pushes, and PR checks. Use push-before SHA or PR base SHA to check client dependency lock changes.
- [ ] Make Linux deploy depend on package validation as well as tests, so packaging/protected-core/dependency-gate failures prevent server deployment.
- [ ] Add a main-only Windows release job that depends on tests, package validation, and successful Linux health checks. Grant `contents: write` only to this job.
- [ ] Publish immutable tag `win-client-<GITHUB_SHA>` with `windows-client.zip`, `windows-client.sha256`, and manifest. Re-running the same workflow for that SHA must verify assets and no-op; conflicting existing release assets fail without overwrite.
- [ ] Add workflow/package integration tests for PR/non-main no-publish behavior, job dependency ordering, exact SHA propagation, and narrow permissions.
- [ ] Run the package builder locally for the current feature commit and inspect only manifest paths/hash summaries. Validate Workflow YAML and run `git diff --check`.

## Task 5: Bootstrap and PR Handoff

- [ ] Confirm Win `CloudPilot` remains Disabled and no autopilot process is running; create restricted backups of its task XML and any bootstrap file before remote changes.
- [ ] Copy the reviewed updater/bootstrap to Win through the already-used authenticated transfer path and verify file hashes.
- [ ] Run bootstrap `-DryRun`; verify the intended task action and one logon trigger. Apply bootstrap configuration while preserving Disabled; do not start or enable the task.
- [ ] Run a local synthetic-release smoke test and a Win dry-run against a staging directory. Verify database/config/log/media hashes and `login_code.py` hash are unchanged.
- [ ] Run the full Python test suite and applicable workflow checks. Prepare an explicit-path commit and a PR on `codex/windows-client-pipeline-update`; do not merge `main`.
- [ ] Report that merging main deploys Linux and publishes the matching Win package, while Win applies it on the next authorized interactive logon. The currently disabled CloudPilot stays disabled until the wrong-destination incident is reviewed and the user resumes it.
