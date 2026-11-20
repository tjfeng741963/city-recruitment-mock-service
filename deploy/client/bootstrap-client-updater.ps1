param(
    [string]$TargetRoot = 'C:\agent',
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
    @{ Source = Join-Path $sourceRoot 'client_updater.py'; Name = 'client_updater.py'; Sha256 = '9026e9db38719a25a84e8d7ec5eb5bc60f969d7f8985595ff5ca5a6ca2bd8ed0' },
    @{ Source = Join-Path $sourceRoot 'client-startup.cmd'; Name = 'client-startup.cmd'; Sha256 = 'cf7f461525e7048cc1112b5c4446b8dd5aad5e56f0ed2a72fbcaef46db6fd49d' },
    @{ Source = Join-Path $sourceRoot 'frozen-core-sha256.json'; Name = 'frozen-core-sha256.json'; Sha256 = '331bd03d756ea740b08be1275245f0d8f5b0bc84386ebb4242c9e44fc02bd43a' }
)

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
    } | ConvertTo-Json -Depth 4
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $TargetRoot "release-backups\updater-bootstrap-$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$installed = @()
try {
    Set-Content -LiteralPath (Join-Path $backup 'CloudPilot.xml') -Value $oldXml -Encoding UTF8
    foreach ($asset in $assets) {
        $destination = Join-Path $TargetRoot $asset.Name
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $asset.Name) -Force
        }
        Copy-Item -LiteralPath $asset.Source -Destination $destination -Force
        $installed += $asset.Name
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
    [pscustomobject]@{
        Mode = 'APPLIED'
        Task = "$taskPath$taskName"
        WasEnabled = $wasEnabled
        RemainsEnabled = [bool]$current.Settings.Enabled
        TaskWillRunNow = $false
        Backup = $backup
        Installed = $installed
    } | ConvertTo-Json -Depth 4
} catch {
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
    throw
}
