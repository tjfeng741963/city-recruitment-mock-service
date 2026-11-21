param(
    [string]$TargetRoot = 'C:\agent',
    [string]$ShortcutDirectory = [Environment]::GetFolderPath('DesktopDirectory'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$taskName = 'CloudPilot'
$sourceRoot = $PSScriptRoot
$taskPath = '\'
function Get-NormalizedSha256([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $normalized = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}
$assets = @(
    @{ Source = Join-Path $sourceRoot 'client_updater.py'; Name = 'client_updater.py'; Sha256 = 'fac8091ed484b77d95ae312735af4343e7c1d6ef7ca6386aac14c8f7a74d831a' },
    @{ Source = Join-Path $sourceRoot 'client-startup.cmd'; Name = 'client-startup.cmd'; Sha256 = 'bf1b85d4c1621a40366c79f1f0f68895273839ab1567523872bd7f3b8b602215' },
    @{ Source = Join-Path $sourceRoot 'frozen-core-sha256.json'; Name = 'frozen-core-sha256.json'; Sha256 = '331bd03d756ea740b08be1275245f0d8f5b0bc84386ebb4242c9e44fc02bd43a' },
    @{ Source = Join-Path $sourceRoot 'client_manager.py'; Name = 'client_manager.py'; Sha256 = '1e9beaca2e186e84a6dc06955c3c59bd3ff3aac6fbb45f39872a2a225e68736f' },
    @{ Source = Join-Path $sourceRoot 'client_manager_service.py'; Name = 'client_manager_service.py'; Sha256 = '7423a842e99acbbdaa6bbae2418652b6f010f5a1d66a6a023690c14b39149864' },
    @{ Source = Join-Path $sourceRoot 'client-manager.vbs'; Name = 'client-manager.vbs'; Sha256 = '37da1603a7749499a394b3b9c6e2d1144ff426c295d1f1f18d324fd6ed8e558b' }
)
$shortcutName = -join ([char[]](0x57CE,0x5E02,0x62DB,0x8058,0x5BA2,0x6237,0x7AEF,0x7BA1,0x7406))
if (-not (Test-Path -LiteralPath $ShortcutDirectory -PathType Container)) {
    throw 'Desktop shortcut directory is missing'
}
$shortcutPath = Join-Path $ShortcutDirectory ($shortcutName + '.lnk')

foreach ($asset in $assets) {
    if (-not (Test-Path -LiteralPath $asset.Source -PathType Leaf)) {
        throw "Bootstrap asset missing: $($asset.Name)"
    }
    if ((Get-NormalizedSha256 $asset.Source) -ne $asset.Sha256) {
        throw "Bootstrap asset hash mismatch: $($asset.Name)"
    }
}
if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) {
    throw "Client root missing: $TargetRoot"
}
foreach ($required in @('login_code.py', 'start-pilot.cmd', 'pilot-hidden.vbs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot $required) -PathType Leaf)) {
        throw "Required machine-local client file missing: $required"
    }
}
$corePins = Get-Content -LiteralPath (Join-Path $sourceRoot 'frozen-core-sha256.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($coreName in @('win.py', 'send.py', 'store.py', 'crypto.py')) {
    $corePath = Join-Path $TargetRoot "wecom_io_core\$coreName"
    if (-not (Test-Path -LiteralPath $corePath -PathType Leaf)) {
        throw "Frozen core file missing: $coreName"
    }
    $source = [System.IO.File]::ReadAllText($corePath, [System.Text.Encoding]::UTF8)
    $normalized = $source.Replace("`r`n", "`n").Replace("`r", "`n")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actual = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    $expected = [string]$corePins.$coreName
    if ($actual -ne $expected) {
        throw "Installed frozen core differs from the reviewed baseline: $coreName"
    }
}
$activeAutopilot = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'python.exe','pythonw.exe' -and $_.CommandLine -like '*autopilot.py*'
})
if ($activeAutopilot.Count -gt 0) {
    throw 'Autopilot is running; stop the existing client before bootstrapping the updater'
}

