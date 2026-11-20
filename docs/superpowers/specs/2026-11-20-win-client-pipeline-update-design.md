# Windows Client Pipeline Update Design

**Date:** 2026-11-20
**Status:** Proposed; user approved pipeline-published client updates checked at client startup.

## Goal

When a tested commit is merged into `main`, the existing Linux deployment and a versioned Windows client package must come from that same commit. The Windows client checks for that package before starting autopilot on its next scheduled interactive logon, applies it safely, records the version, then starts the client if the update succeeds.

## Current State

- `.github/workflows/deploy.yml` tests the commit and deploys Linux Node/Python services on `main`.
- `C:\agent` is not a Git checkout. The existing `deploy/client/sync_from_github.py` downloads a GitHub source tarball and applies Python files when manually invoked; it is not connected to the Windows startup task.
- The deployed client has an untracked `login_code.py` and other machine-local operational files. Those files and runtime data must survive an update.
- The current Windows `CloudPilot` task repeats every five minutes and is disabled after confirmed wrong-conversation sends. The updater must not re-enable it or start sending during installation.
- `agent/wecom_io_core/win.py`, `send.py`, `store.py` and `crypto.py` are frozen. The updater must refuse an artifact whose hashes for those files differ from the approved baseline.
- The repository has no GitHub Releases yet and is public. The workflow can publish immutable, commit-addressed releases; the Windows client can download public release assets without a GitHub credential.

## Design

### Pipeline publication

The existing main workflow remains the source of truth. A Windows package job runs only for a non-PR push to `main`, after the shared test job and Linux deployment job both succeed. It packages files from the exact `GITHUB_SHA`, not a later moving `main` ref.

The package contains the tracked Windows client Python sources that are safe to update, plus a manifest containing the full commit SHA, relative file paths, sizes and SHA-256 hashes. It excludes config, credentials, logs, SQLite databases, media, decrypted data, local state, and the frozen core. The job verifies the package contents and frozen-core baseline before publishing a GitHub Release tagged with the full commit SHA. The release contains a client ZIP and its checksum/manifest. The release is immutable and does not move a stable tag.

The package targets existing provisioned clients, not clean installations: the current runtime requires a machine-local `login_code.py` that is absent from Git. The updater verifies this prerequisite exists and preserves it. The build job compares `agent/pyproject.toml` and `agent/uv.lock` against the base commit; if either changes, package validation fails before the Linux deploy job, so the two deployed ends cannot silently use incompatible client dependencies. A dependency change requires an explicitly reviewed follow-up update path.

The release job receives `contents: write` only for publishing. All ordinary jobs retain read-only contents permission. PRs and non-main branches do not publish client releases. If tests or Linux deployment fail, no client release is published.

### Windows startup updater

A small, separately maintained bootstrap updater runs before autopilot in the interactive `CloudPilot` task. It reads the current `main` commit SHA from the public GitHub API, then requests the Windows release tagged for that exact SHA; it never updates from a newer or unrelated release. It downloads the archive to a staging directory, verifies the archive checksum and every manifest path/hash, and rejects path traversal, duplicate paths, missing files, a missing machine-local `login_code.py`, or modified frozen-core files.

Before applying a newer commit, the updater verifies that no autopilot process is running. It backs up each changed tracked source file and a version manifest, writes files via same-volume temporary files and atomic replace, and rolls back all replaced files if any replacement fails. It preserves untracked files such as `login_code.py` and never touches `config.json`, `.greeted.json`, `.report_state.json`, `reply_log.db`, WAL/SHM files, media, logs, or `_decrypted/`.

If GitHub is unreachable, the release is invalid, hashes fail, frozen files differ, or replacement/rollback fails, the updater logs the exact stage and does not start autopilot. If the latest commit is already installed, it records a no-op and continues to the existing client launcher. The updater never submits messages, performs UI automation, or changes the CloudPilot enabled state.

### One-time bootstrap and task boundary

The first installation must copy the reviewed bootstrap updater to `C:\agent` and change `CloudPilot` to an interactive logon trigger that invokes the updater. Because the present task is disabled for wrong-conversation investigation, bootstrap edits its action and trigger while preserving the disabled state. The user must separately authorize/resume the task after reviewing the wrong-send incident; merging the feature must not resume it.

The previous five-minute trigger is removed. Repeated updater invocations and simultaneous autopilot processes are prevented by a named single-updater lock and by checking the existing autopilot mutex/process before replacement. The task remains tied to the logged-in desktop session required by WeCom.

## Error and rollback behavior

- Network/API failure: keep current client files; do not start a new autopilot process.
- Checksum, manifest, path or frozen-core mismatch: reject the whole package and retain diagnostic metadata without extracted customer data.
- Partial replacement failure: restore every file already replaced from the timestamped backup; keep the task disabled if rollback cannot be verified.
- Successful update: record installed commit SHA and per-file hashes locally, then launch the existing reviewed startup chain once.
- Existing wrong-destination `unknown` rows remain unchanged. Updating code never resets or requeues the reply ledger.

## Verification

1. Unit tests cover package allowlisting/exclusions, deterministic manifest hashes, immutable core checks, release selection, checksum failure, path traversal, already-current no-op, rollback after a simulated mid-apply failure, and preservation of untracked runtime files.
2. Workflow validation proves PR/non-main runs cannot publish and that publication waits for both tests and Linux deploy success.
3. Staging smoke test uses a temporary client tree and a synthetic release; it verifies file hashes and confirms config, database, logs and local-only files are byte-identical afterward.
4. Windows bootstrap dry run confirms the current CloudPilot task is disabled, validates the staged updater and release metadata, and prints the proposed task action without enabling or running it.
5. First live update occurs only after the user explicitly resumes the disabled client task. Verify installed SHA, single autopilot PID, health/heartbeat and client logs; do not send a synthetic customer message. Confirm no wrong-conversation event before continuing observation.

## Scope

This feature does not repair the wrong-conversation root cause, change sender input actions, automatically requeue `unknown` rows, alter model prompts, or make the updater silently restart an active client. Those remain separate work items.
