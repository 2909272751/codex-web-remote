#Requires -Version 5.1
<#
.SYNOPSIS
    codexweb 部署同步脚本（P0+P1 契约 §5）。

    兼容 Windows PowerShell 5.1 与 PowerShell 7+（本机只装了 5.1，故用 powershell -File 运行）。

.DESCRIPTION
    把开发仓库里的指定文件同步到线上运行副本（默认 D:\CodexWebRemote），
    需要时优雅重启网关并等待新版本真正生效。

    行为契约：
      1. 默认 Source=E:\实用软件开发\电脑软件\dsh插件\codex-web-remote、Target=D:\CodexWebRemote；
      2. -Files 为相对路径列表；先全量预检源文件，再逐个「目标已存在则先备份 → 复制」；
      3. 备份到 $Target\.backup-<yyyyMMdd-HHmmss>\<相对路径>；
      4. 复制后逐个比对 SHA256，任一不一致立即 exit 1 且**不重启**；
      5. -Restart：CodexWebRemote.exe --shutdown → 等启动器与 node 子进程退出（≤20s）
         → WMI broker 独立启动 CodexWebRemote.exe --background（不继承桌面 Job）
         → 轮询 http://127.0.0.1:<port>/api/session 直到 200 且 version 与 package.json 一致（≤60s）。

    绝对禁止（脚本内没有任何 Remove-Item / 删除逻辑）：
      删除文件、覆盖 settings.json、改动 %LOCALAPPDATA%\CodexWebRemote、
      改动 .runtime-data、改动 88frp 的任何配置。

.PARAMETER Source
    开发仓库根。默认取本脚本所在目录的父目录（即 E:\实用软件开发\电脑软件\dsh插件\codex-web-remote），
    这样默认值与契约一致，同时不受脚本源码编码影响。

.PARAMETER Preflight
    只读预检：校验参数、列出每个文件的状态（新增/内容一致/将覆盖），不复制、不备份、不重启。
    可用于在不触碰 Target 的前提下自查脚本。

.EXAMPLE
    powershell -NoProfile -File scripts/deploy-sync.ps1 -Files server.mjs,src/codex-client.mjs,package.json,public/app.js,public/index.html,public/sw.js -Restart

.EXAMPLE
    powershell -NoProfile -File scripts/deploy-sync.ps1 -Preflight
