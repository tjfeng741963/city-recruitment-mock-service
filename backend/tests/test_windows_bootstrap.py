from pathlib import Path
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = REPO_ROOT / "deploy/client/bootstrap-client-updater.ps1"
STARTUP = REPO_ROOT / "deploy/client/client-startup.cmd"
WORKFLOW = REPO_ROOT / ".github/workflows/deploy.yml"
LEGACY_SYNC = REPO_ROOT / "deploy/client/sync_from_github.py"


def test_bootstrap_changes_only_cloudpilot_action_and_interactive_logon_trigger():
    text = BOOTSTRAP.read_text(encoding="utf-8")
    lower = text.lower()

    assert "cloudpilot" in lower
    assert "new-scheduledtasktrigger -atlogon" in lower
    assert "$existingsettings = $task.settings" in lower
    assert "$wasenabled = [bool]$task.settings.enabled" in lower
    assert "$current.settings.enabled -ne $wasenabled" in lower
    assert "disable-scheduledtask -taskname $taskname" in lower
    assert "enable-scheduledtask -taskname $taskname" in lower
    assert "get-normalizedsha256 $asset.source" in lower
    assert "login_code.py" in lower
    assert "pilot-hidden.vbs" in lower
    assert "installed frozen core differs from the reviewed baseline" in lower
    assert "frozen-core-sha256.json" in lower
    assert "activeautopilot.count -gt 0" in lower
    assert "$dryrun" in lower
    assert "start-scheduledtask" not in lower
    assert not re.search(r"(?i)taskkill\s+/im\s+python|stop-process\s+.*python", text)


def test_startup_reports_local_launch_failure_and_does_not_chain_another_launcher():
    text = STARTUP.read_text(encoding="utf-8")
    assert "c:\\progra~1\\python311\\python.exe" in text.lower()
    assert "client_updater.py" in text.lower()
    assert "if errorlevel 1" in text.lower()
    assert "start-pilot.cmd" not in text.lower()
    assert "更新未完成" not in text


def test_workflow_restricts_release_publication_to_deployed_main():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "contents: read" in text
    assert "contents: write" in text
    assert "windows-client-package" in text
    assert "publish-windows-client" in text
    assert "needs: [test, deploy, windows-client-package]" in text
    assert 'elif [ "$EVENT_NAME" = workflow_dispatch ]; then' in text
    assert 'base="$(git rev-parse "$SHA^" 2>/dev/null || git rev-parse "$SHA")"' in text
    assert '--target "$SHA"' in text
    assert 'git/ref/tags/$tag' in text
    assert text.index('- name: Deploy systemd backend') < text.index('  publish-windows-client:')
    assert '(cd dist/windows-client && sha256sum windows-client.zip > windows-client.sha256)' in text


def test_legacy_manual_apply_is_disabled():
    text = LEGACY_SYNC.read_text(encoding="utf-8")
    assert "if args.apply:" in text
    assert "手动覆盖更新已禁用" in text
    assert "return sync(target, args.ref, apply=False)" in text


def test_legacy_internal_apply_rejected_before_network(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("legacy_sync", LEGACY_SYNC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    def forbidden_fetch(ref):
        pytest.fail("legacy writes must stop before network access")
    monkeypatch.setattr(module, "_fetch", forbidden_fetch)
    with pytest.raises(ValueError, match="writes are disabled"):
        module.sync(tmp_path, "main", apply=True)


def test_bootstrap_asset_pins_match_checked_in_sources():
    text = BOOTSTRAP.read_text(encoding="utf-8")
    assets = re.findall(r"Name = '([^']+)'; Sha256 = '([0-9a-f]{64})'", text)
    assert len(assets) == 6
    for name, digest in assets:
        data = (BOOTSTRAP.parent / name).read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        assert hashlib.sha256(data).hexdigest() == digest, name


@pytest.mark.skipif(sys.platform != "win32", reason="Windows ScheduledTasks PowerShell contract")
@pytest.mark.parametrize("dry_run", [True, False])
def test_powershell_bootstrap_keeps_disabled_task_without_launch(tmp_path, dry_run):
    target = tmp_path / "agent"
    target.mkdir()
    desktop = tmp_path / "desktop"
    desktop.mkdir()
    for name in ("login_code.py", "start-pilot.cmd", "pilot-hidden.vbs"):
        (target / name).write_text("# local prerequisite", encoding="utf-8")
    core = target / "wecom_io_core"
    core.mkdir()
    for name in ("win.py", "send.py", "store.py", "crypto.py"):
        shutil.copy2(REPO_ROOT / "agent/wecom_io_core" / name, core / name)
    harness = tmp_path / "harness.ps1"
    harness.write_text(r'''
param([string]$Bootstrap, [string]$Target, [string]$Desktop, [switch]$Dry)
$ErrorActionPreference = 'Stop'
# 输出统一 UTF-8：中文 Windows 默认 GBK、英文 runner 默认 cp1252，
# 不固定编码时 json.loads 会读不出中文路径（CI 上就是这么红的）。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# 输出统一 UTF-8：中文 Windows 默认 GBK、英文 runner 默认 cp1252，
# 不固定编码时 json.loads 会读不出中文路径（CI 上就是这么红的）。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Bootstrap, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PowerShell parser failed' }
$global:MockTask = [pscustomobject]@{
  Settings = [pscustomobject]@{ Enabled = $false; MultipleInstances = 'IgnoreNew' }
  Principal = [pscustomobject]@{ UserId = 'FixtureUser'; LogonType = 'Interactive' }
}
function Get-CimInstance { param($ClassName) @() }
function Get-ScheduledTask { param($TaskName, $TaskPath) $global:MockTask }
function Export-ScheduledTask { param($TaskName, $TaskPath) '<Task><Settings><Enabled>false</Enabled></Settings></Task>' }
function New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) if (-not $AtLogOn) { throw 'expected logon' }; [pscustomobject]@{UserId=$User} }
function Set-ScheduledTask {
  param($TaskName, $TaskPath, $Action, $Trigger, $Settings, $Principal)
  if ($Settings.Enabled -or $Settings.MultipleInstances -ne 'IgnoreNew') { throw 'settings changed' }
  if ($Action.Arguments -notlike '*client-startup.cmd*' -or $Principal.LogonType -ne 'Interactive') { throw 'invalid action/principal' }
}
function Disable-ScheduledTask { param($TaskName, $TaskPath) $global:MockTask.Settings.Enabled = $false }
function Enable-ScheduledTask { throw 'must not enable disabled task' }
function Start-ScheduledTask { throw 'must not run task' }
function Register-ScheduledTask { throw ('unexpected rollback: ' + $global:Error[0].Exception.Message) }
& $Bootstrap -TargetRoot $Target -ShortcutDirectory $Desktop -DryRun:$Dry
''', encoding="utf-8")
    args = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(harness), "-Bootstrap", str(BOOTSTRAP), "-Target", str(target), "-Desktop", str(desktop)]
    if dry_run:
        args.append("-Dry")
    result = subprocess.run(args, capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace")
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["WasEnabled"] is False
    assert output["TaskWillRunNow"] is False
    if dry_run:
        assert output["WillRemainEnabled"] is False
        assert not (target / "client_updater.py").exists()
        assert not list(desktop.iterdir())
    else:
        assert output["RemainsEnabled"] is False
        assert (target / "client_updater.py").read_bytes() == (BOOTSTRAP.parent / "client_updater.py").read_bytes()
        assert (desktop / "城市招聘客户端管理.lnk").is_file()