$task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
$wasEnabled = [bool]$task.Settings.Enabled
$principal = $task.Principal
if ([string]$principal.LogonType -ne 'Interactive') {
    throw 'CloudPilot must already use an interactive principal; refusing unattended desktop launch'
}
$oldXml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath
$newAction = New-ScheduledTaskAction -Execute $env:ComSpec -Argument "/c `"`"$TargetRoot\client-startup.cmd`"`""
$newTrigger = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
$existingSettings = $task.Settings
$existingSettings.Enabled = $wasEnabled

if ($DryRun) {
    [pscustomobject]@{
        Mode = 'DRY-RUN'
        Task = "$taskPath$taskName"
        WasEnabled = $wasEnabled
        WillRemainEnabled = $wasEnabled
        Principal = $principal.UserId
        Action = "$env:ComSpec /c `"`"$TargetRoot\client-startup.cmd`"`""
        Trigger = 'AtLogOn / InteractiveToken'
        Assets = @($assets | ForEach-Object { @{ Name = $_.Name; Sha256 = $_.Sha256 } })
        TaskWillRunNow = $false
        DesktopShortcut = $shortcutPath
    } | ConvertTo-Json -Depth 4
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $TargetRoot "release-backups\updater-bootstrap-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$installed = @()
$shortcutChanged = $false
try {
    Set-Content -LiteralPath (Join-Path $backup 'CloudPilot.xml') -Value $oldXml -Encoding UTF8
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backup 'manager-shortcut.lnk') -Force
    }
    foreach ($asset in $assets) {
        $destination = Join-Path $TargetRoot $asset.Name
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $asset.Name) -Force
        }
        $installed += $asset.Name
        Copy-Item -LiteralPath $asset.Source -Destination $destination -Force
    }

    Set-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
        -Action $newAction -Trigger $newTrigger -Settings $existingSettings -Principal $principal | Out-Null

    if ($wasEnabled) {
        Enable-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Out-Null
    } else {
        Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Out-Null
    }

    $current = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    if ([bool]$current.Settings.Enabled -ne $wasEnabled) {
        throw 'CloudPilot enabled state changed unexpectedly'
    }
    $shell = New-Object -ComObject WScript.Shell
    # WScript's save path uses the system ANSI code page on some Windows builds.
    # Save under an ASCII name, then let PowerShell copy to the Unicode desktop name.
    $stagedShortcut = Join-Path $backup 'manager-new.lnk'
    $shortcut = $shell.CreateShortcut($stagedShortcut)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $TargetRoot 'client-manager.vbs') + '"'
    $shortcut.WorkingDirectory = $TargetRoot
    $shortcut.Description = 'City Recruitment Client Manager'
    $shortcut.IconLocation = Join-Path $env:SystemRoot 'System32\shell32.dll,21'
    $shortcut.Save()
    $shortcutChanged = $true
    Copy-Item -LiteralPath $stagedShortcut -Destination $shortcutPath -Force
    [pscustomobject]@{
        Mode = 'APPLIED'
        Task = "$taskPath$taskName"
        WasEnabled = $wasEnabled
        RemainsEnabled = [bool]$current.Settings.Enabled
        TaskWillRunNow = $false
        Backup = $backup
        Installed = $installed
        DesktopShortcut = $shortcutPath
    } | ConvertTo-Json -Depth 4
} catch {
    $bootstrapFailure = $_
    try {
    if ($shortcutChanged) {
        $savedShortcut = Join-Path $backup 'manager-shortcut.lnk'
        if (Test-Path -LiteralPath $savedShortcut -PathType Leaf) {
            Copy-Item -LiteralPath $savedShortcut -Destination $shortcutPath -Force
        } else {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($asset in $assets) {
        $destination = Join-Path $TargetRoot $asset.Name
        $saved = Join-Path $backup $asset.Name
        if (Test-Path -LiteralPath $saved -PathType Leaf) {
            Copy-Item -LiteralPath $saved -Destination $destination -Force
        } elseif ($installed -contains $asset.Name) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        }
    }
    Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
        -Xml $oldXml -Force | Out-Null
    if ($wasEnabled) {
        Enable-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Out-Null
    } else {
        Disable-ScheduledTask -TaskName $taskName -TaskPath $taskPath | Out-Null
    }
    } catch {
        throw "Bootstrap failed: $($bootstrapFailure.Exception.Message); rollback also failed: $($_.Exception.Message)"
    }
    throw $bootstrapFailure
}
