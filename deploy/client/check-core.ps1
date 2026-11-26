# 核心文件自检：核对 wecom_io_core 下四个文件与 frozen-core-sha256.json 是否一致。
#
# 为什么要单独查：核心文件不随发布包下发，一旦被人手工覆盖，客户端启动和更新
# 都会被拒绝（2026-11-26 现场：win.py 被改过，客户端直接起不来，排查花了半小时）。
# 这里只读，不改任何东西；哈希口径与 client_updater.py::_normalized_sha256 一致，
# 即先把 CRLF/CR 统一成 LF 再算 sha256。
param(
    [Parameter(Mandatory = $true)][string]$Pins,
    [Parameter(Mandatory = $true)][string]$Core
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Pins)) {
    Write-Output "        未找到冻结清单：$Pins"
    exit 2
}
if (-not (Test-Path -LiteralPath $Core)) {
    Write-Output "        未找到核心目录：$Core"
    exit 2
}

$pinsObject = Get-Content -LiteralPath $Pins -Raw -Encoding UTF8 | ConvertFrom-Json
$sha = [System.Security.Cryptography.SHA256]::Create()
$mismatch = 0

foreach ($property in $pinsObject.PSObject.Properties) {
    $name = [string]$property.Name
    $expected = ([string]$property.Value).ToLower()
    $path = Join-Path $Core $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Output ("        [缺失]   {0}" -f $name)
        $mismatch++
        continue
    }

    # 字节级归一化：CRLF 只保留 LF，孤立 CR 换成 LF（不经过字符串，避免 BOM/编码干扰）
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $normalized = New-Object System.Collections.Generic.List[byte]
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        if ($bytes[$i] -eq 13) {
            if (($i + 1) -lt $bytes.Length -and $bytes[$i + 1] -eq 10) { continue }
            $normalized.Add(10)
        }
        else {
            $normalized.Add($bytes[$i])
        }
    }
    $digest = [System.BitConverter]::ToString($sha.ComputeHash($normalized.ToArray())) -replace '-', ''
    $actual = $digest.ToLower()

    if ($actual -eq $expected) {
        Write-Output ("        [一致]   {0}" -f $name)
    }
    else {
        Write-Output ("        [不一致] {0}  本地 {1}  清单 {2}" -f $name, $actual.Substring(0, 12), $expected.Substring(0, 12))
        $mismatch++
    }
}

if ($mismatch -gt 0) {
    Write-Output ""
    Write-Output "        核心文件与冻结清单不符，客户端启动和更新都会被拒绝。"
    Write-Output "        恢复方法见 deploy\client\README.md 的「核心文件排查」一节。"
    exit 1
}

Write-Output "        全部一致"
exit 0