#>
[CmdletBinding()]
param(
    [string]$Source = '',
    [string]$Target = 'D:\CodexWebRemote',
    [string[]]$Files = @(
        'server.mjs',
        'src/codex-client.mjs',
        'src/app-projects.mjs',
        'src/frp-address.mjs',
        'src/thread-view.mjs',
        'src/windows-process-control.mjs',
        'package.json',
        'public/app.js',
        'public/project-utils.js',
        'public/index.html',
        'public/sw.js',
        'public/timeline.js',
        'public/experience.css',
        'public/markdown.js',
        'public/workspace-cache.js'
    ),
    [switch]$Restart,
    [switch]$Preflight,
    [int]$Port = 0,
    [int]$StopTimeoutSeconds = 20,
    [int]$HealthTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$restartHelper = Join-Path $PSScriptRoot 'start-independent.ps1'
if ($Restart -and -not (Test-Path -LiteralPath $restartHelper -PathType Leaf)) { throw 'Missing independent-start helper; refusing to stop the current service.' }

# `powershell -File script.ps1 -Files a,b,c` hands the whole comma list over as a
# single string (argument transformation does not split it), so normalize the
# bound value back into a real array before anything else looks at it.
$Files = @($Files | ForEach-Object { [string]$_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

# ---------------------------------------------------------------------------
# 输出与失败处理
# ---------------------------------------------------------------------------
function Write-Info {
    param([string]$Message)
    Write-Host "[deploy-sync] $Message"
}

function Write-Err {
    param([string]$Message)
    Write-Host "[deploy-sync][错误] $Message" -ForegroundColor Red
}

function Stop-WithError {
    param([string]$Message)
    Write-Err $Message
    exit 1
}

# ---------------------------------------------------------------------------
# 路径工具
# ---------------------------------------------------------------------------
function Resolve-RootPath {
    param([string]$Value, [string]$Label)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Stop-WithError "$Label 不能为空。"
    }
    $full = [System.IO.Path]::GetFullPath($Value)
    return $full.TrimEnd('\')
}

# 相对路径净化 + 黑名单校验（契约 §5 的「绝对禁止」项在这里硬拦）
function ConvertTo-SafeRelativePath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Stop-WithError '文件列表中存在空路径。'
    }
    $raw = $Value.Trim().Replace('/', '\')
    if ($raw.StartsWith('\\')) {
        Stop-WithError "只接受相对路径，收到 UNC 路径：$Value"
    }
    if ($raw -match '^[A-Za-z]:') {
        Stop-WithError "只接受相对路径，收到绝对路径：$Value"
    }
    while ($raw.StartsWith('.\')) { $raw = $raw.Substring(2) }
    $raw = $raw.TrimStart('\')
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Stop-WithError "无效的相对路径：$Value"
    }
    if ($raw -match '(^|\\)\.\.(\\|$)') {
        Stop-WithError "路径不得包含 ..：$Value"
    }
    if ($raw -match '(?i)(^|\\)settings\.json$') {
        Stop-WithError "契约禁止覆盖 settings.json：$Value"
    }
    if ($raw -match '(?i)(^|\\)\.runtime-data(\\|$)') {
        Stop-WithError "契约禁止改动 .runtime-data：$Value"
    }
    if ($raw -match '(?i)(^|\\)node_modules(\\|$)') {
        Stop-WithError "禁止同步 node_modules：$Value"
    }
    return $raw
}

function Assert-PathUnderRoot {
    param([string]$FullPath, [string]$Root, [string]$Label)
    $rootWithSeparator = $Root.TrimEnd('\') + '\'
    if (-not $FullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-WithError "$Label 越界：$FullPath 不在 $rootWithSeparator 之下。"
    }
}

# ---------------------------------------------------------------------------
# 只读查询工具
# ---------------------------------------------------------------------------
# 读取网关端口：只读 %LOCALAPPDATA%\CodexWebRemote\settings.json，绝不写入
function Get-GatewayPort {
    param([string]$SettingsPath)
    $fallbackPort = 18888
    try {
        if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) { return $fallbackPort }
        $settings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $property = $settings.PSObject.Properties['Port']
        if ($property -and [int]$property.Value -gt 0) { return [int]$property.Value }
    }
    catch {
        Write-Info "读取 settings.json 端口失败（只读，忽略）：$($_.Exception.Message)"
    }
    return $fallbackPort
}

# 读取 package.json 版本：重启后服务端 /api/session 上报的就是这个值
function Get-PackageVersion {
    param([string]$PackagePath)
    try {
        if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { return $null }
        $package = Get-Content -LiteralPath $PackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $property = $package.PSObject.Properties['version']
        if ($property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            return [string]$property.Value
        }
    }
    catch {
        Write-Info "读取 package.json 版本失败：$($_.Exception.Message)"
    }
    return $null
}

# 找出属于本安装目录的启动器与 node 子进程（按可执行文件全路径精确匹配）
function Get-InstallProcess {
    param([string]$LauncherPath, [string]$NodePath)
    $found = @()
    foreach ($name in @('CodexWebRemote', 'node')) {
        foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $path = $null
            try { $path = $process.Path } catch { $path = $null }
            if (-not $path) { continue }
            if ($path -ieq $LauncherPath -or $path -ieq $NodePath) { $found += $process }
        }
    }
    return $found
}

# ---------------------------------------------------------------------------
# 0. 根目录校验
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Source)) {
    # 契约默认 Source = E:\实用软件开发\电脑软件\dsh插件\codex-web-remote，
    # 它正好是本脚本（<repo>\scripts\deploy-sync.ps1）所在目录的父目录。
    $derivedSource = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { '' }
    if (-not $derivedSource -or -not (Test-Path -LiteralPath $derivedSource -PathType Container)) {
        # 脚本被复制到别处时的兜底：契约写死的默认值
        $derivedSource = 'E:\实用软件开发\电脑软件\dsh插件\codex-web-remote'
    }
    $Source = $derivedSource
    Write-Info "使用默认 Source（脚本所在仓库）：$Source"
}

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Stop-WithError "Source 不存在：$Source"
}

$sourceRoot = Resolve-RootPath -Value $Source -Label 'Source'
$targetRoot = Resolve-RootPath -Value $Target -Label 'Target'

if ($sourceRoot -ieq $targetRoot) {
    Stop-WithError "Source 与 Target 不能是同一个目录：$sourceRoot"
}
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    Stop-WithError "Target 不存在（部署前应已安装）：$targetRoot"
}

# 受保护目录：Target 及其下任何写入都不得落进去
$protectedRoots = @(
    (Join-Path $env:LOCALAPPDATA 'CodexWebRemote'),
    'C:\ProgramData\88frp-node'
)
foreach ($protected in $protectedRoots) {
    if ([string]::IsNullOrWhiteSpace($protected)) { continue }
    $protectedFull = $protected.TrimEnd('\')
    if ($targetRoot -ieq $protectedFull -or $targetRoot.StartsWith($protectedFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-WithError "Target 不得位于受保护目录之下：$protectedFull"
    }
}

# ---------------------------------------------------------------------------
# 1. 预检文件列表（任何缺失都在动手之前失败）
# ---------------------------------------------------------------------------
if (-not $Files -or $Files.Count -eq 0) {
    Stop-WithError '必须通过 -Files 指定至少一个相对路径。'
}

$plan = @()
foreach ($file in ($Files | Select-Object -Unique)) {
    $relative = ConvertTo-SafeRelativePath -Value $file
    $sourceFull = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
    $targetFull = [System.IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    Assert-PathUnderRoot -FullPath $sourceFull -Root $sourceRoot -Label '源文件'
    Assert-PathUnderRoot -FullPath $targetFull -Root $targetRoot -Label '目标文件'
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Leaf)) {
        Stop-WithError "源文件不存在：$sourceFull"
    }
    $plan += [pscustomobject]@{
        Relative = $relative
        Source   = $sourceFull
        Target   = $targetFull
        Exists   = (Test-Path -LiteralPath $targetFull -PathType Leaf)
    }
}

Write-Info "Source = $sourceRoot"
Write-Info "Target = $targetRoot"
Write-Info "待同步 $($plan.Count) 个文件。"

# ---------------------------------------------------------------------------
# 1.5 只读预检模式：只报告计划，不复制 / 不备份 / 不重启
# ---------------------------------------------------------------------------
if ($Preflight) {
    Write-Info '预检模式（只读）：不会复制、不会备份、不会重启。'
    foreach ($item in $plan) {
        if (-not $item.Exists) {
            $state = '新增'
        }
        else {
            $sourceHash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash
            $targetHash = (Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash
            $state = if ($sourceHash -eq $targetHash) { '内容一致' } else { '将覆盖（先备份）' }
        }
        Write-Host ("  {0,-30} {1}" -f $item.Relative, $state)
    }
    Write-Info "-Restart 指定：$([bool]$Restart)；预检结束，未做任何修改。"
    exit 0
}

# ---------------------------------------------------------------------------
# 2. 备份 + 复制 + 逐个 SHA256 校验
# ---------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $targetRoot ".backup-$stamp"
$backupCreated = $false
$copiedFiles = @()
$mismatchedFiles = @()

foreach ($item in $plan) {
    if ($item.Exists) {
        if (-not $backupCreated) {
            New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
            $backupCreated = $true
            Write-Info "备份目录：$backupRoot"
        }
        $backupFile = Join-Path $backupRoot $item.Relative
        $backupDir = Split-Path -Parent $backupFile
        if ($backupDir -and -not (Test-Path -LiteralPath $backupDir)) {
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $item.Target -Destination $backupFile -Force
        Write-Info "已备份：$($item.Relative)"
    }

    $targetDir = Split-Path -Parent $item.Target
    if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    Copy-Item -LiteralPath $item.Source -Destination $item.Target -Force

    $sourceHash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) {
        $mismatchedFiles += "$($item.Relative)（源 $sourceHash ≠ 目标 $targetHash）"
        Write-Err "SHA256 不一致：$($item.Relative)"
    }
    else {
        $copiedFiles += $item.Relative
        Write-Info "已同步并校验：$($item.Relative)  SHA256=$($targetHash.Substring(0, 12))…"
    }
}

if ($mismatchedFiles.Count -gt 0) {
    Stop-WithError ("SHA256 校验失败，已中止且不会重启：`n  - " + ($mismatchedFiles -join "`n  - "))
}

if ($backupCreated) {
    Write-Info "同步完成：$($copiedFiles.Count) 个文件，备份在 $backupRoot"
}
else {
    Write-Info "同步完成：$($copiedFiles.Count) 个文件（目标原本都不存在，无需备份）"
}

# ---------------------------------------------------------------------------
# 3. 重启（仅在 -Restart 时执行）
# ---------------------------------------------------------------------------
if (-not $Restart) {
    Write-Info '未指定 -Restart，跳过重启。'
    exit 0
}

$launcherPath = Join-Path $targetRoot 'CodexWebRemote.exe'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    Stop-WithError "未找到启动器：$launcherPath"
}
$nodePath = Join-Path $targetRoot 'runtime\node.exe'

$settingsPath = Join-Path $env:LOCALAPPDATA 'CodexWebRemote\settings.json'
$effectivePort = if ($Port -gt 0) { $Port } else { Get-GatewayPort -SettingsPath $settingsPath }
$expectedVersion = Get-PackageVersion -PackagePath (Join-Path $targetRoot 'package.json')

Write-Info "端口 = $effectivePort；期望版本 = $(if ($expectedVersion) { $expectedVersion } else { '（package.json 不可读，只校验 HTTP 200）' })"

# 3.1 优雅停止：--shutdown 只是给已存在的命名事件 Local\CodexWebRemote.Shutdown 发信号
#     （见 desktop\CodexWebRemote.Launcher\Program.cs:45-49），它自己不等待退出，
#     所以必须由本脚本轮询等待启动器与 node 子进程真正退出。
Write-Info '停止网关：CodexWebRemote.exe --shutdown'
try {
    $shutdownProcess = Start-Process -FilePath $launcherPath -ArgumentList '--shutdown' -WorkingDirectory $targetRoot -WindowStyle Hidden -PassThru
    if ($shutdownProcess) { [void]$shutdownProcess.WaitForExit(10000) }
}
catch {
    Stop-WithError "执行 --shutdown 失败：$($_.Exception.Message)"
}

$stopDeadline = (Get-Date).AddSeconds($StopTimeoutSeconds)
$remaining = @(Get-InstallProcess -LauncherPath $launcherPath -NodePath $nodePath)
while ($remaining.Count -gt 0 -and (Get-Date) -lt $stopDeadline) {
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-InstallProcess -LauncherPath $launcherPath -NodePath $nodePath)
}
if ($remaining.Count -gt 0) {
    $ids = ($remaining | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ', '
    Stop-WithError "等待进程退出超时（${StopTimeoutSeconds}s）：$ids"
}
Write-Info '启动器与 node 子进程已退出。'

# 3.2 后台启动
Write-Info '启动网关：CodexWebRemote.exe --background'
. (Join-Path $PSScriptRoot 'start-independent.ps1')
$independent = Start-IndependentWindowsProcess -Path $launcherPath -Arguments @('--background') -Directory $targetRoot
Write-Info "独立启动 PID=$($independent.ProcessId)，宿主 PID=$($independent.ParentProcessId)，broker=$($independent.Broker)"

# 3.3 轮询 /api/session，直到 200 且版本一致
$sessionUrl = "http://127.0.0.1:$effectivePort/api/session"
$healthDeadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
$lastState = '尚未收到响应'
$ready = $false
while ((Get-Date) -lt $healthDeadline) {
    try {
        $session = Invoke-RestMethod -Uri $sessionUrl -Method Get -TimeoutSec 3
        $actualVersion = [string]$session.version
        if (-not $expectedVersion -or $actualVersion -eq $expectedVersion) {
            $ready = $true
            $lastState = "version=$actualVersion codexReady=$($session.codexReady)"
            break
        }
        $lastState = "version=$actualVersion（期望 $expectedVersion）"
    }
    catch {
        $lastState = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Stop-WithError "启动后 ${HealthTimeoutSeconds}s 内 /api/session 未就绪：$sessionUrl；最后状态：$lastState"
}

Write-Info "网关已就绪：$sessionUrl（$lastState）"
Write-Info '部署完成。'
exit 0
